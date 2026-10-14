#!/usr/bin/env node
/**
 * dsh_log_stream.mjs —— DSH 会话事件日志 → NDJSON 实时事实流（零依赖 Node 边车进程）
 *
 * 为什么需要它
 * ------------
 * DSH 把会话事件持久化为**拼接式 Zstandard 帧**的 JSONL 文件：
 *   <DSH_HOME>/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd
 * 每个追加批次是一个独立的 zstd 帧（因此不能用一次性解压：只能逐帧解）。
 * Node 自带 zstd 解码（node:zlib `zstdDecompressSync`），而后端 venv 没有 zstd
 * 绑定，所以解码交给本进程，Python 只消费 NDJSON。
 *
 * 职责边界（重要）
 * ---------------
 *   本进程 = DSH 协议侧：解码 zstd 帧、解析事件、把事件**折叠成客观事实(facts)**。
 *   dsh_adapter.py = 策略侧：facts → 统一 phase（桌宠只认 phase）。
 *   折叠逻辑只在本文件实现一次，Python 不重复实现，避免两处规则漂移。
 *
 * 输出（stdout，每行一个 JSON）
 * ---------------------------
 *   {"kind":"ready",   "session","log","cwd","delegation_depth","events_replayed"}
 *   {"kind":"facts",   "facts":{...}}                     附着时的当前事实快照
 *   {"kind":"event",   "type","seq","time","data","facts"} 实时增量事件 + 折叠后事实
 *   {"kind":"switch",  "session","log","from"}             活跃会话切换
 *   {"kind":"offline", "reason"}                           DSH 未运行 / 无会话可跟
 *   {"kind":"ping",    "ts"}                               保活心跳（5s）
 *   {"kind":"error",   "message"}                          内部错误（不退出）
 *
 * 用法
 * ----
 *   node dsh_log_stream.mjs [--sessions-root <dir>] [--workspace <cwd>] [--session-id <id>]
 *                          [--poll-ms 400] [--stale-takeover-ms 2500] [--once]
 *   --once 只输出当前 facts 后退出（探测/自检用）。
 *
 * 设计约束
 * -------
 *   - **只读**：绝不写 DSH 的 session 目录；
 *   - 附着时**不回放全部历史事件**（否则桌宠会把几百条旧事件当实时状态闪一遍）：
 *     内部重放折叠出“当前事实”，只发一条 facts，再从文件末尾增量跟随；
 *   - 会话选择带**迟滞**，且优先“本工作区的主会话（delegationDepth=0）”，
 *     避免跟随 subagent 子会话或两个会话来回抖动；
 *   - 任何异常都降级为 error/offline 消息，进程存活等待恢复（绝不崩溃退出）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 (LE)
const DECODE_CHUNK = 1024 * 1024
const PING_MS = 5000
const HEADER_PROBE_BYTES = 64 * 1024
const DEFAULT_TAKEOVER_MS = 2500

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    sessionsRoot: '',
    workspace: '',
    sessionId: '',
    pollMs: 400,
    takeoverMs: DEFAULT_TAKEOVER_MS,
    once: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sessions-root') out.sessionsRoot = argv[++i] || ''
    else if (a === '--workspace') out.workspace = argv[++i] || ''
    else if (a === '--session-id') out.sessionId = argv[++i] || ''
    else if (a === '--poll-ms') out.pollMs = Math.max(100, Number(argv[++i]) || 400)
    else if (a === '--stale-takeover-ms') out.takeoverMs = Math.max(0, Number(argv[++i]) || 0)
    else if (a === '--once') out.once = true
  }
  if (!out.sessionsRoot) {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    out.sessionsRoot = path.join(home, 'sessions')
  }
  return out
}

const ARGS = parseArgs(process.argv.slice(2))

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch (_) {
    /* stdout 已关闭（父进程退出）：忽略，由退出逻辑收尾 */
  }
}

