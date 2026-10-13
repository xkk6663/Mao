"""小智官方云（xiaozhi.me）接入代理。

- GET  /api/xiaozhi/status  设备绑定状态
- WS   /api/xiaozhi/ws      双向代理：浏览器 <-> 官方云 wss://api.tenclass.net/xiaozhi/v1/
                            官方云下发的裸 Opus 帧由本端 PyAV 解码为 48kHz 双声道 float32 PCM
                            二进制消息格式：4B 样本数 + 4B 声道数 + ch0 float32 + ch1 float32

单例上游：官方云同一设备只允许一条连接，故代理全局共享一条上游连接，
所有浏览器连接 attach 到它；上游消息只转发给“最近活跃”的浏览器连接。
"""
from __future__ import annotations

import asyncio
import base64
import ctypes
import io
import json
import logging
import os
import re
import subprocess
import tempfile
import struct
import time
import uuid
import urllib.request
import wave
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

import av
import numpy as np
import websockets
from websockets.asyncio.client import connect as ws_async_connect
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/xiaozhi", tags=["xiaozhi"])

XIAOZHI_UPSTREAM = os.getenv("MIO_XIAOZHI_UPSTREAM", "wss://api.tenclass.net/xiaozhi/v1/")

# 项目根 = 本文件 (backend/app/routes/) 向上 4 级；发布版解压到任意目录均可运行
_PROJECT_ROOT = Path(__file__).resolve().parents[4]

_env_device = os.getenv("MIO_XIAOZHI_DEVICE_JSON", "").strip()
DEVICE_JSON = Path(_env_device) if _env_device else (_PROJECT_ROOT / "xiaozhi_device.json")

# ---- 图片识别 / 屏幕观察 前置提示词（可编辑、持久化到 JSON）----
_env_prompts = os.getenv("MIO_XIAOZHI_PROMPTS_FILE", "").strip()
PROMPTS_FILE = Path(_env_prompts) if _env_prompts else (_PROJECT_ROOT / "xiaozhi_prompts.json")

_prompt_defaults = {
    "image_prompt": "请详细描述这张图片里的内容。",
    "observe_prompt": "用调侃吐槽的语气，用60字以内的简洁口语评价我屏幕上正在做的事。",
    "force_60": True,  # 是否强制追加"（请用60字以内的简洁口语回答）"
}
_prompt_cfg: dict = dict(_prompt_defaults)


def _load_prompts() -> None:
    global _prompt_cfg
    try:
        if PROMPTS_FILE.exists():
            data = json.loads(PROMPTS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                merged = dict(_prompt_defaults)
                merged.update({k: v for k, v in data.items() if k in _prompt_defaults})
                _prompt_cfg = merged
    except Exception:  # noqa: BLE001
        logger.warning("读取提示词配置失败，使用默认值", exc_info=True)


def _save_prompts() -> None:
    try:
        PROMPTS_FILE.write_text(json.dumps(_prompt_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:  # noqa: BLE001
        logger.warning("保存提示词配置失败: %s", exc_info=True)


_load_prompts()

OPUS_PCM_RATE = 48000
OPUS_PCM_CHANNELS = 2

HELLO = {
    "type": "hello",
    "version": 1,
    "transport": "websocket",
    "audio_params": {"format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60},
    "features": {"mcp": True},
}

# ---- 全局单例上游状态 ----
_upstream: websockets.asyncio.client.ClientConnection | None = None
_upstream_lock = asyncio.Lock()
_inject_lock = asyncio.Lock()  # 注入串行化：同一时刻只允许一个注入进行（连续快速发消息时官方只响应一次）
_session_id: str | None = None
_subscribers: dict[WebSocket, float] = {}  # ws -> last_active_ts
_sub_queues: dict[WebSocket, asyncio.Queue] = {}  # ws -> 发送队列（保序）
_sub_roles: dict[WebSocket, str] = {}  # ws -> 'main'(桌宠本体，唯一音频播放者) / 'chat'(对话窗口，只收文本)
_active_ws: WebSocket | None = None
_vision: dict | None = None  # 小智官方云下发的视觉能力 {"url": str, "token": str}
_tts_playing: bool = False  # 官方 TTS 是否正在播放（只在播放中才发 abort，避免无意义中断触发官方"播放被中断"问候）
_MCP_STATS = {"initialize": 0, "tools_list": 0, "tools_call": 0, "send_ok": 0, "send_fail": 0}

# ---- MCP 设备工具（官方协议：JSON-RPC 2.0 封装在 type=mcp 消息里）----
# 小智官方云是 MCP client（调用设备工具），本端（桌宠后端）是 MCP server（注册/执行工具）。
# 官方云在 hello 后发 MCP initialize（含 capabilities.vision{url,token}），随后可发 tools/list / tools/call。
# 视觉识别正确姿势（对齐官方 esp_xiaozhi 组件）：识别文本作为 tools/result 回灌官方 LLM，
# 由官方 LLM 组织回答 → 官方 TTS 合成音频 → 官方音色语音。
_MCP_SERVER_INFO = {"name": "mao-desktop-pet", "version": "2.5.0"}
_MCP_PROTOCOL_VERSION = "2025-03-26"

# ================= MCP 工具注册表（配置驱动，可在管理页按需开关） =================
# 每个工具：name / description(提示 LLM 何时调用) / inputSchema / handler(异步函数名) /
#           default_enabled(默认开关) / category(管理页分组) / config(工具级配置项)
_MCP_TOOLS_FILE = (
    Path(os.getenv("MIO_XIAOZHI_MCP_TOOLS_FILE", "").strip())
    if os.getenv("MIO_XIAOZHI_MCP_TOOLS_FILE", "").strip()
    else (_PROJECT_ROOT / "xiaozhi_mcp_tools.json")
)

_MCP_TOOLS_DEF: list[dict] = [
    {
        "name": "self.camera.explain",
        "description": (
            "拍一张屏幕截图/查看一张图片并用视觉模型识别其中的内容。"
            "当用户让你\"看看屏幕\"、\"看看我的屏幕\"、\"看看这张图片/这张图\"、"
            "\"描述屏幕上正在显示的内容\"、\"识别图片内容\"、\"评价/锐评屏幕或画面上的内容\"、"
            "\"看看我正在做什么\"，或询问屏幕上正在做什么、当前画面是什么时调用。"
            "参数 question: 想针对截图/图片问的问题（可选，缺省自动描述内容）。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "针对截图/图片的具体问题，缺省自动描述图片内容",
                }
            },
            "required": [],
        },
        "handler": "_exec_screen_explain",
        "default_enabled": True,
        "category": "视觉",
    },
    {
        "name": "self.clock.get_time",
        "description": "获取当前日期、星期和准确时间。用户问\"现在几点\"、\"今天几号\"、\"星期几\"、\"什么时间\"时调用。无参数。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
        "handler": "_mcp_clock_get_time",
        "default_enabled": True,
        "category": "基础",
    },
    {
        "name": "self.system.get_info",
        "description": "获取电脑系统状态：CPU 负载、内存占用、系统运行时长、操作系统名称。用户问\"电脑卡不卡\"、\"内存够不够\"、\"电脑状态\"、\"系统运行多久了\"时调用。无参数。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
        "handler": "_mcp_system_get_info",
        "default_enabled": True,
        "category": "基础",
    },
    {
        "name": "self.weather.get",
        "description": "查询城市实时天气：温度、体感、天气现象、湿度、风速。用户问\"今天天气怎么样\"、\"外面冷不冷\"、\"会不会下雨\"、\"广州天气\"时调用。参数 city: 城市名（可选，缺省用配置的默认城市）。",
        "inputSchema": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "城市名，如\"广州\""}},
            "required": [],
        },
        "handler": "_mcp_weather_get",
        "default_enabled": True,
        "category": "资讯",
        "config": {"weather_city": "广州"},
    },
    {
        "name": "self.news.get",
        "description": "获取最新新闻头条（社会/科技/财经，来自中国新闻网 RSS）。用户说\"有什么新闻\"、\"看看新闻\"、\"今天有什么大事\"、\"读新闻给我听\"时调用。无参数。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
        "handler": "_mcp_news_get",
        "default_enabled": False,
        "category": "资讯",
    },
    {
        "name": "self.music.play",
        "description": "播放本地音乐文件（扫描 xiaozhi_music 目录下的 mp3/wav）。用户说\"放首歌\"、\"放音乐\"、\"播放 xxx\"、\"来点音乐\"时调用。参数 keyword: 想听的歌名/关键词（可选，缺省随机播放）。",
        "inputSchema": {
            "type": "object",
            "properties": {"keyword": {"type": "string", "description": "歌名或关键词，缺省随机"}},
            "required": [],
        },
        "handler": "_mcp_music_play",
        "default_enabled": False,
        "category": "娱乐",
    },
    {
        "name": "self.music.stop",
        "description": "停止当前播放的本地音乐。用户说\"停歌\"、\"别放了\"、\"停止播放\"时调用。无参数。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
        "handler": "_mcp_music_stop",
        "default_enabled": False,
        "category": "娱乐",
    },
    {
        "name": "self.clipboard.get",
        "description": "读取电脑剪贴板当前文本内容。用户问\"剪贴板里是什么\"、\"我复制了什么\"时调用。无参数。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
        "handler": "_mcp_clipboard_get",
        "default_enabled": False,
        "category": "系统",
    },
    {
        "name": "self.clipboard.set",
        "description": "把一段文本写入电脑剪贴板。用户说\"复制 xxx\"、\"帮我复制\"、\"放到剪贴板\"时调用。参数 text: 要写入剪贴板的文本。",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "要写入剪贴板的文本"}},
            "required": ["text"],
        },
        "handler": "_mcp_clipboard_set",
        "default_enabled": False,
        "category": "系统",
    },
    {
        "name": "self.memo.set",
        "description": "记录一条备忘到本地（键值形式，可存提醒事项/待办/小知识）。用户说\"记住 xxx\"、\"记一下\"、\"提醒我 xxx\"、\"存个备忘\"时调用。参数 key: 备忘名称（可选）；text: 备忘内容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "备忘名称，如\"会议时间\"（可选，缺省自动编号）"},
                "text": {"type": "string", "description": "要记住的内容"},
            },
            "required": ["text"],
        },
        "handler": "_mcp_memo_set",
        "default_enabled": False,
        "category": "效率",
    },
    {
        "name": "self.memo.get",
        "description": "列出本地所有备忘。用户问\"你记得什么\"、\"我的备忘\"、\"之前让我记住什么\"时调用。无参数。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
        "handler": "_mcp_memo_get",
        "default_enabled": False,
        "category": "效率",
    },
    {
        "name": "self.memo.delete",
        "description": "删除一条本地备忘。用户说\"删掉备忘 xxx\"时调用。参数 key: 要删除的备忘名称。",
        "inputSchema": {
            "type": "object",
            "properties": {"key": {"type": "string", "description": "要删除的备忘名称"}},
            "required": ["key"],
        },
        "handler": "_mcp_memo_delete",
        "default_enabled": False,
        "category": "效率",
    },
    {
        "name": "self.timer.set",
        "description": "设定一个倒计时提醒，时间到后桌宠会主动说话提醒你。用户说\"X 分钟后提醒我 xxx\"、\"设个计时器\"、\"帮我计时\"时调用。参数 minutes: 倒计时分钟数；message: 提醒内容（可选）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "minutes": {"type": "integer", "description": "倒计时分钟数"},
                "message": {"type": "string", "description": "到点提醒的内容"},
            },
            "required": ["minutes"],
        },
        "handler": "_mcp_timer_set",
        "default_enabled": False,
        "category": "效率",
    },
    {
        "name": "self.timer.cancel",
        "description": "取消所有/指定的倒计时提醒。用户说\"取消提醒\"、\"别提醒了\"时调用。参数 key: 提醒编号（可选，缺省取消全部）。",
        "inputSchema": {
            "type": "object",
            "properties": {"key": {"type": "string", "description": "提醒编号，缺省取消全部"}},
            "required": [],
        },
        "handler": "_mcp_timer_cancel",
        "default_enabled": False,
        "category": "效率",
    },
    {
        "name": "self.web.search",
        "description": "联网搜索最新新闻/资讯（Bing 新闻 RSS，免费）。用户问\"搜索 xxx\"、\"查一下 xxx 的最新消息\"、\"网上怎么说\"、\"金价/股价/热点\"时调用。参数 query: 搜索关键词。",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "搜索关键词"}},
            "required": ["query"],
        },
        "handler": "_mcp_web_search",
        "default_enabled": False,
        "category": "资讯",
    },
    {
        "name": "self.desktop.open_app",
        "description": "打开电脑上的常用应用（白名单：浏览器/记事本/计算器/文件管理器/画图/任务管理器/终端）。用户说\"打开浏览器\"、\"打开记事本\"、\"帮我打开计算器\"时调用。参数 app: 应用名（浏览器/记事本/计算器/文件管理器/画图/任务管理器/终端）。",
        "inputSchema": {
            "type": "object",
            "properties": {"app": {"type": "string", "description": "应用名，如\"浏览器\"\"记事本\"\"计算器\"\"文件管理器\"\"画图\"\"任务管理器\"\"终端\""}},
            "required": ["app"],
        },
        "handler": "_mcp_desktop_open_app",
        "default_enabled": False,
        "category": "系统",
    },
]

