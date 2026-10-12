# Mio 桌宠 · 源码地图（SRC-MAP）

> 本项目的界面导航手册。**改哪个界面，先查这张表。**
> 更新日期：2026-10-12

---

## 1. 项目定位（一句话）

把开源 Mio 桌宠改造为「**本地免费运行的 Live2D 看板娘**」：接入**小智官方免费云**（xiaozhi.me 控制台 / api.tenclass.net），支持文字对话、图片识别、屏幕观察、模型管理与每日换装，全部本地运行、不花 API 钱。

---

## 2. 界面导航（最重要，先看这里）

现在**在用的界面只有两类**：**桌宠体系**（桌宠本体 + 对话浮窗 + 截图选区）和 **MIO 管理窗口**（私人空间对话页）。原版 Mio 的 Agent 工作台、QQ 对话等界面**已弃用**。

### 2.1 桌宠本体（桌面上的 Live2D 看板娘）

| 项 | 位置 |
|---|---|
| 页面入口 | `澪Agent应用\dist\live2d-pet\index.html` |
| 主逻辑 | `澪Agent应用\dist\live2d-pet\live2d-pet.js`（84KB，含右键菜单/拖拽/模型加载/小智事件） |
| 样式 | `澪Agent应用\dist\live2d-pet\live2d-pet.css` |
| 表情工具 | `澪Agent应用\dist\live2d-pet\expression-utils.js` |
| 小智音频播放 | `澪Agent应用\dist\live2d-pet\pet-xz-audio.js`（PCM 流 → 口型同步） |
| 渲染库 | `dist\live2d-pet\libs\`（pixi / cubism4 / live2dcubismcore） |
| 模型库 | `dist\live2d-pet\models\`（hiyori 等，导入的模型都放这） |
| Electron 窗口 | `澪Agent应用\live2d-desktop\main.js` 中 `mainWindow` |

### 2.2 对话浮窗（点桌宠弹出，小智聊天）

| 项 | 位置 |
|---|---|
| 页面 | `澪Agent应用\dist\live2d-pet\xiaozhi\xiaozhi-chat.html` |
| 逻辑 | `澪Agent应用\dist\live2d-pet\xiaozhi\xiaozhi-chat.js`（暂存图片 + 防竞态历史轮询） |
| Electron 窗口 | `main.js` 中 `chatWindow`（preload: `pet-chat-preload.js`） |
| 后端接口 | `POST /api/xiaozhi/say`（文字）、`POST /api/xiaozhi/vision`（图片） |

### 2.3 MIO 管理窗口（右键桌宠 →「打开 MIO」）

> 这就是「Mio 私人空间对话页」，也是主对话界面。

| 项 | 位置 |
|---|---|
| URL | `http://127.0.0.1:8000/agent-app/?workspace=main&v=...` |
| 入口 HTML | `澪Agent应用\dist\index.html`（加载 assets 分片 + 注入脚本） |
| 对话页组件 | `澪Agent应用\dist\assets\ChatPage-DUGVoyFe.js`（小智对话：输入框 `.composer-input`、WS 直连、历史轮询、状态点） |
| 主入口/路由 | `澪Agent应用\dist\assets\index-BBVquePX.js`（bootstrap/状态管理，勿手改） |
| **图片上传注入** | `澪Agent应用\dist\xiaozhi-chat-inject.js`（📷 按钮 + 粘贴暂存 + 左下角红/黄/绿调试角标） |
| Electron 窗口 | `main.js` 中 `petAdminWindow`（打开前强制清缓存） |

### 2.4 截图提问的选区覆盖层（快捷键触发）

| 项 | 位置 |
|---|---|
| 页面 | `澪Agent应用\dist\live2d-pet\overlay.html`（`cropWindow` 加载） |
| 后端 | `POST /api/xiaozhi/vision`（携带区域截图 base64） |

### 2.5 辅助文件（Electron 进程侧）

| 文件 | 用途 |
|---|---|
| `live2d-desktop\main.js` | **Electron 主进程**：窗口管理 / 右键菜单 / 副屏边界 / 截图 / 快捷键 |
| `live2d-desktop\preload.js` | 桌宠窗口 preload（安全桥） |
| `live2d-desktop\pet-chat-preload.js` | 对话浮窗 preload |
| `live2d-desktop\lock-control-preload.js` | 锁定控制窗 preload |
| `live2d-desktop\lock-control.html` | 锁定控制窗页面 |

---

## 3. 后端导航（FastAPI，端口 8000）

**入口**：`私人AI日记系统\backend\app\main.py`（include_router 挂载所有路由）

### 3.1 小智核心（本项目主战场）

文件：`私人AI日记系统\backend\app\routes\xiaozhi.py`