// ---------------------------------------------------------------------------
// zstd 拼接帧：按帧结构步进扫描边界
// （不靠 magic 搜索——压缩块内可能恰好出现相同 4 字节序列，会误判）
// ---------------------------------------------------------------------------
/** 逐个步进 zstd 帧，返回完整帧范围与可能的“撕裂尾帧”起点。 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (blockHeader & 1) === 1
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payload = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payload) return { frames, tornStart: start }
      offset += payload
      if (last) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 解码单个 zstd 帧（可能跨多块）。 */
function decodeFrame(buf) {
  return zlib.zstdDecompressSync(buf, { chunkSize: DECODE_CHUNK }).toString('utf8')
}

/** 逐行解析 JSONL，跳过空行与半行。 */
function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object') out.push(o)
    } catch (_) {
      /* 跳过半行/脏行 */
    }
  }
  return out
}

/** 整文件解码（逐帧），返回 {events, torn}。单帧损坏跳过而不整体失败。 */
function decodeWholeLog(raw) {
  const { frames, tornStart } = scanZstdFrames(raw)
  let text = ''
  for (const f of frames) {
    try {
      text += decodeFrame(raw.subarray(f.start, f.end))
    } catch (_) {
      /* 单帧损坏：保留其余可解内容 */
    }
  }
  return {
    events: parseLines(text),
    torn: tornStart === undefined ? Buffer.alloc(0) : Buffer.from(raw.subarray(tornStart)),
  }
}

// ---------------------------------------------------------------------------
// 会话发现
// ---------------------------------------------------------------------------
/**
 * 读取会话日志头部（第一帧就是 header 行），拿到 DSH 自报的真实 cwd 与
 * delegationDepth —— 比从目录名反推路径可靠，也用于“优先主会话”。
 */
function readHeader(logPath) {
  let fd
  try {
    fd = fs.openSync(logPath, 'r')
    const size = Math.min(fs.fstatSync(fd).size, HEADER_PROBE_BYTES)
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, 0)
    const { frames } = scanZstdFrames(buf)
    if (!frames.length) return {}
    const events = parseLines(decodeFrame(buf.subarray(frames[0].start, frames[0].end)))
    const header = events.find((e) => e.type === 'session') || {}
    return {
      id: header.id,
      cwd: header.cwd || '',
      delegationDepth: Number.isInteger(header.delegationDepth) ? header.delegationDepth : 0,
      agentPreset: header.agentPreset || '',
      createdAt: header.createdAt,
    }
  } catch (_) {
    return {}
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (_) {}
    }
  }
}

/** 枚举候选会话日志。 */
function listCandidates() {
  const out = []
  let slugs
  try {
    slugs = fs.readdirSync(ARGS.sessionsRoot, { withFileTypes: true })
  } catch (_) {
    return out
  }
  const wantCwd = ARGS.workspace ? path.resolve(ARGS.workspace).toLowerCase() : ''
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const slugDir = path.join(ARGS.sessionsRoot, slug.name)
    let sessions
    try {
      sessions = fs.readdirSync(slugDir, { withFileTypes: true })
    } catch (_) {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      if (ARGS.sessionId && s.name !== ARGS.sessionId) continue
      const dir = path.join(slugDir, s.name)
      let files
      try {
        files = fs.readdirSync(dir)
      } catch (_) {
        continue
      }
      const logs = files.filter((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f))
      if (!logs.length) continue
      // 取格式版本最高的那个（当前为 v4）
      logs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      const logPath = path.join(dir, logs[0])
      let st
      try {
        st = fs.statSync(logPath)
      } catch (_) {
        continue
      }
      const header = readHeader(logPath)
      const cwd = header.cwd || ''
      out.push({
        logPath,
        sessionId: s.name,
        cwd,
        delegationDepth: header.delegationDepth || 0,
        agentPreset: header.agentPreset || '',
        mtimeMs: st.mtimeMs,
        size: st.size,
        inWorkspace: Boolean(wantCwd) && path.resolve(cwd || '.').toLowerCase() === wantCwd,
      })
    }
  }
  // 排序优先级：本工作区 > 主会话(depth=0) > 最近修改
  out.sort((a, b) => {
    if (a.inWorkspace !== b.inWorkspace) return a.inWorkspace ? -1 : 1
    if (a.delegationDepth !== b.delegationDepth) return a.delegationDepth - b.delegationDepth
    return b.mtimeMs - a.mtimeMs
  })
  return out
}

