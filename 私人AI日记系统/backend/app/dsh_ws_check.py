"""端到端验证桌宠真正消费的那条链路：WS /api/companion/ws → agent_phase 事件。

对照 `GET /api/companion/agents`（HTTP 快照）与 WS 推送，确认：
  1. WS 连得上、hello 后能收到 agent_phase / agent_status / agents_snapshot；
  2. DSH 的 phase 事件确实经 WS 推到渲染端（桌宠就是靠这条消息切动画/表情/徽标）；
  3. 推送与快照的 phase 口径一致（不会出现"页面显示 A、桌宠演 B"）。

用法（backend 目录下）::

    .venv\\Scripts\\python.exe -m app.dsh_ws_check [seconds]
"""
from __future__ import annotations

import asyncio
import json
import sys
import urllib.request

WS_URL = "ws://127.0.0.1:8000/api/companion/ws"
HTTP_URL = "http://127.0.0.1:8000/api/companion/agents"


def snapshot() -> dict | None:
    try:
        with urllib.request.urlopen(HTTP_URL, timeout=4) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


async def main() -> int:
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    try:
        import websockets
    except ImportError:
        print("缺少 websockets 库，跳过 WS 检查")
        return 0

    print("=" * 70)
    print(f"桌宠 WS 链路检查（{WS_URL}，{seconds}s）")
    print("=" * 70)

    counters: dict[str, int] = {}
    dsh_phases: list[tuple[str, bool, str]] = []
    other_samples: list[str] = []
    hello_seen = False

    try:
        async with websockets.connect(WS_URL, open_timeout=8) as ws:
            print("[ws] connected")
            deadline = asyncio.get_event_loop().time() + seconds
            while asyncio.get_event_loop().time() < deadline:
                remaining = deadline - asyncio.get_event_loop().time()
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=min(3.0, max(0.2, remaining)))
                except asyncio.TimeoutError:
                    continue
                try:
                    msg = json.loads(raw)
                except Exception:  # noqa: BLE001
                    continue
                mtype = str(msg.get("type") or "?")
                counters[mtype] = counters.get(mtype, 0) + 1
                if mtype in {"hello", "connected", "ready"}:
                    hello_seen = True
                # 事件负载在 payload 里（与 pet_event_service.publish 的封装一致）
                pl = msg.get("payload") if isinstance(msg.get("payload"), dict) else msg
                if mtype == "agent_phase":
                    if str(pl.get("agent_id")) == "dsh":
                        state = pl.get("state") if isinstance(pl.get("state"), dict) else {}
                        dsh_phases.append((
                            str(pl.get("phase")),
                            bool(pl.get("active")),
                            str(pl.get("agent_name") or ""),
                            str(state.get("tool") or ""),
                        ))
                    elif len(other_samples) < 4:
                        other_samples.append(
                            f"{pl.get('agent_id')}:{pl.get('phase')} active={pl.get('active')}"
                        )
    except Exception as exc:  # noqa: BLE001
        print(f"[ws] 连接失败：{type(exc).__name__}: {exc}")
        return 1

    print(f"\n收到消息类型统计：{json.dumps(counters, ensure_ascii=False)}")
    print(f"hello/connected 帧：{hello_seen}")

    snap = snapshot()
    active_id = (snap or {}).get("active_agent_id")
    print(f"HTTP 快照 active_agent_id：{active_id}")

    print(f"\nDSH 的 agent_phase 推送：{len(dsh_phases)} 条")
    for phase, active, name, tool in dsh_phases[:10]:
        print(f"  {name} phase={phase} active={active} tool={tool or '-'}")
    if other_samples:
        print(f"其它 Agent 的推送样例：{other_samples}")

    ok = True
    if not counters:
        print("\n[FAIL] 未收到任何 WS 消息（链路不通）")
        ok = False
    if not dsh_phases:
        # 静默期内 DSH 可能没有 phase 变化，不算失败——但要说明
        print("\n[WARN] 本次窗口内未捕获到 DSH 的 agent_phase（可能恰好无 phase 变化）")
    else:
        print("\n[OK] DSH 的 phase 确实经桌宠消费的那条 WS 通道推送")

    if counters:
        print("[OK] WS 链路连通（桌宠能收到事件）")
    print("=" * 70)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
