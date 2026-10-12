# -*- coding: utf-8 -*-
"""连续触发 say 3 次，统计每次音频帧"""
import asyncio
import json
import urllib.request
import websockets

BASE = "http://127.0.0.1:8000"
WS_URL = "ws://127.0.0.1:8000/api/xiaozhi/ws"


def call_say(text):
    req = urllib.request.Request(
        BASE + "/api/xiaozhi/say",
        data=json.dumps({"text": text}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def main():
    async with websockets.connect(WS_URL, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        print("订阅成功 session=%s\n" % hello.get("session_id"))
        for i, text in enumerate(["你好呀", "今天天气怎么样", "你现在能听到吗"]):
            r = await asyncio.to_thread(call_say, text)
            frames = 0
            bytes_n = 0
            seq = []
            try:
                async with asyncio.timeout(18):
                    while True:
                        m = await ws.recv()
                        if isinstance(m, bytes):
                            frames += 1
                            bytes_n += len(m)
                        else:
                            try:
                                j = json.loads(m)
                                t = j.get("type")
                                if t in ("stt", "tts", "llm", "alert", "error"):
                                    seq.append("%s:%s" % (t, str(j.get("text") or j.get("message") or j.get("error") or j.get("state") or "")[:30]))
                                else:
                                    seq.append(t)
                            except Exception:
                                seq.append("?")
            except TimeoutError:
                pass
            print("[%d] say=%s ok=%s 音频帧=%d 字节=%d 序列=%s" % (i + 1, text[:10], r.get("ok"), frames, bytes_n, seq[:8]))
            await asyncio.sleep(1)


asyncio.run(main())