// ---------------------------------------------------------------------------
// 事实折叠：DSH 会话事件 → 客观事实 facts
// （事实是“发生了什么”的客观描述；它到 phase 的映射属于 Python 适配器的策略）
// ---------------------------------------------------------------------------
/** 会“等待用户”的工具名（调用即进入聆听态，结果返回才结束）。 */
const ASK_TOOLS = new Set(['ask_user_question', 'ask_user', 'askuserquestion', 'user_questions'])
/** 规划类工具名（映射到 planning）。 */
const PLAN_TOOLS = new Set(['todo_write', 'todowrite', 'create_goal', 'update_goal', 'exit_plan_mode'])
/** 语音播报类工具名（DSH 默认无 TTS；若部署了此类工具即可驱动 voice）。 */
const VOICE_TOOLS = new Set(['speak', 'tts', 'text_to_speech', 'say'])

function initialFacts() {
  return {
    // 轮次 / 步骤
    in_turn: false,
    turn: null,
    step: null,
    // 工具
    last_tool: '',
    tool_calls: 0,
    active_tools: 0,
    // 等待类
    approvals_pending: 0,
    awaiting_user: false,
    voice_active: false,
    // 异常 / 重试
    retrying: false,
    errored: false,
    // 仅当“最近一个事件”本身是失败时为 true（进展事件会立即清零）——
    // 用于把 error phase 精确限定在失败当下，而不是让失败态粘住整轮
    last_event_failed: false,
    turn_end_reason: '',
    last_error: '',
    // 输出规模
    text_chars: 0,
    reason_chars: 0,
    last_assistant_has_text: false,
    last_assistant_has_reason: false,
    // 最近一条 assistant/message 是否**只有文字、没有工具调用**。
    // 实测真实日志：335/377 条 assistant/message 同时含 tool-call 块，只有
    // 「纯文字」才代表"正在输出正文"（streaming）；带 tool-call 的是"要调工具"
    // （executing_tool），不能拿 has_text 当 streaming 的判据。
    last_message_text_only: false,
    // 事件溯源
    last_event: '',
    user_turns: 0,
    updated_at: 0,
  }
}

