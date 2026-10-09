<script setup>
import AgentTasksPage from './AgentTasksPage.vue'
import ImagePreview from './ImagePreview.vue'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Wrench,
  ListChecks,
  MessageSquareText,
  Paperclip,
  Pin,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Square,
  SquarePen,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  Wifi,
  X,
} from '@lucide/vue'

const context = inject('mio-chat-page')
if (!context) throw new Error('对话页上下文未初始化')
const conversationDrawerOpen = ref(false)
const conversationDrawerPinned = ref(localStorage.getItem('mio_conversation_drawer_pinned') === 'true')
const qqCleanupMode = ref(false)
const selectedQqMessageIds = ref([])
const activeImageAttachment = ref(null)
const agentProcessExpanded = ref(localStorage.getItem('mio_agent_process_expanded') !== 'false')
const activeConversation = computed(() => context.conversations.find((item) => item.id === context.selectedConversationId) || null)
// 阉割 QQ 共享对话：对话列表不再显示 qq 类型会话
const visibleConversations = computed(() => (context.conversations || []).filter((item) => item.kind !== 'qq'))

// ============ 跟随对话开关（替换原“当前会话标题”按钮） ============
const followChat = ref(localStorage.getItem('mio_chat_follow') !== 'false')
function xzScrollToBottom() {
  const el = context.chatScroll
  if (el) el.scrollTop = el.scrollHeight
}
function toggleFollowChat() {
  followChat.value = !followChat.value
  localStorage.setItem('mio_chat_follow', String(followChat.value))
  if (followChat.value) nextTick(() => xzScrollToBottom())
}

async function openConversation(conversationId) {
  if (conversationId !== context.selectedConversationId) cancelQqCleanup()
  await context.selectConversation(conversationId)
  if (!conversationDrawerPinned.value) conversationDrawerOpen.value = false
}

async function beginQqCleanup(conversation) {
  if (context.sending) return
  await openConversation(conversation.id)
  selectedQqMessageIds.value = []
  qqCleanupMode.value = true
}

function cancelQqCleanup() {
  qqCleanupMode.value = false
  selectedQqMessageIds.value = []
}

function toggleQqMessage(messageId) {
  const id = Number(messageId)
  if (!Number.isInteger(id) || id <= 0) return
  selectedQqMessageIds.value = selectedQqMessageIds.value.includes(id)
    ? selectedQqMessageIds.value.filter((item) => item !== id)
    : [...selectedQqMessageIds.value, id]
}

async function deleteSelectedQqMessages() {
  if (!activeConversation.value || !selectedQqMessageIds.value.length) return
  const deleted = await context.deleteConversationMessages(activeConversation.value, selectedQqMessageIds.value)
  if (deleted) cancelQqCleanup()
}

function toggleConversationDrawerPin() {
  conversationDrawerPinned.value = !conversationDrawerPinned.value
  localStorage.setItem('mio_conversation_drawer_pinned', String(conversationDrawerPinned.value))
}

function openImagePreview(attachment) {
  if (!attachment?.url) return
  activeImageAttachment.value = attachment
}

function closeImagePreview() {
  activeImageAttachment.value = null
}

// ================= 小智对话（注入：文字对答 + 桌宠说话/气泡） =================
const xzBridge = window.mioDesktop || {}
const xzConnected = ref(false)
const xzTurns = ref([])
const xzInput = ref('')
const xzThinking = ref(false)
let xzSessionId = ''
let xzWs = null
let xzReconnectTimer = null
let xzRetryDelay = 3000

// 开启跟随且消息/思考状态变化时，自动滚动到底部（flush post：确保 DOM 渲染后再滚）
watch([xzTurns, xzThinking], () => {
  if (followChat.value) nextTick(() => xzScrollToBottom())
}, { flush: 'post' })

