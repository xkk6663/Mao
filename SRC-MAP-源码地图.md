# Mio 桌宠 · 源码地图（SRC-MAP）

> 本项目的界面导航手册。**改哪个界面，先查这张表。**
> 更新日期：2026-10-16（M0 收口：保存反馈三态修复 + 仓库清理）

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
| 主逻辑 | `澪Agent应用\dist\live2d-pet\live2d-pet.js`（含右键菜单/拖拽/模型加载/phase 映射/状态栏/视线跟随/getBounds 节流） |
| 样式 | `澪Agent应用\dist\live2d-pet\live2d-pet.css`（含徽标 12 态专属色） |
| 表情工具 | `澪Agent应用\dist\live2d-pet\expression-utils.js` |
| 小智音频播放 | `澪Agent应用\dist\live2d-pet\pet-xz-audio.js`（PCM 流 → 口型同步；v3.5 drain 收尾） |
| 渲染库 | `dist\live2d-pet\libs\`（pixi / cubism4 / live2dcubismcore） |
| 模型库 | `dist\live2d-pet\models\`（内置：官方 6 个 Hiyori/Haru/Mao/Mark/Rice/Wanko + 项目内置 DeepSeek娘(`whale-deepseek`)/大肥鱼(`da-feiyu`)，随 git 分发；外部导入放 `pet-data\Live2D桌宠\models\`，仅本机） |
| Electron 窗口 | `澪Agent应用\live2d-desktop\main.js` 中 `mainWindow`（穿透判定 `setMainWindowIgnoreMouseEvents` + 16Hz 鼠标推送 `sendMouseMoveToRenderer`） |

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
| 入口 HTML | `澪Agent应用\dist\index.html`（加载 assets 分片 + **15 个注入 script 标签**，均带 `?v=` 版本参数） |
| 对话页组件 | `澪Agent应用\dist\assets\ChatPage-DUGVoyFe.js`（小智对话：输入框 `.composer-input`、WS 直连、历史轮询、状态点） |
| 桌宠管理页 | `澪Agent应用\dist\assets\CompanionPage-D7yDEAW1.js` + `assets\PetAppearancePanel-CAsGsCDg.js`（模型管理 / 动作表情预览 / 保存反馈三态 / 实时刷新按钮） |
| 主入口/路由 | `澪Agent应用\dist\assets\index-BBVquePX.js`（bootstrap + store + provide，勿手改） |
| **前端微内核** | `dist\kernel\plugin-registry.js`（插件注册表）/ `dist\kernel\plugin-nav.js`（导航注入） |
| **插件包（目录化）** | `dist\plugins\{xiaozhi,dsh,octop}\`（每个含 `manifest.js` + 自有面板：`xiaozhi/chat-inject.js`、`xiaozhi/mcp-panel.js`、`dsh/dsh-panel.js`） |
| **核心注入层** | `dist\core-inject\`（7 个）：`settings-panel-inject.js`（★ 设置 5 tab）/ `settings-clean-inject.js` / `bubble-panel-inject.js`（★ 泡泡工坊）/ `agent-switch-inject.js`（★ Agent 开关）/ `agent-kill-inject.js` / `rail-switch-inject.js` / `health-panel-inject.js`（体检） |
| Electron 窗口 | `main.js` 中 `petAdminWindow`（打开前强制清缓存） |

> ⚠ **已变更（2026-10-16）**：注入脚本已从 dist 根目录**迁入 `core-inject/` / `kernel/` / `plugins/` 三层**；
> 旧根路径 `dist\xiaozhi-chat-inject.js`、`dist\mcp-tools-panel.js`、`dist\settings-panel-inject.js`、`dist\agent-switch-inject.js` **均不再存在**。
> `dist\xiaozhi-history-panel.js` **已删除**——历史/实时对话已内建于 `ChatPage-DUGVoyFe.js`（走 `/api/xiaozhi/chat-history` + `/api/xiaozhi/ws?role=chat`），不再需要独立覆盖面板。

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
| `WS /api/xiaozhi/ws?role=main\|chat` | 小智官方云长连接（单会话免唤醒、断线重连；main=桌宠播音频，chat=对话窗收文本） |
| `POST /api/xiaozhi/say` | 文字对话：写"你说" + 注入官方音频流（语音回答） |
| `POST /api/xiaozhi/vision` | 图片识别：官方视觉 MCP → 文本 + **官方音色语音**（回灌官方 LLM 由 TTS 产出） |
| `POST /api/xiaozhi/vision-bubble` | 截图提问/屏幕观察：分析广播桌宠气泡 + 写历史 |
| `POST /api/xiaozhi/mcp/tools/call` | 本地 MCP 工具调用（小智工具页开关控制） |
| `GET /api/xiaozhi/chat-history` | 会话历史（上限 1000 条） |
| `GET /api/xiaozhi/status` | 连接状态（bound/connected/session_id/subscribers/机器码） |
| `GET/PUT /api/xiaozhi/prompts` | 图片/观察提示词配置读写 |
| `GET/POST /api/xiaozhi/observe/status\|start\|stop` | 自动屏幕观察任务 |
| `_inject_say` | 音频流注入串行化锁（防断断续续/多回答叠加） |
| `_edge_tts_wav` / `_broadcast_tts_pcm` | v3.4：edge-tts 合成（晓晓音色）+ 触发语预合成缓存（wav+opus 双层 LRU，启动预热） |
| `_pump_upstream` | 官方消息泵（stt 不回写历史、不广播 = 角色机制级解耦；opus 帧解码为 PCM 广播） |
| `_broadcast` / `_broadcast_bytes` | 文本广播（所有订阅者）/ 音频帧广播（仅 role=main，防多窗口叠声） |

### 3.2 桌宠配套

| 文件 | 用途 |
|---|---|
| `routes\companion.py` | 桌宠状态 / 截图 / 窗口拓扑 / **Agent 总线接口**（`/agents`、`/agents/{id}/enabled`、`/agents/{id}/inspect`） |
| `companion\live2d_assets.py` | ★ 桌宠数据目录解析（`MIO_PET_STATE_DIR`，v3.4 与 Electron 统一）+ 模型清单 |
| `routes\agent.py` | 原版 agent 接口（**bootstrap/messages 仍被前端使用**，勿删） |
| `app\desktop_pet_live2d.py` 等 | 桌宠/观察/屏幕服务 |

### 3.3 跨 Agent 状态总线（v3.1+）

| 文件 | 用途 |
|---|---|
| `app\agent_bus_service.py` | **统一总线**：12 phase 枚举、活跃聚焦调度、心跳在线检测、WS 广播 |
| `app\dsh_adapter.py` | **DSH 适配器**：facts → phase 策略层；边车管理；`--once` 自检入口 `inspect_current()` |
| `app\dsh_log_stream.mjs` | **DSH 边车**（Node，零依赖）：逐帧解 zstd 会话日志 → 折叠 facts → NDJSON |
| `app\octop_adapter.py` | Octop 适配器（占位骨架，配置即启用） |
| `app\dsh_adapter_selftest.py` | DSH 自检 131 项（映射/解码/回放/可达性/总线/回归/前端契约） |
| `app\dsh_adapter_e2e.py` | DSH 端到端验证（轮询总线看 phase 实时变化） |
| `app\dsh_fixture_build.py` | 从真实 DSH 日志重建回放夹具 `dsh_events_fixture.json` |
| `app\dsh_latency.py` | DSH 端到端状态延迟测量（诚实口径，别抄死数字） |
| `app\dsh_stats.py` | DSH 真实事件语料统计（条数会过期，现取现用） |
| `app\dsh_gap_analysis.py` | 事件覆盖缺口分析（DSH 升级后跑一次） |
| `app\dsh_ws_check.py` | 桌宠消费的 WS 通道检查 |
| `app\dsh_acceptance.py` | 验收报告：12 phase 注册/可达/驱动来源 |
| `私人AI日记系统\dsh_config.json` | DSH 接入配置（已 gitignore；`enabled` 为部署就绪开关） |
| `私人AI日记系统\agent_bus_config.json` | 总线启用状态持久化（Agent 页开关；已 gitignore） |

**DSH 事件源**（只读，别写）：
`C:\Users\xiao1\.dsh\sessions\<cwd-slug>\<session-id>\session.v4.jsonl.zstd`
——拼接式 zstd 帧的 JSONL，必须逐帧解（Node `zlib.zstdDecompressSync` 可用，Python venv 无 zstd 绑定）。

### 3.4 历史文件

- `C:\Users\xiao1\Mao\xiaozhi_chat_history.json`（会话历史持久化）
- `C:\Users\xiao1\Mao\xiaozhi_device.json`（小智设备绑定）
- `C:\Users\xiao1\Mao\status.json`（运行状态）

---

## 4. 启动 / 日志 / 自启

| 项 | 位置 |
|---|---|
| 一键启动 | `C:\Users\xiao1\Mao\start_mio.ps1`（后端 + Electron，脱离控制台；就绪探测用 `/api/companion/agents`；传入 `pet-data\Live2D桌宠` 作为桌宠数据目录） |
| 桌宠数据目录 | `pet-data\Live2D桌宠`（v3.4 起后端与 Electron 通过 `MIO_PET_STATE_DIR` 解析到同一目录） |
| 开机自启 | 注册表 `HKCU\...\Run` → `Mio桌宠自启动` → 指向 start_mio.ps1 |
| 后端日志 | `backend_out.log`（stdout）、`backend_err.log`（应用日志） |
| 启动日志 | `start_mio.log` |
| 副屏边界 | `C:\Users\xiao1\Mao\phys_bounds.ps1`（枚举真实显示器，勿移） |
| 调试角标 | MIO 管理窗口左下角：🟢 输入区+按钮 OK / 🟡 缺按钮 / 🔴 没找到输入区 |
| DSH 自检 | `cd 私人AI日记系统\backend` → `.venv\Scripts\python.exe -m app.dsh_adapter_selftest` |
| DSH 端到端 | `.venv\Scripts\python.exe -m app.dsh_adapter_e2e 60`（轮询总线看 phase 变化） |
| DSH 边车手测 | `node 私人AI日记系统\backend\app\dsh_log_stream.mjs --once`（打印当前会话与 facts） |

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
| 根目录历史探测输出 `_o5~_o12/_o20.txt` | ✅ 已删除 | 临时排查输出（.gitignore 已覆盖 `_*.txt`） |
| 根目录探测脚本 `_probe_del5.py` | ✅ 已删除 | git rm 移除 + `.gitignore` 新增 `_probe*.py` 防再入库 |
| 启动诊断 `boot_diag.txt` | ✅ 已删除 | 一次性诊断输出（.gitignore 新增 `boot_diag.txt`） |
| 临时音频 `tts_tmp.wav` | ✅ 已删除 | 本地 TTS 已禁用，无引用 |
| 上游备份 `_mio_orig\`（120MB，含回收站垃圾） | ✅ 已删除 | git 历史可回溯（提交 eb520213） |
| 顶层 `node_modules\`（83MB，vite 构建依赖） | ✅ 已删除 | dist 即源码模式不再构建 |
| 原版构建源 `src\`、`public\`（Vue 源码+静态源） | ✅ 已删除 | 运行时用 dist，不重建 |
| 原版发布链 `desktop\`（launcher/updater/installer） | ✅ 已删除 | 发自己的仓库不需要原版打包链 |
| 构建脚本 `vite.config.js`/`启动预览.ps1`/`构建Windows应用.ps1`/`build_frontend.ps1` | ✅ 已删除 | 不再构建前端 |
| 原版文档（根/子项目 README_EN、CHANGELOG*、CONTRIBUTING、SECURITY、.github CI） | ✅ 已删除 | 保留 LICENSE / THIRD_PARTY_NOTICES |
| 后端空转后台任务（QQ/日记/备份/周月报/费用对账等 9 项） | ✅ 已移除 | main.py 任务工厂 13→4（提交见下） |

### 2026-10-16 追加清理（M0 收口）

| 内容 | 处理 | 说明 |
|---|---|---|
| `dist\xiaozhi-history-panel.js` | ✅ 已删除 | 历史/实时对话已内建于 `ChatPage-DUGVoyFe.js`（`/api/xiaozhi/chat-history` + `ws?role=chat`） |
| `dist\assets\CompanionPage-D7yDEAVz.js` / `-D7yDEAW0.js` | ✅ 已删除 | 改名遗留的孤儿分片（全仓 0 引用） |
| `dist\assets\PetAppearancePanel-CAsGsCDh.js` / `-CDi.js` / `-CDj.js` | ✅ 已删除 | 孤儿分片；`__vite__mapDeps` 已重指到 `-CDg.js` |
| `dist\assets\save-D7rMjPJ0.js` | ✅ 已删除 | 仅被已阉割的 AgentSettingsPage 引用 |
| `dist\assets\*.bak` / `*.orig` / `*.bak-<ts>`（5 个） | ✅ 已删除 | 补丁备份（`clean-dist.mjs` A 类） |
| 9 处悬空 `import()` 引用 | ✅ 已改写为 `_trimmed-stub.js` / `.css` | **不增删 `__vite__mapDeps` 数组元素**（保 27 项与全部下标） |
| `pet-data\_verify\`（434 文件 / 21 MB） | ✅ 已删除 | 调试探针脚本 |
| `pet-data\.edge-pA~pD`（4 个浏览器剖面 / 240 MB） | ✅ 已删除 | 调试用 Edge 剖面 |
| `workspace_patch\`（252 项） | ✅ 已删除 | 上一轮工作区临时补丁脚本 |

**保留（别删）**：
- `本地视觉\`（后端 config 引用路径 `MIO_LOCAL_VISION_DIR`，空目录也要留）
- `xiaozhi_device.json` / `xiaozhi_chat_history.json` / `status.json`（运行数据）
- `backend_out.log` / `backend_err.log` / `start_mio.log`（start_mio.ps1 引用路径）
- `routes\agent.py`（bootstrap/messages/conversations 仍被前端使用）
- 本地 TTS `_speak_local`（函数保留但已禁用——音色难听，图片识别走纯文本气泡）

---

## 6. 修改守则（每次改前看一遍）

1. **改界面** → 先查第 2 节表，确定改哪个文件；dist 内是**构建产物**，`assets\` 分片不要手改（`ChatPage` / `CompanionPage` / `PetAppearancePanel` 例外——它们是我们自研的页面，可直接改，改完 `node --check`）。
   ⚠ **手改压缩产物必知的坑（2026-10-16 实证）**：往 Vue 编译产物里**手工新增动态节点**时，若它落在 `(openBlock(), createBlock(...))` 包裹的区块内，会被 `patchBlockChildren` 的**索引式 patch 整体跳过**——表现为「render 确实跑了、数据也对，但 DOM 永不更新」（本次"保存反馈不显示"+"刷新 tip 不出现"两个 BUG 的真实根因）。
   **解法**：把该区块的 `(s(),u(\`div\`,X,[...]))` 改成 `f(\`div\`,X,[...])`（去掉 block 包裹），让它走完整 children diff。
   **验证纪律**：改动后必须用无头浏览器**实测 DOM 变化**，不能只看 render 是否执行——render 执行 ≠ DOM 更新。
2. **改后端** → 改 `routes\` 下对应文件，`py_compile` 校验；小智逻辑全在 `xiaozhi.py`。
3. **改完必做**：`node --check`（JS）+ `python -m py_compile`（py）+ **git commit**。
4. **Electron 加载的页面 URL 带版本参数**——`dist\index.html` 内有 **15 个注入 script 标签**各带 `?v=`（当前：`index-BBVquePX.js?v=20261015-ui11`、`settings-panel-inject.js?v=20261015a2`、`bubble-panel-inject.js?v=20261015-bp5`、`health-panel-inject.js?v=20261015-health`、`plugin-registry.js?v=20261015-p3b`…）；`live2d-pet\index.html` 同理。**改了哪个前端文件就升它自己的 `?v=`**，否则缓存不刷新。
5. **重启方式**：`taskkill /F /IM electron.exe` 后跑 `start_mio.ps1`（start_mio.ps1 检测到 electron 在跑会跳过启动）。
6. **MIO 管理窗口红点**：看左下角角标颜色定位注入状态；inject.js 每次 keepAlive 都会更新角标颜色。
7. **git 仓库**：根目录 `C:\Users\xiao1\Mao`（本地 main 分支），每次改动都提交，防写坏。
