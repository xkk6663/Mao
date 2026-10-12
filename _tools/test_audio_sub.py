# -*- coding: utf-8 -*-
"""验证：订阅 ws 收音频帧 + 触发 say 注入，统计桌宠能收到的音频"""
import asyncio
import json
import urllib.request
import websockets

BASE = "http://127.0.0.1:8000"
WS_URL = "ws://127.0.0.1:8000/api/xiaozhi/ws"


def call_say():
    req = urllib.request.Request(
        BASE + "/api/xiaozhi/say",
        data=json.dumps({"text": "你好，你现在说话我能听到吗，请用一句话回答"}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def main():
    audio_bytes = 0
    audio_frames = 0
    msgs = []
    async with websockets.connect(WS_URL, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        print("订阅成功 session=%s" % hello.get("session_id"))

        # 触发 say（带唤醒注入）
        r = await asyncio.to_thread(call_say)
        print("say 返回: ok=%s" % r.get("ok"))

        # 收 30s 音频
        try:
            async with asyncio.timeout(30):
                while True:
                    m = await ws.recv()
                    if isinstance(m, bytes):
                        audio_bytes += len(m)
                        audio_frames += 1
                    else:
                        try:
                            j = json.loads(m)
                            t = j.get("type")
                            if t in ("stt", "tts", "llm", "alert", "error"):
                                msgs.append("%s:%s" % (t, str(j.get("text") or j.get("error") or j.get("state") or "")[:40]))
                            else:
                                msgs.append(t)
                        except Exception:
                            msgs.append("?")
        except TimeoutError:
            pass

    print("收到消息序列: %s" % msgs[:12])
    print("音频帧数=%d 音频字节=%d" % (audio_frames, audio_bytes))
    print("结论: %s" % ("桌宠应能听到声音" if audio_bytes > 1000 else "无音频（官方云未响应）"))


asyncio.run(main())
