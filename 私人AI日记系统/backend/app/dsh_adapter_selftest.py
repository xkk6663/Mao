"""DSH 适配器自检 / 单元测试：facts 折叠 + phase 映射 + 边车解码全链路。

运行（在 backend 目录下）：:

    .venv\\Scripts\\python.exe -m app.dsh_adapter_selftest

覆盖：
  1. 边车解码真实 DSH 会话日志 → facts（含 zstd 多帧、状态折叠）；
  2. DSH 全部可显示工作状态（10 phase）逐一构造并断言映射正确；
  3. 单事件映射 parse_dsh_event 的关键分支；
  4. 配置/路径/node 探测等工具函数。
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import dsh_adapter as dsh


PASS = 0
FAIL = 0
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [OK]   {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name} — {detail}")
        print(f"  [FAIL] {name}  {detail}")


def check_eq(name: str, got: Any, want: Any) -> None:
    check(name, got == want, f"got={got!r} want={want!r}")


# ---------------------------------------------------------------------------
# 1) facts → phase：DSH 全部可显示工作状态逐一验证
# ---------------------------------------------------------------------------
def test_phase_mapping() -> None:
    print("\n[1] facts → phase 映射（DSH 全部可显示工作状态）")

    base = {
        "in_turn": True, "turn": 1, "step": 3, "last_tool": "", "tool_calls": 0,
        "active_tools": 0, "approvals_pending": 0, "awaiting_user": False,
        "voice_active": False, "retrying": False, "errored": False,
        "last_event_failed": False, "turn_end_reason": "", "last_error": "",
        "text_chars": 0, "reason_chars": 0, "last_assistant_has_text": False,
        "last_assistant_has_reason": False, "last_message_text_only": False,
        "plan_intent": False, "voice_intent": False, "todo_count": 0, "goal_operation": "",
        "last_event": "step/start", "user_turns": 1,
    }

    def facts(**over: Any) -> dict[str, Any]:
        f = dict(base)
        f.update(over)
        return f

    # --- 工作细分状态（7 个，桌宠会显示徽标）---
    # planning：轮次刚开始（plan_intent 由 turn/start 置位）
    p, s = dsh.phase_for_facts(facts(last_event="turn/start", plan_intent=True))
    check_eq("planning（轮次开始）", p, "planning")

    # planning：规划类工具已调完、当前没工具在跑 → 规划态
    p, s = dsh.phase_for_facts(facts(plan_intent=True, active_tools=0,
                                     last_tool="todo_write", todo_count=5, last_event="todo/write"))
    check_eq("planning（规划意图，无工具在跑）", p, "planning")
    check_eq("  └ state.todos 透传", s.get("todos"), 5)

    # 规划意图与工具执行同时存在时，以工具执行为准——与总线
    # PHASE_PRIORITY（executing_tool=2 高于 planning=3）保持同一口径
    p, _ = dsh.phase_for_facts(facts(plan_intent=True, active_tools=1,
                                     last_tool="todo_write", tool_calls=1, last_event="tool/call"))
    check_eq("planning 让位于 executing_tool（同总线优先级）", p, "executing_tool")

    # thinking：步骤推进中（纯推理）
    p, _ = dsh.phase_for_facts(facts(last_assistant_has_reason=True, last_event="assistant/message"))
    check_eq("thinking（纯推理）", p, "thinking")

    # executing_tool：工具在跑
    p, s = dsh.phase_for_facts(facts(active_tools=1, last_tool="read", tool_calls=2, last_event="tool/call"))
    check_eq("executing_tool（工具进行中）", p, "executing_tool")
    check_eq("  └ state.tool 透传", s.get("tool"), "read")

    # streaming：助手产出纯文字正文（无 tool-call 块）
    p, _ = dsh.phase_for_facts(facts(last_message_text_only=True,
                                     last_assistant_has_text=True, last_event="assistant/message"))
    check_eq("streaming（正文输出）", p, "streaming")

    # 反例（真实数据 335/377 条如此）：assistant/message 同时含 text + tool-call
    # 时不是 streaming，而是"要调工具"
    p, _ = dsh.phase_for_facts(facts(last_message_text_only=False,
                                     last_assistant_has_text=True,
                                     last_assistant_has_reason=True,
                                     active_tools=1, last_event="assistant/message"))
    check_eq("含 tool-call 的 assistant/message 不是 streaming", p, "executing_tool")

    p, _ = dsh.phase_for_facts(facts(last_message_text_only=False,
                                     last_assistant_has_text=True,
                                     last_assistant_has_reason=True,
                                     active_tools=0, last_event="assistant/message"))
    check_eq("推理+文字但无工具 → thinking", p, "thinking")

    # waiting_input：等待用户工具在跑
    p, s = dsh.phase_for_facts(facts(awaiting_user=True, active_tools=1,
                                     last_tool="ask_user_question", last_event="tool/call"))
    check_eq("waiting_input（等待用户）", p, "waiting_input")

    # voice：语音工具在跑
    p, _ = dsh.phase_for_facts(facts(voice_active=True, active_tools=1,
                                     last_tool="speak", last_event="tool/call"))
    check_eq("voice（语音播报）", p, "voice")

    # awaiting_approval：审批挂起
    p, _ = dsh.phase_for_facts(facts(approvals_pending=1, last_event="approval/asked"))
    check_eq("awaiting_approval（等待审批）", p, "awaiting_approval")

    # --- 非工作状态（5 个）---
    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end", turn_end_reason="completed"))
    check_eq("complete（轮次完成）", p, "complete")

    p, s = dsh.phase_for_facts(facts(last_event_failed=True, last_error="tool boom",
                                     last_event="tool/result"))
    check_eq("error（失败当下）", p, "error")
    check_eq("  └ state.error 透传", s.get("error"), "tool boom")

    p, _ = dsh.phase_for_facts(facts(in_turn=False, turn_end_reason="error"))
    check_eq("error（轮次异常结束）", p, "error")

    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end", turn_end_reason="aborted"))
    check_eq("idle（轮次被中止）", p, "idle")

    # blocked：preStep 被 hook 拒绝 → 等用户换输入（对齐 DSH 官方桌宠投影）
    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end", turn_end_reason="blocked"))
    check_eq("waiting_input（轮次被 hook 拦下）", p, "waiting_input")

    # forked：轮次延续到子会话，不该挂在工作态
    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end", turn_end_reason="forked"))
    check_eq("idle（轮次 fork 到子会话）", p, "idle")

    # 未知的 turn 结束原因（TurnEndReasonMap 可被 merge 扩展）：不得挂在工作态
    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end",
                                     turn_end_reason="brand-new-reason"))
    check_eq("idle（未知结束原因）", p, "idle")

    p, _ = dsh.phase_for_facts({})
    check_eq("idle（空 facts）", p, "idle")

    # --- 优先级顺序验证 ---
    p, _ = dsh.phase_for_facts(facts(approvals_pending=1, active_tools=3, awaiting_user=True,
                                     last_event_failed=True, last_event="approval/asked"))
    check_eq("优先级：审批 > 其他", p, "awaiting_approval")

    p, _ = dsh.phase_for_facts(facts(active_tools=1, awaiting_user=True, last_event_failed=True))
    check_eq("优先级：等待用户 > 错误", p, "waiting_input")

    p, _ = dsh.phase_for_facts(facts(active_tools=1, voice_active=True, last_event_failed=True))
    check_eq("优先级：语音 > 错误", p, "voice")

    p, _ = dsh.phase_for_facts(facts(active_tools=2, last_event_failed=True, last_event="tool/call"))
    check_eq("优先级：错误 > 工具进行中", p, "error")

    # --- 失败不粘轮：后续进展事件恢复工作态 ---
    p, _ = dsh.phase_for_facts(facts(errored=True, last_event_failed=False, active_tools=1,
                                     last_event="tool/call"))
    check_eq("失败不粘轮（errored=True 但已恢复）", p, "executing_tool")

    # --- retrying → thinking ---
    p, _ = dsh.phase_for_facts(facts(retrying=True, last_event="llm/retry"))
    check_eq("thinking（LLM 重试中）", p, "thinking")

    # --- phase 集合口径 ---
    check_eq("工作态 7 个", len(dsh.DSH_WORK_PHASES), 7)
    check_eq("非工作态 4 个", len(dsh.DSH_IDLE_PHASES), 4)
    check_eq("注册 phase 共 12 个（含 heartbeat）", len(dsh.DSH_PHASES), 12)
    check_eq("facts 可产出 10 个 phase", len(dsh.DSH_FACT_PHASES), 10)
    check("工作态与总线枚举一致",
          all(p in dsh.agent_bus_service.PHASES for p in dsh.DSH_WORK_PHASES))
    check("全部注册 phase 都在总线枚举内",
          all(p in dsh.agent_bus_service.PHASES for p in dsh.DSH_PHASES))
    check("含 heartbeat", "heartbeat" in dsh.DSH_PHASES)
    check("is_work_phase 判定正确",
          dsh.is_work_phase("thinking") and not dsh.is_work_phase("complete"))

    # 可达性口径必须诚实：phase_for_facts 只能产出 DSH_FACT_PHASES；
    # paused 由连接中断分支 emit，heartbeat 只走总线 heartbeat()（不作 phase emit）。
    reachable: set[str] = set()
    grid_combos = [
        {"in_turn": t, "active_tools": a, "approvals_pending": ap, "awaiting_user": au,
         "voice_active": v, "last_event_failed": f, "turn_end_reason": r,
         "last_message_text_only": tx, "retrying": ry, "last_event": le, "plan_intent": pi}
        for t in (True, False)
        for a in (0, 1)
        for ap in (0, 1)
        for au in (True, False)
        for v in (True, False)
        for f in (True, False)
        for r in ("", "completed", "error", "max-tokens", "interrupted", "aborted", "blocked", "forked")
        for tx in (True, False)
        for ry in (True, False)
        for le in ("turn/start", "step/start", "tool/call", "assistant/message", "tool/result")
        for pi in (True, False)
    ]
    for combo in grid_combos:
        reachable.add(dsh.phase_for_facts(combo)[0])
    check("phase_for_facts 产出集合 == DSH_FACT_PHASES",
          reachable == set(dsh.DSH_FACT_PHASES),
          f"reachable={sorted(reachable)} declared={sorted(dsh.DSH_FACT_PHASES)}")
    check("paused 不由 facts 产出（走连接中断分支）",
          "paused" not in reachable, f"reachable={sorted(reachable)}")
    check("heartbeat 不作 phase emit（只走总线 heartbeat）",
          "heartbeat" not in reachable, f"reachable={sorted(reachable)}")


# ---------------------------------------------------------------------------
# 2) 单事件映射（parse_dsh_event）
# ---------------------------------------------------------------------------
def test_parse_event() -> None:
    print("\n[2] 单事件映射 parse_dsh_event")

    cases: list[tuple[dict[str, Any], str]] = [
        ({"type": "turn/start", "data": {"turn": 1}}, "planning"),
        ({"type": "step/start", "data": {"step": 2}}, "thinking"),
        ({"type": "tool/call", "data": {"name": "read"}}, "executing_tool"),
        ({"type": "tool/call", "data": {"name": "ask_user_question"}}, "waiting_input"),
        ({"type": "tool/call", "data": {"name": "todo_write"}}, "planning"),
        ({"type": "tool/call", "data": {"name": "speak"}}, "voice"),
        ({"type": "tool/result", "data": {"message": {"isError": True}}}, "error"),
        ({"type": "tool/result", "data": {"message": {"isError": False}}}, "thinking"),
        ({"type": "tool/result", "data": {"message": {}, "error": {"code": "TOOL_TIMEOUT"}}}, "error"),
        ({"type": "assistant/message", "data": {"message": {"content": [{"type": "text", "text": "hi"}]}}}, "streaming"),
        ({"type": "assistant/message", "data": {"message": {"content": [{"type": "reasoning", "text": "r"}]}}}, "thinking"),
        ({"type": "assistant/message", "data": {"message": {"content": [{"type": "tool-call"}]}}}, "executing_tool"),
        ({"type": "approval/asked", "data": {"toolName": "pwsh"}}, "awaiting_approval"),
        ({"type": "llm/retry", "data": {"retry": 1}}, "error"),
        ({"type": "llm/retry-started", "data": {"retry": 1}}, "error"),
        ({"type": "turn/end", "data": {"reason": {"kind": "completed"}}}, "complete"),
        ({"type": "turn/end", "data": {"reason": {"kind": "error"}}}, "error"),
        ({"type": "turn/end", "data": {"reason": {"kind": "max-tokens"}}}, "error"),
        ({"type": "turn/end", "data": {"reason": {"kind": "interrupted"}}}, "error"),
        ({"type": "turn/end", "data": {"reason": {"kind": "aborted"}}}, "idle"),
        ({"type": "user/message", "data": {"source": {"kind": "user"}}}, "thinking"),
        ({"type": "user/message", "data": {"source": {"kind": "voice"}}}, "waiting_input"),
        ({"type": "session/start", "data": {}}, "idle"),
    ]
    for ev, want in cases:
        got = dsh.parse_dsh_event(ev)
        check_eq(f"parse_dsh_event {ev['type']}", got[0] if got else None, want)

    for junk in [None, {}, {"type": "unknown/thing"}, {"type": "step/end", "data": {}}]:
        check(f"未知事件返回 None ({junk})", dsh.parse_dsh_event(junk) is None)


# ---------------------------------------------------------------------------
# 3) 边车真实日志解码（端到端：zstd 多帧 → facts）
# ---------------------------------------------------------------------------
def test_sidecar_real_log() -> None:
    print("\n[3] 边车解码真实 DSH 会话日志")

    node = dsh.resolve_node({})
    check("探测到 node 可执行文件", bool(node), f"node={node}")
    if not node:
        return
    script = Path(dsh.__file__).with_name(dsh.SIDECAR_NAME)
    check("边车脚本存在", script.exists(), str(script))
    if not script.exists():
        return

    sessions_root = dsh.default_sessions_root()
    check("DSH 会话根目录存在", sessions_root.exists(), str(sessions_root))

    proc = subprocess.run(
        [node, str(script), "--once", "--workspace", dsh.default_workspace(),
         "--sessions-root", str(sessions_root)],
        capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    check_eq("边车 --once 退出码", proc.returncode, 0)
    if proc.returncode != 0:
        print(f"      stderr: {proc.stderr[:500]}")
        return

    msgs = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    kinds = [m.get("kind") for m in msgs]
    print(f"      边车输出：{kinds}")
    if "offline" in kinds:
        print("      （当前无活跃 DSH 会话，跳过解码断言）")
        return

    ready = next(m for m in msgs if m.get("kind") == "ready")
    facts_msg = next(m for m in msgs if m.get("kind") == "facts")
    check("ready 带 session", bool(ready.get("session")), str(ready))
    check("ready 带真实 cwd", bool(ready.get("cwd")), str(ready))
    check("重放事件数 > 0", int(ready.get("events_replayed") or 0) > 0,
          f"replayed={ready.get('events_replayed')}")
    check("delegation_depth 为 0（主会话）", ready.get("delegation_depth") == 0,
          f"depth={ready.get('delegation_depth')}")

    f = facts_msg.get("facts") or {}
    print(f"      facts: {json.dumps({k: v for k, v in f.items() if k not in ('reason_chars','text_chars')}, ensure_ascii=False)[:400]}")
    for key in ("in_turn", "turn", "tool_calls", "approvals_pending", "last_event"):
        check(f"facts 含字段 {key}", key in f, f"keys={list(f)}")

    # 折叠出的事实必须能映射到合法 phase
    phase, state = dsh.phase_for_facts(f)
    check(f"真实 facts → 合法 phase（得到 {phase}）", phase in dsh.agent_bus_service.PHASES)
    check("phase 属于 DSH 注册集合", phase in dsh.DSH_PHASES, f"phase={phase}")


# ---------------------------------------------------------------------------
# 3.5) 真实事件回放：用从真实 DSH 日志抽取的片段驱动 phase 映射
# ---------------------------------------------------------------------------
def test_replay_real_events() -> None:
    """回放真实 DSH 事件片段，检查折叠与映射在真实数据上成立。

    夹具由 ``app.dsh_fixture_build`` 从真实会话日志抽取（原样事件，未手工构造）。
    这里复刻边车的折叠语义（同一套规则），逐事件喂入并断言：
      - 全程不抛异常；
      - 每个中间状态都落在合法 phase 枚举内；
      - 片段内出现过的关键状态确实被观察到（如审批 → awaiting_approval）。
    """
    print("\n[3.5] 真实事件回放（夹具来自真实 DSH 会话日志）")

    fixture_path = Path(dsh.__file__).with_name("dsh_events_fixture.json")
    if not fixture_path.exists():
        print(f"      未找到夹具 {fixture_path.name}，跳过（可运行 app.dsh_fixture_build 生成）")
        return

    try:
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        check("读取夹具", False, str(exc))
        return

    sequences = fixture.get("sequences") or []
    check("夹具含回放片段", len(sequences) > 0, f"n={len(sequences)}")
    counts = fixture.get("event_type_counts") or {}
    check("夹具覆盖 tool/call", counts.get("tool/call", 0) > 0,
          f"tool/call={counts.get('tool/call')}")
    print(f"      夹具事件类型数={len(counts)} 片段数={len(sequences)}")

    # 隐私回归：夹具必须是脱敏的（不含对话正文/工具参数内容）
    raw = fixture_path.read_text(encoding="utf-8")
    leaked = [k for k in ('"text": "', '"arguments"', '"objective"') if k in raw]
    check("夹具已脱敏（无对话正文/工具参数）", not leaked, f"leaked markers={leaked}")
    check("夹具体积受控（< 100KB）", len(raw.encode("utf-8")) < 100_000,
          f"size={len(raw.encode('utf-8'))}B")

    # 复刻边车 foldEvent 的语义（保持与 .mjs 一致；两边都改才算改对）。
    # 夹具条目是**脱敏**过的（正文换成 len、工具参数不留），故这里按脱敏字段读。
    def fold(prev: dict[str, Any], ev: dict[str, Any]) -> dict[str, Any]:
        f = dict(prev)
        f["last_event_failed"] = False
        # 与边车同语义：intent 类标记每事件清零，由当前事件置位
        f["plan_intent"] = False
        f["voice_intent"] = False
        t = str(ev.get("type") or "")
        d = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        d = d or {}
        f["last_event"] = t
        if t == "turn/start":
            f.update(in_turn=True, turn=d.get("turn"), step=None, last_tool="", tool_calls=0,
                     active_tools=0, approvals_pending=0, awaiting_user=False, voice_active=False,
                     retrying=False, errored=False, turn_end_reason="", last_error="",
                     text_chars=0, reason_chars=0,
                     last_assistant_has_text=False, last_assistant_has_reason=False,
                     last_message_text_only=False, plan_intent=True)
        elif t == "turn/end":
            reason = d.get("reason") if isinstance(d.get("reason"), dict) else {}
            kind = str((reason or {}).get("kind") or "")
            f.update(in_turn=False, turn=None, step=None, last_tool="", active_tools=0,
                     approvals_pending=0, awaiting_user=False, voice_active=False,
                     turn_end_reason=kind)
            if kind in {"error", "max-tokens", "interrupted"}:
                f.update(errored=True, last_event_failed=True)
        elif t == "step/start":
            f.update(step=d.get("step"), active_tools=0,
                     last_assistant_has_text=False, last_assistant_has_reason=False,
                     last_message_text_only=False)
        elif t == "assistant/message":
            # 脱敏后：content 里 text/reasoning 只留 len；tool-call 留 name
            content = (d.get("message") or {}).get("content") or []
            has_text = any(isinstance(c, dict) and c.get("type") == "text" for c in content)
            has_reason = any(isinstance(c, dict) and c.get("type") == "reasoning" for c in content)
            has_tool = any(isinstance(c, dict) and c.get("type") == "tool-call" for c in content)
            f.update(last_assistant_has_text=has_text, last_assistant_has_reason=has_reason,
                     last_message_text_only=bool(has_text and not has_tool))
            f["text_chars"] = f.get("text_chars", 0) + sum(
                int(c.get("len") or 0) for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
            f["reason_chars"] = f.get("reason_chars", 0) + sum(
                int(c.get("len") or 0) for c in content
                if isinstance(c, dict) and c.get("type") == "reasoning"
            )
        elif t == "assistant/attempt":
            for fin in d.get("stream_finishes") or []:
                if isinstance(fin, dict) and str(fin.get("kind")) == "error":
                    f.update(errored=True, last_event_failed=True)
        elif t == "tool/call":
            name = str(d.get("name") or "")
            f.update(last_tool=name, tool_calls=f.get("tool_calls", 0) + 1,
                     active_tools=f.get("active_tools", 0) + 1)
            lname = name.lower()
            if lname in {"ask_user_question", "ask_user", "askuserquestion"}:
                f["awaiting_user"] = True
            if lname in {"speak", "tts", "text_to_speech"}:
                f["voice_active"] = True
            if lname in {"todo_write", "todowrite", "create_goal", "update_goal", "exit_plan_mode"}:
                f["plan_intent"] = True
        elif t == "todo/write":
            f["plan_intent"] = True
            # 脱敏后 todos 是**数量**（int），不是列表
            try:
                f["todo_count"] = int(d.get("todos") or 0)
            except (TypeError, ValueError):
                f["todo_count"] = 0
        elif t == "goal/change":
            f["plan_intent"] = True
        elif t == "tool/result":
            msg = d.get("message") if isinstance(d.get("message"), dict) else {}
            f["active_tools"] = max(0, f.get("active_tools", 0) - 1)
            # 脱敏后仍是原始语义：isError 布尔 + data.error 是否存在
            if bool(msg.get("isError")) or d.get("has_error"):
                f.update(errored=True, last_event_failed=True)
            f["awaiting_user"] = False
        elif t == "approval/asked":
            f["approvals_pending"] = f.get("approvals_pending", 0) + 1
        elif t == "approval/decided":
            f["approvals_pending"] = max(0, f.get("approvals_pending", 0) - 1)
        elif t in {"llm/retry", "llm/retry-started"}:
            f["retrying"] = True
        return f

    base = {
        "in_turn": False, "turn": None, "step": None, "last_tool": "", "tool_calls": 0,
        "active_tools": 0, "approvals_pending": 0, "awaiting_user": False, "voice_active": False,
        "retrying": False, "errored": False, "last_event_failed": False, "turn_end_reason": "",
        "last_error": "", "text_chars": 0, "reason_chars": 0, "last_assistant_has_text": False,
        "last_assistant_has_reason": False, "last_message_text_only": False,
        "plan_intent": False, "voice_intent": False, "todo_count": 0, "goal_operation": "",
        "last_event": "", "user_turns": 0,
    }

    observed: set[str] = set()
    illegal: list[str] = []
    errors: list[str] = []
    total_steps = 0

    for seq in sequences:
        facts = dict(base)
        for ev_raw in seq.get("events") or []:
            if not isinstance(ev_raw, dict):
                continue
            if str(ev_raw.get("type")) == "session":
                continue
            try:
                facts = fold(facts, ev_raw)
                phase, _state = dsh.phase_for_facts(facts)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{seq.get('name')}@{ev_raw.get('type')}: {exc}")
                continue
            total_steps += 1
            observed.add(phase)
            if phase not in dsh.agent_bus_service.PHASES:
                illegal.append(f"{seq.get('name')}: {phase}")

    check(f"回放 {total_steps} 步无异常", not errors, "; ".join(errors[:3]))
    check("回放产出的 phase 全部合法", not illegal, "; ".join(illegal[:3]))
    check("回放确实观察到工作态", bool(observed & set(dsh.DSH_WORK_PHASES)),
          f"observed={sorted(observed)}")
    print(f"      回放观察到的 phase：{sorted(observed)}")

    # 真实数据里 tool/call 占多数，必须能看出「执行工具」
    check("回放观察到 executing_tool", "executing_tool" in observed,
          f"observed={sorted(observed)}")


# ---------------------------------------------------------------------------
# 4) 工具函数
# ---------------------------------------------------------------------------
def test_step_start_resets_output_flags() -> None:
    """回归：step/start 必须清掉上一轮的「纯文字」标记，否则 streaming 会粘到新步骤。

    这是两个独立验证者都报出的真实缺陷：README 写了「step/start 会重置该标记」，
    但代码只重置了 last_assistant_has_text/has_reason，漏了 last_message_text_only。
    后果：上一轮以纯文字收尾后，新步骤即使只在推理，桌宠仍显示「回复中」。

    这里用**边车的真实实现**跑一遍（不是复刻），直接验证 .mjs 的行为。
    """
    print("\n[7] 回归：step/start 重置输出标记（真实边车实现）")

    node = dsh.resolve_node({})
    script = Path(dsh.__file__).with_name(dsh.SIDECAR_NAME)
    if not node or not script.exists():
        print("      缺少 node 或边车脚本，跳过")
        return

    # 造一个最小合法 zstd 会话日志：纯文字 assistant/message → step/start。
    # 落盘位置用 __pycache__ 下的子目录（同仓库内、确定可写），不用系统 temp：
    # Windows 沙箱下 tempfile 的清理会因权限回收失败而抛 PermissionError。
    # 脚本用 `node -e` 内联传入，不落 .mjs 文件——仓库路径含中文，node 按路径
    # 加载脚本时会因 URL 编码解析失败（file:///…%E7%A7%81…）。
    root = Path(dsh.__file__).resolve().parent / "__pycache__" / "_dsh_regress"
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)

    probe_js = r"""
