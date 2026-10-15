from __future__ import annotations

import ctypes
import http.client
import importlib.util
import json
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .config import settings
from .model_registry import list_model_profiles
from .ollama_model_files import manifest_complete as _ollama_manifest_complete


MINIMUM_FREE_BYTES = 1024**3
WHISPER_DISCOVERY_VERSION = 2


def _item(
    item_id: str,
    label: str,
    status: str,
    detail: str,
    *,
    action: str = "",
) -> dict[str, object]:
    return {
        "id": item_id,
        "label": label,
        "status": status,
        "detail": detail,
        "action": action,
    }


# ---------- 自动探索常见安装位置 ----------

_UPPER_NAMES: dict[str, tuple[str, ...]] = {}


def _scan_roots() -> list[Path]:
    """返回适合做浅扫描的根目录：所有本地磁盘根 + 用户常见安装目录。"""
    roots: list[Path] = []

    def _add(path: Path) -> None:
        try:
            exists = path.is_dir()
        except OSError:
            return
        key = str(path).casefold()
        if exists and all(str(item).casefold() != key for item in roots):
            roots.append(path)

    try:
        drive_mask = int(ctypes.windll.kernel32.GetLogicalDrives()) if os.name == "nt" else 0
        for index, letter in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
            if drive_mask and not drive_mask & (1 << index):
                continue
            drive = Path(f"{letter}:\\")
            if os.name == "nt":
                drive_type = int(ctypes.windll.kernel32.GetDriveTypeW(str(drive)))
                if drive_type not in {2, 3}:  # removable / fixed，跳过断开的网络盘和光驱
                    continue
            _add(drive)
    except (AttributeError, OSError, ValueError):
        for letter in "CDEFGH":
            _add(Path(f"{letter}:\\"))
    for env_name in ("LOCALAPPDATA", "APPDATA", "USERPROFILE", "PROGRAMFILES", "PROGRAMFILES(X86)"):
        raw = os.getenv(env_name)
        if raw:
            _add(Path(raw))
    return roots


def _nearby_scan_roots() -> list[Path]:
    """优先扫描当前程序、数据和安装目录的各级父目录，覆盖较深的便携目录。"""
    seeds = [settings.voice_training_dir, Path.cwd(), Path(sys.executable).parent]
    for env_name in ("MIO_RUNTIME_ROOT", "MIO_DESKTOP_STATE_DIR", "MIO_VOICE_TRAINING_DIR"):
        raw = os.getenv(env_name)
        if raw:
            seeds.append(Path(raw))
    roots: list[Path] = []
    seen: set[str] = set()
    for seed in seeds:
        try:
            resolved = seed.resolve()
        except OSError:
            continue
        if resolved.is_file():
            resolved = resolved.parent
        for candidate in (resolved, *resolved.parents):
            try:
                key = str(candidate.resolve()).casefold()
            except OSError:
                continue
            if key in seen or not candidate.is_dir():
                continue
            seen.add(key)
            roots.append(candidate)
    return roots


def _dir_matches(name: str, patterns: tuple[str, ...]) -> bool:
    if not name:
        return False
    folded = name.lower()
    for pattern in patterns:
        if pattern in folded:
            return True
    return False


_SKIP_DIR_NAMES = frozenset(
    {
        "$recycle.bin",
        "system volume information",
        "recovery",
        "windows",
        "program files",
        "program files (x86)",
        "node_modules",
        ".git",
        ".venv",
        "venv",
        "site-packages",
        "python",
        "python310",
        "winsxs",
        "msocache",
        "perflogs",
    }
)


