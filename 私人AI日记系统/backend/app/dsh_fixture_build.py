"""从真实 DSH 会话日志中抽取事件样本，生成映射回放测试夹具。

产出：``dsh_events_fixture.json``
  {
    "source_sessions": [...],
    "event_type_counts": {...},
    "sequences": [ {"name": "...", "events": [ {type, data}, ... ]}, ... ]
  }

每条 sequence 都是从真实日志里**原样摘取并脱敏**的事件链，用于回放验证
facts 折叠 + phase 映射在真实数据上正确（而不是只在手造数据上正确）。

覆盖策略（重要）
---------------
先取事件最丰富的两个会话切片段（代表性最好），再做一轮**覆盖补齐**：折叠逻辑
有分支、但上面片段里没出现的事件类型，从其它会话各补一个窗口。否则像
``turn/end``、``approval/asked`` 这类只存在于别处的分支永远不会被回放测试覆盖
（此前夹具就漏了 5 个分支，等于这些分支从未被真实数据验证过）。

用法（backend 目录下）::

    .venv\\Scripts\\python.exe -m app.dsh_fixture_build
"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from .agents.dsh import dsh_adapter as dsh

OUT = Path(__file__).with_name("dsh_events_fixture.json")

# 折叠逻辑（dsh_log_stream.mjs::foldEvent）有 case 分支的事件类型。
# 夹具必须尽量覆盖它们，否则对应 branch 没有真实样本。
BRANCH_TYPES: tuple[str, ...] = (
    "turn/start", "turn/end", "step/start", "step/end",
    "assistant/message", "assistant/attempt",
    "tool/call", "tool/result",
    "approval/asked", "approval/decided",
    "llm/retry", "llm/retry-started",
    "user/message", "todo/write", "goal/change",
)

# 内联的 Node 解码脚本：复用边车的帧扫描 + zstd 解码，输出全部事件为 JSONL。
# 注意：用 `node -e <script> <arg>` 时，脚本参数从 process.argv[1] 开始
# （不像 `node script.mjs <arg>` 那样从 argv[2] 起）。
DECODE_JS = r"""
const fs=require('fs'),path=require('path'),zlib=require('node:zlib');
const root=process.argv[1];
const M=4247762216;
function scan(b){const fr=[];let o=0;while(o<b.length){const s=o;
 if(b.length-o<4)return{fr};
 if(b.readUInt32LE(o)!==M)return{fr};
 o+=4;if(o===b.length)return{fr};
 const d=b.readUInt8(o);o+=1;if((d&24)!==0)return{fr};
 const csf=d>>>6,sg=(d&32)!==0,ck=(d&4)!==0,df=d&3;const db=df===3?4:df;
 const cb=csf===0?(sg?1:0):(1<<csf);o+=(sg?0:1)+db+cb;
 for(;;){if(b.length-o<3)return{fr};const bh=b.readUIntLE(o,3);o+=3;
  const last=(bh&1)===1,bt=(bh>>>1)&3,bs=bh>>>3;if(bt===3)return{fr};
  const pl=bt===1?1:bs;if(b.length-o<pl)return{fr};o+=pl;if(last)break;}
 if(ck){if(b.length-o<4)return{fr};o+=4;}
 fr.push({s,e:o});}
 return{fr};}