const fs=require('fs'),path=require('path'),zlib=require('node:zlib');
const outDir=process.argv[1];
const sid='session-regress';
const dir=path.join(outDir,'--C-Users-xiao1-Regress--',sid);
fs.mkdirSync(dir,{recursive:true});
const header={type:'session',version:4,id:sid,createdAt:Date.now(),cwd:'C:\\Users\\xiao1\\Regress',
  isSeeded:false,delegationDepth:0,agentPreset:'standard'};
const events=[
  {type:'turn/start',seq:0,time:Date.now(),data:{turn:1}},
  {type:'step/start',seq:1,time:Date.now(),data:{turn:1,step:1}},
  // 纯文字（无 tool-call）→ 应使 last_message_text_only=true
  {type:'assistant/message',seq:2,time:Date.now(),data:{turn:1,step:1,
    message:{role:'assistant',content:[{type:'text',text:'纯文字收尾'}]}}},
  {type:'step/start',seq:3,time:Date.now(),data:{turn:1,step:2}},
];
const lines=[JSON.stringify(header),...events.map(e=>JSON.stringify(e))].join('\n')+'\n';
fs.writeFileSync(path.join(dir,'session.v4.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(lines,'utf8')));
console.log('MADE');
"""
    try:
        try:
            made = subprocess.run([node, "-e", probe_js, str(root)], capture_output=True,
                                  text=True, encoding="utf-8", timeout=60)
        except Exception as exc:  # noqa: BLE001
            check("构造回归日志", False, str(exc))
            return
        if made.returncode != 0:
            check("构造回归日志", False, (made.stderr or "")[:300])
            return
        check("构造回归日志", "MADE" in (made.stdout or ""), (made.stdout or "")[:120])

        proc = subprocess.run(
            [node, str(script), "--once", "--sessions-root", str(root)],
            capture_output=True, text=True, encoding="utf-8", timeout=60,
        )
        check_eq("边车读取回归日志退出码", proc.returncode, 0)
        facts = {}
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if msg.get("kind") == "facts":
                facts = msg.get("facts") or {}
        check("拿到 facts", bool(facts), proc.stdout[:200])
        if not facts:
            return

        check_eq("最后事件是 step/start", facts.get("last_event"), "step/start")
        check("step/start 后 last_message_text_only 已清零（回归点）",
              facts.get("last_message_text_only") is False,
              f"got={facts.get('last_message_text_only')!r}")
        check("step/start 后 has_text 已清零",
              facts.get("last_assistant_has_text") is False,
              f"got={facts.get('last_assistant_has_text')!r}")
        # 该状态下不应再判为 streaming
        phase, _ = dsh.phase_for_facts(facts)
        check("新步骤不应判为 streaming", phase != "streaming", f"phase={phase}")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_frontend_contract() -> None:
    """前端契约：桌宠渲染端的 phase 映射必须覆盖本适配器会发出的每个 phase。

    README 6.8 承诺「接入新 Agent 时前端零改动——只要 phase 落在枚举内」。
    这条测试就是那句话的机器校验：解析 live2d-pet.js 里内嵌的 PHASE_LABELS 与
    WORK_PHASES，断言 DSH 会发出的 phase 全部有中文标签，且"工作态"口径一致。
    """
    print("\n[6] 前端契约（桌宠渲染端 phase 映射覆盖）")

    pet_js = Path(dsh.__file__).resolve().parents[3] / "澪Agent应用" / "dist" / "live2d-pet" / "live2d-pet.js"
    if not pet_js.exists():
        print(f"      未找到 {pet_js}，跳过前端契约检查")
        return

    src = pet_js.read_text(encoding="utf-8", errors="replace")
    m_labels = re.search(r"const PHASE_LABELS\s*=\s*\{(.*?)\}", src, re.S)
    m_work = re.search(r"const WORK_PHASES\s*=\s*new Set\(\[(.*?)\]\)", src, re.S)
    check("解析到 PHASE_LABELS", m_labels is not None, "未匹配到 PHASE_LABELS")
    check("解析到 WORK_PHASES", m_work is not None, "未匹配到 WORK_PHASES")
    if not (m_labels and m_work):
        return

    # 同时解析 key 与 **value**：只抓 key 会让"标签值被改成空串/英文"这类
    # 真实回归静默通过（只抓 key 的写法已被变异测试证明是空过）。
    pairs = re.findall(r"([A-Za-z_]+)\s*:\s*'([^']*)'", m_labels.group(1))
    labels = {k: v for k, v in pairs}
    keys = set(labels)
    work = set(re.findall(r"'([a-z_]+)'", m_work.group(1)))

    missing_label = [p for p in dsh.DSH_PHASES if p not in keys]
    check("桌宠对 DSH 全部 12 phase 都有中文标签", not missing_label,
          f"缺标签={missing_label}")

    # 值必须真的存在且为中文（catch 空串 / 未翻译 / 占位符）
    empty_vals = [k for k, v in labels.items() if not v.strip()]
    check("没有空标签值", not empty_vals, f"空值={empty_vals}")
    untranslated = [k for k in keys & set(dsh.DSH_PHASES)
                    if labels.get(k, "") and not any("\u4e00" <= ch <= "\u9fff" for ch in labels[k])]
    check("DSH 各 phase 的标签值含中文（非占位/未翻译）", not untranslated,
          f"未翻译={[(k, labels[k]) for k in untranslated]}")

    check("前端工作态口径与适配器一致（7 个）", work == set(dsh.DSH_WORK_PHASES),
          f"frontend={sorted(work)} adapter={sorted(dsh.DSH_WORK_PHASES)}")


def test_helpers() -> None:
    print("\n[4] 工具函数 / 配置")
    check("默认 sessions_root 指向 .dsh/sessions",
          "sessions" in str(dsh.default_sessions_root()))
    # 默认 workspace 留空 = 不限定，由边车选最近活跃的主会话
    check("默认 workspace 为空（不限定工作区）",
          dsh.default_workspace() == "",
          f"got={dsh.default_workspace()!r}")

    paths = dsh.config_search_paths()
    check("配置搜索路径非空", len(paths) > 0, f"paths={paths}")
    check("配置搜索路径都指向 dsh_config.json",
          all(p.name == "dsh_config.json" for p in paths), f"paths={paths}")

    cfg_path = dsh.dsh_config_path()
    check("生效配置路径在项目内", cfg_path.name == "dsh_config.json",
          f"path={cfg_path}")
    print(f"      配置搜索路径：{[str(p) for p in paths]}")
    print(f"      生效配置：{cfg_path}（存在={cfg_path.exists()}）")

    cfg = dsh.load_config()
    check("load_config 返回 dict", isinstance(cfg, dict))
    check("配置含 enabled", "enabled" in cfg)
    check("配置含 sessions_root", "sessions_root" in cfg)

    running = dsh.dsh_process_running()
    check("dsh_process_running 返回 bool|None", running in (True, False, None),
          f"got={running!r}")

    info = dsh.inspect_current()
    check("inspect_current 返回 dict", isinstance(info, dict))
    check("inspect_current 含 phase", info.get("phase") in dsh.agent_bus_service.PHASES)
    check("inspect_current 含 12 个 phase", len(info.get("phases") or []) == 12)


# ---------------------------------------------------------------------------
# 5) 总线注册与 phase 广播（在真实总线上跑一遍）
# ---------------------------------------------------------------------------
def test_bus_integration() -> None:
    print("\n[5] 总线集成：注册 + 全部工作 phase 广播")

    bus = dsh.agent_bus_service
    bus.register(dsh.AGENT_ID, dsh.AGENT_NAME, "dsh_adapter",
                 capabilities={"voice": True, "text": True, "screen": False,
                               "mcp": True, "observe": False})

    agent = bus.get(dsh.AGENT_ID)
    check("DSH 已注册进总线", agent is not None)
    check_eq("注册名", agent.name if agent else None, "DSH")

    # 逐一 emit DSH 能显示的每个 phase，断言总线接受且节流/优先级不报错
    for phase in dsh.DSH_PHASES:
        try:
            bus.emit(dsh.AGENT_ID, phase, state={"tool": "read"}, force=True)
            ok = True
            err = ""
        except Exception as exc:  # noqa: BLE001
            ok = False
            err = str(exc)
        check(f"总线接受 phase {phase}", ok, err)

    snap = bus.snapshot()
    ids = [a.get("agent_id") for a in snap.get("agents", [])]
    check("快照含 dsh", "dsh" in ids, f"agents={ids}")
    entry = next((a for a in snap["agents"] if a["agent_id"] == "dsh"), {})
    check("快照 phase 合法", entry.get("phase") in dsh.agent_bus_service.PHASES,
          f"phase={entry.get('phase')}")
    check("快照含 capabilities", isinstance(entry.get("capabilities"), dict))


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> int:
    print("=" * 68)
    print("DSH 适配器自检（app.dsh_adapter_selftest）")
    print("=" * 68)
    test_phase_mapping()
    test_parse_event()
    test_sidecar_real_log()
    test_replay_real_events()
    test_helpers()
    test_bus_integration()
    test_step_start_resets_output_flags()
    test_frontend_contract()

    print("\n" + "=" * 68)
    print(f"结果：{PASS} 通过 / {FAIL} 失败")
    if FAILURES:
        print("失败项：")
        for f in FAILURES:
            print(f"  - {f}")
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
