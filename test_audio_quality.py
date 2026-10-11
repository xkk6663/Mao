# -*- coding: utf-8 -*-
"""完整链路测试：say → 收集回答音频帧 → 统计连续性 + 断连情况"""
import asyncio
import json
import time
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
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def main():
    async with websockets.connect(WS_URL, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        print("session=%s" % hello.get("session_id"))
        t0 = time.time()
        r = await asyncio.to_thread(call_say, "你好")
        print("say 返回耗时=%.1fs ok=%s" % (time.time() - t0, r.get("ok")))
        frames = []
        seq = []
        t_start = time.time()
        try:
            async with asyncio.timeout(60):
                while True:
                    m = await ws.recv()
                    now = time.time() - t_start
                    if isinstance(m, bytes):
                        frames.append((now, len(m)))
                    else:
                        try:
                            j = json.loads(m)
                            t = j.get("type")
                            if t in ("stt", "tts", "llm", "alert", "error"):
                                seq.append("%s:%s" % (t, str(j.get("text") or j.get("message") or j.get("error") or j.get("state") or "")[:24]))
                            if t == "tts" and j.get("state") == "stop":
                                break
                        except Exception:
                            pass
        except TimeoutError:
            pass
        n = len(frames)
        print("序列=%s" % seq[:12])
        print("帧数=%d 总时长=%.1fs" % (n, (frames[-1][0] - frames[0][0]) if n > 1 else 0))
        if n > 2:
            gaps = [round(frames[i+1][0] - frames[i][0], 3) for i in range(n - 1)]
            big = [g for g in gaps if g > 0.15]
            print("间隔 min=%.3fs max=%.3fs avg=%.3fs 断点(>150ms)=%d" % (
                min(gaps), max(gaps), sum(gaps)/len(gaps), len(big)))
            print("前10帧时间:", [round(f[0], 3) for f in frames[:10]])


asyncio.run(main())
