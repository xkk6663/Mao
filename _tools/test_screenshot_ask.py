# -*- coding: utf-8 -*-
"""验证截图提问全链路：screen-shot → vision → say，并检查音频帧转发"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8000"


def call(path, method="GET", obj=None, timeout=40):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(obj, ensure_ascii=False).encode("utf-8") if obj is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# 1. 截屏
shot = call("/api/companion/screen-shot", "POST", {})
print("1. screen-shot: ok=%s 图片长度=%s" % (shot.get("ok"), len(shot.get("image_base64", ""))))
if not shot.get("ok"):
    raise SystemExit("截图失败")

# 2. 视觉分析
vision = call("/api/xiaozhi/vision", "POST", {
    "image_base64": shot["image_base64"],
    "question": "用调侃吐槽的语气，简短评价我屏幕上正在做的事。",
})
print("2. vision: ok=%s 评价=%s" % (vision.get("ok"), str(vision.get("text") or "")[:40]))

# 3. 注入 say（断连时最长等 20s 重连）
t0 = time.time()
say = call("/api/xiaozhi/say", "POST", {"text": "你看看我的屏幕：" + str(vision.get("text") or "")}, timeout=45)
print("3. say: ok=%s 耗时=%.1fs" % (say.get("ok"), time.time() - t0))

# 4. 等音频帧转发（最多 30s）
time.sleep(8)
print("4. 已等待音频播放窗口（8s），请确认桌宠是否出声")