// ============ 小智状态全屏（替代原右侧小智状态栏） ============
const xzStatusPanelOpen = ref(false)
const xzStatusData = ref({ connected: false, session_id: '', vision: false, vision_url: '', observe_enabled: false, observe_next: 0 })
let xzStatusTimer = null
async function loadXzStatus() {
  try {
    const [s, v, o] = await Promise.all([
      fetch('/api/xiaozhi/status').then((r) => r.json()),
      fetch('/api/xiaozhi/vision-info').then((r) => r.json()),
      fetch('/api/xiaozhi/observe/status').then((r) => r.json()),
    ])
    xzStatusData.value = {
      connected: Boolean(s?.connected),
      session_id: s?.session_id || '',
      vision: Boolean(v?.vision),
      vision_url: v?.url || v?.vision_url || '',
      observe_enabled: Boolean(o?.enabled),
      observe_next: Number(o?.next_in_seconds || 0),
    }
  } catch (e) { /* 静默 */ }
}
function toggleXzStatusPanel() {
  xzStatusPanelOpen.value = !xzStatusPanelOpen.value
  if (xzStatusPanelOpen.value) loadXzStatus()
}
function closeXzStatusPanel() { xzStatusPanelOpen.value = false }

// 音频播放（48kHz 双声道 float32 planar，后端代理解码）
let xzAudioCtx = null
let xzQueue = []
let xzPlaying = false
let xzNextStart = 0
let xzSources = new Set()

function xzEnsureAudio() {
  if (!xzAudioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (AC) { try { xzAudioCtx = new AC() } catch (e) { xzAudioCtx = null } }
  }
  if (xzAudioCtx && xzAudioCtx.state === 'suspended') { try { xzAudioCtx.resume() } catch (e) {} }
  return xzAudioCtx
}
function xzPump() {
  if (!xzAudioCtx || xzPlaying || xzQueue.length === 0) return
  xzPlaying = true
  while (xzQueue.length > 0) {
    const buf = xzQueue.shift()
    const src = xzAudioCtx.createBufferSource()
    src.buffer = buf
    src.connect(xzAudioCtx.destination)
    const now = xzAudioCtx.currentTime
    if (xzNextStart < now + 0.03) xzNextStart = now + 0.03
    src.start(xzNextStart)
    xzNextStart += buf.duration
    src.onended = function () { xzSources.delete(src); try { src.disconnect() } catch (e) {} }
    xzSources.add(src)
  }
  xzPlaying = false
}
function xzStopPlayback() {
  for (const s of xzSources) { try { s.onended = null; s.stop() } catch (e) {} }
  xzSources.clear()
  xzQueue = []; xzPlaying = false; xzNextStart = 0
}
function xzHandlePcm(data) {
  const ctx = xzEnsureAudio()
  if (!ctx || data.byteLength < 8) return
  const view = new DataView(data, 0, data.byteLength)
  const samples = view.getUint32(0, true)
  const channels = view.getUint32(4, true)
  if (samples < 1 || channels < 1 || channels > 8) return
  const frameBytes = samples * 4
  if (8 + frameBytes * channels > data.byteLength) return
  const buffer = ctx.createBuffer(channels, samples, 48000)
  for (let c = 0; c < channels; c++) {
    const off = 8 + c * frameBytes
    buffer.copyToChannel(new Float32Array(data, off, samples), c)
  }
  xzQueue.push(buffer)
  xzPump()
}
function xzBubble(payload) { if (xzBridge.sendXiaozhiBubble) xzBridge.sendXiaozhiBubble(payload) }
function xzPetEvent(ev) { if (xzBridge.sendPetEvent) xzBridge.sendPetEvent(ev) }

