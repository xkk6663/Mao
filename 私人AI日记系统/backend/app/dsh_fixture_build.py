"""从真实 DSH 会话日志中抽取事件样本，生成映射回放测试夹具。

产出：``dsh_events_fixture.json``
  {
    "source_sessions": [...],
    "event_types": {...计数...},
    "sequences": [ {"name": "...", "events": [ {type,data}, ... ]}, ... ]
  }

每条 sequence 都是从真实日志里**原样摘取**的事件链，用于回放验证
facts 折叠 + phase 映射在真实数据上正确（而不是只在手造数据上正确）。

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

from . import dsh_adapter as dsh

OUT = Path(__file__).with_name("dsh_events_fixture.json")

# 内联的 Node 解码脚本：复用边车的帧扫描 + zstd 解码，输出全部事件为 JSONL
DECODE_JS = r"""
const fs=require('fs'),path=require('path'),zlib=require('node:zlib');
const root=process.argv[2];
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
    tmp = Path(__file__).with_name("_dsh_decode_events.js")
    tmp.write_text(DECODE_JS, encoding="utf-8")
    try:
        proc = subprocess.run(
            [node, str(tmp), str(dsh.default_sessions_root())],
            capture_output=True, text=True, encoding="utf-8", timeout=180,
        )
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    if proc.returncode != 0:
        print(f"解码失败 rc={proc.returncode}: {proc.stderr[:400]}")
        return []
    out = []
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

    真实 DSH 事件里含用户对话正文、助手推理文本、工具参数与输出（可能含私密内容）。
    回放测试只需要"类型 + 判定用的布尔/枚举/小标识"，故整表重写而不是原样留：
      - 文本类字段只留**长度**（`text` → `text_len`），不留内容；
      - 工具名保留（映射要用），工具**参数不留**；
      - `tool/result` 只留 `isError` 布尔与是否有 `error`，不留输出内容；
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
        failure = data.get("failure")
        out["has_failure"] = isinstance(failure, dict)
    elif t == "user/message":
        src = data.get("source") if isinstance(data.get("source"), dict) else {}
        out["source_kind"] = str((src or {}).get("kind") or "")
    else:
        # 其它类型：只留键名，不留值（结构可见、内容不留）
        out["_keys"] = sorted(str(k) for k in data.keys())[:20]

    return out


def sanitize_event(event: dict[str, Any]) -> dict[str, Any]:
    """把一个真实事件裁成 ``{"type": ..., "data": {...脱敏...}}``。

    注意必须保留外层 ``type``——回放时靠它分派折叠逻辑。
    """
    return {"type": str(event.get("type") or ""), "data": sanitize(event.get("type") or "", event.get("data"))}


def build_sequences(session: str, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """从真实事件里切出有代表性的片段：每个 turn 一条，外加若干关键片段。"""
    seqs: list[dict[str, Any]] = []

    # 按 turn 切分（turn/start ... turn/end）
    current: list[dict[str, Any]] = []
    turn_no = 0
    for ev in events:
        if ev["type"] == "turn/start":
            current = []
            turn_no += 1
        current.append(ev)
        if ev["type"] == "turn/end" and current:
            seqs.append({
                "name": f"turn{turn_no}（真实完整轮次）",
                "events": [sanitize_event(e) for e in current],
            })
            current = []

    # 单独的片段：以某个关键事件为中心的邻域
    def window(center_type: str, before: int, after: int, name: str) -> None:
        for i, ev in enumerate(events):
            if ev["type"] != center_type:
                continue
            lo = max(0, i - before)
            hi = min(len(events), i + after + 1)
            seg = events[lo:hi]
            if seg:
                seqs.append({
                    "name": name,
                    "events": [sanitize_event(e) for e in seg],
                })
            return

    window("approval/asked", 2, 3, "审批等待→放行（真实 approval 对）")
    window("llm/retry", 2, 3, "LLM 重试（真实 llm/retry 片段）")
    window("tool/result", 0, 1, "工具失败→错误态（真实失败片段）")
    window("tool/call", 1, 2, "工具调用（真实 tool/call 片段）")

    # 截断，保持夹具精简
    for s in seqs:
        s["events"] = s["events"][:60]
    return seqs


def main() -> int:
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
        by_session.setdefault(ev["session"], []).append(ev)

    types: Counter[str] = Counter(ev["type"] for ev in all_events)
    print(f"解码事件总数：{len(all_events)}，涉及会话 {len(by_session)} 个")
    print("事件类型分布（前 25）：")
    for t, n in types.most_common(25):
        print(f"  {t:38s} {n:5d}")

    sequences: list[dict[str, Any]] = []
    # 只取事件最丰富的会话，避免夹具臃肿
    richest = sorted(by_session.items(), key=lambda kv: len(kv[1]), reverse=True)[:2]
    for session, evs in richest:
        evs.sort(key=lambda e: e.get("seq") if isinstance(e.get("seq"), int) else 0)
        sequences.extend(build_sequences(session, evs))

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
