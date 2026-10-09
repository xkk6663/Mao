# -*- coding: utf-8 -*-
"""用 Python 直测观察注入链路（绕开 PowerShell 编码问题）"""
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
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    print("step1 screen-shot ...")
    shot = post_json("/api/companion/screen-shot", {}, timeout=30)
    print("shot ok =", shot.get("ok"))
    if not shot.get("ok"):
        print("shot fail:", shot)
        return
    print("step2 vision ...")
    vision = post_json(
        "/api/xiaozhi/vision",
        {
            "image_base64": shot["image_base64"],
            "question": "用调侃吐槽的语气，简短评价我屏幕上正在做的事。",
        },
        timeout=60,
    )
    text = vision.get("text", "")
    print("vision ok =", vision.get("ok"), "len =", len(text))
    print("head =", text[:80])
    print("step3 say ...")
    say = post_json(
        "/api/xiaozhi/say",
        {"text": "你看看我的屏幕：" + text},
        timeout=30,
    )
    print("say ok =", say.get("ok"))
    print("DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print("FAIL:", exc)
        sys.exit(1)
