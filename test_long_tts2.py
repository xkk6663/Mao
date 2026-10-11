"""test_long_tts2.py — 直接文本输入（不先发你好），观察官方是否响应长文本"""
import asyncio, json, sys, time
import websockets

TEXT = sys.argv[1] if len(sys.argv) > 1 else "你好，请帮我看看我现在在做什么？"

async def main():
    frames = 0
    pcm_bytes = 0
    tts_events = []
    stt_texts = []
    llm_texts = []
    t0 = time.time()

    async with websockets.connect("ws://127.0.0.1:8000/api/xiaozhi/ws?role=main") as ws:
        async def pump():
            nonlocal frames, pcm_bytes
            try:
                async for raw in ws:
                    if isinstance(raw, bytes):
                        frames += 1
                        pcm_bytes += len(raw)
                    else:
                        try:
                            j = json.loads(raw)
                        except Exception:
                            continue
                        t = j.get("type")
                        if t == "hello":
                            await ws.send(json.dumps({"type": "listen", "state": "detect", "text": TEXT, "source": "text", "session_id": j.get("session_id") or ""}))
                            print(f"[send {time.time()-t0:.1f}s] 直接发送: {TEXT[:40]}...")
                        elif t == "tts":
                            tts_events.append((time.time() - t0, j.get("state"), str(j.get("text"))[:40]))
                        elif t == "stt":
                            stt_texts.append(str(j.get("text")))
                            print(f"[stt {time.time()-t0:.1f}s] {j.get('text')}")
                        elif t == "llm":
                            llm_texts.append(str(j.get("text")))
                            print(f"[llm {time.time()-t0:.1f}s] {str(j.get('text'))[:80]}")
            except Exception as e:
                print("pump end:", e)

        task = asyncio.create_task(pump())
        await asyncio.sleep(20)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    print("=" * 50)
    print(f"耗时 {time.time()-t0:.1f}s | 帧 {frames} | 字节 {pcm_bytes}")
    print(f"tts事件: {len(tts_events)} | stt: {stt_texts} | llm: {llm_texts[:2]}")
    for ts, st, tx in tts_events:
        print(f"  +{ts:.1f}s tts {st} {tx}")

asyncio.run(main())
