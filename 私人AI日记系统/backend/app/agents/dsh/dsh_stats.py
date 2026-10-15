"""精确统计 README 里引用的数字（此前几个数字是我口算/早期版本得出的，不可复现）。

输出：
  - assistant/message 总数与各类内容块组合分布（用于"纯文字"比例）
  - tool/result 总数、isError 数、data.error 数
  - 并发工具组数（同时 ≥2 个 call 在飞）与峰值并发
  - 有无 turn/end、approval 配对、todo/write、goal/change（夹具覆盖用）

用法（backend 目录下）::

    .venv\\Scripts\\python.exe -m app.dsh_stats
"""
from __future__ import annotations

import sys
from collections import Counter

from . import dsh_adapter as dsh


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

    node = dsh.resolve_node({})
    if not node:
        print("未找到 node")
        return 1

    import app.dsh_fixture_build as fb  # noqa: PLC0415

    events = fb.decode_all(node)
    if not events:
        print("未解码到事件")
        return 1

    print("=" * 74)
    print(f"DSH 真实事件精确统计（共 {len(events)} 条）")
    print("=" * 74)

    types = Counter(e.get("type") or "?" for e in events)
    print("\n事件类型计数：")
    for t, n in types.most_common():
        print(f"  {n:6d}  {t}")

    # --- assistant/message 内容块 ---
    msgs = [e for e in events if e.get("type") == "assistant/message"]
    combos: Counter[tuple[str, ...]] = Counter()
    for e in msgs:
        content = ((e.get("data") or {}).get("message") or {}).get("content") or []
        kinds = tuple(sorted({str(c.get("type")) for c in content if isinstance(c, dict)}))
        combos[kinds] += 1
    text_only = combos.get(("text",), 0)
    with_tool = sum(n for k, n in combos.items() if "tool-call" in k)
    print(f"\nassistant/message 总数 = {len(msgs)}")
    print("  内容块组合分布：")
    for k, n in combos.most_common():
        print(f"    {n:6d}  {k}")
    print(f"  → 纯文字（仅 text，无 tool-call）= {text_only}"
          f"  ({text_only / max(1, len(msgs)) * 100:.2f}%)")
    print(f"  → 含 tool-call = {with_tool}  ({with_tool / max(1, len(msgs)) * 100:.2f}%)")

    # --- tool/result 失败口径 ---
    results = [e for e in events if e.get("type") == "tool/result"]
    is_err = sum(1 for e in results
                 if bool((((e.get("data") or {}).get("message") or {}).get("isError"))))
    has_data_err = sum(1 for e in results if (e.get("data") or {}).get("error") is not None)
    no_iserror_field = sum(
        1 for e in results
        if "isError" not in (((e.get("data") or {}).get("message") or {}))
    )
    print(f"\ntool/result 总数 = {len(results)}")
    print(f"  message.isError == True            = {is_err}")
    print(f"  message 里缺 isError 字段           = {no_iserror_field}")
    print(f"  data.error 存在                     = {has_data_err}")
    calls = types.get("tool/call", 0)
    print(f"tool/call 总数 = {calls}")

    # --- 并发工具组 ---
    ordered = sorted(
        [e for e in events if e.get("type") in {"tool/call", "tool/result"}],
        key=lambda e: e.get("seq") if isinstance(e.get("seq"), int) else 0,
    )
    live = 0
    peak = 0
    groups = 0
    in_group = False
    for e in ordered:
        if e.get("type") == "tool/call":
            live += 1
            peak = max(peak, live)
            if live >= 2 and not in_group:
                groups += 1
                in_group = True
        else:
            live = max(0, live - 1)
            if live < 2:
                in_group = False
    print(f"\n并发工具：峰值同时在飞 = {peak}，'同时≥2 个 call 在飞' 的组数 = {groups}")

    # --- 夹具覆盖相关 ---
    print("\n夹具覆盖相关（这些类型是否存在）：")
    for t in ("turn/end", "approval/asked", "approval/decided", "todo/write",
              "goal/change", "turn/start", "assistant/attempt", "llm/retry"):
        print(f"  {t:20s} {types.get(t, 0)}")

    # --- tool/result 有没有 callId（能否按 id 配对） ---
    keys = Counter()
    for e in results[:200]:
        d = e.get("data") or {}
        for k in d:
            keys[k] += 1
    print(f"\ntool/result 的 data 键（前 200 条）：{dict(keys)}")
    top_keys = Counter()
    for e in results[:200]:
        for k in e:
            top_keys[k] += 1
    print(f"tool/result 的顶层键：{dict(top_keys)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