def _find_dirs_named(roots: list[Path], patterns: tuple[str, ...], max_depth: int = 1) -> list[Path]:
    """在给定根目录下浅扫描名字匹配的目录，避免全盘深递归（只扫到 max_depth 层）。"""

    def _walk(directory: Path, depth: int) -> list[Path]:
        found: list[Path] = []
        try:
            with os.scandir(directory) as it:
                entries = list(it)
        except OSError:
            return found
        for entry in entries:
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if not is_dir:
                continue
            if entry.name.lower() in _SKIP_DIR_NAMES:
                continue
            if _dir_matches(entry.name, patterns):
                found.append(Path(entry.path))
            if depth < max_depth:
                found.extend(_walk(Path(entry.path), depth + 1))
        return found

    found: list[Path] = []
    for root in roots:
        if root is None or not root.is_dir():
            continue
        found.extend(_walk(root, 1))
    # 去重（按大小写折叠的绝对路径）
    seen: set[str] = set()
    unique: list[Path] = []
    for path in found:
        key = str(path.resolve()).casefold()
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


WHISPER_REQUIRED_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")


def _whisper_model_directory(root: Path) -> Path | None:
    cache = root / "cache" / "faster-whisper"
    if cache.is_dir():
        try:
            repositories = list(cache.glob("models--*faster-whisper-*"))
        except OSError:
            repositories = []
        for repository in repositories:
            snapshots = repository / "snapshots"
            if not snapshots.is_dir():
                continue
            try:
                candidates = [path for path in snapshots.iterdir() if path.is_dir()]
            except OSError:
                candidates = []
            for snapshot in candidates:
                if all((snapshot / name).is_file() and (snapshot / name).stat().st_size > 0 for name in WHISPER_REQUIRED_FILES):
                    return snapshot
    bundled_models = root / "GPT-SoVITS" / "tools" / "asr" / "models"
    if bundled_models.is_dir():
        try:
            candidates = list(bundled_models.glob("faster-whisper-*"))
        except OSError:
            candidates = []
        for candidate in candidates:
            if all((candidate / name).is_file() and (candidate / name).stat().st_size > 0 for name in WHISPER_REQUIRED_FILES):
                return candidate
    return None


def _whisper_runtime_layout(root: Path) -> dict[str, object]:
    python = root / ".voice-env" / "Scripts" / "python.exe"
    site_packages_candidates = (
        root / ".voice-env" / "Lib" / "site-packages",
        root / ".voice-env" / "lib" / "site-packages",
    )
    package_ready = any(
        (site_packages / "faster_whisper" / "__init__.py").is_file()
        and (site_packages / "ctranslate2" / "__init__.py").is_file()
        for site_packages in site_packages_candidates
    )
    model = _whisper_model_directory(root)
    return {
        "root": root,
        "python": python,
        "cache": root / "cache" / "faster-whisper",
        "model": model,
        "python_ready": python.is_file() and package_ready,
        "model_ready": model is not None,
        "ready": python.is_file() and package_ready and model is not None,
    }


@lru_cache(maxsize=1)
def whisper_runtime_candidates() -> tuple[dict[str, object], ...]:
    candidates: list[Path] = [settings.voice_training_dir]
    search_patterns = (
        "音色训练",
        "voice-training",
        "voice_training",
        "faster-whisper",
        "faster_whisper",
    )
    layouts: list[dict[str, object]] = []
    seen: set[str] = set()

    def _add(candidate: Path) -> None:
        try:
            key = str(candidate.resolve()).casefold()
        except OSError:
            return
        if key in seen:
            return
        seen.add(key)
        layout = _whisper_runtime_layout(candidate)
        if layout["python_ready"] or layout["model_ready"]:
            layouts.append(layout)

    def _add_discovered(path: Path) -> None:
        folded_name = path.name.casefold()
        if folded_name in {"faster-whisper", "faster_whisper"} and path.parent.name.casefold() == "cache":
            _add(path.parent.parent)
        elif _dir_matches(path.name, ("音色训练", "voice-training", "voice_training")):
            _add(path)

    for candidate in candidates:
        _add(candidate)
    if any(layout["ready"] for layout in layouts):
        return tuple(layouts)

    # 从离当前程序最近的目录开始逐级找；完整环境一旦找到便立即停止。
    for scan_root in _nearby_scan_roots():
        for path in _find_dirs_named([scan_root], search_patterns, max_depth=2):
            _add_discovered(path)
        if any(layout["ready"] for layout in layouts):
            return tuple(layouts)

    # 最后的兜底才逐盘扫描 5 层，覆盖自定义盘符和更深的工具目录。
    for scan_root in _scan_roots():
        for path in _find_dirs_named([scan_root], search_patterns, max_depth=5):
            _add_discovered(path)
        if any(layout["ready"] for layout in layouts):
            break
    return tuple(layouts)


