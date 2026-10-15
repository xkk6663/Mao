"""缺口分析：把真实 DSH 事件全量喂进边车的折叠逻辑，找出未处理的事件类型。

做法：复用 dsh_fixture_build 的解码器拿到全部真实事件，统计类型分布，
并对照 dsh_log_stream.mjs 里 foldEvent 的 case 分支，列出"真实出现过但折叠
逻辑没处理"的类型——这些是潜在的状态盲区。

用法（backend 目录下）::

    .venv\\Scripts\\python.exe -m app.dsh_gap_analysis
"""
from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

from .agents.dsh import dsh_adapter as dsh


def handled_types_from_sidecar() -> set[str]:
    """从边车源码里解析 foldEvent 实际处理的事件类型。"""
    src = Path(dsh.__file__).with_name(dsh.SIDECAR_NAME).read_text(encoding="utf-8")
    m = re.search(r"function foldEvent\(prev, ev\)\s*\{(.*?)\n\}", src, re.S)
    if not m:
        return set()
    body = m.group(1)
    # case 'x': / case 'a': case 'b':
    return set(re.findall(r"case '([^']+)'", body))


def main() -> int:
    node = dsh.resolve_node({})
    if not node:
        print("未找到 node，无法分析")
        return 1

    import app.dsh_fixture_build as fb  # noqa: PLC0415

    events = fb.decode_all(node)
    if not events:
        print("未解码到事件")
        return 1

    counts: Counter[str] = Counter(e.get("type") or "?" for e in events)
    handled = handled_types_from_sidecar()

    print("=" * 72)
    print(f"DSH 事件缺口分析（真实事件 {len(events)} 条，{len(counts)} 种类型）")
    print("=" * 72)
    print(f"折叠逻辑处理 {len(handled)} 种：{sorted(handled)}\n")

    unknown = [(t, n) for t, n in counts.most_common() if t not in handled and t != "session"]
    known = [(t, n) for t, n in counts.most_common() if t in handled]

    print(f"已处理类型（{len(known)} 种，共 {sum(n for _, n in known)} 条）：")
    for t, n in known:
        print(f"  {n:6d}  {t}")

    print(f"\n未处理类型（{len(unknown)} 种，共 {sum(n for _, n in unknown)} 条）：")
    for t, n in unknown:
        print(f"  {n:6d}  {t}")

    # 未处理类型里哪些可能影响工作状态？
    IMPACTFUL = {
        "goal/change": "目标变更 → 可视为 planning",
        "plan/mode": "计划模式切换 → planning",
        "command/run": "用户执行斜杠命令 → 用户交互",
        "command/done": "命令结束",
        "todo/write": "待办写入 → planning",
        "compaction/start": "上下文压缩开始 → thinking",
        "compaction/end": "压缩结束",
        "error": "运行级错误 → error",
        "tool/ptc-dispatch": "PTC 工具分发",
        "tool/ptc-dispatch-start": "PTC 工具分发开始 → executing_tool",
        "subagent/catalog": "子会话登记（不影响主会话状态）",
        "subagent/descriptor": "子会话描述（同上）",
        "model/selection": "模型切换（不影响工作状态）",
        "assistant/attempt": "失败的尝试结算 → error（已处理）",
        "session-log-deepseek/delivery-accepted": "插件注入的投递回执（非核心协议）",
        "request/header": "请求头",
        "request/context": "请求上下文",
        "permission/preset": "权限预设",
        "sandbox/mode": "沙箱模式",
        "approval/policy": "审批策略",
        "system/message": "系统消息",
        "developer/message": "开发者消息",
        "session/title": "会话标题",
        "session/title-llm-request": "标题请求",
        "image/offload": "图片卸载",
        "user/message": "用户消息（已处理）",
        "agent/inbox/spliced": "收件箱注入（已处理）",
    }
    print("\n未处理但可能影响状态判断的类型：")
    risky = [(t, n) for t, n in unknown if t in IMPACTFUL and n > 0]
    if risky:
        for t, n in risky:
            print(f"  {n:6d}  {t}  —— {IMPACTFUL[t]}")
    else:
        print("  （无）")

    print("\n未处理且确认无关的类型（协议元数据/子会话/标题等）：")
    for t, n in unknown:
        if t not in IMPACTFUL:
            print(f"  {n:6d}  {t}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
