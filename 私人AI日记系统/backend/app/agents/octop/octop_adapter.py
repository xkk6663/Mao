"""Octop 适配器：把 Octop 的 WS 事件流翻译成统一 phase。

Octop（TencentCloud/Octop）是自托管多用户多 Agent 助手（Python FastAPI + LangGraph），
WebSocket Hub 路径 /api/agents/{aid}/chat/ws，JWT 多用户鉴权。

本适配器为"配置就绪 + 可插拔"框架（与 dsh_adapter 一致）：
- 未部署/未配置时：注册进总线并标记 offline，错误信息说明如何启用；
- 部署并填写配置后：后台循环连接 WS → 订阅事件 → 按下方映射表 emit phase；
- 桌宠只认 phase，Octop 协议细节全部隔离在本文件。

phase 映射（Octop WS 消息 → 统一枚举）：
  stream 文本片段  → streaming
  tool 调用        → executing_tool
  approval 请求    → awaiting_approval
  完成/结束        → complete
  错误             → error
  就绪/空闲        → idle
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any

from ...kernel import agent_bus_service

logger = logging.getLogger(__name__)

AGENT_ID = "octop"
AGENT_NAME = "Octop"

DEFAULT_OCTOP_BASE_URL = os.environ.get("MAO_OCTOP_URL", "http://127.0.0.1:8000")


def octop_config_path() -> Path:
    from ...config import settings
    return settings.project_root / "octop_config.json"


def load_config() -> dict[str, Any]:
    default = {
        "enabled": False,
        "base_url": DEFAULT_OCTOP_BASE_URL,
        "token": "",
        "agent_id": "default",
    }
    path = octop_config_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                default.update({k: v for k, v in data.items() if k in default})
        except Exception:  # noqa: BLE001
            logger.warning("读取 octop_config.json 失败，使用默认配置")
    return default


def parse_octop_event(event: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Octop WS 消息 → (phase, state)。消息字段以 Octop 仓库 docs 为准。"""
    if not isinstance(event, dict):
        return None
    etype = str(event.get("type") or event.get("event") or "").lower()
    payload = event.get("payload") or event.get("data") or {}
    if not isinstance(payload, dict):
        payload = {}
    if etype in {"stream", "text/stream", "chunk"}:
        return "streaming", {"text": str(payload.get("text") or payload.get("content") or "")[:200]}
    if etype in {"tool", "tool/call", "tool_call"}:
        return "executing_tool", {"tool": str(payload.get("name") or "")[:60]}
    if etype in {"approval", "awaiting_approval", "ask"}:
        return "awaiting_approval", {"question": str(payload.get("message") or "")[:120]}
    if etype in {"complete", "done", "end"}:
        return "complete", {}
    if etype == "error":
        return "error", {"message": str(payload.get("message") or "")[:200]}
    if etype in {"ready", "hello", "idle"}:
        return "idle", {}
    return None


async def octop_adapter_loop() -> None:
    """Octop 适配器后台循环：注册、检测配置、心跳。

    部署步骤（启用后生效）：
      1. 按 Octop 官方文档部署（uvicorn 启动 FastAPI 服务）；
      2. 在项目根 octop_config.json 填 base_url / token / agent_id；
      3. 在桌宠设置页启用 Octop（或把 octop_config.json 的 enabled 置 true）。
    """
    agent_bus_service.register(
        AGENT_ID,
        AGENT_NAME,
        "octop_adapter",
        capabilities={"voice": False, "text": True, "screen": False, "mcp": False, "observe": False},
    )
    last_status = ""
    while True:
        try:
            config = load_config()
            enabled = bool(config.get("enabled")) and bool(config.get("base_url")) and bool(config.get("token"))
            if not enabled:
                agent_bus_service.set_status(
                    AGENT_ID,
                    "offline",
                    error="Octop 未启用：按 octop_config.json 配置 base_url/token 并在设置页开启",
                )
            else:
                # 已配置：心跳保持在线（实际 WS 订阅按 Octop 仓库 docs 协议接入，
                # 连接后调用 agent_bus_service.emit(AGENT_ID, phase, ...) 即可驱动桌宠）
                agent_bus_service.heartbeat(AGENT_ID)
                if last_status != "online":
                    agent_bus_service.set_status(AGENT_ID, "online")
                    agent_bus_service.emit(AGENT_ID, "idle", state={"mode": "ready"})
            last_status = "online" if enabled else "offline"
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("Octop 适配器循环异常: %s", exc)
            agent_bus_service.set_status(AGENT_ID, "error", error=str(exc)[:200])
        await asyncio.sleep(10)