def find_whisper_runtime() -> dict[str, object] | None:
    return next((layout for layout in whisper_runtime_candidates() if layout["ready"]), None)



@lru_cache(maxsize=1)
def _find_ollama_executables() -> list[Path]:
    """探测 ollama.exe 常见位置（含“本地视觉/local_vision”目录与标准安装位置）。"""
    exes: list[Path] = []
    roots = _scan_roots()
    resolved: set[str] = set()

    def _add(candidate: Path) -> None:
        nonlocal exes
        if candidate.is_file():
            key = str(candidate.resolve()).casefold()
            if key not in resolved:
                resolved.add(key)
                exes.append(candidate)

    # 1) 全盘浅扫 “ollama” 命名的目录
    for path in _find_dirs_named(roots, ("ollama",), max_depth=3):
        _add(path / "ollama.exe")
        _add(path / "Ollama" / "ollama.exe")
    # 2) 全盘浅扫 “本地视觉 / local_vision” 命名的目录，检查其 Ollama/ollama.exe
    for path in _find_dirs_named(roots, ("本地视觉", "local_vision"), max_depth=3):
        _add(path / "Ollama" / "ollama.exe")
        _add(path / "ollama.exe")
    # 3) 标准安装位置
    candidate = settings.local_vision_dir / "Ollama" / "ollama.exe"
    _add(candidate)
    for root in roots:
        _add(root / "Ollama" / "ollama.exe")
    _add(Path(os.getenv("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe")
    _add(Path(os.getenv("PROGRAMFILES", "")) / "Ollama" / "ollama.exe")
    # 4) PATH
    which = shutil.which("ollama")
    if which:
        _add(Path(which))
    return exes



def refresh_detection_cache() -> None:
    """清除安装位置和服务探测缓存，供重新检查与安装完成后调用。"""
    _find_ollama_executables.cache_clear()
    whisper_runtime_candidates.cache_clear()
    _gpu_info.cache_clear()


def _format_bytes(value: int) -> str:
    size = max(0, int(value))
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            number = f"{size:.1f}" if unit in {"GB", "TB"} else f"{size:.0f}"
            return f"{number} {unit}"
        size /= 1024
    return "0 B"


def _memory_bytes() -> int:
    if os.name != "nt":
        return 0

    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("memory_load", ctypes.c_ulong),
            ("total_physical", ctypes.c_ulonglong),
            ("available_physical", ctypes.c_ulonglong),
            ("total_page_file", ctypes.c_ulonglong),
            ("available_page_file", ctypes.c_ulonglong),
            ("total_virtual", ctypes.c_ulonglong),
            ("available_virtual", ctypes.c_ulonglong),
            ("available_extended_virtual", ctypes.c_ulonglong),
        ]

    status = MemoryStatus()
    status.length = ctypes.sizeof(MemoryStatus)
    return int(status.total_physical) if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else 0


def _ollama_model_ready(models_root: Path) -> bool:
    manifest = models_root / "manifests" / "registry.ollama.ai" / "library" / "qwen2.5vl" / "3b"
    return _ollama_manifest_complete(manifest, models_root)


def _windows_label() -> str:
    if os.name != "nt":
        return platform.platform()
    version = sys.getwindowsversion()
    product = "Windows 11" if version.build >= 22000 else "Windows 10"
    return f"{product} · 构建 {version.build}"


@lru_cache(maxsize=1)
def _gpu_info() -> list[dict[str, object]]:
    if os.name != "nt":
        return []
    command = shutil.which("nvidia-smi")
    if command:
        try:
            completed = subprocess.run(
                [
                    command,
                    "--query-gpu=name,memory.total",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=3,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            rows: list[dict[str, object]] = []
            for line in completed.stdout.splitlines():
                name, separator, memory = line.rpartition(",")
                if separator and name.strip():
                    rows.append({"name": name.strip(), "memory_mb": int(memory.strip() or 0)})
            if rows:
                return rows
        except (OSError, subprocess.SubprocessError, ValueError):
            pass

    powershell = shutil.which("powershell") or shutil.which("powershell.exe")
    if not powershell:
        return []
    try:
        completed = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8-sig",
            errors="replace",
            timeout=4,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        payload = json.loads(completed.stdout or "[]")
        records = payload if isinstance(payload, list) else [payload]
        return [
            {
                "name": str(record.get("Name") or "显示适配器"),
                "memory_mb": max(0, int(record.get("AdapterRAM") or 0) // 1024**2),
            }
            for record in records
            if isinstance(record, dict)
        ]
    except (OSError, subprocess.SubprocessError, ValueError, json.JSONDecodeError):
        return []


def _webview2_version() -> str:
    if os.name != "nt":
        return ""
    try:
        import winreg
    except ImportError:
        return ""
    client_id = r"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    keys = (
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{client_id}"),
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{client_id}"),
        (winreg.HKEY_CURRENT_USER, rf"Software\Microsoft\EdgeUpdate\Clients\{client_id}"),
    )
    for hive, key_path in keys:
        try:
            with winreg.OpenKey(hive, key_path) as key:
                version = str(winreg.QueryValueEx(key, "pv")[0] or "").strip()
            if version and version != "0.0.0.0":
                return version
        except OSError:
            continue
    application_roots = (
        Path(os.getenv("PROGRAMFILES(X86)", "")) / "Microsoft/EdgeWebView/Application",
        Path(os.getenv("LOCALAPPDATA", "")) / "Microsoft/EdgeWebView/Application",
    )
    for root in application_roots:
        if not root.is_dir():
            continue
        versions = sorted((path.name for path in root.iterdir() if path.is_dir()), reverse=True)
        if versions:
            return versions[0]
    return ""


def _data_directory_check() -> tuple[bool, str, int]:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    free_bytes = shutil.disk_usage(settings.data_dir).free
    probe = settings.data_dir / f".environment-check-{uuid.uuid4().hex}.tmp"
    try:
        probe.write_text("ok", encoding="ascii")
        writable = probe.read_text(encoding="ascii") == "ok"
    except OSError:
        writable = False
    finally:
        probe.unlink(missing_ok=True)
    return writable, str(settings.data_dir.resolve()), free_bytes


def _database_check() -> tuple[bool, str]:
    try:
        with sqlite3.connect(settings.db_path) as connection:
            result = str(connection.execute("PRAGMA quick_check").fetchone()[0])
        return result.lower() == "ok", result
    except (OSError, sqlite3.Error) as exc:
        return False, str(exc)


def _required_checks() -> tuple[list[dict[str, object]], dict[str, object]]:
    windows_ready = os.name == "nt" and platform.system().lower() == "windows"
    architecture = platform.machine() or "未知"
    architecture_ready = architecture.lower() in {"amd64", "x86_64", "arm64"} and sys.maxsize > 2**32
    writable, data_path, free_bytes = _data_directory_check()
    database_ready, database_detail = _database_check()
    webview_version = _webview2_version()
    webview_ready = bool(webview_version)

    os_label = _windows_label()
    checks = [
        _item("windows", "Windows 系统", "available" if windows_ready else "unsupported", os_label),
        _item("architecture", "64 位运行环境", "available" if architecture_ready else "unsupported", architecture),
        _item(
            "webview2",
            "WebView2 界面运行库",
            "available" if webview_ready else "missing",
            f"版本 {webview_version}" if webview_ready else "没有检测到 WebView2 Runtime",
            action="安装 Microsoft Edge WebView2 Runtime" if not webview_ready else "",
        ),
        _item(
            "data_directory",
            "数据目录可写",
            "available" if writable else "missing",
            data_path if writable else f"无法写入 {data_path}",
            action="更换数据目录或检查目录权限" if not writable else "",
        ),
        _item(
            "disk_space",
            "数据盘空间",
            "available" if free_bytes >= MINIMUM_FREE_BYTES else "missing",
            f"可用 {_format_bytes(free_bytes)}，基础运行至少保留 1 GB",
            action="清理空间或更换数据目录" if free_bytes < MINIMUM_FREE_BYTES else "",
        ),
        _item(
            "database",
            "本地数据库",
            "available" if database_ready else "missing",
            "SQLite 读写与快速校验正常" if database_ready else f"数据库检查失败：{database_detail}",
        ),
        _item("backend", "内置后端", "available", "当前环境检查接口运行正常"),
    ]
    return checks, {
        "os": os_label,
        "architecture": architecture,
        "python_bundled": bool(getattr(sys, "frozen", False)),
        "memory_bytes": _memory_bytes(),
        "memory_label": _format_bytes(_memory_bytes()),
        "gpus": _gpu_info(),
        "data_directory": data_path,
        "free_disk_bytes": free_bytes,
        "free_disk_label": _format_bytes(free_bytes),
    }


def _optional_checks(system: dict[str, object]) -> list[dict[str, object]]:
    profiles = list_model_profiles()
    vision_profiles = [profile for profile in profiles if profile.supports_vision]

    # Installation and runtime readiness are separate; discovery never runs inference.
    from .screen import local_vision_service

    local_vision = local_vision_service.dependency_status()
    local_vision_state = str(local_vision["status"])
    local_recommendation = str(local_vision["detail"])

    live2d_index = settings.agent_frontend_dir / "live2d-pet/index.html"
    live2d_model = settings.agent_frontend_dir / "live2d-pet/models/hiyori/Hiyori.model3.json"
    live2d_ready = live2d_index.is_file() and live2d_model.is_file()
    capture_ready = importlib.util.find_spec("mss") is not None

    # —— 系统声音理解：完整探测可实际启动的 Python 环境 + whisper 模型 ——
    audio_worker = settings.agent_control_scripts_dir / "system_audio_worker.py"
    whisper_worker_ok = audio_worker.is_file()
    whisper_layouts = whisper_runtime_candidates()
    whisper_runtime = next((layout for layout in whisper_layouts if layout["ready"]), None)
    audio_ready = whisper_worker_ok and whisper_runtime is not None
    if audio_ready:
        runtime_root = Path(whisper_runtime["root"])
        if runtime_root.resolve() == settings.voice_training_dir.resolve():
            audio_detail = f"声音转写环境与模型已找到：{runtime_root}"
        else:
            audio_detail = f"已复用电脑上的 faster-whisper 环境：{runtime_root}"
    elif whisper_layouts:
        partial = whisper_layouts[0]
        missing_parts = []
        if not partial["python_ready"]:
            missing_parts.append("可运行的 faster-whisper Python 环境")
        if not partial["model_ready"]:
            missing_parts.append("完整本地模型")
        audio_detail = f"电脑上发现部分文件，但缺少{'、'.join(missing_parts)}：{partial['root']}"
    elif not whisper_worker_ok:
        audio_detail = "程序缺少系统声音转写工作器"
    else:
        audio_detail = "尚未找到可运行的 faster-whisper 环境与完整本地模型"


    return [
        _item(
            "cloud_model",
            "云端或兼容 API 模型",
            "configured" if profiles else "unconfigured",
            f"已配置 {len(profiles)} 个模型" if profiles else "尚未配置；首次向导需要先完成一次真实聊天测试",
            action="前往模型与 API 设置" if not profiles else "",
        ),
        _item(
            "cloud_vision",
            "云端视觉",
            "configured" if vision_profiles else "unconfigured",
            f"有 {len(vision_profiles)} 个模型声明支持图片" if vision_profiles else "当前没有声明支持图片的云端模型",
            action="添加支持图片的模型" if not vision_profiles else "",
        ),
        _item(
            "local_vision",
            "本地视觉模型",
            local_vision_state,
            f"Qwen2.5-VL 3B：{local_recommendation}",
            action="在环境与模型中心安装、启动或验证" if local_vision_state != "available" else "",
        ),
        _item(
            "live2d",
            "Live2D 桌宠",
            "available" if live2d_ready else "unconfigured",
            "内置运行库和示例模型已就绪" if live2d_ready else "没有找到完整的 Live2D 运行资源",
            action="可以先使用静态形象" if not live2d_ready else "",
        ),
        _item(
            "screen_capture",
            "屏幕与窗口捕获",
            "available" if capture_ready else "unsupported",
            "基础截图组件可用；具体游戏和显卡仍需实际测试" if capture_ready else "缺少基础截图组件",
        ),
        _item(
            "system_audio",
            "系统声音理解",
            "available" if audio_ready else "unconfigured",
            audio_detail,
            action="一键安装会补齐运行环境和模型" if not audio_ready else "",
        ),
    ]


def environment_status(*, refresh: bool = True) -> dict[str, Any]:
    if refresh:
        refresh_detection_cache()
    required, system = _required_checks()
    optional = _optional_checks(system)
    core_ready = all(item["status"] == "available" for item in required)
    return {
        "checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "core_ready": core_ready,
        "required": required,
        "optional": optional,
        "system": system,
        "summary": {
            "required_ready": sum(item["status"] == "available" for item in required),
            "required_total": len(required),
            "optional_ready": sum(item["status"] in {"available", "configured"} for item in optional),
            "optional_total": len(optional),
        },
    }


def passive_environment_status() -> dict[str, Any]:
    """Report readiness without creating files, directories, or database state."""
    windows_ready = os.name == "nt" and platform.system().lower() == "windows"
    architecture = platform.machine() or "未知"
    architecture_ready = architecture.lower() in {"amd64", "x86_64", "arm64"} and sys.maxsize > 2**32
    webview_version = _webview2_version()
    data_directory_exists = settings.data_dir.is_dir()
    try:
        free_bytes = shutil.disk_usage(settings.data_dir).free if data_directory_exists else 0
    except OSError:
        free_bytes = 0
    database_exists = settings.db_path.is_file()
    profiles = list_model_profiles()
    configured_models = sum(bool(profile.api_key and profile.base_urls) for profile in profiles)
    required = {
        "windows": windows_ready,
        "architecture": architecture_ready,
        "webview2": bool(webview_version),
        "data_directory": data_directory_exists,
        "disk_space": free_bytes >= MINIMUM_FREE_BYTES,
        "database": database_exists,
        "backend": True,
    }
    gpus = _gpu_info()
    return {
        "mode": "passive_read_only",
        "core_ready": all(required.values()),
        "required": required,
        "summary": {
            "required_ready": sum(required.values()),
            "required_total": len(required),
            "configured_models": configured_models,
            "model_total": len(profiles),
            "gpu_count": len(gpus),
            "memory_bytes": _memory_bytes(),
            "free_disk_bytes": free_bytes,
            "webview2_version": webview_version,
        },
    }


__all__ = ["environment_status", "passive_environment_status"]
