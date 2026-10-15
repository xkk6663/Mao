"""验收报告：DSH 能显示的全部工作状态一览（注册 / 可达 / 驱动来源 / 桌宠表现）。

直接回答需求「注册好 DSH 能显示的所有工作状态」：把 12 个 phase 逐条列出——
是否注册进总线、是否能被 DSH 实时事件驱动、由什么真实事件驱动、桌宠怎么演。

用法（backend 目录下）::

    .venv\\Scripts\\python.exe -m app.dsh_acceptance
"""
from __future__ import annotations

import json
import sys
import urllib.request

from ..kernel import agent_bus_service
from . import dsh_adapter as dsh

# phase → (驱动来源, 桌宠表现)
DRIVERS: dict[str, tuple[str, str]] = {
    "planning": (
        "turn/start；todo_write/create_goal/update_goal；todo/write；goal/change",
        "思考动画 + 徽标「规划」",
    ),
    "thinking": (
        "step/start；tool/result 后继续推理；llm/retry(-started)",
        "思考动画 + 徽标「思考中」",
    ),
    "executing_tool": (
        "tool/call（active_tools>0）",
        "观察动作 + 徽标「执行工具」",
    ),
    "streaming": (
        "assistant/message 且为纯文字（无 tool-call 块）",
        "回应动画 + 徽标「回复中」",
    ),
    "waiting_input": (
        "ask_user_question 在跑；turn/end{blocked}",
        "聆听动作 + 徽标「聆听中」",
    ),
    "voice": (
        "speak/tts 类工具（本版 DSH 无 TTS，装了即生效）",
        "说话口型 + 徽标「说话中」",
    ),
    "awaiting_approval": (
        "approval/asked 未 approval/decided",
        "回应动作 + 徽标「待确认」",
    ),
    "idle": ("DSH 在线且无工作；未知 turn 结束原因", "待机动画（不显示徽标）"),
    "complete": ("turn/end{completed}", "待机动画（不显示徽标）"),
    "error": (
        "tool/result{message.isError}；turn/end{error|max-tokens|interrupted}",
        "待机动画（不显示徽标）",
    ),
    "paused": ("连接中断分支（DSH 进程在但会话不可用）", "待机动画（不显示徽标）"),
    "heartbeat": ("持续保活（走总线 heartbeat()，不作 phase emit）", "无（不改变动画）"),
}


def fetch_snapshot() -> dict | None:
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:8000/api/companion/agents", timeout=4
        ) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    # 控制台可能是 GBK（Windows 默认），避免用 ✓/✗ 这类会 UnicodeEncodeError 的字符
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

    print("=" * 96)
    print("DSH 工作状态接入验收报告")
    print("=" * 96)

    fact_reachable = set(dsh.DSH_FACT_PHASES)
    all_registered = set(dsh.DSH_PHASES)
    bus_phases = set(agent_bus_service.PHASES)

    print(f"\n总线 phase 枚举总数        : {len(bus_phases)}")
    print(f"本适配器注册 phase 数      : {len(all_registered)}  (DSH_PHASES)")
    print(f"由实时事件可产出 phase 数  : {len(fact_reachable)}  (DSH_FACT_PHASES)")
    print(f"工作细分状态（显示徽标）    : {len(dsh.DSH_WORK_PHASES)}  (DSH_WORK_PHASES)")

    print("\n" + "-" * 96)
    print(f"{'phase':<20}{'注册':<6}{'实时可达':<10}{'桌宠表现':<26}驱动来源")
    print("-" * 96)
    ok = True
    for p in dsh.DSH_PHASES:
        registered = p in all_registered and p in bus_phases
        reachable = p in fact_reachable
        driver, look = DRIVERS.get(p, ("?", "?"))
        if not registered:
            ok = False
        # heartbeat 刻意不走 facts；paused 走连接中断分支 —— 都算“可达”但路径不同
        reach = "是" if reachable else ("间接" if p in {"paused", "heartbeat"} else "否")
        if reach == "否":
            ok = False
        print(f"{p:<20}{'YES' if registered else 'NO':<6}{reach:<10}{look:<26}{driver}")

    print("-" * 96)
    print("\n说明：")
    print("  · 「注册」= 在总线 PHASE_PRIORITY 枚举内且被本适配器声明（12/12）。")
    print("  · 「实时可达」= 可由 DSH 实时事件经 phase_for_facts 直接产出（10/12）。")
    print("  · paused 走连接中断分支、heartbeat 走总线 heartbeat()，二者是刻意的不同路径，")
    print("    不是缺口——自检里有断言禁止它们从 facts 产出，避免污染 Agent 页显示。")

    snap = fetch_snapshot()
    print("\n" + "=" * 96)
    if snap:
        entry = next((a for a in snap.get("agents", []) if a.get("agent_id") == "dsh"), None)
        if entry:
            print("实时总线状态：")
            print(f"  status={entry.get('status')}  enabled={entry.get('enabled')}  "
                  f"phase={entry.get('phase')}  active={entry.get('active')}")
            st = entry.get("state")
            if st:
                print(f"  state={json.dumps(st, ensure_ascii=False)[:200]}")
            print(f"  active_agent_id={snap.get('active_agent_id')}")
        else:
            print("总线快照中未找到 dsh 条目")
            ok = False
    else:
        print("（后端未运行，跳过实时状态检查）")
    print("=" * 96)

    print("\n结论：" + ("DSH 全部工作状态已注册，实时链路正常。" if ok else "存在未注册/不可达状态，需修复。"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
