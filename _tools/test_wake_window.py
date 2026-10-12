# -*- coding: utf-8 -*-
"""验证免唤醒窗口：say 两次（间隔 60s），第二次应无唤醒词问候"你来啦" """
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


async def collect_once(ws, text, label):
    print("=== %s: 发送 %r ===" % (label, text))
    t0 = time.time()
    r = await asyncio.to_thread(call_say, text)
    print("%s say ok=%s 耗时=%.1fs" % (label, r.get("ok"), time.time() - t0))
    seq = []
    try:
        async with asyncio.timeout(40):
            while True:
                m = await ws.recv()
                if isinstance(m, bytes):
                    continue
                try:
                    j = json.loads(m)
                    t = j.get("type")
                    if t in ("stt", "tts", "llm"):
                        seq.append("%s:%s" % (t, str(j.get("text") or j.get("state") or "")[:40]))
                    if t == "tts" and j.get("state") == "stop":
                        break
                except Exception:
                    pass
    except TimeoutError:
        pass
    print("%s 序列=%s" % (label, seq[:10]))
    has_greet = any("你来啦" in s or "你好呀" in s or "欢迎" in s for s in seq)
    print("%s 出现问候=%s" % (label, has_greet))
    return has_greet


async def main():
    async with websockets.connect(WS_URL, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        print("session=%s" % hello.get("session_id"))
        await collect_once(ws, "你好", "第1次")
        await asyncio.sleep(60)   # 间隔 60s（旧窗口 30s 会再次唤醒；新窗口 120s 应免唤醒）
        await collect_once(ws, "你好", "第2次(60s后)")


asyncio.run(main())
