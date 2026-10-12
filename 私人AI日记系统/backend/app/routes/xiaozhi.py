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
import io
import json
import logging
import os
import tempfile
import struct
import time
import uuid
import urllib.request
import wave
from pathlib import Path

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


class VisionRequest(BaseModel):
    image_base64: str
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
    global _observe_next_at, _observe_last_result
    from ..screen_capture import MssCapture
    while True:
        try:
            if _observe_cfg.get("enabled") and _in_quiet_hours():
                _observe_next_at = time.time() + 120  # 免打扰期间推迟
            elif _observe_cfg.get("enabled") and time.time() >= _observe_next_at:
                try:
                    img = await asyncio.to_thread(_full_screen_jpeg, MssCapture)
                    if img:
                        text = await asyncio.to_thread(
                            _vision_explain_sync,
                            img,
                            str(_prompt_cfg.get("observe_prompt") or _prompt_defaults["observe_prompt"]),
                        )
                        # 观察截图写入会话历史（同步到聊天界面）
                        _chat_append("user", "image", text="（屏幕观察）", image_base64=img, tag="observe")
                        # 观察评价写入历史 → 聊天界面显示为"她说"气泡（AI 在评价屏幕）
                        _chat_append("pet", "text", text, tag="observe")
                        # 屏幕观察只显示文本气泡：不注入官方（不触发唤醒/官方"拜拜"；官方视觉仅返回文本）
                        # 广播 speech-bubble → 桌宠显示气泡并自动消失（与截图提问一致）
                        await _broadcast_observe_bubble(text)
                        _observe_last_result = "已生成评价（文本气泡） · " + str(text)[:50]
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
    最近 3 秒内已写过同文本的 pet 记录（tag=vision/observe）→ 跳过，避免同一回复双写。"""
    full = (full or "").strip()
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
        await conn.send(json.dumps({"type": "listen", "state": "start", "mode": "auto", "session_id": _session_id}, ensure_ascii=False))
        await asyncio.sleep(0.3)
        for f in opus_frames:
            await conn.send(f)
        await asyncio.sleep(0.3)
        await conn.send(json.dumps({"type": "listen", "state": "stop", "session_id": _session_id}, ensure_ascii=False))
        return opus_frames
    except Exception as exc:  # noqa: BLE001
        logger.warning("音频流发送失败: %s", exc)
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


async def _inject_say(text: str, wait_upstream: float = 6.0, source: str = "user") -> bool:
    """注入入口：串行化锁（连续快速发消息时官方只响应一次，未加锁会互相 abort 导致吞消息）。"""
    async with _inject_lock:
        return await _inject_say_impl(text, wait_upstream, source)


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


async def _inject_say_impl(text: str, wait_upstream: float = 6.0, source: str = "user") -> bool:
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
        # 1. 只在官方 TTS 正在播放时才发 abort（避免无意义中断触发官方"播放被中断，要不要再放一次"问候）
        if _tts_playing:
            await conn.send(json.dumps({"type": "abort", "reason": "user_interrupt", "session_id": _session_id}, ensure_ascii=False))
            await asyncio.sleep(0.3)
            _tts_playing = False
        # 2. 静默连接：不发唤醒词 detect("你好")，直接音频流注入（listen start → 语音 → listen stop），
        #    官方靠 listen start + 音频帧直接 ASR 识别，避免每次新会话/重连都触发"你好呀今天过得怎么样"问候
        # 3. 音频流注入（不重试，避免相同音频被官方识别两次）
        frames = await _send_audio_stream(conn, text)
        if not frames:
            return False
        await _syslog(f"🎤 已发送语音「{str(text)[:40]}」等待官方识别…")
        # 4. 等 STT 确认（15s 超时；不重试，避免相同音频被官方识别两次）
        confirmed = await _wait_stt_confirmed(15.0)
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
        jpeg = base64.b64decode(image_base64)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("图片 base64 解码失败") from exc
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
    """上传/截图图片 → 小智官方视觉分析 → 注入对话（语音回答）。
    与聊天发图同一条链路：图片写入会话历史，分析文本注入后由官方云语音回答。"""
    if _vision is None:
        raise HTTPException(status_code=409, detail="小智视觉能力不可用：请先打开小智对话建立连接")
    question = str(payload.question or "").strip() or str(_prompt_cfg.get("image_prompt") or _prompt_defaults["image_prompt"])
    # 官方 ASR 对长音频识别会截断（>150字几乎必然失败）：
    # 强制要求官方视觉用 60 字以内简洁口语回答，保证注入音频能完整识别并播放
    if _prompt_cfg.get("force_60", True) and "字以内" not in question:
        question = f"{question}（请用60字以内的简洁口语回答）"
    image_base64 = str(payload.image_base64 or "").strip()
    if not image_base64:
        raise HTTPException(status_code=400, detail="图片不能为空")
    try:
        # 1. 图片写入会话历史（同步到聊天界面）
        _chat_append("user", "image", text=question, image_base64=image_base64, tag="chat")
        await _syslog("🖼️ 已发送图片给小智分析…")
        # 2. 官方视觉分析
        text = await asyncio.to_thread(_vision_explain_sync, image_base64, question)
        # 3. 分析文本写入历史 → 聊天界面显示为"她说"气泡（AI 在描述图片，不是用户发言）
        _chat_append("pet", "text", text, tag="vision")
        await _syslog("✅ 图片分析完成（小智返回文本）")
        # 4. 广播气泡给桌宠（自动消失，与截图提问/立即观察一致）：分析结果直接显示在桌宠旁气泡
        await _broadcast_observe_bubble(text)
        # 5. 图片识别只显示文本气泡：不注入官方（官方视觉仅返回文本；注入会触发唤醒/官方主动"拜拜"结束，
        #    且官方无独立 TTS 无法朗读分析文本）——用户确认接受"返回文本显示气泡"
        return {"ok": True, "text": text}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("小智视觉分析失败")
        raise HTTPException(status_code=502, detail=f"小智视觉分析失败: {exc}") from exc


@router.post("/vision-bubble")
async def xiaozhi_vision_bubble(payload: VisionRequest) -> dict:
    """截图/图片 → 小智官方视觉分析 → 广播 speech-bubble 给桌宠（气泡自动消失）。
    与 /vision 的区别：分析文本通过 pet_event_service 广播到桌宠显示气泡，
    而不是返回给调用方自行显示。供管理面板"立即观察"等场景使用，去掉旧的 /say 复述注入。"""
    if _vision is None:
        raise HTTPException(status_code=409, detail="小智视觉能力不可用：请先打开小智对话建立连接")
    _prompt_default = (
        str(_prompt_cfg.get("observe_prompt") or _prompt_defaults["observe_prompt"])
        if str(payload.kind or "").strip() == "observe"
        else str(_prompt_cfg.get("image_prompt") or _prompt_defaults["image_prompt"])
    )
    question = str(payload.question or "").strip() or _prompt_default
    # 官方视觉只返回文本；强制 60 字以内简洁口语，保证文本气泡可读
    if _prompt_cfg.get("force_60", True) and "字以内" not in question:
        question = f"{question}（请用60字以内的简洁口语回答）"
    image_base64 = str(payload.image_base64 or "").strip()
    if not image_base64:
        raise HTTPException(status_code=400, detail="图片不能为空")
    try:
        # 1. 图片写入会话历史（同步到聊天界面）
        _chat_append("user", "image", text=question, image_base64=image_base64, tag="observe")
        await _syslog("🖼️ 已发送图片给小智分析…")
        # 2. 官方视觉分析
        text = await asyncio.to_thread(_vision_explain_sync, image_base64, question)
        # 3. 分析文本写入历史 → 聊天界面显示为"她说"气泡
        _chat_append("pet", "text", text, tag="observe")
        await _syslog("✅ 图片分析完成（小智返回文本）")
        # 4. 广播气泡给桌宠（自动消失，与截图提问一致）；不注入官方
        await _broadcast_observe_bubble(text)
        return {"ok": True, "text": text}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("小智视觉分析失败（vision-bubble）")
        raise HTTPException(status_code=502, detail=f"小智视觉分析失败: {exc}") from exc


class PromptsRequest(BaseModel):
    image_prompt: str | None = None
    observe_prompt: str | None = None
    force_60: bool | None = None


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


async def _reconnect_loop(initial_delay: float = 3.0) -> None:
    """上游断开后自动重连（退避 3s→15s），成功后广播 hello 让前端恢复。"""
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
                    if j.get("type") == "mcp":
                        _capture_vision_from_mcp(j.get("payload"))
                    if j.get("type") == "stt":
                        _last_stt_ts = time.time()
                        _last_stt_text = str(j.get("text") or "")
                        # 机制级角色解耦：官方 STT 回传一律不写"你说"历史（含注入回声/官方误听），
                        # "你说"只由浏览器真实输入（_relay_browser_message）写入
                    if j.get("type") == "llm":
                        _pending_llm_text = str(j.get("text") or "")
                        _llm_text = _pending_llm_text
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
                        if j.get("type") == "mcp":
                            _capture_vision_from_mcp(j.get("payload"))
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
                            # 机制级角色解耦：官方 STT 回传一律不写"你说"历史（含注入回声/官方误听），
                            # "你说"只由浏览器真实输入（_relay_browser_message）写入
                        if j.get("type") == "llm":
                            _pending_llm_text = str(j.get("text") or "")
                            _llm_text = _pending_llm_text
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