_MCP_HANDLERS: dict[str, str] = {t["name"]: t["handler"] for t in _MCP_TOOLS_DEF}
_mcp_enabled: dict[str, bool] = {}  # name -> 用户开关（未记录的用 default_enabled）


def _load_mcp_tools_cfg() -> None:
    global _mcp_enabled
    try:
        if _MCP_TOOLS_FILE.exists():
            data = json.loads(_MCP_TOOLS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("enabled"), dict):
                _mcp_enabled = {str(k): bool(v) for k, v in data["enabled"].items()}
    except Exception:  # noqa: BLE001
        logger.warning("读取 MCP 工具配置失败，使用默认开关", exc_info=True)


_load_mcp_tools_cfg()


def _save_mcp_tools_cfg() -> None:
    try:
        _MCP_TOOLS_FILE.write_text(
            json.dumps({"enabled": _mcp_enabled}, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:  # noqa: BLE001
        logger.warning("保存 MCP 工具配置失败", exc_info=True)


def _mcp_tool_enabled(name: str) -> bool:
    if name in _mcp_enabled:
        return bool(_mcp_enabled[name])
    for t in _MCP_TOOLS_DEF:
        if t["name"] == name:
            return bool(t.get("default_enabled", False))
    return False


def _mcp_enabled_tools() -> list[dict]:
    """tools/list 只返回已开启的工具（管理页开关生效）。"""
    return [t for t in _MCP_TOOLS_DEF if _mcp_tool_enabled(t["name"])]


def _mcp_tool_public(name: str) -> dict | None:
    for t in _MCP_TOOLS_DEF:
        if t["name"] == name:
            return {k: t[k] for k in ("name", "description", "inputSchema")}
    return None


# 用户手动触发（截图提问/立即观察/聊天发图）后待工具回调使用的截图：
# {"image_base64": str|None(缺省则工具回调时现截全屏), "question": str(用户配置的识别提示词)}
_pending_vision: dict | None = None
# 最近一次用户手动发图副本（工具被官方 LLM 连续调用多次时复用同一张图，60s 窗口）：
_last_vision_image: dict | None = None


class _UpstreamGoodbye(Exception):
    """官方云主动结束会话（如 LLM 说"拜拜"后官方发 goodbye）。
    捕获后立即断开并重连，保持长连接待命，缩短用户感知的断连空窗。"""


class VisionRequest(BaseModel):
    image_base64: str = ""
    question: str = ""
    kind: str = "image"  # "image"=图片识别（用 image_prompt） / "observe"=屏幕观察（用 observe_prompt）


class XiaozhiSayRequest(BaseModel):
    text: str


# ---- 随机屏幕观察（冷不丁评价）----
_observe_cfg: dict = {
    "enabled": False,
    "min_seconds": 300,      # 默认 5–15 分钟随机
    "max_seconds": 900,
    "quiet_start": "23:00",  # 夜间免打扰
    "quiet_end": "08:00",
    "prompt": "用调侃吐槽的语气，用60字以内的简洁口语评价我屏幕上正在做的事。",
}
_observe_next_at: float = 0.0
_observe_task: asyncio.Task | None = None
_observe_lock = asyncio.Lock()
_observe_last_result: str = "尚未触发"
_OBSERVE_CFG_FILE = _PROJECT_ROOT / "xiaozhi_observe.json"


def _load_observe_cfg() -> None:
    """启动时从文件恢复自动观察配置（间隔/免打扰/开关），重启不丢。"""
    global _observe_next_at
    try:
        if _OBSERVE_CFG_FILE.exists():
            with open(_OBSERVE_CFG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                for k in ("enabled", "min_seconds", "max_seconds", "quiet_start", "quiet_end", "prompt"):
                    if k in data:
                        _observe_cfg[k] = data[k]
        # 重启前观察开启中 → 恢复排程（按用户设置的间隔随机排首次，避免 20 秒后立即触发一次"误观察"）
        if _observe_cfg.get("enabled"):
            import random as _random
            _lo = max(60, int(_observe_cfg.get("min_seconds") or 300))
            _hi = max(_lo + 60, int(_observe_cfg.get("max_seconds") or 900))
            _observe_next_at = time.time() + _random.randint(_lo, _hi)
    except Exception as exc:  # noqa: BLE001
        logger.warning("加载自动观察配置失败: %s", exc)


def _save_observe_cfg() -> None:
    """持久化自动观察配置（enabled/间隔/免打扰），重启不丢。"""
    try:
        with open(_OBSERVE_CFG_FILE, "w", encoding="utf-8") as f:
            json.dump(_observe_cfg, f, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        logger.warning("保存自动观察配置失败: %s", exc)


_load_observe_cfg()


class ObserveRequest(BaseModel):
    enabled: bool | None = None
    min_seconds: int | None = None
    max_seconds: int | None = None
    quiet_start: str | None = None
    quiet_end: str | None = None
    prompt: str | None = None


def _in_quiet_hours(now: time.struct_time | None = None) -> bool:
    now = now or time.localtime()
    hm = f"{now.tm_hour:02d}:{now.tm_min:02d}"
    start = str(_observe_cfg.get("quiet_start") or "23:00")
    end = str(_observe_cfg.get("quiet_end") or "08:00")
    if start < end:
        return start <= hm < end
    return hm >= start or hm < end  # 跨午夜


def _pick_next_observe_at() -> float:
    import random as _random
    lo = max(60, int(_observe_cfg.get("min_seconds") or 300))
    hi = max(lo + 60, int(_observe_cfg.get("max_seconds") or 900))
    return time.time() + _random.randint(lo, hi)


async def _observe_loop() -> None:
    global _observe_next_at, _observe_last_result, _pending_vision, _last_vision_image
    from ..screen_capture import MssCapture
    while True:
        try:
            if _observe_cfg.get("enabled") and _in_quiet_hours():
                _observe_next_at = time.time() + 120  # 免打扰期间推迟
            elif _observe_cfg.get("enabled") and time.time() >= _observe_next_at:
                try:
                    img = await asyncio.to_thread(_full_screen_jpeg, MssCapture)
                    if img:
                        # 与"立即观察"同一条官方 MCP 工具链路：暂存截图 → 注入触发语
                        # → 官方 LLM 调 self.camera.explain 工具 → 官方视觉识别 → 工具结果回灌
                        # → 官方 TTS（官方音色）语音回答 + 气泡 + 历史（不再旁路只显示文本）
                        question = str(_prompt_cfg.get("observe_prompt") or _prompt_defaults["observe_prompt"])
                        if _prompt_cfg.get("force_60", True) and "字以内" not in question:
                            question = f"{question}（请用60字以内的简洁口语回答）"
                        # 观察截图写入会话历史（同步到聊天界面）
                        _chat_append("user", "image", text="（屏幕观察）", image_base64=img, tag="observe")
                        # 暂存截图 → 注入触发语（官方 LLM 收到后调 self.camera.explain 工具）
                        _pending_vision = {"image_base64": img, "question": question}
                        _last_vision_image = None  # 作废旧图副本：工具调用不得串到上一张图
                        await _reset_upstream_connection()  # 每次观察强制重置会话，确保官方视觉工具可调用
                        trigger = _next_observe_trigger()
                        ok = await _inject_say(trigger, source="vision", confirm_timeout=8.0)
                        if ok:
                            _observe_last_result = "已触发官方观察（工具链路） · " + str(trigger)[:30]
                        else:
                            _observe_last_result = "观察失败：小智连接不可用"
                    else:
                        _observe_last_result = "观察失败：截屏失败"
                except Exception as exc:  # noqa: BLE001
                    _observe_last_result = "观察失败：" + str(exc)[:60]
                    logger.warning("随机观察触发失败: %s", exc)
                _observe_next_at = _pick_next_observe_at()
        except Exception as exc:  # noqa: BLE001
            logger.warning("观察循环异常: %s", exc)
        await asyncio.sleep(15)


def _full_screen_jpeg(capture_cls) -> str | None:
    try:
        import base64 as _b64
        import io as _io
        cap = capture_cls()
        img = cap.capture(all_screens=True).convert("RGB")
        img.thumbnail((1280, 720))
        buf = _io.BytesIO()
        img.save(buf, "JPEG", quality=80)
        return _b64.b64encode(buf.getvalue()).decode()
    except Exception as exc:  # noqa: BLE001
        logger.warning("观察截屏失败: %s", exc)
        return None


async def _broadcast_observe_bubble(text: str) -> None:
    """把视觉分析文本广播为 speech-bubble 事件 → 桌宠显示气泡并自动消失（与截图提问一致）。
    不注入官方（视觉仅返回文本；注入会触发唤醒/官方主动结束，且官方无独立 TTS 朗读分析文本）。"""
    try:
        from .. import pet_event_service  # 延迟导入避免循环依赖

        pet_event_service.publish("speech-bubble", {
            "text": str(text or ""),
            "emotion": "gentle",
            "motion_hint": "observe",
            "duration_ms": 6000,
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("广播观察气泡失败: %s", exc)


_last_wake_ts: float = 0.0  # 上次唤醒时间戳（保留兼容；会话级免唤醒见 _session_wake_done）
_session_wake_done: bool = False  # 本次官方会话是否已唤醒过（长连接只唤醒一次，断线重连重置）
_last_tts_stop: float = 0.0  # 上游最后一次 TTS 播完时间戳（用于判断唤醒回复是否已完整播完）
_last_stt_ts: float = 0.0    # 上游最后一次 STT 识别时间戳（用于确认注入的语音是否被官方云识别）
_last_stt_text: str = ""     # 上游最后一次 STT 识别文本
_llm_text: str = ""          # 上游最后一次 LLM 回答文本（回声过滤用）
_tts_sentences: list[str] = []   # 当前一段 TTS 的分句文本累积（tts stop 时拼接为完整回复写入历史）
_pending_llm_text: str = ""      # LLM 完整文本暂存（tts stop 时若 TTS 无分句则回退使用；不逐帧写历史）
_last_injected_text: str = ""  # 最近一次内部注入（vision/observe）的文本（STT 匹配即丢弃，不写"你说"历史）
_inject_stt_suppress_until: float = 0.0  # 内部注入（vision/observe）后 STT 写入"你说"历史的抑制截止时间


def _is_injected_stt(stt_text: str) -> bool:
    """注入文本过滤：内部注入（vision/observe）的语音被官方 STT 识别回传时，
    与最近注入文本相同/互相包含 → 判定为注入回声，不写入"你说"历史。
    比时间窗口可靠（官方 STT 延迟可能超过窗口）。"""
    global _last_injected_text
    if not stt_text or not _last_injected_text:
        return False
    a, b = stt_text.strip(), _last_injected_text.strip()
    if not a or not b:
        return False
    if len(b) >= 6 and (a == b or a in b or b in a):
        return True
    if len(b) >= 10 and (a.startswith(b[:10]) or b.startswith(a[:10])):
        return True
    return False


def _is_echo_stt(stt_text: str) -> bool:
    """回声过滤：官方云会把 AI 自己的回答（TTS 播放声）识别成"用户语音"回传 stt，
    与最近一次 LLM 回答文本相同/互相包含时判定为回声，不写入"你说"历史。"""
    global _llm_text
    if not stt_text or not _llm_text:
        return False
    a, b = stt_text.strip(), _llm_text.strip()
    if not a or not b:
        return False
    if len(b) >= 8 and (a == b or a in b or b in a):
        return True
    # 较长的 LLM 回答被 STT 截断时，前缀/后缀高度重合也判为回声
    if len(b) >= 12 and (a.startswith(b[:12]) or b.startswith(a[:12])):
        return True
    return False

# ---- 会话历史（长连接建立以来的所有来往记录，文字/图片；持久化到文件，重启不丢）----
# 每条: {id, ts, role(user/pet/system), type(text/image), text, image_base64, tag(chat/observe/screenshot/stt/llm/vision/sys)}
_CHAT_HISTORY_MAX = 1000
_hist_seq = 0  # 历史条目唯一 id 计数器（前端按 id 去重，避免同文本/同秒误去重丢记录）
_env_history = os.getenv("MIO_CHAT_HISTORY_FILE", "").strip()
CHAT_HISTORY_FILE = Path(_env_history) if _env_history else (_PROJECT_ROOT / "xiaozhi_chat_history.json")
_chat_history: list[dict] = []
_history_save_task: asyncio.Task | None = None


def _load_chat_history() -> None:
    """启动时从文件加载历史（图片 base64 可能很大，加载时截断大字段以保内存）。
    旧文件条目 id 可能冲突/缺失（多次重启防抖未落盘导致）→ **一律按序重建单调唯一 id**，
    消除 id 撞车后前端按 id 去重误吞新消息的问题。"""
    global _chat_history, _hist_seq
    try:
        if CHAT_HISTORY_FILE.exists():
            with open(CHAT_HISTORY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                items = [it for it in data if isinstance(it, dict)][-_CHAT_HISTORY_MAX:]
                _hist_seq = 0
                for it in items:
                    _hist_seq += 1
                    it["id"] = _hist_seq  # 强制重建，不保留旧 id
                _chat_history = items
    except Exception as exc:  # noqa: BLE001
        logger.warning("加载会话历史失败: %s", exc)
        _chat_history = []


async def _save_chat_history() -> None:
    """防抖保存历史到文件（每批最多 2s 一次）。"""
    global _history_save_task
    try:
        while True:
            await asyncio.sleep(2)
            try:
                with open(CHAT_HISTORY_FILE, "w", encoding="utf-8") as f:
                    json.dump(_chat_history, f, ensure_ascii=False)
            except Exception as exc:  # noqa: BLE001
                logger.warning("保存会话历史失败: %s", exc)
    except asyncio.CancelledError:
        pass


def _chat_append(role: str, type_: str, text: str = "", image_base64: str | None = None, tag: str = "") -> None:
    """写入会话历史（单线程事件循环内 append 原子，无锁；2s 防抖落盘）。"""
    global _history_save_task, _hist_seq
    # 诊断日志：定位"你说"消息来源（排查分析文本被复述成用户发言）
    if role == "user":
        logger.info("写历史[user] tag=%s type=%s text=%s", tag, type_, str(text)[:60])
    _hist_seq += 1
    _chat_history.append({
        "id": _hist_seq,
        "ts": round(time.time(), 3),
        "role": role,
        "type": type_,
        "text": str(text)[:2000],        "image_base64": image_base64,
        "tag": tag,
    })
    if len(_chat_history) > _CHAT_HISTORY_MAX:
        del _chat_history[: len(_chat_history) - _CHAT_HISTORY_MAX]
    if _history_save_task is None or _history_save_task.done():
        _history_save_task = asyncio.create_task(_save_chat_history())


def _maybe_write_llm_reply(full: str) -> None:
    """写入小智完整回复文本（tag=llm）。与 vision/observe 主动写入去重：
    最近 3 秒内已写过同文本的 pet 记录（tag=vision/observe）→ 跳过，避免同一回复双写。

    同时剥离官方 LLM 内联工具调用标记（%工具名%）：官方云在 LLM 输出里保留
    "% self.camera.explain...%" 工具调用回显，不剥离会被 TTS 念出来并污染聊天历史。"""
    full = (full or "").strip()
    if not full:
        return
    # 剥离成对 %...% 工具调用标记（只删短标记，保护正文中可能的百分号文本）
    full = re.sub(r"%[^%\n]{1,120}%", "", full).strip()
    if not full:
        return
    now = time.time()
    last = _chat_history[-1] if _chat_history else None
    if (
        last
        and last.get("role") == "pet"
        and str(last.get("text") or "")[:120] == full[:120]
        and now - float(last.get("ts") or 0) < 3.0
    ):
        return
    _chat_append("pet", "text", full, tag="llm")


async def _syslog(text: str, tag: str = "sys", quiet: bool = False) -> None:
    """系统时间线消息：写入会话历史（role=system，前端灰色小字显示）+ 广播给所有订阅者。
    让整个小智通信链路（连接/断开/重连/唤醒/识别/说话/视觉）在聊天窗口完全可视化，不再黑箱。
    quiet=True 时只写运行日志、不写历史不广播：用于频繁的连接状态消息（重连/断连），
    避免高频刷屏占用聊天界面空间（用户要求主聊天界面不显示重连/断开）。"""
    if quiet:
        logger.info("sys[quiet]: %s", text)
        return
    _chat_append("system", "text", text, tag=tag)
    await _broadcast(json.dumps({
        "type": "sysmsg",
        "text": str(text)[:300],
        "ts": round(time.time(), 3),
    }, ensure_ascii=False))


# 模块导入时加载历史文件（同步文件读取，无需事件循环）
_load_chat_history()


def _sapi_tts_wav(text: str) -> bytes:
    """Windows SAPI 本地 TTS → 16kHz 16bit mono WAV（零依赖，无需下载）"""
    import comtypes.client
    import comtypes.gen.SpeechLib as SL
    sp = comtypes.client.CreateObject("SAPI.SpVoice")
    # 优先选中文女声（Huihui/Yaoyao 等），音色更接近官方；系统无中文语音包则保持默认
    try:
        for v in sp.GetVoices():
            desc = str(v.GetDescription())
            if any(k in desc for k in ("Huihui", "Yaoyao", "YaoYao", "中文", "Chinese")):
                sp.Voice = v
                break
    except Exception:  # noqa: BLE001
        pass
    fs = comtypes.client.CreateObject("SAPI.SpFileStream")
    fs.Format.Type = SL.SpeechAudioFormatType.SAFT16kHz16BitMono
    tts_tmp = os.path.join(tempfile.gettempdir(), "mio_tts_tmp.wav")
    fs.Open(tts_tmp, 3, False)
    sp.AudioOutputStream = fs
    sp.Speak(text)
    fs.Close()
    with open(tts_tmp, "rb") as f:
        return f.read()


async def _speak_local(text: str, source: str = "vision") -> bool:
    """本地 TTS 合成 → 广播 48kHz 单声道 float32 PCM（桌宠播放+口型）。
    不依赖官方云 ASR：图片分析/屏幕观察的分析文本走本地播放——稳定、长文本完整播放、
    不产生"你说[分析]"回声错乱。"""
    if not text:
        return False
    try:
        wav = await asyncio.to_thread(_sapi_tts_wav, str(text)[:200])
        with wave.open(io.BytesIO(wav), "rb") as w:
            sr = w.getframerate()
            ch = w.getnchannels()
            pcm = w.readframes(w.getnframes())
        arr = np.frombuffer(pcm, dtype=np.int16).reshape(-1, ch)
        if ch == 2:
            arr = arr.mean(axis=1, dtype=np.int16)
        arr = arr.astype(np.int16)
        if sr != 48000:
            resampler = av.AudioResampler(format="s16", layout="mono", rate=48000)
            # PyAV mono 需 planar 布局 (1, samples)；(samples,1) 会被误判为 planar 而报错
            f0 = av.AudioFrame.from_ndarray(arr.reshape(1, -1), format="s16", layout="mono")
            f0.sample_rate = sr
            res = resampler.resample(f0)
            pcm16 = b"".join(bytes(f.planes[0]) for f in res)
        else:
            pcm16 = arr.tobytes()
        f32 = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
        total = int(f32.shape[0])
        if total == 0:
            return False
        await _broadcast_bytes(struct.pack("<II", total, 1) + f32.tobytes())
        logger.info("本地语音播放 source=%s chars=%d samples=%d", source, len(str(text)), total)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("本地语音播放失败: %s", exc)
        return False


def _wav_to_opus_frames(wav_bytes: bytes, samples_per_frame: int = 960) -> list[bytes]:
    """PyAV: WAV → 60ms opus 帧（16kHz mono，官方云 ASR 输入格式）"""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        pcm = w.readframes(w.getnframes())
    arr = np.frombuffer(pcm, dtype=np.int16).reshape(-1, ch)
    if ch == 2:
        arr = arr.mean(axis=1, dtype=np.int16)
    arr = arr.astype(np.int16)
    if sr != 16000:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        f0 = av.AudioFrame.from_ndarray(arr.reshape(1, -1), format="s16", layout="mono")
        f0.sample_rate = sr
        res = resampler.resample(f0)
        pcm16 = b"".join(bytes(f.planes[0]) for f in res)
    else:
        pcm16 = arr.tobytes()
    ctx = av.CodecContext.create("opus", "w")
    ctx.sample_rate = 16000
    ctx.bit_rate = 32000
    ctx.format = "fltp"
    ctx.layout = "mono"
    ctx.open()
    frames = []
    pcm_f = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
    for i in range(0, len(pcm_f), samples_per_frame):
        chunk = pcm_f[i:i + samples_per_frame]
        if len(chunk) < samples_per_frame:
            chunk = np.pad(chunk, (0, samples_per_frame - len(chunk)))
        f = av.AudioFrame(format="fltp", layout="mono", samples=samples_per_frame)
        f.sample_rate = 16000
        f.pts = i // samples_per_frame
        f.planes[0].update(chunk.tobytes())
        for pkt in ctx.encode(f):
            frames.append(bytes(pkt))
    for pkt in ctx.encode(None):
        frames.append(bytes(pkt))
    return frames


async def _send_audio_stream(conn, text: str) -> list[bytes] | None:
    """合成并发送音频流：listen start → opus 帧(+静音尾巴) → listen stop。返回帧列表（None=失败）。

    【静音尾巴】官方云 ASR 靠 VAD 检测"语音结束"（静音段）才触发识别；若发完语音立即
    stop，VAD 未检测到结束，音频会被官方云挂起/缓存到下次 listen 才处理（实测：唤醒后
    首次注入无响应，第二次 say 才识别出第一次的文本）。故语音帧后追加 ~1s 静音，
    让 VAD 判定语音结束并立即触发 ASR。
    """
    try:
        voice = await asyncio.to_thread(_wav_to_opus_frames, _sapi_tts_wav(text))
        # 模拟真实麦克风语音段：前导静音(0.5s) → 语音 → 尾部静音(1s)，
        # 让官方云 VAD 检测到完整"语音开始→结束"边界才触发 ASR
        head = await asyncio.to_thread(_silence_opus_frames, 0.5)
        tail = await asyncio.to_thread(_silence_opus_frames, 1.0)
        opus_frames = head + voice + tail
    except Exception as exc:  # noqa: BLE001
        logger.warning("TTS/编码失败: %s", exc)
        return None
    try:
        # conn.send 加 5s 超时：官方连接半死（TCP 活着但应用层无响应，无心跳感知）时 send 会
        # 永久挂起 → 占用 _inject_lock → 后续所有对话/观察/提问排队阻塞（"卡住后其他功能也用不了"）
        await asyncio.wait_for(conn.send(json.dumps({"type": "listen", "state": "start", "mode": "auto", "session_id": _session_id}, ensure_ascii=False)), timeout=5.0)
        await asyncio.sleep(0.3)
        for f in opus_frames:
            await asyncio.wait_for(conn.send(f), timeout=5.0)
        await asyncio.sleep(0.3)
        await asyncio.wait_for(conn.send(json.dumps({"type": "listen", "state": "stop", "session_id": _session_id}, ensure_ascii=False)), timeout=5.0)
        return opus_frames
    except Exception as exc:  # noqa: BLE001
        logger.warning("音频流发送失败/超时: %s", exc)
        return None


def _silence_opus_frames(seconds: float, samples_per_frame: int = 960) -> list[bytes]:
    """生成 N 秒静音的 opus 帧（16kHz mono 60ms/帧）"""
    ctx = av.CodecContext.create("opus", "w")
    ctx.sample_rate = 16000
    ctx.bit_rate = 32000
    ctx.format = "fltp"
    ctx.layout = "mono"
    ctx.open()
    n = int(seconds * 16000 / samples_per_frame)
    frames = []
    for i in range(n):
        f = av.AudioFrame(format="fltp", layout="mono", samples=samples_per_frame)
        f.sample_rate = 16000
        f.pts = i
        f.planes[0].update(b"\x00\x00\x00\x00" * samples_per_frame)
        for pkt in ctx.encode(f):
            frames.append(bytes(pkt))
    for pkt in ctx.encode(None):
        frames.append(bytes(pkt))
    return frames


async def _wait_stt_confirmed(timeout: float = 8.0) -> bool:
    """等待官方云 STT 识别到非唤醒词文本（确认注入语音已被 ASR 处理）。"""
    global _last_stt_ts, _last_stt_text
    before_ts, before_text = _last_stt_ts, _last_stt_text
    wait_until = time.time() + timeout
    while time.time() < wait_until:
        await asyncio.sleep(0.5)
        if _last_stt_ts > before_ts and _last_stt_text not in ("你好", ""):
            return True
    return False


# 视觉触发语轮换：官方 LLM 对同一会话内重复的用户指令（相同文本）会去重/不重复响应，
# 每次发图/观察用不同短语，让官方认为是新指令（短触发语 ASR 识别率高，长文本会识别成乱码）
_VISION_TRIGGERS = ["请看看这张图片", "请再看看这张图片", "请看看这张新图片", "请仔细观察这张图片", "请再看看这张图吧"]
_OBSERVE_TRIGGERS = ["看看我的屏幕", "再看看我的屏幕", "帮我看看屏幕", "看看我现在屏幕上的内容", "再看看我现在的屏幕"]
_vision_trigger_idx = 0
_observe_trigger_idx = 0


def _next_vision_trigger() -> str:
    global _vision_trigger_idx
    t = _VISION_TRIGGERS[_vision_trigger_idx % len(_VISION_TRIGGERS)]
    _vision_trigger_idx += 1
    return t


def _next_observe_trigger() -> str:
    global _observe_trigger_idx
    t = _OBSERVE_TRIGGERS[_observe_trigger_idx % len(_OBSERVE_TRIGGERS)]
    _observe_trigger_idx += 1
    return t


async def _reset_upstream_connection() -> None:
    """强制断开当前官方连接触发自动重连（新会话 = 干净 LLM 上下文）。
    官方视觉工具只在"新会话"里稳定被调用：同一会话内第一次 tools/call 后，
    后续"看图片"指令官方 LLM 认为图片已在上下文 → 不再调工具 → 回答"没收到图片"。
    实测每次重启后端后第一张图正常、之后全部不调工具，即为此机制。"""
    global _upstream
    conn = _upstream
    if conn is None:
        return
    _upstream = None
    try:
        await conn.close()
    except Exception:  # noqa: BLE001
        pass
    # _pump_upstream 的 finally 会启动 _reconnect_loop（首延 1.5s）自动重连；
    # _inject_say 的 wait_upstream(6s) 会等待重连完成后再注入


async def _inject_say(text: str, wait_upstream: float = 6.0, source: str = "user", confirm_timeout: float = 15.0) -> bool:
    """注入入口：串行化锁（连续快速发消息时官方只响应一次，未加锁会互相 abort 导致吞消息）。
    整体 30s 超时保护：底层卡住（半死连接/STT 无响应）时释放锁，后续注入不被永久阻塞。"""
    async with _inject_lock:
        try:
            return await asyncio.wait_for(_inject_say_impl(text, wait_upstream, source, confirm_timeout), timeout=30.0)
        except asyncio.TimeoutError:
            logger.warning("注入超时(30s)释放锁，跳过本次: %s", str(text)[:30])
            return False


async def _inject_segments(text: str, source: str = "vision") -> bool:
    """把长分析文本分段注入官方（官方 ASR 长音频截断→每段≤60字），
    每段经官方识别→LLM 回答→官方 TTS 播放（官方音色，禁用本地 TTS）。
    官方无独立 TTS 接口，官方音色只能通过"注入→回答"间接获得。"""
    if not text or not text.strip():
        return False
    text = text.strip()
    if len(text) <= 60:
        return await _inject_say(text, source=source)
    # 优先按标点断句，其次按 60 字硬切
    import re as _re
    sentences = _re.split(r"(?<=[。！？!?；;])", text)
    segs: list[str] = []
    cur = ""
    for s in sentences:
        if len(cur) + len(s) <= 60:
            cur += s
        else:
            if cur:
                segs.append(cur)
            while len(s) > 60:
                segs.append(s[:58] + "…")
                s = s[58:]
            cur = s
    if cur:
        segs.append(cur)
    ok_all = True
    for i, seg in enumerate(segs):
        ok = await _inject_say(seg, source=source)
        if not ok:
            ok_all = False
            logger.warning("分段注入第 %d 段失败: %s", i + 1, str(seg)[:30])
        await asyncio.sleep(0.8)  # 段间间隔，避免官方状态机冲突
    return ok_all


async def _inject_say_impl(text: str, wait_upstream: float = 6.0, source: str = "user", confirm_timeout: float = 15.0) -> bool:
    """把文本注入小智会话（模拟用户发言）→ 小智语音/表情/口型联动。
    source: "user"=用户真实输入（STT 识别结果正常写"你说"历史）
            "vision"/"observe"=内部注入（AI 分析文本，STT 结果不写"你说"历史，
            避免"把云端发回的信息当成用户发的"角色错乱）。

    【静默连接·音频流注入】不发唤醒词 detect，直接 listen start → SAPI TTS 合成语音流(opus)
        → listen stop → 官方云 ASR 识别文本 → LLM 回答 → TTS 声音。
    避免每次新会话/断线重连都触发"你好呀今天过得怎么样"唤醒问候。
    只在官方 TTS 播放中才发 abort（避免无意义中断触发官方"播放被中断"问候）。
    """
    global _last_wake_ts, _inject_stt_suppress_until, _session_wake_done, _tts_playing
    # 官方 ASR 对长音频识别会截断（>150字几乎必然失败，只回唤醒问候）：
    # 内部注入（vision/observe 分析文本）强制压到 70 字以内，保证官方完整识别 + 完整语音播放
    if source != "user" and len(text) > 70:
        text = text[:68] + "…"
    conn = _upstream
    if conn is None and wait_upstream > 0:
        deadline = time.time() + wait_upstream
        while time.time() < deadline:
            await asyncio.sleep(1.5)
            conn = _upstream
            if conn is not None:
                break
    if conn is None:
        logger.warning("注入小智语音失败：官方云未连接（hello 未建立）")
        return False
    try:
        # 1. 只在官方 TTS 正在播放时才发 abort（避免无意义中断触发官方"播放被中断，要不要再放一次"问候；
        #    实测 vision 场景无条件 abort 会让官方 LLM 识别触发语却不调视觉工具 → 回答"没收到图片"）
        if _tts_playing:
            await conn.send(json.dumps({"type": "abort", "reason": "user_interrupt", "session_id": _session_id}, ensure_ascii=False))
            await asyncio.sleep(0.3)
            _tts_playing = False
        # 2. 静默连接：不发唤醒词 detect("你好")，直接音频流注入（listen start → 语音 → listen stop），
        #    官方靠 listen start + 音频帧直接 ASR 识别，避免每次新会话/重连都触发"你好呀今天过得怎么样"问候
        # 3. 音频流注入（不重试，避免相同音频被官方识别两次）
        frames = await _send_audio_stream(conn, text)
        if not frames:
            # 发送失败/超时 → 官方连接可能半死（无心跳感知），主动断开触发自动重连
            asyncio.create_task(_reset_upstream_connection())
            return False
        await _syslog(f"🎤 已发送语音「{str(text)[:40]}」等待官方识别…")
        # 4. 等 STT 确认（超时按场景：vision 8s 快速返回，普通注入 15s；不重试，避免相同音频被官方识别两次）
        confirmed = await _wait_stt_confirmed(confirm_timeout)
        if confirmed:
            await _syslog("🧠 官方已识别语音，小智正在思考回答…")
        else:
            logger.warning("注入后 15s 内未收到官方 STT 确认（文本可能未被识别）: %s", str(text)[:40])
        logger.info("注入小智语音成功(音频流 %d 帧): %s", len(frames), str(text)[:40])
        # 内部注入（vision/observe）：接下来官方 STT 识别到的文本是注入内容本身，
        # 不应写入"你说"历史（否则 AI 分析文本被当成用户发言）。记录注入文本 + 抑制窗口 60s 兜底。
        if source != "user":
            _last_injected_text = text
            _inject_stt_suppress_until = time.time() + 60.0
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("注入小智对话失败: %s", exc)
        return False


async def _ensure_observe_task() -> None:
    global _observe_task
    async with _observe_lock:
        if _observe_task is None or _observe_task.done():
            _observe_task = asyncio.create_task(_observe_loop())


@router.get("/observe/status")
async def xiaozhi_observe_status() -> dict:
    await _ensure_observe_task()
    return {**_observe_cfg, "next_in_seconds": max(0, int(_observe_next_at - time.time())), "last_result": _observe_last_result}


@router.post("/observe/start")
async def xiaozhi_observe_start(payload: ObserveRequest) -> dict:
    global _observe_next_at
    _observe_cfg["enabled"] = True
    if payload.min_seconds is not None:
        _observe_cfg["min_seconds"] = max(60, int(payload.min_seconds))
    if payload.max_seconds is not None:
        _observe_cfg["max_seconds"] = max(int(_observe_cfg["min_seconds"]) + 60, int(payload.max_seconds))
    if payload.quiet_start is not None:
        _observe_cfg["quiet_start"] = str(payload.quiet_start)[:5]
    if payload.quiet_end is not None:
        _observe_cfg["quiet_end"] = str(payload.quiet_end)[:5]
    if payload.prompt:
        _observe_cfg["prompt"] = str(payload.prompt)[:300]
        # 同步到持久化提示词配置（管理面板编辑屏幕观察提示词走同一条链路）
        _prompt_cfg["observe_prompt"] = str(payload.prompt)[:300]
        _save_prompts()
    _save_observe_cfg()
    _observe_next_at = time.time() + 20  # 首次 20 秒后即可触发（便于测试）
    await _ensure_observe_task()
    return {**_observe_cfg, "next_in_seconds": 20}


@router.post("/observe/stop")
async def xiaozhi_observe_stop() -> dict:
    _observe_cfg["enabled"] = False
    _save_observe_cfg()
    return {**_observe_cfg, "next_in_seconds": 0}


@router.post("/say")
async def xiaozhi_say(payload: XiaozhiSayRequest) -> dict:
    """把文本注入小智会话（模拟用户发言）→ 小智语音/表情/口型联动。"""
    text = str(payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="文本不能为空")
    _chat_append("user", "text", text, tag="chat")
    ok = await _inject_say(text)
    if not ok:
        raise HTTPException(status_code=409, detail="注入失败：小智连接不可用")
    return {"ok": True, "text": text}


def _capture_vision_from_mcp(payload) -> None:
    """从服务器下发的 MCP initialize 中捕获视觉能力（vision url + token）。

    兼容多种下发结构（实测小智协议偶有嵌套差异），并记录原始 payload 供诊断。
    """
    global _vision
    try:
        raw = payload if isinstance(payload, dict) else (json.loads(payload) if payload else {})
        # 结构 A: payload.params.capabilities.vision
        params = (raw.get("params") or {}) if isinstance(raw, dict) else {}
        caps = (params.get("capabilities") or {}) if isinstance(params, dict) else {}
        # 结构 B: payload.capabilities.vision
        if not isinstance(caps, dict) or not caps.get("vision"):
            caps = raw.get("capabilities") or {}
        vision = caps.get("vision") if isinstance(caps, dict) else None
        if isinstance(vision, dict) and vision.get("url"):
            _vision = {"url": str(vision["url"]), "token": str(vision.get("token") or "")}
            logger.info("已捕获小智视觉能力: %s", _vision["url"])
        else:
            # 诊断：记录 mcp 顶层键与 capabilities 键，便于判断服务器是否下发视觉
            top_keys = sorted(raw.keys()) if isinstance(raw, dict) else []
            cap_keys = sorted(caps.keys()) if isinstance(caps, dict) else []
            logger.info(
                "MCP initialize 未发现 vision（顶层键=%s，capabilities键=%s）",
                top_keys, cap_keys,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("解析 MCP vision 失败: %s", exc)


def _vision_explain_sync(image_base64: str, question: str) -> str:
    """同步调用小智 vision/explain（multipart: file + question），返回分析文本。"""
    vision = _vision
    if not vision or not vision.get("url"):
        raise RuntimeError("小智视觉能力不可用（尚未建立小智连接或未下发 vision 能力）")
    try:
        import io as _io
        from PIL import Image as _PILImage
        raw = base64.b64decode(image_base64)
        # 任意图片格式（PNG/WebP/BMP/JPEG）统一转 JPEG：官方视觉接口要求 image/jpeg，
        # 前端聊天发图可能是 PNG，直接按 JPEG 上传会解码失败导致工具报"连不上"
        img = _PILImage.open(_io.BytesIO(raw)).convert("RGB")
        img.thumbnail((1280, 720))
        buf = _io.BytesIO()
        img.save(buf, "JPEG", quality=80)
        jpeg = buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"图片解析/转换失败（需为有效图片）: {exc}") from exc
    boundary = "----XZ" + uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="question"\r\n\r\n{question}\r\n'.encode("utf-8"),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="frame.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode("utf-8"),
        jpeg,
        f"\r\n--{boundary}--\r\n".encode("utf-8"),
    ]
    req = urllib.request.Request(
        vision["url"],
        data=b"".join(parts),
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {vision.get('token') or ''}",
        },
    )
    # 网络偶发 DNS/连接失败：重试 2 次（间隔 2s），单次 20s 超时，避免视觉请求长时间挂起
    last_err: Exception | None = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read().decode("utf-8", errors="replace")
            break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < 1:
                time.sleep(2)
    else:
        raise last_err  # type: ignore[misc]
    try:
        data = json.loads(body)
        text = data.get("text") or data.get("result") or body
    except Exception:  # noqa: BLE001
        text = body
    return str(text)


async def _exec_screen_explain(question: str) -> str:
    """执行 self.camera.explain：优先使用用户手动触发时暂存的截图，
    无暂存则复用最近 60 秒内用户手动发送的图片（官方 LLM 可能连续调用工具多次，
    避免第二次调用时现截全屏、把屏幕内容当成用户发的图），最后才现截全屏，
    再调官方视觉分析，返回识别文本（tools/result 回灌官方 LLM 用）。"""
    global _pending_vision, _last_vision_image
    image_base64 = None
    q = question.strip() or "请详细描述这张图片里的内容。"
    if _pending_vision:
        image_base64 = _pending_vision.get("image_base64")
        pending_q = str(_pending_vision.get("question") or "").strip()
        if pending_q:
            q = pending_q  # 用户配置的识别提示词优先（管理面板可编辑）
        # 保留一份最近图片副本：官方 LLM 可能连续调用工具多次，
        # 第一次消费 pending 后，后续调用复用同一张图（60s 窗口）
        _last_vision_image = {"image_base64": image_base64, "question": pending_q, "ts": time.time()}
        _pending_vision = None
    elif (
        _last_vision_image
        and _last_vision_image.get("image_base64")
        and time.time() - float(_last_vision_image.get("ts") or 0) < 60.0
    ):
        image_base64 = _last_vision_image.get("image_base64")
        pending_q = str(_last_vision_image.get("question") or "").strip()
        if pending_q:
            q = pending_q
    if not image_base64:
        from ..screen_capture import MssCapture
        image_base64 = await asyncio.to_thread(_full_screen_jpeg, MssCapture)
    if not image_base64:
        raise RuntimeError("截图失败：无法获取屏幕画面")
    logger.info("MCP 工具执行 self.camera.explain question=%s", str(q)[:60])
    text = await asyncio.to_thread(_vision_explain_sync, image_base64, q)
    # 识别文本写历史（"她说" 标记 vision），供聊天界面可视化工具调用过程
    _chat_append("pet", "text", text, tag="vision")
    await _syslog("👁️ 屏幕/图片识别完成（工具结果已回灌小智，等待官方回答…）")
    return text


def _mcp_error(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


# ================= 本地免费 MCP 工具实现（全部本机能力/免费公开源） =================

async def _mcp_clock_get_time(args: dict) -> str:
    """self.clock.get_time：当前日期/星期/时间（本机，零成本）。"""
    now = time.localtime()
    week = "一二三四五六日"[now.tm_wday]
    return f"现在是{now.tm_year}年{now.tm_mon}月{now.tm_mday}日，星期{week}，{now.tm_hour:02d}:{now.tm_min:02d}"


def _pwsh_sysinfo() -> str:
    """PowerShell 采集 CPU 负载/内存/运行时长/系统名（无 psutil 依赖）。"""
    ps = (
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
        "$os=Get-CimInstance Win32_OperatingSystem;"
        "$cpu=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average;"
        "$up=[int]($os.LastBootUpTime - [datetime]::Now).Duration().TotalHours;"
        "Write-Output (\"cpu=$([math]::Round($cpu,0)) mem_free={0} mem_total={1} hours={2} os={3}\" -f "
        "[math]::Round($os.FreePhysicalMemory/1MB,0), [math]::Round($os.TotalVisibleMemorySize/1MB,0), $up, $os.Caption)"
    )
    r = subprocess.run(
        ["pwsh.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=15, creationflags=0x08000000,  # CREATE_NO_WINDOW
    )
    m = re.search(r"cpu=([\d.]+) mem_free=([\d.]+) mem_total=([\d.]+) hours=([\d.-]+) os=(.+)", r.stdout)
    if not m:
        return f"系统状态：无法读取（{r.stdout.strip()[:60] or r.stderr.strip()[:60]}）"
    cpu, mem_free, mem_total, hours, os_name = m.groups()
    mem_used = round(float(mem_total) - float(mem_free), 1)
    mem_pct = round(mem_used / float(mem_total) * 100, 0) if float(mem_total) else 0
    return (
        f"CPU负载{cpu}%；内存已用{mem_used}GB/共{mem_total}GB（占用{mem_pct:.0f}%）；"
        f"系统已运行{hours}小时；操作系统{os_name}"
    )


async def _mcp_system_get_info(args: dict) -> str:
    """self.system.get_info：CPU/内存/运行时长/系统名（本机）。"""
    try:
        return await asyncio.to_thread(_pwsh_sysinfo)
    except Exception as exc:  # noqa: BLE001
        return f"系统状态读取失败：{exc}"


async def _mcp_weather_get(args: dict) -> str:
    """self.weather.get：实时天气（wttr.in 免费无 key）。"""
    city = str(args.get("city") or "").strip()
    if not city:
        city = "广州"  # 默认城市
    try:
        url = f"https://wttr.in/{quote(city)}?format=j1&lang=zh"
        req = urllib.request.Request(url, headers={"User-Agent": "MaoPet/2.5"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        cur = (data.get("current_condition") or [{}])[0]
        desc = (cur.get("weatherDesc") or [{}])[0].get("value", "未知")
        temp = cur.get("temp_C", "?")
        feels = cur.get("FeelsLikeC", temp)
        hum = cur.get("humidity", "?")
        wind = cur.get("windspeedKmph", "?")
        return f"{city}当前天气：{desc}，气温{temp}°C（体感{feels}°C），湿度{hum}%，风速{wind}公里/小时"
    except Exception as exc:  # noqa: BLE001
        return f"天气查询失败：{exc}（可稍后再试）"


def _fetch_rss_items(url: str, limit: int = 5) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "MaoPet/2.5"})
    with urllib.request.urlopen(req, timeout=12) as resp:
        root = ET.fromstring(resp.read())
    items = []
    for item in root.iter("item"):
        t = (item.findtext("title") or "").strip()
        d = (item.findtext("description") or "").strip()
        if t:
            items.append({"title": t, "desc": d})
        if len(items) >= limit:
            break
    return items


async def _mcp_news_get(args: dict) -> str:
    """self.news.get：最新新闻（中国新闻网 RSS，免费）。"""
    try:
        items = await asyncio.to_thread(_fetch_rss_items, "https://www.chinanews.com.cn/rss/society.xml", 5)
        if not items:
            return "新闻获取失败：暂无内容"
        lines = [f"{i+1}. {it['title']}" for i, it in enumerate(items)]
        return "最新新闻：\n" + "\n".join(lines)
    except Exception as exc:  # noqa: BLE001
        return f"新闻获取失败：{exc}"


# ---- 本地音乐播放（winmm MCI，纯 ctypes，零依赖） ----
_MUSIC_DIR = _PROJECT_ROOT / "xiaozhi_music"
_MCI_ALIAS = "mao_music"
_mci_error: str = ""


def _mci(cmd: str) -> bool:
    global _mci_error
    try:
        buf = ctypes.create_unicode_buffer(256)
        rc = ctypes.windll.winmm.mciSendStringW(cmd, buf, 256, 0)
        if rc != 0:
            _mci_error = buf.value or f"错误码{rc}"
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        _mci_error = str(exc)
        return False


def _music_files() -> list[str]:
    if not _MUSIC_DIR.exists():
        return []
    exts = (".mp3", ".wav", ".m4a")
    return sorted(str(p) for p in _MUSIC_DIR.rglob("*") if p.suffix.lower() in exts)


def _mci_play_path(path: str) -> str:
    _mci(f'close {_MCI_ALIAS}')
    # mpegvideo 可播 mp3/m4a；wav 用 waveaudio
    kind = "mpegvideo" if path.lower().endswith((".mp3", ".m4a")) else "waveaudio"
    if not _mci(f'open "{path}" type {kind} alias {_MCI_ALIAS}'):
        return f"打开音乐失败：{_mci_error}"
    if not _mci(f"play {_MCI_ALIAS}"):
        return f"播放失败：{_mci_error}"
    return "ok"


async def _mcp_music_play(args: dict) -> str:
    """self.music.play：播放 xiaozhi_music 目录下的音乐（keyword 匹配/随机）。"""
    files = await asyncio.to_thread(_music_files)
    if not files:
        return "没有找到音乐：请把 mp3/wav 文件放到项目目录的 xiaozhi_music 文件夹里"
    kw = str(args.get("keyword") or "").strip().lower()
    matched = [f for f in files if kw and kw in Path(f).stem.lower()]
    if kw and not matched:
        return f"没找到包含「{kw}」的音乐，可试试这些：{', '.join(Path(f).stem for f in files[:3])}"
    target = (matched or files)[0]
    r = await asyncio.to_thread(_mci_play_path, target)
    if r != "ok":
        return r
    return f"正在播放：{Path(target).stem}"


async def _mcp_music_stop(args: dict) -> str:
    """self.music.stop：停止当前音乐。"""
    try:
        await asyncio.to_thread(_mci, f"stop {_MCI_ALIAS}")
        await asyncio.to_thread(_mci, f"close {_MCI_ALIAS}")
        return "音乐已停止"
    except Exception as exc:  # noqa: BLE001
        return f"停止音乐失败：{exc}"


# ---- 剪贴板读写（PowerShell 子进程） ----
async def _mcp_clipboard_get(args: dict) -> str:
    """self.clipboard.get：读取剪贴板文本。"""
    try:
        r = await asyncio.to_thread(
            lambda: subprocess.run(
                ["pwsh.exe", "-NoProfile", "-NonInteractive", "-Command",
                 "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"],
                capture_output=True, text=True, timeout=10, encoding="utf-8", errors="replace",
                creationflags=0x08000000,
            )
        )
        text = (r.stdout or "").strip()
        return f"剪贴板内容是：{text}" if text else "剪贴板是空的"
    except Exception as exc:  # noqa: BLE001
        return f"读取剪贴板失败：{exc}"


async def _mcp_clipboard_set(args: dict) -> str:
    """self.clipboard.set：写入剪贴板。"""
    text = str(args.get("text") or "").strip()
    if not text:
        return "没有要写入剪贴板的文本"
    try:
        # Set-Clipboard 对特殊字符用单引号转义
        safe = text.replace("'", "''")
        await asyncio.to_thread(
            lambda: subprocess.run(
                ["pwsh.exe", "-NoProfile", "-NonInteractive", "-Command", f"Set-Clipboard -Value '{safe}'"],
                capture_output=True, text=True, timeout=10, encoding="utf-8", errors="replace",
                creationflags=0x08000000,
            )
        )
        return f"已复制到剪贴板：{text[:40]}"
    except Exception as exc:  # noqa: BLE001
        return f"写入剪贴板失败：{exc}"


# ---- 本地记事（JSON 持久化） ----
_MEMO_FILE = _PROJECT_ROOT / "xiaozhi_memo.json"


def _load_memos() -> dict:
    try:
        if _MEMO_FILE.exists():
            data = json.loads(_MEMO_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        pass
    return {}


def _save_memos(memos: dict) -> None:
    try:
        _MEMO_FILE.write_text(json.dumps(memos, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


async def _mcp_memo_set(args: dict) -> str:
    """self.memo.set：记录一条备忘。"""
    text = str(args.get("text") or "").strip()
    if not text:
        return "没有要记的内容"
    key = str(args.get("key") or "").strip() or f"备忘{int(time.time())}"
    memos = await asyncio.to_thread(_load_memos)
    memos[key] = {"text": text, "ts": time.strftime("%Y-%m-%d %H:%M")}
    await asyncio.to_thread(_save_memos, memos)
    return f"记住了「{key}」：{text[:40]}"


async def _mcp_memo_get(args: dict) -> str:
    """self.memo.get：列出全部备忘。"""
    memos = await asyncio.to_thread(_load_memos)
    if not memos:
        return "目前没有备忘"
    lines = [f"{k}：{v.get('text') if isinstance(v, dict) else v}" for k, v in memos.items()]
    return "你的备忘：\n" + "\n".join(lines)


async def _mcp_memo_delete(args: dict) -> str:
    """self.memo.delete：删除一条备忘。"""
    key = str(args.get("key") or "").strip()
    if not key:
        return "请指定要删除的备忘名称"
    memos = await asyncio.to_thread(_load_memos)
    if key in memos:
        del memos[key]
        await asyncio.to_thread(_save_memos, memos)
        return f"已删除备忘「{key}」"
    return f"没有找到备忘「{key}」"


# ---- 倒计时提醒（到点桌宠主动说话） ----
_timers: dict[str, asyncio.Task] = {}


async def _timer_fire(key: str, message: str) -> None:
    """提醒触发：优先注入官方（官方音色说话+气泡+历史），连接不可用时广播气泡兜底。"""
    try:
        await _syslog(f"⏰ 提醒「{key}」触发，正在告知…")
        ok = await _inject_say(message, source="timer")
        if ok:
            return
        # 注入失败：气泡兜底
        await _broadcast_observe_bubble(message)
        _chat_append("pet", "text", message, tag="timer")
    except Exception as exc:  # noqa: BLE001
        logger.warning("定时提醒触发失败: %s", exc)
        try:
            await _broadcast_observe_bubble(message)
            _chat_append("pet", "text", message, tag="timer")
        except Exception:  # noqa: BLE001
            pass


async def _mcp_timer_set(args: dict) -> str:
    """self.timer.set：设定倒计时提醒。"""
    try:
        minutes = max(1, int(args.get("minutes") or 1))
    except (TypeError, ValueError):
        return "minutes 参数必须是分钟数"
    message = str(args.get("message") or "").strip() or "时间到啦"
    key = f"timer{int(time.time())}"
    task = asyncio.create_task(_timer_schedule(key, minutes, message))
    _timers[key] = task
    return f"好的，{minutes} 分钟后我会提醒你：{message[:40]}"


async def _timer_schedule(key: str, minutes: int, message: str) -> None:
    await asyncio.sleep(minutes * 60)
    try:
        await _timer_fire(key, message)
    finally:
        _timers.pop(key, None)


async def _mcp_timer_cancel(args: dict) -> str:
    """self.timer.cancel：取消提醒。"""
    key = str(args.get("key") or "").strip()
    if not key:
        n = len(_timers)
        for k, t in list(_timers.items()):
            t.cancel()
        _timers.clear()
        return f"已取消全部 {n} 个提醒" if n else "当前没有待触发的提醒"
    t = _timers.pop(key, None)
    if t:
        t.cancel()
        return f"已取消提醒「{key}」"
    return f"没有找到提醒「{key}」"


# ---- 联网搜索（Bing 新闻 RSS，免费无 key） ----
async def _mcp_web_search(args: dict) -> str:
    """self.web.search：Bing 新闻 RSS 搜索。"""
    q = str(args.get("query") or "").strip()
    if not q:
        return "请提供搜索关键词"
    try:
        url = f"https://www.bing.com/search?q={quote(q)}&format=rss&setlang=zh-hans"
        items = await asyncio.to_thread(_fetch_rss_items, url, 5)
        if not items:
            return f"没搜到关于「{q}」的新闻"
        lines = [f"{i+1}. {it['title']}" for i, it in enumerate(items)]
        return f"关于「{q}」的最新消息：\n" + "\n".join(lines)
    except Exception as exc:  # noqa: BLE001
        return f"搜索失败：{exc}"


# ---- 打开白名单应用 ----
_OPEN_APP_MAP = {
    "浏览器": "https://www.baidu.com",
    "记事本": "notepad.exe",
    "计算器": "calc.exe",
    "文件管理器": "explorer.exe",
    "画图": "mspaint.exe",
    "任务管理器": "taskmgr.exe",
    "终端": "wt.exe",
}


async def _mcp_desktop_open_app(args: dict) -> str:
    """self.desktop.open_app：打开白名单应用（防 LLM 乱开程序）。"""
    app = str(args.get("app") or "").strip()
    if not app:
        return "请指定要打开的应用：浏览器/记事本/计算器/文件管理器/画图/任务管理器/终端"
    target = None
    for key, cmd in _OPEN_APP_MAP.items():
        if app == key or key in app or app in key:
            target = (key, cmd)
            break
    if not target:
        return f"我不支持打开「{app}」，只能打开：{', '.join(_OPEN_APP_MAP.keys())}"
    key, cmd = target
    try:
        if cmd.startswith("http"):
            await asyncio.to_thread(os.startfile, cmd)
        else:
            await asyncio.to_thread(
                lambda: subprocess.Popen(
                    cmd, creationflags=0x08000000, close_fds=True
                )
            )
        return f"已为你打开{key}"
    except Exception as exc:  # noqa: BLE001
        return f"打开{key}失败：{exc}"


def _mcp_result(req_id, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


async def _handle_mcp_message(payload) -> dict | None:
    """处理官方云下发的 MCP（JSON-RPC 2.0）请求，返回要发回的响应 payload（None=无需响应）。

    严格遵循小智官方 MCP 协议格式：
      initialize  → result{protocolVersion, capabilities{tools}, serverInfo}
      tools/list  → result{tools:[...], nextCursor}
      tools/call  → result{content:[{type:text,text}], isError} / error{code,message}
    """
    try:
        raw = payload if isinstance(payload, dict) else (json.loads(payload) if payload else {})
        method = str(raw.get("method") or "")
        req_id = raw.get("id")
        params = raw.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        if method == "initialize":
            _MCP_STATS["initialize"] += 1
            return _mcp_result(req_id, {
                "protocolVersion": _MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": _MCP_SERVER_INFO,
            })
        if method == "tools/list":
            _MCP_STATS["tools_list"] += 1
            return _mcp_result(req_id, {"tools": _mcp_enabled_tools(), "nextCursor": ""})
        if method == "tools/call":
            _MCP_STATS["tools_call"] += 1
            name = str(params.get("name") or "")
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                arguments = {}
            # 开关控制：关掉的工具对云端 LLM 不可见、不可调
            if not _mcp_tool_enabled(name):
                return _mcp_result(req_id, {
                    "content": [{"type": "text", "text": f"工具 {name} 未启用（可在 MIO 管理页的「小智工具」中打开）"}],
                    "isError": True,
                })
            handler_name = _MCP_HANDLERS.get(name)
            if not handler_name:
                return _mcp_error(req_id, -32601, f"Unknown tool: {name}")
            handler = globals().get(handler_name)
            if handler is None or not callable(handler):
                logger.warning("MCP 工具 %s 的实现函数 %s 不存在", name, handler_name)
                return _mcp_error(req_id, -32601, f"Tool implementation missing: {name}")
            try:
                text = await handler(arguments)
                return _mcp_result(req_id, {
                    "content": [{"type": "text", "text": str(text)}],
                    "isError": False,
                })
            except Exception as exc:  # noqa: BLE001
                logger.warning("MCP 工具 %s 执行失败: %s", name, exc)
                await _syslog(f"⚠️ MCP 工具 {name} 执行失败：{str(exc)[:80]}")
                return _mcp_result(req_id, {
                    "content": [{"type": "text", "text": f"工具 {name} 执行失败：{exc}"}],
                    "isError": True,
                })
        # 其他方法（notifications 等）：不回响应
        logger.info("MCP 消息 method=%s（无需响应）", method)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("解析 MCP 请求失败: %s", exc)
        return None


async def _send_mcp_response(conn, payload: dict | None) -> None:
    """按官方协议发送 type=mcp 响应（payload 为 JSON-RPC 2.0）。"""
    if payload is None or conn is None:
        return
    try:
        await conn.send(json.dumps({
            "type": "mcp",
            "payload": payload,
            "session_id": _session_id,
        }, ensure_ascii=False))
        _MCP_STATS["send_ok"] += 1
    except Exception as exc:  # noqa: BLE001
        _MCP_STATS["send_fail"] += 1
        logger.warning("发送 MCP 响应失败: %s", exc)


@router.get("/chat-history")
async def xiaozhi_chat_history(limit: int = 100) -> dict:
    """返回长连接以来的会话历史（最近 N 条，图片含 base64 data URL）。"""
    n = max(1, min(int(limit or 100), _CHAT_HISTORY_MAX))
    history = list(_chat_history[-n:])
    return {"ok": True, "total": len(_chat_history), "history": history}


@router.get("/vision-info")
async def xiaozhi_vision_info() -> dict:
    return {
        "ok": _vision is not None,
        "url": (_vision or {}).get("url"),
        "has_token": bool((_vision or {}).get("token")),
    }


@router.post("/vision")
async def xiaozhi_vision(payload: VisionRequest) -> dict:
    """上传图片 → 官方 MCP 工具链路：暂存截图 → 注入触发语 → 官方 LLM 调 self.camera.explain
    → 官方视觉识别 → 工具结果回灌官方 LLM → 官方 TTS（官方音色）语音回答，桌宠播放+气泡+历史。
    不再旁路显示文本（识别文本作为工具结果给官方 LLM，最终回答由官方生成）。"""
    global _pending_vision
    if _vision is None:
        raise HTTPException(status_code=409, detail="小智视觉能力不可用：请先打开小智对话建立连接")
    question = str(payload.question or "").strip() or str(_prompt_cfg.get("image_prompt") or _prompt_defaults["image_prompt"])
    if _prompt_cfg.get("force_60", True) and "字以内" not in question:
        question = f"{question}（请用60字以内的简洁口语回答）"
    image_base64 = str(payload.image_base64 or "").strip()
    if not image_base64:
        raise HTTPException(status_code=400, detail="图片不能为空")
    try:
        # 1. 图片写入会话历史（同步到聊天界面）
        _chat_append("user", "image", text=question, image_base64=image_base64, tag="chat")
        await _syslog("🖼️ 已发送图片给小智分析…")
        # 2. 暂存截图 → 注入触发语（官方 LLM 收到后会调 self.camera.explain 工具，
        #    工具回调里用这张暂存图做官方视觉识别，识别文本作为工具结果回灌 LLM）
        _pending_vision = {"image_base64": image_base64, "question": question}
        _last_vision_image = None  # 作废旧图副本：官方连续工具调用不得串到上一张图
        # 每次发图强制重置官方会话（新上下文）：官方视觉工具只在干净会话里稳定被调用，
        # 同一会话内第一次工具调用后，后续"看图片"指令官方不再调工具（实测"第一张通、后续全失败"）
        await _reset_upstream_connection()
        # 注入语音用短触发语（ASR 对 SAPI 合成音的长文本识别差，实测长触发语被识别成乱码 → LLM 不调工具）。
        # 每次发图轮换不同触发语：官方 LLM 对重复的用户指令（同一会话内相同文本）会去重/不重复响应
        # （实测第一张图正常调工具，第二张起注入文本相同 → 官方识别了触发语却不调工具 → 回答"没收到图片"）
        trigger = _next_vision_trigger()
        ok = await _inject_say(trigger, source="vision", confirm_timeout=8.0)
        if not ok:
            raise HTTPException(status_code=409, detail="注入失败：小智连接不可用")
        return {"ok": True, "trigger": trigger}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("小智视觉分析失败")
        raise HTTPException(status_code=502, detail=f"小智视觉分析失败: {exc}") from exc


@router.post("/vision-bubble")
async def xiaozhi_vision_bubble(payload: VisionRequest) -> dict:
    """截图/图片 → 官方 MCP 工具链路（与 /vision 同一条链路）：暂存截图（缺省现截全屏）
    → 注入触发语 → 官方 LLM 调工具 → 官方视觉识别 → 工具结果回灌 → 官方 TTS 语音回答。
    供"立即观察"、右键"截图提问"等场景使用；分析/回答经 pet_text 与 tts 链路显示气泡。"""
    global _pending_vision
    if _vision is None:
        raise HTTPException(status_code=409, detail="小智视觉能力不可用：请先打开小智对话建立连接")
    _prompt_default = (
        str(_prompt_cfg.get("observe_prompt") or _prompt_defaults["observe_prompt"])
        if str(payload.kind or "").strip() == "observe"
        else str(_prompt_cfg.get("image_prompt") or _prompt_defaults["image_prompt"])
    )
    question = str(payload.question or "").strip() or _prompt_default
    if _prompt_cfg.get("force_60", True) and "字以内" not in question:
        question = f"{question}（请用60字以内的简洁口语回答）"
    image_base64 = str(payload.image_base64 or "").strip()
    try:
        # 1. 截图/图片写入会话历史（同步到聊天界面）
        _chat_append("user", "image", text=question, image_base64=image_base64 or None, tag="observe")
        await _syslog("🖼️ 已发送屏幕/图片给小智分析…")
        # 2. 暂存截图（缺省现截全屏）→ 注入触发语 → 官方 LLM 调工具 → 官方回答 + 官方 TTS 音频
        _pending_vision = {"image_base64": image_base64 or None, "question": question}
        _last_vision_image = None  # 作废旧图副本：官方连续工具调用不得串到上一张图
        await _reset_upstream_connection()  # 每次观察/提问强制重置会话，确保官方视觉工具可调用
        # 注入语音用短触发语（ASR 对 SAPI 合成音的长文本识别差，实测长触发语被识别成乱码
        # 导致 LLM 不调工具）；用户 prompt 作视觉 API question（识别文本自带其风格，已实测生效）。
        # 每次触发轮换不同短语：官方 LLM 对同一会话内重复的用户指令会去重/不重复响应
        if str(payload.kind or "").strip() == "observe":
            trigger = _next_observe_trigger()
        else:
            trigger = _next_vision_trigger()
        ok = await _inject_say(trigger, source="vision", confirm_timeout=8.0)
        if not ok:
            raise HTTPException(status_code=409, detail="注入失败：小智连接不可用")
        return {"ok": True, "trigger": trigger}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("小智视觉分析失败（vision-bubble）")
        raise HTTPException(status_code=502, detail=f"小智视觉分析失败: {exc}") from exc


class PromptsRequest(BaseModel):
    image_prompt: str | None = None
    observe_prompt: str | None = None
    force_60: bool | None = None


class MCPToolsRequest(BaseModel):
    enabled: dict[str, bool] | None = None  # {工具名: 开关}


@router.get("/mcp-tools")
async def xiaozhi_mcp_tools_get() -> dict:
    """返回全部 MCP 工具的注册信息 + 当前开关状态（管理页「小智工具」用）。"""
    tools = []
    for t in _MCP_TOOLS_DEF:
        tools.append({
            "name": t["name"],
            "description": t["description"],
            "category": t.get("category", "其他"),
            "enabled": _mcp_tool_enabled(t["name"]),
            "default_enabled": bool(t.get("default_enabled", False)),
        })
    return {"ok": True, "tools": tools}


@router.put("/mcp-tools")
async def xiaozhi_mcp_tools_put(payload: MCPToolsRequest) -> dict:
    """实时开关 MCP 工具（持久化；tools/list 在下次官方会话初始化时生效）。"""
    if not payload.enabled:
        raise HTTPException(status_code=400, detail="enabled 不能为空")
    valid = {t["name"] for t in _MCP_TOOLS_DEF}
    for name, val in payload.enabled.items():
        if name not in valid:
            raise HTTPException(status_code=400, detail=f"未知工具: {name}")
        _mcp_enabled[name] = bool(val)
    _save_mcp_tools_cfg()
    return {
        "ok": True,
        "enabled": {t["name"]: _mcp_tool_enabled(t["name"]) for t in _MCP_TOOLS_DEF},
    }


@router.get("/prompts")
async def xiaozhi_prompts_get() -> dict:
    """返回图片识别/屏幕观察 前置提示词配置（可编辑、持久化）。"""
    return {"ok": True, **_prompt_cfg}


@router.put("/prompts")
async def xiaozhi_prompts_put(payload: PromptsRequest) -> dict:
    """保存图片识别/屏幕观察 前置提示词配置（写 JSON 持久化）。"""
    if payload.image_prompt is not None:
        _prompt_cfg["image_prompt"] = str(payload.image_prompt).strip()[:300] or _prompt_defaults["image_prompt"]
    if payload.observe_prompt is not None:
        _prompt_cfg["observe_prompt"] = str(payload.observe_prompt).strip()[:300] or _prompt_defaults["observe_prompt"]
    if payload.force_60 is not None:
        _prompt_cfg["force_60"] = bool(payload.force_60)
    _save_prompts()
    return {"ok": True, **_prompt_cfg}


def _device_identity() -> dict | None:
    try:
        with open(DEVICE_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        mac = (data.get("mac_address") or "").strip().lower()
        if not mac:
            return None
        return {"mac": mac, "client_id": data.get("client_id", mac), "path": str(DEVICE_JSON)}
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取小智设备身份失败: %s", exc)
        return None


def _machine_code(mac: str) -> str:
    """派生六位数机器码：取 MAC 十六进制后 6 位（去冒号，大写）。"""
    import re as _re
    digits = _re.sub(r"[^0-9A-Fa-f]", "", str(mac or "").upper())
    if len(digits) >= 6:
        return digits[-6:]
    return digits.zfill(6)


@router.get("/status")
async def xiaozhi_status() -> dict:
    identity = _device_identity()
    if identity is None:
        return {"ok": False, "error": "未找到设备身份文件，请先运行 OTA 注册脚本", "path": str(DEVICE_JSON)}
    bound = True
    try:
        with open(DEVICE_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        bound = "activation" not in data
    except Exception:  # noqa: BLE001
        pass
    return {
        "ok": True,
        "bound": bound,
        "mac": identity["mac"],
        "client_id": identity.get("client_id", ""),
        "machine_code": _machine_code(identity["mac"]),
        "upstream": XIAOZHI_UPSTREAM,
        "connected": _upstream is not None,
        "session_id": _session_id,
        "subscribers": len(_subscribers),
        "roles": list(_sub_roles.values()),
        "mcp_stats": dict(_MCP_STATS),
    }


class _OpusDecoder:
    """单会话 Opus 裸帧解码器（48kHz 双声道 float32 planar）。"""

    def __init__(self) -> None:
        self._ctx = av.CodecContext.create("opus", "r")
        self._ctx.sample_rate = OPUS_PCM_RATE

    def decode(self, frame_bytes: bytes) -> bytes | None:
        chunks = []
        total_samples = 0
        channels = OPUS_PCM_CHANNELS
        try:
            for packet in self._ctx.parse(frame_bytes):
                for frame in self._ctx.decode(packet):
                    arr = frame.to_ndarray()  # (channels, samples) float32 planar
                    ch, n = arr.shape
                    if ch != channels:
                        channels = ch
                    total_samples += n
                    for c in range(ch):
                        chunks.append(arr[c].tobytes())
        except Exception as exc:  # noqa: BLE001
            logger.warning("opus 解码失败: %s", exc)
            return None
        if total_samples == 0 or not chunks:
            return None
        header = struct.pack("<II", total_samples, channels)
        return header + b"".join(chunks)


async def _pick_target() -> WebSocket | None:
    """返回最近活跃的订阅者；无则返回 None。"""
    if not _subscribers:
        return None
    if _active_ws is not None and _active_ws in _subscribers:
        return _active_ws
    ws = max(_subscribers, key=_subscribers.get)
    return ws


async def _broadcast(text: str) -> None:
    """向所有订阅者广播文本消息（每订阅者队列，顺序发送，不阻塞上游泵）。"""
    for ws in list(_subscribers.keys()):
        q = _sub_queues.get(ws)
        if q is None:
            continue
        try:
            q.put_nowait(("text", text))
        except asyncio.QueueFull:
            try:
                q.get_nowait()
                q.put_nowait(("text", text))
            except Exception:  # noqa: BLE001
                pass


async def _broadcast_bytes(data: bytes) -> None:
    """音频帧只发给 'main'（桌宠本体）订阅者——多窗口并存时只有一个播放者，杜绝声音叠加。"""
    mains = [ws for ws, role in _sub_roles.items() if role == "main" and ws in _subscribers]
    targets = mains or list(_subscribers.keys())   # 无 main 时回退：发给全部（避免音频丢失）
    for ws in targets:
        q = _sub_queues.get(ws)
        if q is None:
            continue
        try:
            q.put_nowait(("bytes", data))
        except asyncio.QueueFull:
            try:
                q.get_nowait()          # 丢最旧帧，保证新帧实时到达
                q.put_nowait(("bytes", data))
            except Exception:  # noqa: BLE001
                pass


async def _sub_writer(ws: WebSocket) -> None:
    """订阅者发送循环：按入队顺序逐条发送（文本/音频帧），防乱序防阻塞。"""
    q = _sub_queues.get(ws)
    if q is None:
        return
    while True:
        try:
            kind, data = await q.get()
            if kind == "text":
                await ws.send_text(data)
            else:
                await ws.send_bytes(data)
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001
            _subscribers.pop(ws, None)
            return


async def _reconnect_loop(initial_delay: float = 1.5) -> None:
    """上游断开后自动重连（退避 1.5s→15s），成功后广播 hello 让前端恢复。"""
    delay = initial_delay
    while True:
        await asyncio.sleep(delay)
        async with _upstream_lock:
            conn, err = await _ensure_upstream()
        if conn is not None:
            await _broadcast(json.dumps({"type": "hello", "version": 1, "session_id": _session_id}, ensure_ascii=False))
            await _syslog("🔗 小智已重连（会话 " + str(_session_id) + "）", quiet=True)
            return
        logger.warning("上游重连失败，%.0fs 后重试: %s", delay, err)
        await _broadcast(json.dumps({"type": "error", "error": "connecting"}, ensure_ascii=False))
        delay = min(15.0, delay * 1.5)


async def _pump_upstream(conn) -> None:
    """上游消息持续转发给最近活跃订阅者；断线自动清理并允许重建。"""
    global _upstream, _last_tts_stop, _llm_text, _last_stt_ts, _last_stt_text, _tts_playing, _tts_sentences, _pending_llm_text
    decoder = _OpusDecoder()
    _pump_audio_count = 0
    _pump_audio_bytes = 0
    try:
        while True:
            msg = await conn.recv()
            if not _subscribers:
                # 无订阅者时只解析 MCP/历史，不转发
                try:
                    j = json.loads(msg)
                except Exception:  # noqa: BLE001
                    continue
                # 官方主动结束会话（goodbye）：穿透到外层触发断开+快速重连，保持长连接
                if j.get("type") == "goodbye":
                    logger.info("收到官方 goodbye，主动断开快速重连（保持长连接）")
                    raise _UpstreamGoodbye()
                try:
                    if j.get("type") == "mcp":
                        _capture_vision_from_mcp(j.get("payload"))
                        resp = await _handle_mcp_message(j.get("payload"))
                        if resp:
                            await _send_mcp_response(conn, resp)
                    if j.get("type") == "stt":
                        _last_stt_ts = time.time()
                        _last_stt_text = str(j.get("text") or "")
                        # 机制级角色解耦：官方 STT 回传一律不写"你说"历史（含注入回声/官方误听），
                        # "你说"只由浏览器真实输入（_relay_browser_message）写入
                    if j.get("type") == "llm":
                        _pending_llm_text = str(j.get("text") or "")
                        _llm_text = _pending_llm_text
                        # LLM 事件即写回答历史（官方 llm 事件为完整文本；tts stop 时同文本去重跳过），
                        # 修复"有声音但文字不显示"：官方部分会话 TTS 无 sentence_start，仅靠 tts stop 会丢文本
                        if _pending_llm_text:
                            _maybe_write_llm_reply(_pending_llm_text)
                    if j.get("type") == "tts" and j.get("state") == "start":
                        _tts_sentences = []
                    if j.get("type") == "tts" and j.get("state") == "sentence_start":
                        _txt = str(j.get("text") or "")
                        if _txt:
                            _tts_sentences.append(_txt)
                    if j.get("type") == "tts" and j.get("state") == "stop":
                        _last_tts_stop = time.time()
                        _tts_playing = False
                        await _syslog("🔊 小智说话结束")
                        _full = "".join(_tts_sentences).strip()
                        if not _full:
                            _full = (_pending_llm_text or "").strip()
                        if _full:
                            _maybe_write_llm_reply(_full)
                        _tts_sentences = []
                        _pending_llm_text = ""
                    if j.get("type") == "tts" and j.get("state") == "start":
                        _tts_playing = True
                        await _syslog("🗣️ 小智开始说话…")
                except Exception:  # noqa: BLE001
                    pass
                continue
            try:
                if isinstance(msg, bytes):
                    pcm = decoder.decode(msg)
                    if pcm is not None:
                        await _broadcast_bytes(pcm)   # 广播给所有订阅者（桌宠稳定播放，不因活跃切换丢帧）
                        _pump_audio_count += 1
                        _pump_audio_bytes += len(pcm)
                        if _pump_audio_count % 10 == 0:
                            logger.info("代理已转发音频帧 %d 次，共 %d 字节", _pump_audio_count, _pump_audio_bytes)
                else:
                    try:
                        j = json.loads(msg)
                    except Exception:  # noqa: BLE001
                        j = None
                    # 官方主动结束会话（goodbye）：穿透到外层触发断开+快速重连，保持长连接
                    if isinstance(j, dict) and j.get("type") == "goodbye":
                        logger.info("收到官方 goodbye，主动断开快速重连（保持长连接）")
                        raise _UpstreamGoodbye()
                    try:
                        if isinstance(j, dict):
                            if j.get("type") == "mcp":
                                _capture_vision_from_mcp(j.get("payload"))
                                resp = await _handle_mcp_message(j.get("payload"))
                                if resp:
                                    await _send_mcp_response(conn, resp)
                            if j.get("type") == "tts" and j.get("state") == "stop":
                                _last_tts_stop = time.time()
                                _tts_playing = False
                                await _syslog("🔊 小智说话结束")
                                _full = "".join(_tts_sentences).strip()
                                if not _full:
                                    _full = (_pending_llm_text or "").strip()
                                if _full:
                                    _maybe_write_llm_reply(_full)
                                _tts_sentences = []
                                _pending_llm_text = ""
                            if j.get("type") == "tts" and j.get("state") == "start":
                                _tts_playing = True
                                await _syslog("🗣️ 小智开始说话…")
                            if j.get("type") == "tts" and j.get("state") == "sentence_start":
                                _txt = str(j.get("text") or "")
                                if _txt:
                                    _tts_sentences.append(_txt)
                                    # 实时文本流：分句广播给前端聊天列表（边听边冒字），
                                    # tts stop 时后端拼接完整回复写历史，前端轮询自动替换临时项
                                    await _broadcast(json.dumps({"type": "pet_text", "text": _txt}, ensure_ascii=False))
                            if j.get("type") == "stt":
                                _last_stt_ts = time.time()
                                _last_stt_text = str(j.get("text") or "")
                                # 诊断（可移除）：显示官方 ASR 实际识别到的文本，
                                # 验证注入语音是否被正确识别（区分 ASR 错 vs LLM 不调工具）
                                if _last_stt_text:
                                    await _syslog(f"🎙️ 识别到：{_last_stt_text[:60]}")
                                # 机制级角色解耦：官方 STT 回传一律不写"你说"历史（含注入回声/官方误听），
                                # "你说"只由浏览器真实输入（_relay_browser_message）写入
                            if j.get("type") == "llm":
                                _pending_llm_text = str(j.get("text") or "")
                                _llm_text = _pending_llm_text
                                # LLM 事件即写回答历史（tts stop 时同文本去重跳过）：
                                # 官方部分会话 TTS 无 sentence_start，仅靠 tts stop 会丢文字
                                if _pending_llm_text:
                                    _maybe_write_llm_reply(_pending_llm_text)
                            if j.get("type") in ("llm", "tts", "error", "listen", "abort"):
                                logger.info("上游消息 type=%s", j.get("type"))
                            # 官方 STT 回传**不广播**给前端（含注入回声/官方误听）——否则聊天窗口会把
                            # 官方识别文本渲染成"你说[分析]"（复述发送一次）。前端"你说"只来自浏览器真实输入。
                            if j.get("type") == "stt":
                                continue
                    except Exception:  # noqa: BLE001
                        pass
                    await _broadcast(msg)   # 文本广播（所有订阅者收同一份消息）
            except Exception:  # noqa: BLE001
                _subscribers.pop(target, None)
    except Exception as exc:  # noqa: BLE001
        logger.warning("上游下行中断: %s", exc)
    finally:
        if _upstream is conn:
            _upstream = None
        try:
            await conn.close()
        except Exception:  # noqa: BLE001
            pass
        # 通知前端"连接中断，正在重连"，并启动自动重连
        # quiet：频繁重连/断连不写聊天历史不广播，避免刷屏占用界面空间
        await _syslog("⚠️ 小智连接中断，正在自动重连…", quiet=True)
        await _broadcast(json.dumps({"type": "error", "error": "connecting"}, ensure_ascii=False))
        asyncio.create_task(_reconnect_loop())


async def _ensure_upstream() -> tuple[object | None, str | None]:
    """确保全局单例上游存在并已 hello；返回 (conn, error)。"""
    global _upstream, _session_id, _session_wake_done, _tts_playing
    if _upstream is not None:
        return _upstream, None
    identity = _device_identity()
    if identity is None:
        return None, "设备身份缺失"
    headers = {
        "Device-Id": identity["mac"],
        "Client-Id": identity["mac"],
        "Protocol-Version": "1",
        "Authorization": "Bearer test-token",
    }
    try:
        # 用新版 websockets asyncio 客户端（legacy 客户端回 pong 时有 drain assert 竞态 bug，
        # 会导致官方云连接 1005 断连；新版已修复）
        conn = await ws_async_connect(
            XIAOZHI_UPSTREAM,
            additional_headers=headers,
            max_size=None,
            open_timeout=10,
            ping_interval=None,   # 禁用协议层ping: 官方协议无心跳, 真实设备不发ping, 避免库ping/pong与官方云LB不兼容导致1005
        )
        # 先完成 hello 会话握手，确认官方云接受后才开放全局连接，
        # 避免 hello 被拒(如 1005)时注入接口出现“假成功”
        await conn.send(json.dumps(HELLO, ensure_ascii=False))
        msg = await asyncio.wait_for(conn.recv(), timeout=10)
        j = json.loads(msg)
        if j.get("type") != "hello":
            logger.warning("上游 hello 响应异常: %s", msg[:200])
            try:
                await conn.close()
            except Exception:  # noqa: BLE001
                pass
            return None, f"官方云 hello 响应异常: {msg[:120]}"
        _session_id = j.get("session_id")
        _upstream = conn
        _session_wake_done = False   # 保留变量（不再用于唤醒，静默连接直接音频流注入）
        _tts_playing = False
        # quiet: 连接成功/重连状态不写历史不广播（用户要求主聊天界面不显示重连/断开，避免刷屏占空间）
        await _syslog(f"🔗 小智已连接（会话 {_session_id}）", quiet=True)
    except Exception as exc:  # noqa: BLE001
        logger.error("上游 hello 失败: %s", exc)
        try:
            await conn.close()
        except Exception:  # noqa: BLE001
            pass
        return None, f"官方云会话建立失败: {exc}"
    asyncio.create_task(_pump_upstream(conn))
    return conn, None


async def _relay_browser_message(ws: WebSocket, text: str) -> None:
    """浏览器文本消息转发上游，自动补齐 session_id，并标记该连接为活跃。

    【文字对话可靠链路】官方 listen/detect 文本通道只响应唤醒词，普通文本会被忽略
    （实测无论长短均无响应）。因此拦截 listen/detect + 非唤醒文本 → 转本地音频流注入
    （SAPI TTS → 官方 ASR），官方能完整识别短文本并语音回答；唤醒词仍透传官方原路径。
    """
    global _active_ws
    _subscribers[ws] = time.time()
    _active_ws = ws
    conn = _upstream
    if conn is None:
        try:
            await ws.send_text(json.dumps({"type": "error", "error": "connecting"}, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            pass
        return
    try:
        j = json.loads(text)
        if isinstance(j, dict) and not j.get("session_id") and _session_id:
            j["session_id"] = _session_id
            text = json.dumps(j, ensure_ascii=False)
        # 拦截前端 abort：不透明传给官方（_inject_say_impl 会在 TTS 播放中时自己发一次 abort，
        # 避免双 abort 导致官方状态机混乱 + 触发"播放被中断，要不要再放一次"问候）
        if isinstance(j, dict) and j.get("type") == "abort":
            return
        if isinstance(j, dict) and j.get("type") == "listen" and j.get("state") == "detect":
            t = str(j.get("text") or "").strip()
            if t:
                # 所有文本（含"你好"等唤醒词）统一走音频流注入，不透传 detect 文本通道
                # （透传 detect 会触发官方"你好呀今天过得怎么样"唤醒问候；静默连接直接注入）
                if len(t) > 100:
                    t = t[:97] + "…"
                _chat_append("user", "text", t, tag="chat")
                ok = await _inject_say(t)
                if ok:
                    return
                # 注入失败则回退原文案透传上游
        await conn.send(text)
    except Exception as exc:  # noqa: BLE001
        logger.warning("转发上游失败: %s", exc)


@router.websocket("/ws")
async def xiaozhi_proxy(ws: WebSocket) -> None:
    await ws.accept()
    _subscribers[ws] = time.time()
    # role 参数：?role=main（桌宠本体，唯一音频播放者）/ ?role=chat（对话窗口）
    role = "chat"
    try:
        qp = ws.query_params
        role = "main" if (qp.get("role") == "main") else "chat"
    except Exception:  # noqa: BLE001
        pass
    _sub_roles[ws] = role
    q: asyncio.Queue = asyncio.Queue(maxsize=512)
    _sub_queues[ws] = q
    writer_task = asyncio.create_task(_sub_writer(ws))
    try:
        async with _upstream_lock:
            conn, err = await _ensure_upstream()
        if err is not None:
            await ws.send_text(json.dumps({"type": "error", "error": err}, ensure_ascii=False))
            await ws.close(code=1011, reason="upstream unavailable")
            return
        # 把当前 session_id 告知浏览器（可选）
        try:
            await ws.send_text(json.dumps({"type": "hello", "version": 1, "session_id": _session_id}, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            pass
        while True:
            message = await ws.receive()
            text = message.get("text")
            data = message.get("bytes")
            if text is None and data is None:
                break
            if text is not None:
                await _relay_browser_message(ws, text)
            elif data is not None:
                conn = _upstream
                if conn is not None:
                    try:
                        await conn.send(data)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("音频上行失败: %s", exc)
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.error("小智代理异常: %s", exc)
    finally:
        _subscribers.pop(ws, None)
        _sub_queues.pop(ws, None)
        _sub_roles.pop(ws, None)
        writer_task.cancel()
        try:
            await ws.close(code=1000, reason="bye")
        except Exception:  # noqa: BLE001
            pass
