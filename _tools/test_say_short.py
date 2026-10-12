"""test_say_short.py — say 接口注入短文本，观察官方是否识别并回答"""
import asyncio, json, time, urllib.request
import websockets

TEXT = "屏幕上有游戏画面和音乐软件，请简单评价一下。"

async def main():
    frames = 0
    ev = []
    t0 = time.time()
    async with websockets.connect("ws://127.0.0.1:8000/api/xiaozhi/ws?role=main") as ws:
        async def pump():
            nonlocal frames
            try:
                async for raw in ws:
                    if isinstance(raw, bytes):
                        frames += 1
                    else:
                        try:
                            j = json.loads(raw)
                        except Exception:
                            continue
                        if j.get("type") == "tts":
                            ev.append((time.time() - t0, j.get("state"), str(j.get("text"))[:50]))
                            print(f"  [tts {time.time()-t0:.1f}s] {j.get('state')} {str(j.get('text'))[:50]}")
                        elif j.get("type") in ("stt", "llm"):
                            print(f"[{j.get('type')} {time.time()-t0:.1f}s] {str(j.get('text'))[:70]}")
            except Exception as e:
                print("end", e)

        task = asyncio.create_task(pump())
        await asyncio.sleep(1.5)
        req = urllib.request.Request(
            "http://127.0.0.1:8000/api/xiaozhi/say",
            data=json.dumps({"text": TEXT}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8"))
        print("say resp ok:", resp.get("ok"))
        await asyncio.sleep(22)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    print("=" * 40)
    print(f"帧 {frames} | tts事件 {len(ev)}")
    for ts, st, tx in ev:
        print(f"  +{ts:.1f}s tts {st} {tx}")

asyncio.run(main())
