# -*- coding: utf-8 -*-
"""模拟订阅者：连本地 ws → 触发官方云建连 → 收 hello/状态"""
import asyncio
import json
import websockets

WS_URL = "ws://127.0.0.1:8000/api/xiaozhi/ws"


async def main():
    async with websockets.connect(WS_URL, max_size=None) as ws:
        print("已连接本地 ws")
        try:
            async with asyncio.timeout(15):
                while True:
                    m = await ws.recv()
                    if isinstance(m, bytes):
                        print("收到音频帧 %d 字节" % len(m))
                    else:
                        j = json.loads(m)
                        print("收到文本 type=%s %s" % (j.get("type"), str(j.get("session_id") or j.get("error") or "")[:60]))
                        if j.get("type") == "error":
                            break
        except TimeoutError:
            print("15s 无消息（官方云未响应）")


asyncio.run(main())
