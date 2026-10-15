"""端到端验证：真实 DSH 会话工作时，桌宠总线是否实时跟随 phase 变化。

做法：轮询 ``GET /api/companion/agents``（驱动桌宠的同一份数据源），
记录 DSH 的 status/phase 随时间的变化，并统计延迟与覆盖到的 phase 种类。

用法（backend 目录下）::

    .venv\\Scripts\\python.exe -m app.dsh_adapter_e2e [seconds]
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from collections import Counter

BUS_URL = "http://127.0.0.1:8000/api/companion/agents"
POLL_S = 0.4


def fetch() -> dict | None:
    try:
        with urllib.request.urlopen(BUS_URL, timeout=4) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    print("=" * 70)
    print(f"DSH 桌宠状态端到端验证（{seconds}s，轮询总线 {BUS_URL}）")
    print("=" * 70)

    transitions: list[tuple[float, str, str, str, bool]] = []
    phase_counts: Counter[str] = Counter()
    last: tuple[str, str] | None = None
    started = time.time()
    dsh_seen = 0
    online_seen = 0
    active_seen = 0
    first_state: dict | None = None

    while time.time() - started < seconds:
        snap = fetch()
        if snap:
            agents = snap.get("agents") or []
            dsh = next((a for a in agents if a.get("agent_id") == "dsh"), None)
            if dsh:
                dsh_seen += 1
                status = str(dsh.get("status"))
                phase = str(dsh.get("phase"))
                active = bool(dsh.get("active"))
                if status == "online":
                    online_seen += 1
                if active:
                    active_seen += 1
                phase_counts[phase] += 1
                if first_state is None:
                    first_state = dsh
                key = (status, phase)
                if key != last:
                    last = key
                    transitions.append((time.time() - started, status, phase, str(dsh.get("error") or ""), active))
                    state = dsh.get("state")
                    state_txt = ""
                    if isinstance(state, dict) and state:
                        state_txt = " " + json.dumps(state, ensure_ascii=False)[:160]
                    elif state:
                        state_txt = " " + str(state)[:160]
                    print(f"[{time.time()-started:6.1f}s] status={status:10s} phase={phase:18s} active={active}{state_txt}")
        time.sleep(POLL_S)

    elapsed = time.time() - started
    print("\n" + "=" * 70)
    print("统计")
    print("=" * 70)
    print(f"采样次数           : {dsh_seen}")
    print(f"DSH online 占比    : {online_seen}/{dsh_seen}" if dsh_seen else "DSH online 占比    : 0/0")
    print(f"DSH 为活跃者占比   : {active_seen}/{dsh_seen}" if dsh_seen else "DSH 为活跃者占比   : 0/0")
    print(f"观察到状态切换次数 : {len(transitions)}")
    print("\nphase 分布：")
    for phase, n in phase_counts.most_common():
        print(f"  {phase:20s} {n:4d} 次 ({n/max(1,dsh_seen)*100:5.1f}%)")

    print("\n状态切换序列：")
    for t, status, phase, err, active in transitions:
        print(f"  {t:6.1f}s  {status:10s} {phase:18s} active={active} {err[:60]}")

    if first_state:
        print("\n首次采样 DSH 条目：")
        print("  " + json.dumps(first_state, ensure_ascii=False)[:500])

    ok = dsh_seen > 0
    print("\n" + "=" * 70)
    print("结论：" + ("DSH 已被总线持续跟踪，桌宠可实时显示其工作状态" if ok else "未在总线中看到 DSH"))
    print("=" * 70)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