/** 把单个 DSH 事件折叠进 facts（纯函数：返回新对象）。 */
function foldEvent(prev, ev) {
  const f = { ...prev, updated_at: ev.time || Date.now() }
  const t = ev.type
  const d = ev.data || {}
  // 默认清零：只有“本事件本身是失败”才置 true，避免失败态粘住整轮
  f.last_event_failed = false

  switch (t) {
    case 'turn/start':
      f.in_turn = true
      f.turn = d.turn ?? f.turn
      f.step = null
      f.last_tool = ''
      f.tool_calls = 0
      f.active_tools = 0
      f.approvals_pending = 0
      f.awaiting_user = false
      f.voice_active = false
      f.retrying = false
      f.errored = false
      f.turn_end_reason = ''
      f.last_error = ''
      f.text_chars = 0
      f.reason_chars = 0
      f.last_assistant_has_text = false
      f.last_assistant_has_reason = false
      break

    case 'turn/end': {
      const kind = String((d.reason && d.reason.kind) || '')
      f.in_turn = false
      f.turn = null
      f.step = null
      f.last_tool = ''
      f.active_tools = 0
      f.approvals_pending = 0
      f.awaiting_user = false
      f.voice_active = false
      f.turn_end_reason = kind
      if (kind === 'error' || kind === 'max-tokens' || kind === 'interrupted') {
        f.errored = true
        f.last_event_failed = true
        const msg = d.reason && d.reason.failure && d.reason.failure.message
        if (msg) f.last_error = String(msg).slice(0, 200)
      }
      break
    }

    case 'step/start':
      f.step = d.step ?? f.step
      // 与 DSH 官方桌宠投影一致：新步骤清空“本步骤内的运行中工具”
      f.active_tools = 0
      // 新步骤 = 新一轮推理，上一轮的输出标记不再代表当下
      f.last_assistant_has_text = false
      f.last_assistant_has_reason = false
      break

    case 'step/end':
      // 步骤边界本身不改变工作性质；下一 step/start 或事件会接管
      break

    case 'assistant/message': {
      const content = (d.message && d.message.content) || []
      let hasText = false
      let hasReason = false
      let hasToolCall = false
      for (const c of content) {
        if (!c) continue
        if (c.type === 'text') {
          hasText = true
          f.text_chars += String(c.text || '').length
        } else if (c.type === 'reasoning') {
          hasReason = true
          f.reason_chars += String(c.text || '').length
        } else if (c.type === 'tool-call') {
          hasToolCall = true
        }
      }
      f.last_assistant_has_text = hasText
      f.last_assistant_has_reason = hasReason
      // 纯文字（有 text、无 tool-call）才代表"正在输出正文"
      f.last_message_text_only = hasText && !hasToolCall
      break
    }

    case 'assistant/attempt': {
      // 尝试流里可能直接以 error finish 结束（重试前的失败尝试）
      const stream = Array.isArray(d.stream) ? d.stream : []
      for (const item of stream) {
        const chunk = item && item.chunk
        if (!chunk) continue
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          f.errored = true
          f.last_event_failed = true
          const msg = chunk.reason.failure && chunk.reason.failure.message
          if (msg) f.last_error = String(msg).slice(0, 200)
        }
      }
      break
    }

    case 'tool/call': {
      const name = String(d.name || '')
      const callId = String(d.callId || '')
      f.tool_calls += 1
      f.last_tool = name
      f.active_tools += 1
      const lname = name.toLowerCase()
      if (ASK_TOOLS.has(lname)) {
        f.awaiting_user = true
        f._askCalls = (prev._askCalls || []).concat([callId])
      }
      if (VOICE_TOOLS.has(lname)) f.voice_active = true
      break
    }

    case 'tool/result': {
      const msg = d.message || {}
      const callId = String(msg.toolCallId || '')
      f.active_tools = Math.max(0, f.active_tools - 1)
      const failed = d.error !== undefined || msg.isError === true
      if (failed) {
        f.errored = true
        f.last_event_failed = true
        const name = d.error && d.error.name
        const text = (msg.content || []).map((c) => (c && c.text) || '').join(' ').trim()
        f.last_error = String(text || name || 'tool failed').slice(0, 200)
      }
      const asks = (prev._askCalls || []).filter((x) => x !== callId)
      f._askCalls = asks
      if (asks.length === 0) f.awaiting_user = false
      if (prev.voice_active) {
        // 只有当前工具是语音工具时才结束语音态（粗粒度但足够）
        f.voice_active = false
      }
      break
    }

    case 'approval/asked':
      f.approvals_pending += 1
      f.last_tool = String(d.toolName || f.last_tool)
      break

    case 'approval/decided':
      f.approvals_pending = Math.max(0, f.approvals_pending - 1)
      break

    case 'llm/retry':
    case 'llm/retry-started': {
      f.retrying = true
      const msg = d.failure && d.failure.message
      if (msg) f.last_error = String(msg).slice(0, 200)
      break
    }

    case 'user/message':
      f.user_turns += 1
      break

    case 'error':
      f.errored = true
      f.last_event_failed = true
      f.last_error = String((d && (d.message || d.error)) || t).slice(0, 200)
      break

    default:
      break
  }

  f.last_event = t
  return f
}

/** 事件序列 → facts。 */
function foldEvents(events) {
  let f = initialFacts()
  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string' || ev.type === 'session') continue
    f = foldEvent(f, ev)
  }
  return f
}

/** 对外暴露的 facts（去掉内部下划线字段）。 */
function publicFacts(f) {
  const out = {}
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith('_')) continue
    out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// 跟随器
