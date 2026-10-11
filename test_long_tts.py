"""test_long_tts.py — 模拟 ChatPage 真实路径：WS 直接文本输入 → 官方 LLM → TTS
统计 tts 句子数/音频帧/是否提前 stop
"""
import asyncio, json, sys, time
import websockets

TEXT = sys.argv[1] if len(sys.argv) > 1 else (
    "请用调侃吐槽的语气，简短评价我屏幕上正在做的事。"
)

async def main():
    frames = 0
    pcm_bytes = 0
    tts_events = []
    t0 = time.time()
    done = False

    async with websockets.connect("ws://127.0.0.1:8000/api/xiaozhi/ws?role=main") as ws:
        async def pump():
            nonlocal frames, pcm_bytes, done
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
                        if t == "tts":
                            tts_events.append((time.time() - t0, j.get("state"), str(j.get("text"))[:30]))
                            if j.get("state") == "stop":
                                print(f"  [tts stop @ {time.time()-t0:.1f}s] 共 {len(tts_events)} 事件")
                        elif t == "hello":
                            sid = j.get("session_id") or ""
                            await ws.send(json.dumps({"type": "listen", "state": "detect", "text": "你好", "source": "text", "session_id": sid}))
                        elif t == "stt":
                            print(f"  [stt {time.time()-t0:.1f}s] {j.get('text')}")
                        elif t == "llm":
                            print(f"  [llm {time.time()-t0:.1f}s] {str(j.get('text'))[:60]}")
            except Exception as e:
                print("pump end:", e)

        task = asyncio.create_task(pump())
        await asyncio.sleep(3.0)  # 等 hello + 唤醒
        # 直接文本输入（ChatPage 发送逻辑）
        await ws.send(json.dumps({"type": "listen", "state": "detect", "text": TEXT, "source": "text", "session_id": ""}))
        print(f"[send {time.time()-t0:.1f}s] 已发送文本: {TEXT[:40]}...")
        await asyncio.sleep(25)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    print("=" * 50)
    print(f"耗时 {time.time()-t0:.1f}s | 音频帧 {frames} | 字节 {pcm_bytes}")
    starts = [e for e in tts_events if e[1] == "start"]
    sentences = [e for e in tts_events if e[1] == "sentence_start"]
    stops = [e for e in tts_events if e[1] == "stop"]
    print(f"tts: start={len(starts)} sentence_start={len(sentences)} stop={len(stops)}")
    for ts, st, tx in tts_events:
        print(f"  +{ts:.1f}s tts {st} {tx}")
    if stops and starts:
        print(f"首 start→末 stop 间隔 {(stops[-1][0]-starts[0][0]):.1f}s（长文本应持续多秒）")

asyncio.run(main())
