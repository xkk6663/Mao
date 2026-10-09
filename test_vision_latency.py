# -*- coding: utf-8 -*-
"""测 vision 请求延迟（官方云视觉 REST 是否慢/挂）"""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8000"


def post_json(path, obj, timeout=20):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(obj, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return "OK", time.time() - t0, body
    except Exception as exc:  # noqa: BLE001
        return "FAIL", time.time() - t0, str(exc)


def main():
    print("step1 全屏截图 ...", flush=True)
    st, dt, s = post_json("/api/companion/screen-shot", {}, timeout=30)
    print("  ", st, "%.1fs" % dt, "ok=", s.get("ok") if isinstance(s, dict) else s, flush=True)
    if st != "OK" or not s.get("image_base64"):
        return
    print("step2 视觉分析（观察延迟）...", flush=True)
    st2, dt2, v = post_json(
        "/api/xiaozhi/vision",
        {"image_base64": s["image_base64"], "question": "一句话描述这张截图内容。"},
        timeout=45,
    )
    print("  ", st2, "%.1fs" % dt2, "text=", str(v.get("text"))[:60] if isinstance(v, dict) else v, flush=True)


if __name__ == "__main__":
    main()
