"""hello 变体测试：找出官方云接受的 hello 格式。"""
import asyncio, json, time
import websockets

UPSTREAM = "wss://api.tenclass.net/xiaozhi/v1/"
VARIANTS = {
    "A_basic_v1_no_features": {
        "type": "hello", "version": 1, "transport": "websocket",
        "audio_params": {"format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60},
    },
    "B_v3_features_mcp": {
        "type": "hello", "version": 3,
        "features": {"mcp": True},
        "transport": "websocket",
        "audio_params": {"format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60},
    },
    "C_v1_features_mcp": {
        "type": "hello", "version": 1,
        "features": {"mcp": True},
        "transport": "websocket",
        "audio_params": {"format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60},
    },
}

def device_identity():
    import uuid
    mac = uuid.getnode()
    mac_str = ":".join(f"{(mac >> (8 * i)) & 0xFF:02X}" for i in reversed(range(6)))
    return {"mac": mac_str}

async def try_variant(name, hello):
    ident = device_identity()
    headers = {
        "Device-Id": ident["mac"], "Client-Id": ident["mac"],
        "Protocol-Version": "1", "Authorization": "Bearer test-token",
    }
    t0 = time.time()
    try:
        conn = await websockets.connect(UPSTREAM, additional_headers=headers, max_size=None, open_timeout=10)
    except Exception as e:
        print(f"[{name}] 握手失败: {e}", flush=True)
        return
    try:
        await conn.send(json.dumps(hello))
        msg = await asyncio.wait_for(conn.recv(), timeout=8)
        j = json.loads(msg)
        print(f"[{name}] 收到: type={j.get('type')} session={j.get('session_id','?')} transport={j.get('transport','?')} ({time.time()-t0:.1f}s)", flush=True)
        # 继续观察 5 秒看是否稳定
        try:
            msg2 = await asyncio.wait_for(conn.recv(), timeout=5)
            print(f"[{name}] 5s内又收到: {msg2[:120]}", flush=True)
        except asyncio.TimeoutError:
            print(f"[{name}] 5s 无消息（连接稳定）", flush=True)
    except Exception as e:
        print(f"[{name}] hello 后异常: {e} ({time.time()-t0:.1f}s)", flush=True)
    finally:
        try:
            await conn.close()
        except Exception:
            pass

async def main():
    for name, hello in VARIANTS.items():
        await try_variant(name, hello)
        await asyncio.sleep(2)

asyncio.run(main())
