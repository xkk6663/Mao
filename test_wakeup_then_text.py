# -*- coding: utf-8 -*-
"""实验2：短文本唤醒后，尝试注入长文本对话"""
import asyncio
import json
import websockets

WS_URL = "ws://127.0.0.1:8000/api/xiaozhi/ws"


async def send_and_collect(ws, msg, timeout=12):
    await ws.send(json.dumps(msg, ensure_ascii=False))
    got = []
    try:
        async with asyncio.timeout(timeout):
            while True:
                m = await ws.recv()
                if isinstance(m, bytes):
                    got.append("audio:%d" % len(m))
                else:
                    try:
                        j = json.loads(m)
                        t = j.get("type")
                        if t in ("llm", "tts", "listen", "abort", "error", "hello", "alert", "stt"):
                            got.append("%s|%s" % (t, str(j.get("text") or j.get("error") or j.get("state") or "")[:40]))
                        else:
                            got.append(t)
                    except Exception:
                        got.append("text?")
    except TimeoutError:
        pass
    return got


async def main():
    async with websockets.connect(WS_URL, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        sid = hello.get("session_id")
        print("session=%s" % sid)

        # 1. 短文本唤醒
        r1 = await send_and_collect(ws, {"session_id": sid, "type": "listen", "state": "detect", "text": "你好"})
        print("[1 唤醒] %s" % r1[:6])
        if not any("audio" in x for x in r1):
            print("唤醒未触发音频，终止")
            return
        await asyncio.sleep(1)

        # 2. 唤醒后：speaking + 长文本
        r2 = await send_and_collect(ws, {"session_id": sid, "type": "listen", "state": "speaking", "text": "帮我看看我的屏幕，你看到了什么"})
        print("[2 speaking长文本] %s" % r2[:8])

        # 3. 唤醒后：detect + 长文本
        r3 = await send_and_collect(ws, {"session_id": sid, "type": "listen", "state": "detect", "text": "帮我看看我的屏幕，你看到了什么"})
        print("[3 detect长文本] %s" % r3[:8])

        # 4. 唤醒后：detect + 短文本再问
        r4 = await send_and_collect(ws, {"session_id": sid, "type": "listen", "state": "detect", "text": "屏幕"})
        print("[4 detect短文本] %s" % r4[:8])

    print("实验2结束")


asyncio.run(main())
