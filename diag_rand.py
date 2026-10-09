"""随机 Device-Id 测试：判断是否设备被官方云风控。"""
import asyncio, json, time, random
import websockets

UPSTREAM = "wss://api.tenclass.net/xiaozhi/v1/"
HELLO = {
    "type": "hello", "version": 1, "transport": "websocket",
    "audio_params": {"format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60},
}

def rand_mac():
    return ":".join(f"{random.randint(0,255):02X}" for _ in range(6))

async def main():
    mac = rand_mac()
    headers = {
        "Device-Id": mac, "Client-Id": mac,
        "Protocol-Version": "1", "Authorization": "Bearer test-token",
    }
    t0 = time.time()
    print(f"测试随机 MAC: {mac}", flush=True)
    try:
        conn = await websockets.connect(UPSTREAM, additional_headers=headers, max_size=None, open_timeout=10)
    except Exception as e:
        print(f"握手失败: {e}", flush=True)
        return
    try:
        await conn.send(json.dumps(HELLO))
        msg = await asyncio.wait_for(conn.recv(), timeout=8)
        j = json.loads(msg)
        print(f"收到: type={j.get('type')} session={j.get('session_id','?')} ({time.time()-t0:.1f}s)", flush=True)
        try:
            msg2 = await asyncio.wait_for(conn.recv(), timeout=5)
            print(f"5s内又收到: {str(msg2)[:150]}", flush=True)
        except asyncio.TimeoutError:
            print("5s 无消息（连接稳定）", flush=True)
    except Exception as e:
        print(f"hello 后异常: {e} ({time.time()-t0:.1f}s)", flush=True)
    finally:
        try:
            await conn.close()
        except Exception:
            pass

asyncio.run(main())