function xzHandleText(raw) {
  let j
  try { j = JSON.parse(raw) } catch (e) { return }
  switch (j.type) {
    case 'hello':
      xzConnected.value = true
      xzSessionId = j.session_id || ''
      xzRetryDelay = 3000
      xzBubble({ type: 'stop' })
      break
    case 'llm':
      xzThinking.value = true
      if (j.emotion) xzPetEvent({ type: 'emotion', emotion: j.emotion })
      break
    case 'tts':
      if (j.state === 'start') {
        xzStopPlayback()
        xzPetEvent({ type: 'speaking', speaking: true })
      } else if (j.state === 'sentence_start' && j.text) {
        xzTurns.value.push({ role: 'assistant', text: j.text })
        xzThinking.value = false
        xzBubble({ type: 'text', text: j.text })
        xzPetEvent({ type: 'speaking', speaking: true })
        // 小智输出新句子时强制跟随到底部（进度跟随）
        if (followChat.value) nextTick(() => xzScrollToBottom())
      } else if (j.state === 'stop') {
        xzBubble({ type: 'stop' }); xzBubble({ type: 'speak_stop' })
        xzPetEvent({ type: 'speaking', speaking: false })
        xzThinking.value = false
      }
      break
    case 'error':
      // 断连/重连信息只更新状态，不写入对话气泡
      xzConnected.value = false
      xzThinking.value = false
      break
  }
}

function xzConnect() {
  let wsTry
  try { wsTry = new WebSocket('ws://' + location.host + '/api/xiaozhi/ws') } catch (e) { xzScheduleReconnect(); return }
  xzWs = wsTry
  xzWs.binaryType = 'arraybuffer'
  xzWs.onopen = function () {}
  xzWs.onclose = function () { xzConnected.value = false; xzScheduleReconnect() }
  xzWs.onerror = function () {}
  xzWs.onmessage = function (ev) {
    if (typeof ev.data === 'string') xzHandleText(ev.data)
    else xzHandlePcm(ev.data)
  }
}
function xzScheduleReconnect() {
  window.clearTimeout(xzReconnectTimer)
  xzReconnectTimer = window.setTimeout(xzConnect, xzRetryDelay)
  xzRetryDelay = Math.min(15000, Math.round(xzRetryDelay * 1.6))
}
function xzSend() {
  const text = xzInput.value.trim()
  if (!text) return
  if (!xzWs || xzWs.readyState !== 1) { xzTurns.value.push({ role: 'assistant', text: '⚠ 连接中，请稍后再试' }); return }
  xzEnsureAudio()
  xzStopPlayback()
  xzInput.value = ''
  xzTurns.value.push({ role: 'user', text })
  xzThinking.value = true
  // 发送后立即跟随到底部
  if (followChat.value) nextTick(() => xzScrollToBottom())
  xzWs.send(JSON.stringify({ session_id: xzSessionId, type: 'abort', reason: 'user_interrupt' }))
  xzBubble({ type: 'thinking', text: '' })
  xzWs.send(JSON.stringify({ session_id: xzSessionId, type: 'listen', state: 'detect', text, source: 'text' }))
}
// ============ 全屏对话（替代原“小智已连接”状态栏） ============
const isFullscreen = ref(Boolean(document.fullscreenElement))
function toggleFullscreen() {
  const el = document.documentElement
  if (document.fullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen()
  } else if (el.requestFullscreen) {
    el.requestFullscreen().catch(() => {})
  }
}
function onFsChange() { isFullscreen.value = Boolean(document.fullscreenElement) }
function xzKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { xzSend(); e.preventDefault() }
}
onMounted(() => {
  xzConnect()
  document.addEventListener('fullscreenchange', onFsChange)
  loadXzStatus()
  xzStatusTimer = window.setInterval(loadXzStatus, 30000)
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFsChange)
  window.clearTimeout(xzReconnectTimer)
  window.clearInterval(xzStatusTimer)
  if (xzWs) try { xzWs.close() } catch (e) {}; xzStopPlayback()
})
</script>

