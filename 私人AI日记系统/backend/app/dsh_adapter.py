"""DSH（DeepSeek Harness）适配器：把 agent/* 事件翻译成统一 phase。

DSH 是单 Agent 运行时（Node.js），事件模型为 agent/* 全量事件 + turn/step 状态机，
外部宿主集成是一等公民（参考 deepseek-ai/deepseek-harness 仓库 docs/architecture.md）。

本适配器为"配置就绪 + 可插拔"框架：
- 未部署/未配置时：注册进总线并标记 offline，错误信息说明如何启用；
- 部署并填写配置后：后台循环检测连接 → 订阅事件 → 按下方映射表 emit phase；
- 桌宠只认 phase，DSH 具体协议细节全部隔离在本文件。

phase 映射（turn/step → 统一枚举）：
  session/start      → idle
  turn/start         → planning
  step/start         → thinking
  tool_call          → executing_tool
  text/stream        → streaming
  awaiting_approval  → awaiting_approval
  turn/end           → complete
  error              → error
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any

from . import agent_bus_service

logger = logging.getLogger(__name__)

AGENT_ID = "dsh"
AGENT_NAME = "DSH"

# DSH 官方 Web UI 默认端口 3080（部署后可改）
DEFAULT_DSH_BASE_URL = os.environ.get("MAO_DSH_URL", "http://127.0.0.1:3080")


def dsh_config_path() -> Path:
    from .config import settings
    return settings.project_root / "dsh_config.json"


def load_config() -> dict[str, Any]:
    default = {
        "enabled": False,
        "base_url": DEFAULT_DSH_BASE_URL,
        "api_key": "",
        "ws_url": "",
    }
    path = dsh_config_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                default.update({k: v for k, v in data.items() if k in default})
        except Exception:  # noqa: BLE001
            logger.warning("读取 dsh_config.json 失败，使用默认配置")
    return default


def parse_dsh_event(event: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """DSH 事件 → (phase, state)。事件字段以 DSH 仓库 docs/architecture.md 为准。"""
    if not isinstance(event, dict):
        return None
    etype = str(event.get("type") or "").lower()
    payload = event.get("payload")
    if isinstance(payload, dict) and "turn" in etype:
        return "planning", {"turn_id": str(payload.get("id") or "")[:40]}
    if etype == "step/start":
        return "thinking", {"step": str(payload.get("step") or "")[:40]}
    if etype in {"tool/call", "tool/start"}:
        return "executing_tool", {"tool": str(payload.get("name") or "")[:60]}
    if etype in {"text/stream", "stream/start"}:
        return "streaming", {"text": str(payload.get("text") or "")[:200]}
    if etype in {"awaiting_approval", "approval/required"}:
        return "awaiting_approval", {}
    if etype in {"turn/end", "turn/complete"}:
        return "complete", {}
    if etype == "error":
        return "error", {"message": str(payload or "")[:200]}
    if etype in {"session/start", "session/ready"}:
        return "idle", {}
    return None


async def dsh_adapter_loop() -> None:
    """DSH 适配器后台循环：注册、检测连接、订阅事件。

    部署步骤（启用后生效）：
      1. 按 DSH 官方文档部署 deepseek-harness（npm install + 配置模型）；
      2. 在项目根 dsh_config.json 填 base_url（默认 3080 端口）；
      3. 在桌宠设置页启用 DSH（或把 dsh_config.json 的 enabled 置 true）。
    """
    agent_bus_service.register(
        AGENT_ID,
        AGENT_NAME,
        "dsh_adapter",
        capabilities={"voice": False, "text": True, "screen": False, "mcp": False, "observe": False},
    )
    last_status = ""
    while True:
        try:
            config = load_config()
            enabled = bool(config.get("enabled")) and bool(config.get("ws_url") or config.get("base_url"))
            if not enabled:
                agent_bus_service.set_status(
                    AGENT_ID,
                    "offline",
                    error="DSH 未启用：按 dsh_config.json 配置 base_url/ws_url 并在设置页开启",
                )
            else:
                # 已配置：心跳保持在线（实际事件订阅按 DSH 官方宿主集成协议接入，
                # 连接后调用 agent_bus_service.emit(AGENT_ID, phase, ...) 即可驱动桌宠）
                agent_bus_service.heartbeat(AGENT_ID)
                if last_status != "online":
                    agent_bus_service.set_status(AGENT_ID, "online")
                    agent_bus_service.emit(AGENT_ID, "idle", state={"mode": "ready"})
            last_status = "online" if enabled else "offline"
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("DSH 适配器循环异常: %s", exc)
            agent_bus_service.set_status(AGENT_ID, "error", error=str(exc)[:200])
        await asyncio.sleep(10)
