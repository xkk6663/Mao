# -*- coding: utf-8 -*-
"""模拟 overlay.html 区域截图→视觉→语音注入 全流程，定位断点"""
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8000"


def post_json(path, obj, timeout=60):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(obj, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        except Exception:
            return exc.code, {"detail": str(exc)}


def main():
    print("=== 1. 全屏截图 ===")
    code, s = post_json("/api/companion/screen-shot", {}, timeout=30)
    print("status", code, "ok=", s.get("ok"), "size=", s.get("width"), "x", s.get("height"))
    if code != 200 or not s.get("image_base64"):
        print("全屏截图失败，中止")
        return

    print("=== 2. 区域截图（中央 1/4 区域）===")
    w, h = s["width"], s["height"]
    bbox = [w // 4, h // 4, w // 2, h // 2]
    code2, s2 = post_json("/api/companion/screen-shot", {"bbox": bbox}, timeout=30)
    print("status", code2, "ok=", s2.get("ok"), "bbox=", s2.get("bbox"), "len=", len(s2.get("image_base64") or ""))
    if code2 != 200 or not s2.get("image_base64"):
        print("区域截图失败，中止")
        return

    print("=== 3. 视觉分析 ===")
    code3, v = post_json(
        "/api/xiaozhi/vision",
        {"image_base64": s2["image_base64"], "question": "详细描述这张截图区域里的内容，包括窗口、文字和界面元素。"},
        timeout=60,
    )
    print("status", code3, "ok=", v.get("ok"), "text=", str(v.get("text"))[:80])
    if code3 != 200:
        print("视觉分析失败（可能官方云 hello 未建立 → MCP vision 未下发）")

    print("=== 4. 语音注入 ===")
    if code3 == 200:
        code4, say = post_json("/api/xiaozhi/say", {"text": "你看看我屏幕上的这个区域：" + v["text"]}, timeout=30)
        print("status", code4, "ok=", say.get("ok"))
    print("DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print("FAIL:", exc)
        sys.exit(1)
