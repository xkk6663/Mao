# -*- coding: utf-8 -*-
"""实验：不abort打断唤醒，等唤醒回复播完(sleep 3s)再注入长文本，验证音频连续"""
import asyncio
import json
import websockets

WS_URL = "ws://127.0.0.1:8000/api/xiaozhi/ws"


async def collect(ws, timeout):
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


async def main():
    async with websockets.connect(WS_URL, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        sid = hello.get("session_id")
        print("session=%s" % sid)

        # 方案A：唤醒 → 等3s(唤醒回复播完) → 长文本（不abort）
        await ws.send(json.dumps({"session_id": sid, "type": "listen", "state": "detect", "text": "你好"}))
        r1 = await collect(ws, 3.0)
        print("[A 唤醒3s] 消息=%s 音频帧=%d" % (r1[:6], r1.count("audio")))
        await ws.send(json.dumps({
            "session_id": sid,
            "type": "listen",
            "state": "detect",
            "text": "用一句话评价你正在做的事",
        }))
        r2 = await collect(ws, 12)
        print("[A 长文本] 消息=%s 音频帧=%d" % (r2[:8], r2.count("audio")))
        print("[A] 结论: %s" % ("连续出声OK" if r2.count("audio") > 20 else "长文本无音频"))

        await asyncio.sleep(1)

        # 方案B：直接长文本（无唤醒）—— 对照组
        await ws.send(json.dumps({"session_id": sid, "type": "abort", "reason": "user_interrupt"}))
        await asyncio.sleep(1)
        await ws.send(json.dumps({
            "session_id": sid,
            "type": "listen",
            "state": "detect",
            "text": "再测试一次，你听到了吗",
        }))
        r3 = await collect(ws, 10)
        print("[B 无唤醒长文本] 消息=%s 音频帧=%d" % (r3[:6], r3.count("audio")))


asyncio.run(main())
