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
import json
import logging
import os
import struct
import time
import uuid
import urllib.request
from pathlib import Path

import av
import websockets
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/xiaozhi", tags=["xiaozhi"])

XIAOZHI_UPSTREAM = os.getenv("MIO_XIAOZHI_UPSTREAM", "wss://api.tenclass.net/xiaozhi/v1/")
DEVICE_JSON = Path(
    os.getenv("MIO_XIAOZHI_DEVICE_JSON", "")
    or r"C:\Users\xiao1\Mio\xiaozhi_device.json"
)

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
_session_id: str | None = None
_subscribers: dict[WebSocket, float] = {}  # ws -> last_active_ts
_active_ws: WebSocket | None = None
_vision: dict | None = None  # 小智官方云下发的视觉能力 {"url": str, "token": str}


class VisionRequest(BaseModel):
    image_base64: str
    question: str = "图片里有什么？描述一下"


class XiaozhiSayRequest(BaseModel):
    text: str


# ---- 随机屏幕观察（冷不丁评价）----
_observe_cfg: dict = {
    "enabled": False,
    "min_seconds": 300,      # 默认 5–15 分钟随机
    "max_seconds": 900,
    "quiet_start": "23:00",  # 夜间免打扰
    "quiet_end": "08:00",
    "prompt": "用调侃吐槽的语气，简短评价我屏幕上正在做的事。",
}
_observe_next_at: float = 0.0
_observe_task: asyncio.Task | None = None
_observe_lock = asyncio.Lock()
_observe_last_result: str = "尚未触发"


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
                            str(_observe_cfg.get("prompt") or "用调侃吐槽的语气，简短评价我屏幕上正在做的事。"),
                        )
                        ok = await _inject_say(text)
                        _observe_last_result = ("语音已注入" if ok else "官方云未连接，语音未出") + " · " + str(text)[:50]
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


_last_wake_ts: float = 0.0  # 上次唤醒时间戳（30s 内会话可能仍活跃，可免唤醒直接注入）
_last_tts_stop: float = 0.0  # 上游最后一次 TTS 播完时间戳（用于判断唤醒回复是否已完整播完）


async def _inject_say(text: str, wait_upstream: float = 6.0) -> bool:
    """把文本注入小智会话（模拟用户发言）→ 小智语音/表情/口型联动。

    官方云限制：空闲会话的 detect 长文本会被拒绝（"Detect is only for wake words"），
    必须先发短文本唤醒词（detect）把会话激活，再注入长文本才能得到 STT/LLM/TTS。
    【稳定性关键】不能在唤醒后立即 abort 打断唤醒回复——实验证明 abort 会搞乱官方云
    会话状态，导致后续长文本无响应（用户听感=响一下→中断）。正确做法：等唤醒回复
    完整播完（sleep 3s）再注入长文本，音频连续。
    30 秒内已唤醒过（会话大概率仍活跃）则跳过唤醒，直接注入长文本（省一句废话）。
    官方云 1005 断连期：等待自动重连成功后再注入（最长 wait_upstream 秒）。
    返回是否成功注入（仅表示消息已发出，不代表官方云一定返回语音）。
    """
    global _last_wake_ts, _last_tts_stop
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
        # 1. 打断任何进行中的会话
        await conn.send(json.dumps({"type": "abort", "reason": "user_interrupt", "session_id": _session_id}, ensure_ascii=False))
        await asyncio.sleep(0.3)
        # 2. 若 30s 内已唤醒过则免唤醒；否则发短文本唤醒词并等其回复真实播完（监听 tts stop）
        need_wake = (time.time() - _last_wake_ts) > 30
        if need_wake:
            await conn.send(json.dumps({
                "type": "listen",
                "state": "detect",
                "text": "你好",
                "source": "text",
                "session_id": _session_id,
            }, ensure_ascii=False))
            # 等唤醒回复 TTS 完整播完：轮询 _last_tts_stop 更新（最多 6s）
            wake_ts_before = _last_tts_stop
            wait_until = time.time() + 6.0
            while time.time() < wait_until:
                await asyncio.sleep(0.3)
                if _last_tts_stop > wake_ts_before:
                    break
            await asyncio.sleep(0.5)  # 播完后再留半拍，确保服务器就绪
            _last_wake_ts = time.time()
        # 3. 注入真正的问题（长文本）
        msg = {
            "type": "listen",
            "state": "detect",
            "text": text,
            "source": "text",
            "session_id": _session_id,
        }
        await conn.send(json.dumps(msg, ensure_ascii=False))
        logger.info("注入小智语音成功: %s", str(text)[:40])
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
    _observe_next_at = time.time() + 20  # 首次 20 秒后即可触发（便于测试）
    await _ensure_observe_task()
    return {**_observe_cfg, "next_in_seconds": 20}