for(const slug of fs.readdirSync(root,{withFileTypes:true})){
 if(!slug.isDirectory())continue;
 const sd0=path.join(root,slug.name);
 let subs;try{subs=fs.readdirSync(sd0,{withFileTypes:true})}catch{continue}
 for(const sd of subs){ if(!sd.isDirectory())continue;
  const dir=path.join(sd0,sd.name);let files;try{files=fs.readdirSync(dir)}catch{continue}
  const lg=files.filter(f=>/^session\.v\d+\.jsonl(\.zstd)?$/.test(f));
  if(!lg.length)continue;
  lg.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  const p=path.join(dir,lg[0]);
  let raw;try{raw=fs.readFileSync(p)}catch{continue}
  let text='';const{fr}=scan(raw);
  for(const f of fr){try{text+=zlib.zstdDecompressSync(raw.subarray(f.s,f.e),{chunkSize:1048576}).toString('utf8')}catch{}}
  for(const line of text.split('\n')){
   if(!line.trim())continue;
   let e;try{e=JSON.parse(line)}catch{continue}
   if(!e||!e.type)continue;
   process.stdout.write(JSON.stringify({session:sd.name,type:e.type,seq:e.seq,time:e.time,data:e.data})+'\n');
  }
 }
}
"""


def decode_all(node: str) -> list[dict[str, Any]]:
    """用 Node 内联脚本解码所有会话日志，返回事件列表。

    脚本通过 ``-e`` 内联传入、**不落 .mjs 文件**：仓库路径含中文，
    node 按文件路径加载时会因 URL 编码解析失败。
    """
    try:
        proc = subprocess.run(
            [node, "-e", DECODE_JS, str(dsh.default_sessions_root())],
            capture_output=True, text=True, encoding="utf-8", timeout=300,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"解码进程启动失败：{exc}")
        return []
    if proc.returncode != 0:
        print(f"解码失败 rc={proc.returncode}: {(proc.stderr or '')[:400]}")
        return []
    out: list[dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:  # noqa: BLE001
            continue
    return out


def sanitize(event_type: str, data: Any) -> dict[str, Any]:
    """把真实事件裁成**只保留结构与语义、去掉私密正文**的夹具条目。

    真实 DSH 事件含用户对话正文、助手推理文本、工具参数与输出（可能含私密内容）。
    回放测试只需要"类型 + 判定用的布尔/枚举/小标识"，故整表重写而不是原样留：
      - 文本类字段只留**长度**（``text`` → ``len``），不留内容；
      - 工具名保留（映射要用），工具**参数不留**；
      - ``tool/result`` 只留 ``isError`` 布尔与 ``data.error`` 是否存在；
      - 错误信息只留是否非空。
    """
    if not isinstance(data, dict):
        return {"_sanitized": True}

    out: dict[str, Any] = {"_sanitized": True}
    t = event_type

    if t == "turn/start":
        out["turn"] = data.get("turn")

    elif t == "turn/end":
        reason = data.get("reason") if isinstance(data.get("reason"), dict) else {}
        out["reason"] = {"kind": (reason or {}).get("kind")}
        failure = (reason or {}).get("failure")
        if isinstance(failure, dict):
            out["reason"]["has_failure"] = bool(failure.get("message") or failure.get("code"))

    elif t == "step/start":
        out["turn"] = data.get("turn")
        out["step"] = data.get("step")

    elif t == "assistant/message":
        content = (data.get("message") or {}).get("content") or []
        blocks = []
        for c in content:
            if not isinstance(c, dict):
                continue
            kind = str(c.get("type") or "")
            if kind == "text":
                blocks.append({"type": "text", "len": len(str(c.get("text") or ""))})
            elif kind == "reasoning":
                blocks.append({"type": "reasoning", "len": len(str(c.get("text") or ""))})
            elif kind == "tool-call":
                blocks.append({"type": "tool-call", "name": str(c.get("name") or "")})
            else:
                blocks.append({"type": kind})
        out["message"] = {"content": blocks}

    elif t == "assistant/attempt":
        stream = data.get("stream") if isinstance(data.get("stream"), list) else []
        finishes = []
        for item in stream:
            chunk = item.get("chunk") if isinstance(item, dict) else None
            if isinstance(chunk, dict) and chunk.get("type") == "finish":
                reason = chunk.get("reason") if isinstance(chunk.get("reason"), dict) else {}
                finishes.append({"kind": (reason or {}).get("kind")})
        out["stream_finishes"] = finishes

    elif t == "tool/call":
        out["name"] = str(data.get("name") or "")
        out["turn"] = data.get("turn")
        out["step"] = data.get("step")

    elif t == "tool/result":
        msg = data.get("message") if isinstance(data.get("message"), dict) else {}
        out["message"] = {"isError": bool(msg.get("isError"))}
        # data.error 是否存在是「失败识别口径」测试的关键，保留其有无而非内容
        out["has_error"] = data.get("error") is not None
        out["turn"] = data.get("turn")
        out["step"] = data.get("step")

    elif t == "approval/asked":
        out["toolName"] = str(data.get("toolName") or "")
        out["has_id"] = bool(data.get("id"))

    elif t == "approval/decided":
        out["outcome"] = str(data.get("outcome") or "")

    elif t in {"llm/retry", "llm/retry-started"}:
        out["retry"] = data.get("retry")
        out["turn"] = data.get("turn")
        out["step"] = data.get("step")
        out["has_failure"] = isinstance(data.get("failure"), dict)

    elif t == "user/message":
        src = data.get("source") if isinstance(data.get("source"), dict) else {}
        out["source_kind"] = str((src or {}).get("kind") or "")
        content = data.get("content") if isinstance(data.get("content"), list) else []
        out["content_blocks"] = len(content)

    elif t == "todo/write":
        todos = data.get("todos") if isinstance(data.get("todos"), list) else []
        out["todos"] = len(todos)

    elif t == "goal/change":
        out["operation"] = str(data.get("operation") or "")

    else:
        # 其它类型：只留键名，不留值（结构可见、内容不留）
        out["_keys"] = sorted(str(k) for k in data.keys())[:20]

    return out


def sanitize_event(event: dict[str, Any]) -> dict[str, Any]:
    """把一个真实事件裁成 ``{"type": ..., "data": {...脱敏...}}``。

    必须保留外层 ``type``——回放时靠它分派折叠逻辑。
    """
    return {
        "type": str(event.get("type") or ""),
        "data": sanitize(event.get("type") or "", event.get("data")),
    }


def _window(events: list[dict[str, Any]], center_type: str, before: int,
            after: int, name: str) -> dict[str, Any] | None:
    """以某个事件类型为中心的邻域片段。"""
    for i, ev in enumerate(events):
        if ev.get("type") != center_type:
            continue
        lo = max(0, i - before)
        hi = min(len(events), i + after + 1)
        seg = events[lo:hi]
        if not seg:
            return None
        return {"name": name, "events": [sanitize_event(e) for e in seg]}
    return None


def build_sequences(
    by_session: dict[str, list[dict[str, Any]]],
    types: Counter[str],
) -> list[dict[str, Any]]:
    """从真实事件里切出有代表性的片段，并保证折叠分支尽量有覆盖。"""
    seqs: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(seq: dict[str, Any] | None) -> None:
        if seq and seq["name"] not in seen:
            seen.add(seq["name"])
            seqs.append(seq)

    # 1) 事件最丰富的两个会话：切完整轮次 + 关键邻域
    richest = sorted(by_session.items(), key=lambda kv: len(kv[1]), reverse=True)[:2]
    richest_ids = [sid for sid, _ in richest]
    for _session, raw_events in richest:
        events = sorted(raw_events, key=lambda e: e.get("seq") if isinstance(e.get("seq"), int) else 0)

        # 完整轮次（turn/start ... turn/end）
        current: list[dict[str, Any]] = []
        turn_no = 0
        for ev in events:
            if ev.get("type") == "turn/start":
                current = []
                turn_no += 1
            current.append(ev)
            if ev.get("type") == "turn/end" and current:
                add({
                    "name": f"turn{turn_no}（真实完整轮次）",
                    "events": [sanitize_event(e) for e in current],
                })
                current = []

        add(_window(events, "approval/asked", 2, 3, "审批等待→放行（真实 approval 对）"))
        add(_window(events, "llm/retry", 2, 3, "LLM 重试（真实 llm/retry 片段）"))
        add(_window(events, "tool/result", 0, 1, "工具失败→错误态（真实失败片段）"))
        add(_window(events, "tool/call", 1, 2, "工具调用（真实 tool/call 片段）"))
        add(_window(events, "todo/write", 2, 3, "规划：真实 todo/write 片段"))
        add(_window(events, "goal/change", 2, 3, "规划：真实 goal/change 片段"))
        add(_window(events, "assistant/attempt", 1, 2, "失败尝试结算（真实 assistant/attempt 片段）"))
        add(_window(events, "user/message", 1, 2, "用户输入（真实 user/message 片段）"))
        add(_window(events, "turn/end", 3, 0, "回合结束（真实 turn/end 片段）"))

    # 2) 覆盖补齐：仍有分支没样本的，从其它会话各补一个窗口
    have = {e.get("type") for s in seqs for e in s.get("events") or []}
    missing = [t for t in BRANCH_TYPES if types.get(t, 0) > 0 and t not in have]
    for want in missing:
        for sid, raw_events in by_session.items():
            if sid in richest_ids:
                continue
            events = sorted(raw_events, key=lambda e: e.get("seq") if isinstance(e.get("seq"), int) else 0)
            seq = _window(events, want, 3, 3, f"覆盖补齐：真实 {want} 片段")
            if seq:
                add(seq)
                have |= {e.get("type") for e in seq["events"]}
                break

    # 3) 截断，保持夹具精简
    for s in seqs:
        s["events"] = s["events"][:60]
    return seqs


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

    node = dsh.resolve_node({})
    if not node:
        print("未找到 node，无法抽取夹具")
        return 1

    all_events = decode_all(node)
    if not all_events:
        print("未解码到任何事件")
        return 1

    by_session: dict[str, list[dict[str, Any]]] = {}
    for ev in all_events:
        by_session.setdefault(ev.get("session") or "?", []).append(ev)

    types: Counter[str] = Counter(ev.get("type") or "?" for ev in all_events)
    print(f"解码事件总数：{len(all_events)}，涉及会话 {len(by_session)} 个")
    print("事件类型分布（前 25）：")
    for t, n in types.most_common(25):
        print(f"  {t:38s} {n:5d}")

    sequences = build_sequences(by_session, types)
    richest = sorted(by_session.items(), key=lambda kv: len(kv[1]), reverse=True)[:2]

    fixture = {
        "source_sessions": [s for s, _ in richest],
        "event_type_counts": dict(types.most_common()),
        "sequences": sequences,
    }
    OUT.write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n已写出夹具：{OUT}")
    print(f"  sequences: {len(sequences)}")
    for s in sequences:
        print(f"    - {s['name']}: {len(s['events'])} events")

    # 覆盖自检：折叠逻辑有分支的事件类型，若在真实数据里出现过却没进夹具，
    # 说明该分支从未被真实数据回放验证过——直接报出来。
    covered = {e.get("type") for s in sequences for e in s.get("events") or []}
    available = {t for t in BRANCH_TYPES if types.get(t, 0) > 0}
    present_but_missing = sorted(available - covered)
    if present_but_missing:
        print(f"\n  [WARN] 以下折叠分支在真实数据里出现过但未进夹具：{present_but_missing}")
        print("         这些分支不会被回放测试覆盖，请检查 build_sequences 的覆盖补齐。")
    else:
        print(f"\n  [OK] 折叠逻辑的每个可用分支都有真实样本进入夹具"
              f"（覆盖 {len(covered & available)}/{len(available)} 个类型）")

    absent = sorted(set(BRANCH_TYPES) - available)
    if absent:
        print(f"  （真实数据里本就没有、故无法覆盖的类型：{absent}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
