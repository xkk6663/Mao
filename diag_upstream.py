"""独立直连官方云诊断：验证单条连接稳定性（不经过 Mio 后端）。"""
import asyncio, json, time, sys
import websockets

UPSTREAM = "wss://api.tenclass.net/xiaozhi/v1/"
HELLO = {
    "type": "hello", "version": 1, "transport": "websocket",
    "audio_params": {"format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60},
    "features": {"mcp": True},
}

def device_identity():
    import uuid, hashlib
    mac = uuid.getnode()
    mac_str = ":".join(f"{(mac >> (8 * i)) & 0xFF:02X}" for i in reversed(range(6)))
    return {"mac": mac_str}

async def main():
    ident = device_identity()
    headers = {
        "Device-Id": ident["mac"], "Client-Id": ident["mac"],
        "Protocol-Version": "1", "Authorization": "Bearer test-token",
    }
    t0 = time.time()
    drops = 0
    hello_ok = False
    try:
        conn = await websockets.connect(UPSTREAM, additional_headers=headers, max_size=None, open_timeout=10)
    except Exception as e:
        print(f"[{time.time()-t0:.1f}s] 握手失败: {e}", flush=True)
        return
    print(f"[{time.time()-t0:.1f}s] 握手成功", flush=True)
    try:
        await conn.send(json.dumps(HELLO))
        msg = await asyncio.wait_for(conn.recv(), timeout=10)
        j = json.loads(msg)
        hello_ok = j.get("type") == "hello"
        print(f"[{time.time()-t0:.1f}s] hello 响应 type={j.get('type')} session={j.get('session_id','?')}", flush=True)
    except Exception as e:
        print(f"[{time.time()-t0:.1f}s] hello 失败: {e}", flush=True)
        await conn.close()
        return
    # 观察 90 秒：发 ping 每 25s，统计断连
    try:
        while time.time() - t0 < 90:
            try:
                msg = await asyncio.wait_for(conn.recv(), timeout=25)
                j = json.loads(msg)
                print(f"[{time.time()-t0:.1f}s] recv type={j.get('type')}", flush=True)
            except asyncio.TimeoutError:
                print(f"[{time.time()-t0:.1f}s] 25s 无消息，发 ping", flush=True)
                await conn.send(json.dumps({"type": "ping"}))
            except Exception as e:
                drops += 1
                print(f"[{time.time()-t0:.1f}s] 断连#{drops}: {e}", flush=True)
                break
    finally:
        await conn.close()
    print(f"总结: hello_ok={hello_ok} drops={drops} 存活={time.time()-t0:.1f}s", flush=True)

asyncio.run(main())