@router.post("/observe/stop")
async def xiaozhi_observe_stop() -> dict:
    _observe_cfg["enabled"] = False
    return {**_observe_cfg, "next_in_seconds": 0}


@router.post("/say")
async def xiaozhi_say(payload: XiaozhiSayRequest) -> dict:
    """把文本注入小智会话（模拟用户发言）→ 小智语音/表情/口型联动。"""
    text = str(payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="文本不能为空")
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


@router.get("/vision-info")
async def xiaozhi_vision_info() -> dict:
    return {
        "ok": _vision is not None,
        "url": (_vision or {}).get("url"),
        "has_token": bool((_vision or {}).get("token")),
    }


@router.post("/vision")
async def xiaozhi_vision(payload: VisionRequest) -> dict:
    if _vision is None:
        raise HTTPException(status_code=409, detail="小智视觉能力不可用：请先打开小智对话建立连接")
    try:
        text = await asyncio.to_thread(_vision_explain_sync, payload.image_base64, payload.question)
        return {"ok": True, "text": text}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("小智视觉分析失败")
        raise HTTPException(status_code=502, detail=f"小智视觉分析失败: {exc}") from exc


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
        "upstream": XIAOZHI_UPSTREAM,
        "connected": _upstream is not None,
        "session_id": _session_id,
        "subscribers": len(_subscribers),
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
    """向所有订阅者广播文本消息。"""
    for ws in list(_subscribers.keys()):
        try:
            await ws.send_text(text)
        except Exception:  # noqa: BLE001
            _subscribers.pop(ws, None)


async def _reconnect_loop(initial_delay: float = 3.0) -> None:
    """上游断开后自动重连（退避 3s→15s），成功后广播 hello 让前端恢复。"""
    delay = initial_delay
    while True:
        await asyncio.sleep(delay)
        async with _upstream_lock:
            conn, err = await _ensure_upstream()
        if conn is not None:
            await _broadcast(json.dumps({"type": "hello", "version": 1, "session_id": _session_id}, ensure_ascii=False))
            return
        logger.warning("上游重连失败，%.0fs 后重试: %s", delay, err)
        await _broadcast(json.dumps({"type": "error", "error": "connecting"}, ensure_ascii=False))
        delay = min(15.0, delay * 1.5)


async def _heartbeat_loop(conn) -> None:
    """上游心跳保活：每 30 秒发 ping，防止官方云因空闲超时断连。"""
    while True:
        await asyncio.sleep(30)
        try:
            await conn.send(json.dumps({"type": "ping"}))
        except Exception:  # noqa: BLE001
            return


async def _pump_upstream(conn) -> None:
    """上游消息持续转发给最近活跃订阅者；断线自动清理并允许重建。"""
    global _upstream, _last_tts_stop
    decoder = _OpusDecoder()
    _pump_audio_count = 0
    _pump_audio_bytes = 0
    try:
        while True:
            msg = await conn.recv()
            target = await _pick_target()
            if target is None:
                continue
            try:
                if isinstance(msg, bytes):
                    pcm = decoder.decode(msg)
                    if pcm is not None:
                        await target.send_bytes(pcm)
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
                        if j.get("type") in ("llm", "tts", "error", "listen", "abort"):
                            logger.info("上游消息 type=%s", j.get("type"))
                    except Exception:  # noqa: BLE001
                        pass
                    await target.send_text(msg)
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
        await _broadcast(json.dumps({"type": "error", "error": "connecting"}, ensure_ascii=False))
        asyncio.create_task(_reconnect_loop())


async def _ensure_upstream() -> tuple[object | None, str | None]:
    """确保全局单例上游存在并已 hello；返回 (conn, error)。"""
    global _upstream, _session_id
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
        conn = await websockets.connect(XIAOZHI_UPSTREAM, additional_headers=headers, max_size=None, open_timeout=10)
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
    except Exception as exc:  # noqa: BLE001
        logger.error("上游 hello 失败: %s", exc)
        try:
            await conn.close()
        except Exception:  # noqa: BLE001
            pass
        return None, f"官方云会话建立失败: {exc}"
    asyncio.create_task(_pump_upstream(conn))
    asyncio.create_task(_heartbeat_loop(conn))
    return conn, None


async def _relay_browser_message(ws: WebSocket, text: str) -> None:
    """浏览器文本消息转发上游，自动补齐 session_id，并标记该连接为活跃。"""
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
        await conn.send(text)
    except Exception as exc:  # noqa: BLE001
        logger.warning("转发上游失败: %s", exc)


@router.websocket("/ws")
async def xiaozhi_proxy(ws: WebSocket) -> None:
    await ws.accept()
    _subscribers[ws] = time.time()
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
        try:
            await ws.close(code=1000, reason="bye")
        except Exception:  # noqa: BLE001
            pass
