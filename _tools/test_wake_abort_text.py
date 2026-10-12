# -*- coding: utf-8 -*-
"""实验3：唤醒 → abort 打断唤醒回复 → 长文本注入 → 音频"""
import asyncio
import json
import websockets

WS_URL = "ws://127.0.0.1:8000/api/xiaozhi/ws"


async def main():
    async with websockets.connect(WS_URL, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        sid = hello.get("session_id")
        print("session=%s" % sid)

        async def collect(timeout=10):
            got = []
            try:
                async with asyncio.timeout(timeout):
                    while True:
                        m = await ws.recv()
                        if isinstance(m, bytes):
                            got.append("audio")
                        else:
                            j = json.loads(m)
                            got.append(j.get("type"))
            except TimeoutError:
                pass
            return got

        # 1. abort
        await ws.send(json.dumps({"session_id": sid, "type": "abort", "reason": "user_interrupt"}))
        # 2. 唤醒短词
        await ws.send(json.dumps({"session_id": sid, "type": "listen", "state": "detect", "text": "你好"}))
        r1 = await collect(3.5)  # 等唤醒回复开始
        print("[唤醒] %s" % r1[:6])
        # 3. abort 打断唤醒回复
        await ws.send(json.dumps({"session_id": sid, "type": "abort", "reason": "user_interrupt"}))
        await asyncio.sleep(0.5)
        # 4. 长文本注入
        await ws.send(json.dumps({
            "session_id": sid,
            "type": "listen",
            "state": "detect",
            "text": "用一句话评价你看到的屏幕画面",
        }))
        r2 = await collect(12)
        print("[长文本] %s" % r2[:10])
        audio_count = r2.count("audio")
        tts_count = sum(1 for _ in [])  # placeholder
        print("音频帧数=%d tts=%s" % (audio_count, "tts" in r2))


asyncio.run(main())