| 接口/函数 | 用途 |
|---|---|
| `WS /api/xiaozhi/ws?role=main\|chat` | 小智官方云长连接（单会话免唤醒、断线重连） |
| `POST /api/xiaozhi/say` | 文字对话：写"你说" + 注入官方音频流（语音回答） |
| `POST /api/xiaozhi/vision` | 图片识别：小智官方视觉 MCP → **纯文本气泡**（不注入、不唤醒、不拜拜） |
| `GET /api/xiaozhi/chat-history` | 会话历史（前端 3s 轮询） |
| `GET /api/xiaozhi/status` | 连接状态（bound/connected/session_id/subscribers） |
| `_inject_say` | 音频流注入串行化锁（防断断续续/多回答叠加） |
| `_observe_loop` | 自动屏幕观察（随机时间种子 → 截图 → 文本评价） |
| `_pump_upstream` | 官方消息泵（**stt 不回写历史、不广播** = 角色机制级解耦） |
| `_chat_append(role,...)` | 写历史；role=user 时打诊断日志 `写历史[user]` |

### 3.2 桌宠配套

| 文件 | 用途 |
|---|---|
| `routes\companion.py` | 桌宠状态 / 截图 / 窗口拓扑 |
| `routes\agent.py` | 原版 agent 接口（**bootstrap/messages 仍被前端使用**，勿删） |
| `app\desktop_pet_live2d.py` 等 | 桌宠/观察/屏幕服务 |

### 3.3 历史文件

- `C:\Users\xiao1\Mio\xiaozhi_chat_history.json`（会话历史持久化）
- `C:\Users\xiao1\Mio\xiaozhi_device.json`（小智设备绑定）
- `C:\Users\xiao1\Mio\status.json`（运行状态）

---

## 4. 启动 / 日志 / 自启

| 项 | 位置 |
|---|---|
| 一键启动 | `C:\Users\xiao1\Mio\start_mio.ps1`（后端 + Electron，脱离控制台） |
| 开机自启 | 注册表 `HKCU\...\Run` → `Mio桌宠自启动` → 指向 start_mio.ps1 |
| 后端日志 | `backend_out.log`（stdout）、`backend_err.log`（应用日志） |
| 启动日志 | `start_mio.log` |
| 副屏边界 | `C:\Users\xiao1\Mio\phys_bounds.ps1`（枚举真实显示器，勿移） |
| 调试角标 | MIO 管理窗口左下角：🟢 输入区+按钮 OK / 🟡 缺按钮 / 🔴 没找到输入区 |

---

## 5. 已弃用 / 已删除（2026-10-12 清理完成）

以下内容已**从磁盘删除**（git 历史可回溯已入库部分），别再去找：

| 内容 | 处理 | 说明 |
|---|---|---|
| 旧桌宠管理页 `admin.html` | ✅ 已删除 | 已被 MIO 管理窗口取代 |
| 旧小智对话页 `pet-chat-xiaozhi.html` | ✅ 已删除 | 已被 xiaozhi-chat.html 取代 |
| 旧 index 备份 `index.html.bak_20261009` | ✅ 已删除 | 前端已 git 入库，无需此备份 |
| Agent 工作台分片（AgentHomePage/AgentRightRail/AgentSettingsPage/TasksPage/creationApi） | ✅ 已删除 | 原版功能，已阉割 |
| 记录页分片（RecordsPage） | ✅ 已删除 | 导航已隐藏 |
| 历史排查工具 `_tools\`（test_*.py、官方协议脚本、诊断 ps1） | ✅ 已删除 | git 有记录 |
| 历史排查输出 `_logs\` | ✅ 已删除 | 日志类，无需保留 |
| 模型下载缓存 `l2d_downloads\` `l2d_official_models\` | ✅ 已删除 | 前端/后端无引用 |
| opus 录音包 `opus-recorder-pkg\` `opus-recorder.tgz` | ✅ 已删除 | 无引用 |
| 小智调研源码 `xzclient_src\` | ✅ 已删除 | 调研完成 |

**保留（别删）**：
- `_mio_orig\`（上游原版发布备份，120MB，只读参照）
- `本地视觉\`（后端 config 引用路径 `MIO_LOCAL_VISION_DIR`，空目录也要留）
- `xiaozhi_device.json` / `xiaozhi_chat_history.json` / `status.json`（运行数据）
- `backend_out.log` / `backend_err.log` / `start_mio.log`（start_mio.ps1 引用路径）
- `routes\agent.py`（bootstrap/messages/conversations 仍被前端使用）
- 本地 TTS `_speak_local`（函数保留但已禁用——音色难听，图片识别走纯文本气泡）

---

## 6. 修改守则（每次改前看一遍）

1. **改界面** → 先查第 2 节表，确定改哪个文件；dist 内是**构建产物**，`assets\` 分片不要手改（ChatPage 分片例外——它就是我们的小智对话页，可直接改，改完 `node --check`）。
2. **改后端** → 改 `routes\` 下对应文件，`py_compile` 校验；小智逻辑全在 `xiaozhi.py`。
3. **改完必做**：`node --check`（JS）+ `python -m py_compile`（py）+ **git commit**。
4. **Electron 加载的页面 URL 带版本参数**（`?v=20261012...`）——改了前端文件记得**升版本号**，否则缓存不刷新。
5. **重启方式**：`taskkill /F /IM electron.exe` 后跑 `start_mio.ps1`（start_mio.ps1 检测到 electron 在跑会跳过启动）。
6. **MIO 管理窗口红点**：看左下角角标颜色定位注入状态；inject.js 每次 keepAlive 都会更新角标颜色。
7. **git 仓库**：根目录 `C:\Users\xiao1\Mio`（本地 main 分支），每次改动都提交，防写坏。