// ---------------------------------------------------------------------------
class Follower {
  constructor() {
    this.reset()
  }

  reset() {
    this.logPath = ''
    this.sessionId = ''
    this.cwd = ''
    this.delegationDepth = 0
    this.offset = 0
    this.partial = Buffer.alloc(0) // 没收完的 JSONL 行（原始字节）
    this.pending = Buffer.alloc(0) // 没扫完的 zstd 字节（撕裂尾帧）
    this.facts = initialFacts()
    this.attached = false
    this.replayed = 0
  }

  /** 附着到候选日志：重放折叠出当前事实 → 发 ready + facts → 从 EOF 增量跟随。 */
  attach(cand) {
    let raw
    try {
      raw = fs.readFileSync(cand.logPath)
    } catch (e) {
      emit({ kind: 'error', message: `read failed: ${e.message}`, log: cand.logPath })
      return false
    }
    let decoded
    try {
      decoded = decodeWholeLog(raw)
    } catch (e) {
      emit({ kind: 'error', message: `decode failed: ${e.message}`, log: cand.logPath })
      return false
    }

    this.logPath = cand.logPath
    this.sessionId = cand.sessionId
    this.cwd = cand.cwd
    this.delegationDepth = cand.delegationDepth
    this.offset = raw.length
    this.pending = decoded.torn // 撕裂尾帧留给下一轮补齐
    this.partial = Buffer.alloc(0)
    this.facts = foldEvents(decoded.events)
    this.replayed = decoded.events.length
    this.attached = true

    emit({
      kind: 'ready',
      session: this.sessionId,
      log: this.logPath,
      cwd: this.cwd,
      delegation_depth: this.delegationDepth,
      agent_preset: cand.agentPreset || '',
      events_replayed: this.replayed,
    })
    emit({ kind: 'facts', session: this.sessionId, facts: publicFacts(this.facts), source: 'replay' })
    return true
  }

  /** 增量：读新增字节 → 解完整帧 → 逐行解析 → 逐事件发 event + facts。 */
  poll() {
    if (!this.attached) return
    let st
    try {
      st = fs.statSync(this.logPath)
    } catch (_) {
      this.attached = false
      emit({ kind: 'offline', reason: 'log disappeared', log: this.logPath })
      return
    }
    if (st.size < this.offset) {
      // 日志被截断或轮转：交回主循环重新附着
      this.attached = false
      return
    }
    if (st.size === this.offset) return

    const len = st.size - this.offset
    let chunk
    let fd
    try {
      fd = fs.openSync(this.logPath, 'r')
      chunk = Buffer.alloc(len)
      fs.readSync(fd, chunk, 0, len, this.offset)
    } catch (e) {
      emit({ kind: 'error', message: `tail read failed: ${e.message}` })
      return
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch (_) {}
      }
    }
    this.offset = st.size

    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    let frames = []
    let tornStart
    try {
      const scanned = scanZstdFrames(buf)
      frames = scanned.frames
      tornStart = scanned.tornStart
    } catch (e) {
      emit({ kind: 'error', message: `frame scan failed: ${e.message}` })
      this.pending = Buffer.alloc(0)
      return
    }

    let text = ''
    for (const f of frames) {
      try {
        text += decodeFrame(buf.subarray(f.start, f.end))
      } catch (e) {
        emit({ kind: 'error', message: `frame decode failed at ${f.start}: ${e.message}` })
      }
    }
    this.pending = tornStart === undefined ? Buffer.alloc(0) : Buffer.from(buf.subarray(tornStart))
    if (!text) return

    // 按 0x0a 切行：0x0a 不会出现在 UTF-8 多字节序列内部，字节级切分安全
    const merged = this.partial.length
      ? Buffer.concat([this.partial, Buffer.from(text, 'utf8')])
      : Buffer.from(text, 'utf8')
    const lastNl = merged.lastIndexOf(0x0a)
    if (lastNl === -1) {
      this.partial = merged
      return
    }
    this.partial = Buffer.from(merged.subarray(lastNl + 1))
    const body = merged.subarray(0, lastNl).toString('utf8')

