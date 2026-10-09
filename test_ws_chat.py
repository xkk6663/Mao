# -*- coding: utf-8 -*-
"""模拟对话浮窗：直连 /api/xiaozhi/ws 发送 listen，监听官方云返回（LLM/TTS/音频帧）"""
import asyncio
import json
import websockets

WS_URL = "ws://127.0.0.1:8000/api/xiaozhi/ws"


async def main():
    async with websockets.connect(WS_URL, max_size=None) as ws:
        # 收 hello
        try:
            hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
            print("收到 hello: session=%s" % hello.get("session_id"))
            session_id = hello.get("session_id")
        except Exception as exc:
            print("未收到 hello: %s" % exc)
            session_id = None

        # 发 abort + listen（与对话浮窗一致）
        await ws.send(json.dumps({"session_id": session_id, "type": "abort", "reason": "user_interrupt"}))
        await ws.send(json.dumps({
            "session_id": session_id,
            "type": "listen",
            "state": "detect",
            "text": "你现在能听到我说话吗，用一句话回答我",
            "source": "text",
        }))
        print("已发送 listen，等待官方云响应…")

        got_any = False
        try:
            async with asyncio.timeout(25):
                while True:
                    msg = await ws.recv()
                    got_any = True
                    if isinstance(msg, bytes):
                        print("收到音频帧: %d 字节" % len(msg))
                    else:
                        try:
                            j = json.loads(msg)
                            t = j.get("type")
                            if t in ("llm", "tts", "listen", "abort", "error", "hello", "alert"):
                                print("消息 type=%s 完整=%s" % (t, json.dumps(j, ensure_ascii=False)[:300]))
                            else:
                                print("消息 type=%s" % t)
                        except Exception:
                            print("文本: %s" % str(msg)[:80])
        except TimeoutError:
            pass
        print("结束。收到任何消息: %s" % got_any)


asyncio.run(main())
