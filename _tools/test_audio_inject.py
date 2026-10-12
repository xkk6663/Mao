# -*- coding: utf-8 -*-
"""音频流注入实验 - 走后端长连接（绕过官方云新连接1005）：
后端ws: detect唤醒 -> 等唤醒回复 -> listen start -> 发opus音频 -> listen stop -> 收回答
"""
import asyncio
import io
import json
import time
import wave
import websockets
import av
import numpy as np

BACKEND_WS = "ws://127.0.0.1:8000/api/xiaozhi/ws"


def sapi_tts_wav(text: str) -> bytes:
    import comtypes.client
    import comtypes.gen.SpeechLib as SL
    sp = comtypes.client.CreateObject("SAPI.SpVoice")
    fs = comtypes.client.CreateObject("SAPI.SpFileStream")
    fs.Format.Type = SL.SpeechAudioFormatType.SAFT16kHz16BitMono
    fs.Open("C:\\Users\\xiao1\\Mio\\tts_tmp.wav", 3, False)
    sp.AudioOutputStream = fs
    sp.Speak(text)
    fs.Close()
    with open("C:\\Users\\xiao1\\Mio\\tts_tmp.wav", "rb") as f:
        return f.read()


def wav_to_opus_frames(wav_bytes: bytes, samples_per_frame: int = 960):
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
        f0 = av.AudioFrame.from_ndarray(arr, format="s16", layout="mono")
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


async def collect(ws, timeout):
    got = []
    t0 = time.time()
    try:
        async with asyncio.timeout(timeout):
            while True:
                m = await ws.recv()
                now = round(time.time() - t0, 2)
                if isinstance(m, bytes):
                    got.append((now, "audio"))
                else:
                    j = json.loads(m)
                    t = j.get("type")
                    if t == "stt":
                        got.append((now, "stt:" + str(j.get("text"))[:50]))
                    elif t == "tts":
                        got.append((now, "tts:" + str(j.get("state"))))
                    elif t == "llm":
                        got.append((now, "llm:" + str(j.get("emotion") or j.get("text"))[:40]))
                    elif t == "alert":
                        got.append((now, "alert:" + str(j.get("message") or j.get("text"))[:60]))
                    else:
                        got.append((now, t + ":" + json.dumps(j, ensure_ascii=False)[:60]))
    except TimeoutError:
        pass
    return got


async def main():
    wav = sapi_tts_wav("你好，请介绍一下你自己")
    print("TTS wav len=%d" % len(wav))
    frames = wav_to_opus_frames(wav)
    print("opus 帧数=%d" % len(frames))

    async with websockets.connect(BACKEND_WS, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        sid = hello.get("session_id")
        print("后端session=%s" % sid)

        # 唤醒
        await ws.send(json.dumps({"type": "listen", "state": "detect", "text": "你好", "session_id": sid}, ensure_ascii=False))
        r_wake = await collect(ws, 4)
        print("唤醒:", "  ".join("[%s] %s" % x for x in r_wake[:8]), "帧=", sum(1 for _, t in r_wake if t == "audio"))

        # listen start -> 音频 -> stop
        await ws.send(json.dumps({"type": "listen", "state": "start", "mode": "auto", "session_id": sid}, ensure_ascii=False))
        print("listen start，发送 %d 帧..." % len(frames))
        for f in frames:
            await ws.send(f)
        await asyncio.sleep(0.3)
        await ws.send(json.dumps({"type": "listen", "state": "stop", "session_id": sid}, ensure_ascii=False))
        print("listen stop，等待 ASR/LLM/TTS...")
        r_ans = await collect(ws, 15)
        print("回答:", "  ".join("[%s] %s" % x for x in r_ans[:18]), "帧=", sum(1 for _, t in r_ans if t == "audio"))
        n = sum(1 for _, t in r_ans if t == "audio")
        print("结论: %s" % ("音频流注入成功(有声音)" if n > 10 else "失败(无声音)"))


asyncio.run(main())
