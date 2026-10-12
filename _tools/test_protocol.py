# -*- coding: utf-8 -*-
"""官方云实验-带重试: A直接长文本 B唤醒->长文本"""
import asyncio
import json
import time
import websockets

WS_URL = "wss://api.tenclass.net/xiaozhi/v1/"
DEVICE_ID = "3C:DC:75:C3:11:13"
CLIENT_ID = "3C:DC:75:C3:11:13"  # 与后端一致：官方云校验 Client-Id 与设备绑定
TOKEN = "test-token"


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
                        got.append((now, "stt:" + str(j.get("text"))[:40]))
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


async def connect_once():
    headers = {
        "Authorization": "Bearer " + TOKEN,
        "Protocol-Version": "1",
        "Device-Id": DEVICE_ID,
        "Client-Id": CLIENT_ID,
    }
    ws = await websockets.connect(WS_URL, additional_headers=headers, max_size=None, ping_interval=None)
    await ws.send(json.dumps({
        "type": "hello", "version": 1, "transport": "websocket",
        "audio_params": {"format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60},
    }, ensure_ascii=False))
    hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
    return ws, hello.get("session_id")


async def exp_with_retry(name, fn, retries=4, gap=3):
    for i in range(retries):
        print("===== %s (尝试%d) =====" % (name, i + 1))
        try:
            await fn()
            return
        except Exception as e:
            print("  连接失败: %s" % str(e)[:120])
            if i < retries - 1:
                await asyncio.sleep(gap)


async def exp_a():
    ws, sid = await connect_once()
    await ws.send(json.dumps({"type": "listen", "state": "detect",
                              "text": "用一句话评价你现在看到的屏幕内容", "session_id": sid}, ensure_ascii=False))
    r = await collect(ws, 8)
    print("  ".join("[%s] %s" % x for x in r[:14]))
    await ws.close()


async def exp_b():
    ws, sid = await connect_once()
    await ws.send(json.dumps({"type": "listen", "state": "detect", "text": "你好", "session_id": sid}, ensure_ascii=False))
    r1 = await collect(ws, 3.5)
    print("  唤醒3.5s:", "  ".join("[%s] %s" % x for x in r1[:10]), "帧数=", sum(1 for _, t in r1 if t == "audio"))
    await ws.send(json.dumps({"type": "listen", "state": "detect",
                              "text": "用一句话评价你现在看到的屏幕内容", "session_id": sid}, ensure_ascii=False))
    r2 = await collect(ws, 10)
    print("  长文本10s:", "  ".join("[%s] %s" % x for x in r2[:16]), "帧数=", sum(1 for _, t in r2 if t == "audio"))
    await ws.close()


asyncio.run(exp_with_retry("A: 直接detect长文本(不唤醒)", exp_a))
asyncio.run(exp_with_retry("B: 唤醒->等3.5s->长文本", exp_b))