    for (const ev of parseLines(body)) {
      if (!ev || typeof ev.type !== 'string' || ev.type === 'session') continue
      this.facts = foldEvent(this.facts, ev)
      emit({
        kind: 'event',
        session: this.sessionId,
        type: ev.type,
        seq: ev.seq,
        time: ev.time,
        data: ev.data,
        facts: publicFacts(this.facts),
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
const follower = new Follower()
let lastOfflineKey = ''
let pingAt = 0

/** 选目标会话（带迟滞）：避免频繁切换，但工作区/主会话更优时立即切换。 */
function pickTarget() {
  const cands = listCandidates()
  if (!cands.length) return null
  if (!follower.attached) return cands[0]
  const current = cands.find((c) => c.logPath === follower.logPath)
  if (!current) return cands[0] // 当前会话消失：立即改附
  const best = cands[0]
  if (best.logPath === current.logPath) return current
  // 迟滞：仅当排序更优的候选明显更新，或它才是本工作区主会话时才切换
  const betterScope = best.inWorkspace && !current.inWorkspace
  const betterDepth = best.delegationDepth < current.delegationDepth && best.inWorkspace
  const advantage = best.mtimeMs - current.mtimeMs
  if (betterScope || betterDepth || advantage > ARGS.takeoverMs) return best
  return current
}

function ensureAttached() {
  const target = pickTarget()
  if (!target) {
    if (lastOfflineKey !== 'no-session') {
      lastOfflineKey = 'no-session'
      emit({ kind: 'offline', reason: 'no DSH session log found', root: ARGS.sessionsRoot })
    }
    follower.attached = false
    return
  }
  if (follower.attached && follower.logPath === target.logPath) return
  const prev = follower.logPath
  if (follower.attach(target)) {
    lastOfflineKey = ''
    if (prev && prev !== target.logPath) {
      emit({ kind: 'switch', session: target.sessionId, log: target.logPath, from: prev })
    }
  }
}

function runOnce() {
  const target = pickTarget()
  if (!target) {
    emit({ kind: 'offline', reason: 'no active session', root: ARGS.sessionsRoot })
    return
  }
  let raw
  try {
    raw = fs.readFileSync(target.logPath)
  } catch (e) {
    emit({ kind: 'error', message: `read failed: ${e.message}` })
    return
  }
  const decoded = decodeWholeLog(raw)
  const facts = foldEvents(decoded.events)
  emit({
    kind: 'ready',
    session: target.sessionId,
    log: target.logPath,
    cwd: target.cwd,
    delegation_depth: target.delegationDepth,
    events_replayed: decoded.events.length,
  })
  emit({ kind: 'facts', session: target.sessionId, facts: publicFacts(facts), source: 'once' })
}

function main() {
  if (ARGS.once) {
    runOnce()
    return
  }
  ensureAttached()

  let tick = 0
  setInterval(() => {
    try {
      follower.poll()
      tick += 1
      if (tick % 8 === 0) ensureAttached() // 每 ~8 轮检查会话切换
      const now = Date.now()
      if (now - pingAt >= PING_MS) {
        pingAt = now
        emit({ kind: 'ping', ts: now, attached: follower.attached, session: follower.sessionId })
      }
    } catch (e) {
      emit({ kind: 'error', message: String((e && e.message) || e) })
    }
  }, ARGS.pollMs)

  const bye = () => {
    try { process.exit(0) } catch (_) {}
  }
  process.on('SIGTERM', bye)
  process.on('SIGINT', bye)
  // 注意：**不要**监听 stdin 'end' 作为退出信号。父进程用 DEVNULL 起我们时
  // stdin 会立即 EOF，那样边车会刚启动就自杀。生命周期由父进程 terminate 掌控。
  process.stdin.on('error', () => {})
  process.stdout.on('error', () => {})
}

try {
  main()
} catch (e) {
  emit({ kind: 'error', message: `fatal: ${(e && e.message) || e}` })
  process.exitCode = 1
}