<template>
  <div :class="['chat-layout', 'integrated-chat-layout', `chat-display-${context.displayMode}`, { 'conversation-drawer-pinned': conversationDrawerPinned, 'has-custom-background': Boolean(context.chatBackgroundStyle?.['--chat-background-image']) }]" :style="context.chatBackgroundStyle || {}">
    <button
      v-if="conversationDrawerOpen && !conversationDrawerPinned"
      class="conversation-drawer-backdrop"
      type="button"
      aria-label="关闭对话窗口"
      @click="conversationDrawerOpen = false"
    />
    <aside v-if="conversationDrawerOpen || conversationDrawerPinned" class="conversation-drawer">
      <header>
        <div><MessageSquareText :size="17" /><strong>{{ context.isAgentWorkspace ? 'Agent 对话' : '对话窗口' }}</strong><span>{{ context.conversations.length }}</span></div>
        <button type="button" :class="{ active: conversationDrawerPinned }" :title="conversationDrawerPinned ? '取消固定' : '固定抽屉'" @click="toggleConversationDrawerPin"><Pin :size="14" /></button>
      </header>
      <button class="conversation-new-button" type="button" @click="context.createNewConversation"><Plus :size="15" />新对话</button>
      <div class="conversation-drawer-list">
        <article v-for="conversation in visibleConversations" :key="conversation.id" :class="{ active: context.selectedConversationId === conversation.id }">
          <button type="button" @click="openConversation(conversation.id)">
            <span><strong>{{ conversation.title }}</strong><small>{{ conversation.preview || (conversation.kind === 'qq' ? '与 QQ 共享上下文' : conversation.kind === 'pet' ? '桌宠独立对话' : '还没有消息') }}</small></span>
            <time>{{ context.formatSidebarTime(conversation.updated_at) }}</time>
          </button>
          <div v-if="['desktop', 'agent', 'qq'].includes(conversation.kind)" class="conversation-drawer-actions">
            <template v-if="conversation.kind === 'desktop' || conversation.kind === 'agent'">
              <button type="button" title="重命名" @click="context.renameConversation(conversation)"><SquarePen :size="13" /></button>
              <button type="button" title="删除" @click="context.deleteConversation(conversation)"><Trash2 :size="13" /></button>
            </template>
            <button v-else type="button" title="选择要清理的 QQ 消息" :disabled="context.sending" @click="beginQqCleanup(conversation)"><ListChecks :size="13" /></button>
          </div>
        </article>
      </div>
    </aside>

    <section
      :class="['chat-column', { 'file-drag-active': context.isFileDragging }]"
      @dragenter="context.handleFileDragEnter"
      @dragover="context.handleFileDragOver"
      @dragleave="context.handleFileDragLeave"
      @drop="context.handleFileDrop"
    >
      <button class="conversation-drawer-trigger follow-chat-toggle" type="button" :class="{ 'follow-off': !followChat }" :title="followChat ? '当前跟随对话：新消息自动滚到底部（点击关闭）' : '已暂停跟随对话：不再自动滚动（点击开启）'" @click="toggleFollowChat">
        <ArrowDownToLine :size="16" /><span>跟随对话</span><i :class="{ online: followChat }" />
      </button>
      <div v-if="!context.isAgentWorkspace && context.latestTaskHandoff?.task_id" class="chat-handoff-notice" role="status">
        <span><ListChecks :size="15" /><strong>已交给 Agent 继续处理</strong><small>详细执行过程在 Agent 页面查看</small></span>
        <button type="button" @click="context.openAgentHandoff">查看任务</button>
      </div>
      <div v-if="context.isFileDragging" class="file-drop-overlay"><Upload :size="25" /><strong>松开即可添加到对话</strong><span>图片、PDF、Word 和其他文件都可以</span></div>

      <div :ref="(element) => { context.chatScroll = element }" class="message-scroll">
        <div v-if="!xzTurns.length" class="empty-chat"><h2>我在这里</h2><p>现在想说什么？</p></div>
        <div v-else class="message-list">
          <article v-for="(turn, index) in xzTurns" :key="`xz-${index}`" :class="['message-row', turn.role]">
            <img v-if="turn.role === 'assistant'" class="message-avatar assistant-avatar" :src="context.avatarUrl" :alt="context.mioDisplayName" />
            <div class="message-body">
              <div class="message-heading"><strong>{{ turn.role === 'assistant' ? context.mioDisplayName : '你' }}</strong></div>
              <div class="message-part"><div class="message-bubble">{{ turn.text }}</div></div>
            </div>
            <span v-if="turn.role === 'user'" class="message-avatar user-avatar" aria-label="你"><UserRound :size="18" /></span>
          </article>
          <article v-if="xzThinking" class="message-row assistant pending-message"><img class="message-avatar assistant-avatar" :src="context.avatarUrl" :alt="context.mioDisplayName" /><div class="message-body"><div class="message-heading"><strong>{{ context.mioDisplayName }}</strong><span>正在思考</span></div><div class="thinking-indicator"><i /><i /><i /></div></div></article>
        </div>
      </div>

      <div v-if="qqCleanupMode" class="qq-message-cleanup-bar">
        <span>{{ selectedQqMessageIds.length ? `已选择 ${selectedQqMessageIds.length} 句` : '选择要清理的消息' }}</span>
        <button type="button" @click="cancelQqCleanup">取消</button>
        <button type="button" class="danger" :disabled="!selectedQqMessageIds.length" @click="deleteSelectedQqMessages"><Trash2 :size="14" />清理</button>
      </div>
      <div v-else class="composer-wrap">
        <div class="composer">
          <textarea v-model="xzInput" class="composer-input" rows="1" placeholder="和小智聊点什么..." @keydown="xzKeydown" />
          <div class="composer-actions">
            <button type="button" class="composer-icon-button" title="小智状态" @click="toggleXzStatusPanel"><Wifi :size="16" /></button>
            <span class="composer-flex-spacer" />
            <button type="button" class="send-button" :disabled="!xzInput.trim()" @click="xzSend"><Send :size="17" /></button>
          </div>
        </div>
      </div>
    </section>
  </div>

  <ImagePreview v-if="activeImageAttachment" :key="activeImageAttachment.url" :attachment="activeImageAttachment" @close="closeImagePreview" />

  <Teleport to="body">
    <div v-if="xzStatusPanelOpen" class="xz-status-fullscreen" @click.self="closeXzStatusPanel">
      <section class="xz-status-card" role="dialog" aria-modal="true" aria-label="小智状态">
        <header>
          <div><Wifi :size="18" /><span><strong>小智状态</strong><small>对话、视觉与屏幕观察</small></span></div>
          <button type="button" class="icon-button" title="关闭" @click="closeXzStatusPanel"><X :size="18" /></button>
        </header>
        <div class="xz-status-grid">
          <article><span>对话连接</span><strong :class="xzStatusData.connected ? 'xz-ok-text' : 'xz-bad-text'">{{ xzStatusData.connected ? '已连接' : '断开' }}</strong></article>
          <article><span>会话 ID</span><strong class="xz-session-text">{{ xzStatusData.session_id || '-' }}</strong></article>
          <article><span>视觉能力</span><strong :class="xzStatusData.vision ? 'xz-ok-text' : 'xz-bad-text'">{{ xzStatusData.vision ? '已捕获' : '未捕获' }}</strong></article>
          <article><span>自动观察</span><strong :class="xzStatusData.observe_enabled ? 'xz-ok-text' : ''">{{ xzStatusData.observe_enabled ? '开启' : '关闭' }}</strong></article>
          <article v-if="xzStatusData.observe_enabled"><span>下次观察</span><strong>{{ xzStatusData.observe_next > 0 ? xzStatusData.observe_next + ' 秒后' : '等待中' }}</strong></article>
          <article class="xz-status-url"><span>视觉端点</span><strong class="xz-url-text" :title="xzStatusData.vision_url">{{ xzStatusData.vision_url || '未配置' }}</strong></article>
        </div>
        <footer>
          <button type="button" class="primary-button" @click="loadXzStatus"><RefreshCw :size="15" />刷新状态</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
