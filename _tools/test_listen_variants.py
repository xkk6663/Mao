# -*- coding: utf-8 -*-
"""实验：不同 listen state 变体，找出官方云接受的文本对话方式"""
import asyncio
import json
import websockets

WS_URL = "ws://127.0.0.1:8000/api/xiaozhi/ws"

VARIANTS = [
    ("A detect+短文本", {"type": "listen", "state": "detect", "text": "你好"}),
    ("B speaking+text", {"type": "listen", "state": "speaking", "text": "你现在能听到我说话吗"}),
    ("C detect+text无source", {"type": "listen", "state": "detect", "text": "你现在能听到我说话吗"}),
    ("D start+mode然后speaking", None),  # 特殊处理
]


async def try_variant(ws, label, msg):
    await ws.send(json.dumps(msg, ensure_ascii=False))
    print("[%s] 已发送 %s" % (label, json.dumps(msg, ensure_ascii=False)[:80]))
    got = []
    try:
        async with asyncio.timeout(12):
            while True:
                m = await ws.recv()
                if isinstance(m, bytes):
                    got.append("audio:%d" % len(m))
                else:
                    try:
                        j = json.loads(m)
                        t = j.get("type")
                        if t in ("llm", "tts", "listen", "abort", "error", "hello", "alert", "stt"):
                            got.append("%s:%s" % (t, str(j.get("text") or j.get("error") or j.get("state") or "")[:50]))
                        else:
                            got.append(t)
                    except Exception:
                        got.append("text?")
    except TimeoutError:
        pass
    print("[%s] 响应: %s" % (label, got[:8]))
    return got


async def main():
    async with websockets.connect(WS_URL, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        sid = hello.get("session_id")
        print("hello session=%s\n" % sid)

        # A/B/C
        for label, msg in VARIANTS[:3]:
            msg["session_id"] = sid
            r = await try_variant(ws, label, msg)
            if any("tts" in x or "audio" in x for x in r):
                print(">>> %s 触发音频！" % label)
                break
            await asyncio.sleep(1)

        # D: start → speaking
        print("[D] 发送 start 再 speaking")
        await ws.send(json.dumps({"session_id": sid, "type": "listen", "state": "start", "mode": "auto"}))
        await asyncio.sleep(1)
        await ws.send(json.dumps({"session_id": sid, "type": "listen", "state": "speaking", "text": "你现在能听到我说话吗"}))
        got = []
        try:
            async with asyncio.timeout(12):
                while True:
                    m = await ws.recv()
                    if isinstance(m, bytes):
                        got.append("audio:%d" % len(m))
                    else:
                        try:
                            j = json.loads(m)
                            t = j.get("type")
                            if t in ("llm", "tts", "listen", "abort", "error", "hello", "alert", "stt"):
                                got.append("%s:%s" % (t, str(j.get("text") or j.get("error") or j.get("state") or "")[:50]))
                            else:
                                got.append(t)
                        except Exception:
                            got.append("text?")
        except TimeoutError:
            pass
        print("[D] 响应: %s" % got[:8])

    print("\n实验结束")


asyncio.run(main())
