"""DSH 插件包 · 独有事件面（本插件自足，不依赖其它插件）。

为什么需要这一层
----------------
DSH 的会话日志里有**只有 DSH 才有**的三类信号，桌宠侧此前拿不到：

1. **纯文字输出**（`assistant/message` 无 tool-call 块）——用来判定"正在回复"而非"在调工具"；
2. **审批等待**（`approval/asked` 未 `approval/decided`）——DSH 在等用户点允许/拒绝；
3. **提问等待**（`ask_user_question` 工具在飞）——DSH 在等用户回答。

前两者由边车折叠进 facts 后驱动 phase；本模块负责把**等待类**信号额外
用气泡播报一次（一次性、可去重），让用户不必盯着 DSH 窗口才知道"它在等我"。

设计约束
--------
- 只读 facts，不写总线 phase（phase 由 dsh_adapter 负责，职责不重叠）；
- 气泡走 ``agent_bus_service.announce``，由渲染端按本插件 manifest 的
  ``bubble.accent`` 着色——**颜色归插件声明，总线与渲染端都不认识 DSH**；
- 完全自足：不 import 小智/Octop/桌宠任何模块。
"""
from __future__ import annotations

import time
from typing import Any

from ...kernel import agent_bus_service

# 同一类等待事件的最小重复播报间隔（避免长等待期间反复弹同一句）
_REANNOUNCE_MS = 60_000

_last_announce: dict[str, float] = {}


def _should_announce(key: str, now_ms: float) -> bool:
    last = _last_announce.get(key, 0.0)
    if now_ms - last < _REANNOUNCE_MS:
        return False
    _last_announce[key] = now_ms
    return True


def reset_announce_state() -> None:
    """自检/测试用：清空去重状态。"""
    _last_announce.clear()


def maybe_announce_waiting(agent_id: str, facts: dict[str, Any]) -> str:
    """按 facts 判断是否需要播报"DSH 在等你"，需要则发一条气泡。

    返回播报的文本（未播报则空串），便于自检断言。
    """
    now_ms = time.time() * 1000

    # 1) 审批等待：优先级最高（卡住整条链路，必须让用户立刻知道）
    if facts.get("awaiting_approval"):
        tool = str(facts.get("approval_tool") or "").strip()
        text = f"DSH 正在等待你授权{'：' + tool if tool else ''}"
        if _should_announce("approval", now_ms):
            agent_bus_service.announce(agent_id, text, duration_ms=6000)
            return text
        return ""

    # 2) 提问等待：DSH 抛出 ask_user_question 等你选
    if facts.get("awaiting_question"):
        question = str(facts.get("question_text") or "").strip()
        text = question if question else "DSH 有个问题想问你"
        if _should_announce("question", now_ms):
            agent_bus_service.announce(agent_id, text[:120], duration_ms=6000)
            return text[:120]
        return ""

    # 3) 工作节点播报：工具开始/完成。
    #    为什么需要它：前两条只在"卡住等人"时才响，日常干活时桌宠**一句话都不说**，
    #    用户看不到属于 DSH 的气泡（会误以为功能没生效）。这里补上"我开工了/这一步做完了"，
    #    让 DSH 在桌宠上始终有存在感，且与其它插件的气泡用颜色区分。
    tool = str(facts.get("last_tool") or "").strip()
    if tool and int(facts.get("active_tools") or 0) > 0:
        key = f"tool-start:{tool}"
        if _should_announce(key, now_ms):
            text = f"正在用 {tool} 干活…"
            agent_bus_service.announce(agent_id, text, duration_ms=4000)
            return text

    return ""


def capability_report(facts: dict[str, Any]) -> dict[str, Any]:
    """本插件当前可观测到的 DSH 独有能力状态（供插件面板/自检展示）。"""
    return {
        "streaming_text_only": bool(facts.get("last_message_text_only")),
        "awaiting_approval": bool(facts.get("awaiting_approval")),
        "awaiting_question": bool(facts.get("awaiting_question")),
        "approval_tool": str(facts.get("approval_tool") or ""),
        "question_text": str(facts.get("question_text") or "")[:120],
        "active_tools": int(facts.get("active_tools") or 0),
        "retrying": bool(facts.get("retrying")),
    }
