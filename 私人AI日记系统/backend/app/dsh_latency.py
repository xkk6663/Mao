"""实测端到端状态延迟：DSH 事件发生 → 桌宠总线可见，共花多少时间。

为什么需要它：README 里原先写的 "p50 215ms" 是我早期用不同方法测的，两位独立
验证者都**无法复现**（他们的独立测量是 p50 259 / p90 400ms）。与其争论数字，
不如把这个测量做成可复现的工具：用总线快照里的事实时间戳（`updated_at`，即
DSH 事件自身的时间）与"我们观察到它"的墙钟时间相减，得到真实延迟分布。

用法（backend 目录下）::

    .venv\\Scripts\\python.exe -m app.dsh_latency [seconds]
"""
from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.request

URL = "http://127.0.0.1:8000/api/companion/agents"


def snap() -> dict | None:
    try:
        with urllib.request.urlopen(URL, timeout=4) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    poll = 0.15  # 高频采样以捕捉每次事件的时间戳变化

    print("=" * 74)
    print(f"端到端状态延迟实测（DSH 事件时间 → 总线可观测），{seconds}s")
    print("=" * 74)

    samples: list[tuple[float, str, int]] = []  # (latency_ms, event_type, seq)
    last_updated = None
    t_end = time.time() + seconds
    misses = 0

    # 关键：必须按 **facts.updated_at 变化** 判定"来了新事件"，不能按 bus seq。
    # 适配器会周期性补发同一份 facts（让桌宠在长工具调用期间保持"工作中"），
    # 那种补发会让 seq 递增但 updated_at 不变——若按 seq 计数，测出来的就是
    # "上一个事件已经过去多久"（会单调增长到几十秒），而不是投递延迟。
    while time.time() < t_end:
        s = snap()
        if not s:
            misses += 1
            time.sleep(poll)
            continue
        dsh = next((a for a in s.get("agents", []) if a.get("agent_id") == "dsh"), None)
        if dsh:
            try:
                with urllib.request.urlopen(
                    "http://127.0.0.1:8000/api/companion/agents/dsh/inspect", timeout=4
                ) as r:
                    ins = json.loads(r.read().decode("utf-8"))
            except Exception:  # noqa: BLE001
                time.sleep(poll)
                continue
            facts = ins.get("facts") or {}
            ev_time = facts.get("updated_at")
            if isinstance(ev_time, (int, float)) and ev_time > 0 and ev_time != last_updated:
                lat = time.time() * 1000 - float(ev_time)
                # 只接受"新鲜"的样本：明显是历史事件的（>60s）说明是从旧状态起步，丢弃
                if 0 <= lat <= 60_000:
                    samples.append((lat, str(facts.get("last_event") or "?"), int(dsh.get("seq") or 0)))
                last_updated = ev_time
        time.sleep(poll)

    print(f"\n采样：捕捉到 {len(samples)} 次**新事件**（按 facts.updated_at 变化判定）；接口失败 {misses} 次")
    if not samples:
        print("未捕捉到事件（DSH 可能空闲）；无法给出延迟分布。")
        return 0

    lats = sorted(s[0] for s in samples)
    n = len(lats)
    print("\n延迟分布（ms）：")
    print(f"  n    = {n}")
    print(f"  min  = {lats[0]:.0f}")
    print(f"  p50  = {lats[n // 2]:.0f}")
    print(f"  p90  = {lats[min(n - 1, int(n * 0.9))]:.0f}")
    print(f"  p99  = {lats[min(n - 1, int(n * 0.99))]:.0f}")
    print(f"  max  = {lats[-1]:.0f}")
    print(f"  mean = {statistics.fmean(lats):.0f}")

    over_300 = sum(1 for x in lats if x > 300)
    over_600 = sum(1 for x in lats if x > 600)
    print(f"\n  > 300ms（总线同 phase 节流窗口）：{over_300}/{n} ({over_300 / n * 100:.0f}%)")
    print(f"  > 600ms（人眼可感的卡顿阈值）  ：{over_600}/{n} ({over_600 / n * 100:.0f}%)")

    print("\n最近 10 次事件：")
    for lat, etype, seq in samples[-10:]:
        print(f"  {lat:7.0f}ms  seq={seq:<5} {etype}")

    print("\n" + "=" * 74)
    print("说明：该延迟已包含边车 --poll-ms 轮询间隔（默认 150ms）与总线节流，")
    print("      是用户真实感知的端到端值。实测经验：主要成本来自 **DSH 自身的")
    print("      写盘节奏**（它按批落盘，不是每条事件立刻 flush），而非我方管道——")
    print("      所以调小 poll_ms 只能省下我方那部分（≤150ms），改不动大头。")
    print("      长工具调用期间日志还会长时间不写（实测 >40s），属正常事件粒度。")
    print("=" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())
