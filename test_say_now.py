# -*- coding: utf-8 -*-
"""实测当前 say + 订阅收音频"""
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
        print("订阅 session=%s" % hello.get("session_id"))
        t0 = asyncio.get_event_loop().time()
        r = await asyncio.to_thread(call_say, "你好，测试一下你现在能说话吗")
        t1 = asyncio.get_event_loop().time()
        print("say 返回 ok=%s 耗时=%.1fs" % (r.get("ok"), t1 - t0))
        frames = 0
        seq = []
        try:
            async with asyncio.timeout(20):
                while True:
                    m = await ws.recv()
                    if isinstance(m, bytes):
                        frames += 1
                    else:
                        try:
                            j = json.loads(m)
                            t = j.get("type")
                            if t in ("stt", "tts", "llm", "alert", "error"):
                                seq.append("%s:%s" % (t, str(j.get("text") or j.get("message") or j.get("error") or j.get("state") or "")[:30]))
                        except Exception:
                            pass
        except TimeoutError:
            pass
        print("音频帧=%d 序列=%s" % (frames, seq[:10]))
        print("结论: %s" % ("当前音频链路通" if frames > 5 else "当前无音频（官方云断档）"))


asyncio.run(main())
