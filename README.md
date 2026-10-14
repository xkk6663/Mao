# Mao 桌宠 · 跨 Agent 桌宠系统（v3.1）

> 把开源桌宠 Mio 改造为**跨 Agent 的"脸"**：桌宠本身无状态、只认标准 phase（思考/执行工具/说话/待机…），
> 任何 Agent（小智 / DSH / Octop / 自研 Agent）通过一根**统一状态总线**接入即可驱动它——即换即用，无需重启。
> 小智是默认的语音主通道：官方免费云（test-token），视觉/语音/对话全部免费。
> 本项目为 **Mio 的深度改造发布版（更名 Mao）**，去掉了原版全部无关功能，仅保留桌宠 + Agent 融合链路。

---

## 一、这是什么

本项目 fork 自 [ochiru520/Mio](https://github.com/ochiru520/Mio)（Windows 个人 AI 桌宠），在其基础上：

- **保留原版 Live2D 桌宠能力**：PixiJS + Cubism 4 渲染、完全自由拖拽、右键菜单、模型加载/切换、说话口型与表情联动、多屏移动。
- **去掉原版臃肿功能**：Agent 工作台、QQ 对话、原版付费模型供应商、原版设置中心等与桌宠无关的界面与链路已全部阉割。
- **跨 Agent 统一状态总线**（v3.1 核心）：
  - 后端 `agent_bus_service.py` 定义 **12 个标准 phase** + 活跃聚焦调度 + 心跳在线检测 + WS 广播；
  - 每个 Agent 一个**适配器**（小智 / DSH / Octop 已内置，可插拔），原生协议全部隔离在适配器里；
  - 桌宠只认 phase，不感知任何 Agent 私有协议；新增 Agent 只需写一个适配器。
- **小智官方免费云接入**（默认语音主通道，`wss://api.tenclass.net/xiaozhi/v1/`）：
  - 文字对话（长连接、免唤醒）、**官方音色语音**（云端 ASR→LLM→TTS，桌宠本体播放并同步口型）；
  - 图片识别 / 屏幕观察（官方视觉 MCP 工具链路，识别文本回灌官方 LLM，由官方 TTS 产出官方音色语音）；
  - 对话历史持久化与通信链路全可视化（MIO 管理窗口"小智对话记录"面板）。
- **界面统一为内嵌框架**：设置页、小智工具页、Agent 页与对话/桌宠页使用同一套主界面框架，无覆盖式浮窗。
- **免费**：不填任何模型 API Key。视觉、语音、对话全部由小智官方免费云提供。

---

## 二、功能总览（v3.1）

| 能力 | 说明 | 入口 |
|---|---|---|
| 文字对话 | 长连接免唤醒，发送即答，官方音色语音播报 + 口型同步，文字随语音逐句显示 | 桌宠右键「打开/关闭对话窗口」或双击桌宠 |
| 横条对话窗 | 单条胶囊形态（460×66）：状态点 + 输入框 + 发图 + 发送 + 关闭 | 桌宠右键「打开对话」/ 双击 |
| 语音播放 | 云端 TTS 音频流（官方音色），桌宠本体播放（防止多窗口声音叠加） | 对话自动播放 |
| 图片识别 | 上传/粘贴图片 → 小智官方视觉 MCP 分析 → **官方音色语音 + 文本双返回** | 横条 📷 / 主聊天面板 📷 / Ctrl+V |
| 截图提问 | 截取屏幕任意区域 → 小智识别画面内容 | 右键「截图提问」/ 全局快捷键 `Ctrl+Shift+S` |
| 屏幕观察 | 随机时间种子自动截屏，让桌宠点评你在做什么（间隔/时段可设置并持久化） | 桌宠管理 → 屏幕观察 |
| **Agent 状态总线** | 统一 12 phase 状态机 + 活跃聚焦调度 + 心跳在线检测；桌宠随工作状态切换表情/动作/说话 | 自动生效 |
| **Agent 管理页** | 列出全部已注册 Agent（小智/DSH/Octop），显示工作状态与能力，一键启用/停用（即换即用） | MIO 管理窗口 → 左侧「Agent」 |
| **Agent 状态徽标** | Agent 工作时在桌宠头顶短暂显示细分状态（思考/执行工具/回复/说话…），4 秒自动淡出；连接/断连不打扰；右键菜单可开关 | 桌宠右键「隐藏/显示状态徽标」 |
| 小智对话记录面板 | 打开 MIO 管理窗口即显示**全部**小智来往记录（横条/主界面/截图提问/屏幕观察），历史加载 + WS 实时追加 + 可直接发送 | 打开 MIO → 自动显示 |
| 设置页（重建） | 桌宠 / 语音 / 屏幕观察 / 提示词 / 小智 5 个 tab，与主界面框架一致，保存真实生效 | MIO 管理窗口 → 左侧「设置」 |
| 小智工具页（MCP 集中管理） | 15 项本地免费 MCP 工具（system/网络/时间/天气/记事本等）按需开关，`tools/list` 过滤 + `tools/call` 分发 | MIO 管理窗口 → 左侧「小智工具」 |
| 模型管理 | 导入 Cubism 模型、切换形象、调整大小（80%~240%）、每日定时自动换装 | 桌宠右键「调整大小」/ 桌宠管理 |
| 内置模型 | 8 个 Live2D 官方免费模型开箱即用：Hiyori Momose、Haru、Mao、Mark、Natori、Ren、Rice、Wanko | 桌宠管理 → 模型切换 |
| 对话历史 | 全部来往记录持久化（`xiaozhi_chat_history.json`），重开不丢，上限 1000 条 | 小智对话记录面板 |
| 提示词配置 | 图片识别/屏幕观察的前置提示词可在线编辑（不再写死） | 设置 → 提示词 tab |
| 设备绑定 | 机器码（MAC 后 6 位）与连接状态实时显示 | 设置 → 小智 tab |
| 自由拖拽 | 上下/水平完全无回弹无拉回，位置原样保存、重启原样恢复 | 直接拖桌宠 |
| 内存优化 | 渲染采样 2x 清晰 + 空闲 30s 自动降帧（12fps，交互即恢复），长挂机省电省内存 | 自动生效 |

### 功能展示

**主聊天界面**（MIO 管理窗口 · 对话页）：与小智的完整往来记录实时显示，支持文字/图片发送、官方音色语音 + 逐句文本。

![主聊天界面](docs/images/主聊天界面.png)

**小智工具界面**（MIO 管理窗口 · 小智工具页）：本地免费 MCP 工具集中管理，按需开关，开启的工具进入小智能力列表，对话中自动调用并以官方音色回答。

![小智工具界面](docs/images/小智工具界面.png)

---

## 三、项目架构

```
┌────────────────────────────── 本地（你的电脑）──────────────────────────────┐
│                                                                             │
│  ┌─ 前端：Electron（澪Agent应用/live2d-desktop/main.js）─────────────────┐  │
│  │  · 桌宠本体    live2d-pet（PixiJS + Cubism4 渲染，只认 phase）         │  │
│  │  · 对话浮窗    xiaozhi-chat.html（单条胶囊横条 460×66）               │  │
│  │  · MIO 管理窗  /agent-app（对话 + Agent + 设置 + 小智工具）           │  │
│  │  · 截图选区    overlay.html（沉浸式区域选择）                         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              ▲ HTTP / WebSocket                              │
│  ┌─ 后端：FastAPI（私人AI日记系统/backend，端口 8000）───────────────────┐  │
│  │                                                                           │
│  │  ┌─ 跨 Agent 统一状态总线（agent_bus_service.py）────────────────────┐ │  │
│  │  │  12 phase 枚举 + 活跃聚焦调度 + 心跳扫描 + WS 广播（agent_phase） │ │  │
│  │  └───────────────────────────────────────────────────────────────────┘ │  │
│  │        ▲ register/emit/heartbeat/set_status/set_enabled                │  │
│  │  ┌─────┴──────────────┬──────────────────┬──────────────────┐           │  │
│  │  │ xiaozhi_adapter    │ dsh_adapter      │ octop_adapter    │           │  │
│  │  │（语音主通道，内置） │（DeepSeek Harness）│（Tencent Octop） │           │  │
│  │  └────────────────────┴──────────────────┴──────────────────┘           │  │
│  │  routes/xiaozhi.py：WS 代理/say/vision/MCP tools/observe/prompts/status │  │
│  │  routes/companion.py：设置/位置/截图/窗口/桌宠状态/agents API            │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
                              │ wss://api.tenclass.net/xiaozhi/v1/（小智默认）
                              ▼
┌───────────────────────────── 小智官方免费云 ─────────────────────────────┐
│  · ASR 语音识别  →  LLM 对话（支持设备侧 MCP 工具调用）→  TTS 官方音色    │
│  · 视觉分析（vision/explain MCP 工具，识别文本回灌官方 LLM 产出语音）    │
│  · test-token 通道，无需付费 API Key                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键设计（踩坑后定型的架构决策）：**

1. **桌宠无状态，只认 phase**：总线不感知任何 Agent 私有协议；适配器是唯一接触原生协议的代码。新增 Agent = 新增一个适配器，渲染端零改动。
2. **活跃聚焦调度**：按 phase 优先级决定"谁占据桌宠身体"（voice 最占注意力，idle 最低）；同 phase 300ms 节流；非活跃者静默 8s 后允许更高优先级抢占。
3. **音频只在桌宠本体播放**：对话窗（role=chat）只收文本，音频由桌宠（role=main）播放，从根上避免"多窗口声音叠加"。
4. **图片识别走官方视觉 MCP 链路**：设备侧实现 MCP server（`initialize` / `tools/list` / `tools/call`），官方视觉 API 识别文本作为 `tools/result` 回灌官方 LLM，由官方 LLM + TTS 产出**官方音色语音**，触发语由用户提示词配置（不写死）。
5. **长连接免唤醒**：后端保持一条到官方云的长连接，重连自动且静默（不进主聊天刷屏）；注入链路三层防阻塞（`conn.send` 5s 超时 + 注入 30s 超时自动释放锁 + 半死连接主动重连）。
6. **角色机制级解耦**：官方 STT 回传文本一律不写"你说"历史，"你说"只来自浏览器真实输入，"她说"只来自 AI 输出，杜绝信息错乱。
7. **小智对话记录面板**：独立注入脚本（不碰原版 SPA 编译产物），打开管理窗口即显示完整历史 + WS 实时 + 可发送；与原版注入脚本做粘贴互斥（`__mioXzChatInjectPaused`），根治"同一张图双发两次分析"。
8. **设置页/小智工具页/Agent 页统一内嵌框架**：导航按钮接管 + 内容区内嵌面板，与主界面其余界面框架一致；原版设置路由不再进入。
9. **前端直接改 dist 产物**：原版是 Vite 构建的压缩 SPA，本项目采用"dist 即源码"方式直接修改压缩产物（`node --check` 校验），不再走构建流程。

---

## 四、目录结构

```
C:\Users\xiao1\Mao
├── 澪Agent应用\                    # 前端
│   ├── live2d-desktop\             # Electron 主进程（窗口/菜单/快捷键/截图）
│   │   ├── main.js                 # 窗口管理 + 托盘菜单 + 全局快捷键 + 副屏边界 + 内存优化
│   │   └── preload*.js             # 各窗口安全桥
│   ├── dist\                       # 构建产物（本项目直接修改的"源码"）
│   │   ├── index.html              # MIO 管理窗口入口（/agent-app，挂载全部注入脚本）
│   │   ├── assets\                 # SPA 分片（index-*.js 主入口、ChatPage 对话页等）
│   │   ├── agent-switch-inject.js  # ★ Agent 管理页（总线快照 + 启用/停用开关）
│   │   ├── settings-panel-inject.js# ★ 新设置面板（桌宠/语音/屏幕观察/提示词/小智）
│   │   ├── mcp-tools-panel.js      # ★ 小智工具页（MCP 工具开关集中管理）
│   │   ├── xiaozhi-history-panel.js# ★ 小智对话记录面板（历史+实时+发送）
│   │   ├── xiaozhi-chat-inject.js  # 主聊天图片暂存注入（📷 + 粘贴，受面板互斥暂停）
│   │   ├── settings-clean-inject.js# 隐藏原版设置页遗留 UI
│   │   ├── agent-kill-inject.js    # 拦截原版 /api/agent/* 请求（防 404 提示条）
│   │   └── live2d-pet\             # 桌宠本体
│   │       ├── live2d-pet.js       # 渲染/右键菜单/模型/气泡/phase 映射/徽标/自由拖拽/空闲降帧
│   │       ├── pet-xz-audio.js     # 小智音频流解码播放 + 口型同步
│   │       ├── overlay.html        # 截图选区覆盖层
│   │       ├── xiaozhi\xiaozhi-chat.html/.js  # 单条胶囊横条对话浮窗
│   │       ├── models\             # Live2D 模型（导入模型放这里）
│   │       └── libs\               # pixi / cubism4 渲染库
│   └── scripts\                    # 原版 worker 脚本（后端引用，保留）
│
├── 私人AI日记系统\backend\         # 后端（FastAPI）
│   ├── app\main.py                 # 应用入口（挂载全部路由 + 后台任务：总线心跳/适配器循环）
│   ├── app\agent_bus_service.py    # ★ 跨 Agent 统一状态总线（phase/调度/心跳/快照/广播）
│   ├── app\dsh_adapter.py          # ★ DSH（DeepSeek Harness）适配器（可插拔框架）
│   ├── app\octop_adapter.py        # ★ Octop（TencentCloud）适配器（可插拔框架）
│   ├── app\routes\xiaozhi.py       # ★ 小智核心：WS 代理/say/vision/MCP tools/observe/prompts/status
│   │                               #   + 总线插桩（_xz_register/_xz_emit/_xz_status）
│   ├── app\routes\companion.py     # 桌宠状态/设置/位置/截图/窗口/agents API
│   └── requirements.txt             # 后端依赖
│
├── start_mio.ps1                   # ★ 一键启动（后端 + Electron，脱离控制台，相对路径版）
├── 安装依赖.ps1                    # 发布版一键装依赖（自动检测 Python/Node → venv → Electron）
├── 打包发布.ps1                    # 生成发布 zip
├── xiaozhi_device.json             # 小智设备身份（mac_address + client_id）
├── xiaozhi_prompts.json            # 图片/观察提示词配置（可在线编辑）
├── xiaozhi_observe.json            # 屏幕观察任务配置（持久化）
├── xiaozhi_chat_history.json       # 对话历史持久化（运行数据）
├── agent_bus_config.json           # 总线启用状态持久化（运行时生成，已 gitignore）
├── dsh_config.json                 # DSH 接入配置（enabled/base_url/api_key/ws_url，已 gitignore）
├── octop_config.json               # Octop 接入配置（enabled/base_url/token/agent_id，已 gitignore）
├── README.md                       # 本文件
├── CHANGELOG.md                    # 版本更新记录
└── SRC-MAP-源码地图.md              # 界面导航手册（改代码先看它）
```

---

## 五、从零开始上手

> **发布版用户快速开始**（拿到 `Mao桌宠_v3.0.zip`）：
> 1. 解压到任意目录（路径含中文没问题）；
> 2. 双击运行 `安装依赖.ps1`（自动检测 Python/Node → 创建后端虚拟环境 → 安装 Electron 运行时，首次约 5 分钟）；
> 3. 双击运行 `start_mio.ps1` 启动桌宠（后端 + Electron 一次性拉起，启动窗口自动关闭）；
> 4. 桌宠首次启动会自动生成设备身份 `xiaozhi_device.json`（机器码 = MAC 后 6 位，如 `C31113`）；
> 5. 打开 MIO 管理窗口 → 「小智对话记录」面板自动显示；左侧「设置 → 小智」tab 查看机器码，到小智控制台绑定/核对设备即可对话。
>
> 以下为源码方式的完整步骤（发布版已自动完成 0/1 步）。

### 0. 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10/11 x64 |
| PowerShell | **PowerShell 7（pwsh）**，脚本统一用 `pwsh.exe` 执行 |
| Python | 3.10+（后端运行于 `私人AI日记系统\backend\.venv`） |
| Node.js | 18+（Electron 运行于 `澪Agent应用\live2d-desktop\node_modules`） |
| 网络 | 能访问小智官方云（`api.tenclass.net`） |

### 1. 安装依赖

```powershell
# 后端
cd 私人AI日记系统\backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt

# 前端 Electron
cd ..\..\澪Agent应用\live2d-desktop
npm install
```

### 2. 配置小智（关键步骤）

小智免费接入走 **test-token 通道**，不需要任何付费 API Key。需要三步：

**① 设备身份**：项目根目录 `xiaozhi_device.json` 保存设备身份（**发布版首次启动会自动生成**，无需手写）。如需自定义设备，按官方文档创建设备后写入：

```json
{
  "mac_address": "3C:DC:75:C3:11:13",
  "client_id": "cf7e8ad1-950f-4efb-8125-f473baa5d249"
}
```

**② 确认设备绑定**：启动后端后访问 `GET /api/xiaozhi/status`，应返回：

```json
{
  "ok": true, "bound": true,
  "mac": "3c:dc:75:c3:11:13",
  "client_id": "cf7e8ad1-...",
  "machine_code": "C31113",
  "connected": true, ...
}
```

- `bound: true` 表示设备已绑定（`xiaozhi_device.json` 中无 `activation` 字段即为已绑定）；
- `machine_code` 是 **六位机器码**（取 MAC 十六进制后 6 位），用于在小智控制台核对设备；
- `connected: true` 表示与官方云的长连接已建立。

**③ 绑定状态可视化**：打开 MIO 管理窗口 → 左侧「设置 → 小智」tab，可实时查看连接状态、机器码与完整 MAC。

### 3. 启动桌宠

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File start_mio.ps1
```

脚本自动完成：启动/检测后端（uvicorn :8000）→ 拉起 Electron 桌宠窗口。所有子进程以 `CreateNoWindow` 方式启动，**关闭启动终端不影响桌宠运行**（启动窗口会自动关闭）。

**开机自启**：默认写入注册表 `HKCU\...\Run`（键名 `Mao桌宠自启动`，指向 `start_mio.ps1`），开机自动拉起桌宠。

### 4. 日常使用

**桌宠右键菜单：**

| 菜单项 | 作用 |
|---|---|
| 打开/关闭对话窗口 | 单条胶囊横条（460×66）：状态点+输入+📷+发送+关闭，回复由桌宠气泡+官方音色语音呈现 |
| 调整大小 | 滑条调整桌宠尺寸（80%~240%） |
| 截图提问 | 截取屏幕 → 小智识别 → 桌宠气泡显示分析（全局快捷键 `Ctrl+Shift+S` 可框选区域） |
| 隐藏说话气泡 | 切换气泡显示 |
| 隐藏/显示状态徽标 | 切换 Agent 状态徽标（工作时头顶短暂显示，默认开） |
| 打开 Mio | 打开 MIO 管理窗口（小智对话记录面板自动显示） |
| 关闭桌宠 | 退出桌宠 |

**MIO 管理窗口：**

- 左侧导航：**对话 / 桌宠 / 设置 / 小智工具 / Agent**，五个界面同一套框架；
- **Agent 页**：列出全部已注册 Agent 的工作状态、能力与启用开关；停用的 Agent 只显示"未启用"；一键切换"谁显示"（即换即用）；
- **小智对话记录面板自动显示**：与小智的全部来往记录（横条/主界面/截图提问/屏幕观察）历史加载 + 实时追加，可直接发送文字/图片，右上角 ✕ 关闭后右下角"小智对话"悬浮按钮重开；
- **设置页**：桌宠（大小/缩放/偏移/跟随鼠标/置顶/穿透/气泡）、语音（开关/音量/流式）、屏幕观察（启用/间隔/安静时段）、提示词（图片/观察触发语）、小智（连接状态/机器码）；
- **小智工具页**：15 项本地免费 MCP 工具按需开关（开启后小智对话可直接调用，如查系统信息、查时间天气、记备忘等）；
- 输入框支持文字、图片（📷 选择 / 直接粘贴，图片先暂存再发送，防双发）。

**导入新模型**：把 Cubism 3/4 模型目录放进 `澪Agent应用\dist\live2d-pet\models\`，然后在桌宠管理页切换形象。

### 5. 常用后端接口

| 接口 | 作用 |
|---|---|
| `WS /api/xiaozhi/ws?role=main\|chat` | 小智官方云长连接（main=桌宠播音频，chat=对话窗收文本） |
| `POST /api/xiaozhi/say` | 文字对话（写历史 + 注入官方音频流） |
| `POST /api/xiaozhi/vision` | 图片识别（官方视觉 MCP → 文本 + 官方音色语音） |
| `POST /api/xiaozhi/vision-bubble` | 截图提问/屏幕观察（分析广播到桌宠气泡 + 写历史） |
| `POST /api/xiaozhi/mcp/tools/call` | 本地 MCP 工具调用（小智工具页开关控制） |
| `GET /api/xiaozhi/chat-history` | 会话历史（小智对话记录面板数据源） |
| `GET /api/xiaozhi/status` | 连接状态 + 机器码 |
| `GET/PUT /api/xiaozhi/prompts` | 提示词配置读写 |
| `GET/POST /api/xiaozhi/observe/status\|start\|stop` | 屏幕观察任务 |
| `GET /api/companion/agents` | ★ 跨 Agent 总线快照（全部 Agent 状态 + 当前活跃者） |
| `POST /api/companion/agents/{id}/enabled` | ★ 启用/停用某个 Agent（即换即用） |
| `GET/PATCH /api/companion/settings` | 桌宠设置读写（设置面板数据源） |
| `PATCH /api/companion/position` | 桌宠位置保存（自由拖拽） |
| `POST /api/companion/screen-shot` | 截屏 |

---

## 六、Agent 接入指南（★ 重点）

桌宠是跨 Agent 的"脸"，接入一个新 Agent 通常**不需要改任何前端代码**——只要你的 Agent 能通过总线汇报标准 phase。下面从协议到代码给出完整指南。

### 6.1 总线协议：12 个标准 phase

所有适配器输出必须落在以下枚举内（`agent_bus_service.PHASES`）：

| phase | 含义 | 桌宠表现 | 徽标展示 |
|---|---|---|---|
| `idle` | 待机 | 待机动画 | ✕ |
| `planning` | 规划任务 | 思考动画 | ✓（工作状态） |
| `thinking` | 思考中 | 思考动画 | ✓ |
| `executing_tool` | 正在调用工具/执行动作 | 观察动作 | ✓ |
| `streaming` | 文本流式输出 | 回应动画 | ✓ |
| `waiting_input` | 等待用户输入（聆听） | 聆听动作 | ✓ |
| `voice` | 语音播报中 | 说话口型 | ✓ |
| `complete` | 单轮完成 | 待机 | ✕ |
| `error` | 出错 | 待机 | ✕ |
| `paused` | 暂停/断线待恢复 | 待机 | ✕ |
| `awaiting_approval` | 等待审批 | 回应动画 | ✓ |
| `heartbeat` | 存活心跳（不改变动画） | 无 | ✕ |

> **徽标口径**：连接/断连/在线（`offline`/`connecting`/`online`）与 `idle`/`complete`/`paused`/`heartbeat` 等非工作状态**不显示徽标**，只有"工作中"细分状态（`planning`/`thinking`/`executing_tool`/`streaming`/`waiting_input`/`voice`/`awaiting_approval`）才会在桌宠头顶短暂展示 4 秒后自动淡出——避免小智频繁重连导致闪烁。

### 6.2 活跃聚焦调度

- **优先级**（数值越小越优先占据桌宠"身体"）：

| 优先级 | phase |
|---|---|
| 1 | `voice` |
| 2 | `executing_tool`、`awaiting_approval` |
| 3 | `thinking`、`planning` |
| 4 | `streaming`、`waiting_input` |
| 5 | `complete`、`error`、`paused`、`heartbeat` |
| 6 | `idle` |

- **调度规则**：当前活跃者停在完成态且新事件优先级更高 → 让位；当前活跃者静默超 `STALE_MS`(8s) → 允许更高优先级抢占；同优先级后发覆盖（"最近说话者"）；`heartbeat` 不参与抢显示。
- **节流**：同 Agent 同 phase 300ms 内重复事件丢弃（`THROTTLE_MS`，可 `force=True` 绕过）。

### 6.3 总线 API（Python）

```python
from . import agent_bus_service as bus

# 1) 注册（启动时调用一次；重复注册会更新 name/adapter/capabilities）
state = bus.register(
    agent_id="myagent",          # 唯一 ID
    name="我的Agent",             # 展示名
    adapter="my_adapter",        # 适配器标识
    capabilities={"voice": False, "text": True, "screen": False, "mcp": False, "observe": False},
    enabled=True,                # 可选；不传则默认 True
)

# 2) 上报状态（连接类：offline/connecting/online/error）
bus.set_status("myagent", "online")                 # error=None 保留旧值
bus.set_status("myagent", "online", error="")       # 传空串清除错误
bus.set_status("myagent", "error", error="连接失败") # 更新错误

# 3) 注入工作 phase（驱动桌宠动画与徽标）
bus.emit("myagent", "thinking", state={"step": "1"})        # state 可选，透传上下文
bus.emit("myagent", "executing_tool", state={"tool": "search"})
bus.emit("myagent", "voice", force=True)                     # force 绕过 300ms 节流

# 4) 心跳（适配器循环里定期调用；超 30s 未上报总线判离线）
bus.heartbeat("myagent")

# 5) 启用/停用（停用立即释放"身体"，同时 phase 归 idle）
bus.set_enabled("myagent", True)

# 6) 查询
bus.snapshot()      # 全量快照：active_agent_id / active_agent / agents[] / phase_priority / ts
bus.list_agents()   # Agent 列表
bus.get("myagent")  # 单个 Agent 状态
```

### 6.4 接入一个新 Agent（三步）

1. **建适配器文件** `backend/app/xx_adapter.py`（照抄 `dsh_adapter.py` / `octop_adapter.py` 骨架）：
   - `load_config()` 读项目根 `xx_config.json`（默认全部禁用 → 注册后标记 offline + 说明如何启用）；
   - 一个事件解析函数（把 Agent 原生事件翻译成 phase）；
   - `async def xx_adapter_loop()` 后台循环：`register` → 检测配置 → 心跳保持在线 → 订阅/轮询 Agent 事件 → `emit`。
2. **挂载后台任务**：在 `backend/app/main.py` 的 `BACKGROUND_TASK_FACTORIES` 里加一行 `"xx_adapter_task": xx_adapter.xx_adapter_loop`。
3. **配置 + 忽略**：项目根建 `xx_config.json`（如 `{"enabled": false, ...}`），并在 `.gitignore` 加入（配置可能含 token）。

**最小适配器示例：**

```python
"""my_adapter.py —— 接入自研 Agent 的最小示例"""
from __future__ import annotations
import asyncio
from . import agent_bus_service as bus

AGENT_ID = "myagent"

async def my_adapter_loop() -> None:
    bus.register(AGENT_ID, "我的Agent", "my_adapter",
                 capabilities={"voice": False, "text": True, "screen": False, "mcp": False, "observe": False})
    while True:
        # 每个 Agent 都有自己的"取事件"方式：WS 订阅 / HTTP 轮询 / 子进程回传……
        # 这里以 WS 订阅为例（伪代码）：
        #   async for raw in ws_subscribe("ws://127.0.0.1:xxxx/events"):
        #       phase, state = parse_my_event(raw)   # 映射到 6.1 枚举
        #       if phase:
        #           bus.heartbeat(AGENT_ID)
        #           bus.emit(AGENT_ID, phase, state=state)
        bus.heartbeat(AGENT_ID)          # 至少保持在线
        await asyncio.sleep(10)
```

> 总线对事件来源零假设：你的 Agent 可以是任何进程/语言，只要能往本后端发 HTTP/WS 并最终调用总线 API 即可。
> 想在独立进程接入？直接向 `POST /api/companion/agents` 家族扩展一个"外部事件上报"接口，或复用 pet_event_service 的 WS 通道（见 6.7）。

**两条实战经验（`dsh_adapter` 踩过，接入时直接照做）：**

1. **不要在 Windows 上用 `asyncio.create_subprocess_exec` 起边车**。它走 overlapped
   命名管道，在受限/隐藏窗口环境下会直接 `PermissionError: [WinError 5]`。改用
   `subprocess.Popen` + `PIPE` + 后台线程逐行读，再用
   `loop.call_soon_threadsafe` 投递到 `asyncio.Queue`（见 `dsh_adapter.DshLogSidecar`）。
2. **区分两个"启用"层次**：适配器自己的 `xx_config.json.enabled` 是"部署就绪开关"，
   总线上的 `enabled`（Agent 页开关、持久化于 `agent_bus_config.json`）是"用户是否让它在
   桌宠上显示"。上报前要同时检查两者（`dsh_adapter._bus_enabled()`），否则用户停用后
   适配器仍在抢桌宠身体。

### 6.5 已内置适配器

| Agent | 适配器 | capabilities | 配置 | 说明 |
|---|---|---|---|---|
| 小智 | `xiaozhi_adapter`（routes/xiaozhi.py 内） | voice/text/screen/mcp/observe 全开 | 无需配置 | 官方免费云，语音主通道；事件插桩见 6.6 |
| DSH | `dsh_adapter.py` + `dsh_log_stream.mjs` | text/mcp | `dsh_config.json` | DeepSeek Harness 桌面版（Electron + Node），**真实会话事件摄取**，见 6.5.1 |
| Octop | `octop_adapter.py` | text | `octop_config.json` | TencentCloud Octop（FastAPI + LangGraph 多 Agent），WS Hub 路径 `/api/agents/{aid}/chat/ws` |

#### 6.5.1 DSH 接入（已实现，非占位）

DSH 是 Electron + Node 的单 Agent 运行时，**不需要 token、不占端口**——它的工作状态
直接来自本机会话事件日志：

```
~/.dsh/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd
```

该文件是**拼接式 Zstandard 帧**的 JSONL（每个追加批次一个独立 zstd 帧，因此不能一次性
解压，只能逐帧解）。事件词汇是 DSH 官方 `SessionEvent` 词汇，粒度到 turn/step/tool。

**进程拓扑**（DSH 协议细节全部隔离在边车里，总线与桌宠只认 phase）：

```
DSH 会话日志(.jsonl.zstd)
  └─ node dsh_log_stream.mjs    协议侧：逐帧解 zstd + 折叠成客观事实 facts
       └─ NDJSON over stdout
            └─ dsh_adapter.py   策略侧：facts → phase → 总线
                 └─ agent_bus_service → WS agent_phase → 桌宠
```

之所以加一层 Node 边车：Python 侧没有 zstd 绑定，而 Node 自带
（`node:zlib` 的 `zstdDecompressSync`）。边车**零依赖、只读**，退出即被适配器自动拉起。

**真实事件 → phase 映射**（`dsh_adapter.phase_for_facts`，判定顺序即优先级）：

| DSH 真实事件 | phase | 说明 |
|---|---|---|
| `turn/start`；`todo_write` / `create_goal` / `update_goal`；`todo/write`；`goal/change` | `planning` | 规划意图（`plan_intent` 事实；无工具在跑时生效） |
| `step/start`；`llm/retry` / `llm/retry-started` | `thinking` | 步骤推进 / LLM 重试 |
| `tool/call`（调用未返回） | `executing_tool` | `active_tools > 0`；**优先于 planning**（与总线 `PHASE_PRIORITY` 一致） |
| `assistant/message` 且为**纯文字**（无 `tool-call` 块） | `streaming` | 正文输出 |
| `ask_user_question` 工具在跑 | `waiting_input` | 等待用户作答 |
| `approval/asked` → 未 `approval/decided` | `awaiting_approval` | 等待审批（本机已观测真实配对） |
| `turn/end` 且 `reason.kind == "completed"` | `complete` | 单轮完成 |
| `turn/end` 且 `reason.kind == "blocked"` | `waiting_input` | 提示词被 hook 拦下，等用户换输入 |
| `tool/result` 的 `message.isError === true`；`turn/end` 的 `error`/`max-tokens`/`interrupted` | `error` | 失败当下（不粘轮） |
| DSH 进程退出但日志仍在（连接中断分支） | `paused` | 连接中断待恢复 |
| DSH 在线且当前无工作 | `idle` | 待机 |

> **`turn/end` 完整词汇**（`TurnEndReasonMap`）：`completed` / `aborted` / `blocked` /
> `error` / `max-tokens` / `interrupted` / `forked`。未列出的新值一律落到 `idle`
> （该 map 可被下游 merge 扩展，不能让桌宠挂在工作态）。

> **并发工具调用是真实的**：本机日志实测存在"同时 ≥2 个 `tool/call` 在飞"的情况
> （峰值并发 >1，随会话规模增长），所以 `tool/result` **不一定**紧跟自己的
> `tool/call`。适配器用**计数器**（`active_tools`，每个 result 递减）而非"配对"，
> 因此并发下语义天然正确——这也是为什么不要改成按位置配对。
>
> 另注：`tool/result` 的 `data` 里**没有** `callId`（只有 `message.toolCallId`），
> 所以"按 id 配对算单个工具耗时"这条路在日志上走不通；用计数器是唯一稳妥做法。

> **12 个 phase 的"注册"与"可达路径"是两件事**（自检里有对应断言，别把二者混为一谈）：
> `DSH_PHASES` 注册 12 个；其中 **10 个由实时事件（facts）产出**（`DSH_FACT_PHASES`）：
> `planning` / `thinking` / `executing_tool` / `streaming` / `waiting_input` / `voice` /
> `awaiting_approval` / `idle` / `complete` / `error`。另外两个：
> - `paused` **不走 facts**，由「DSH 进程还在但会话不可用」的连接中断分支直接 emit；
> - `heartbeat` **刻意不作为 phase emit**：总线的 `emit()` 对 heartbeat 不广播 `agent_phase`，
>   且会把 `agent.phase` 写成 `"heartbeat"` 污染 Agent 页显示——保活一律走
>   `agent_bus_service.heartbeat()`（这正是它存在的意义）。
>
> **`streaming` 的判据是「纯文字」而非「含文字」**：实测真实日志里 `assistant/message`
> **绝大多数（约 99%）都带 `tool-call` 块**，若拿"含 text"当判据会长期误报回复中。
> 故边车额外折叠出 `last_message_text_only`（有 `text` 且无 `tool-call`），
> 且 `step/start` 与本轮 `turn/start` 都会重置该标记（否则上一轮的 streaming 会粘到
> 新步骤上；这正是自检 `[7]` 那条回归测试守着的点）。

> **失败识别口径**：DSH 的失败标记是 `tool/result.data.message.isError === true`，
> 而**不是** `data.error`。实测（`python -m app.dsh_stats`）：`message.isError` 字段
> **从不缺失**，失败样本里 `data.error` 只是**可选的补充信息**，所以判据必须用 `isError`。
> `error` phase 只在“最近一个事件本身是失败”时进入，后续任何进展事件
> 立即恢复工作态，避免失败态粘住整轮。
>
> 注：本机日志持续增长，任何绝对条数都会过期——**别照抄数字，跑 `dsh_stats` 取当时的**。
> 早先版本写死的 "330 条 / 仅 2 条带 data.error" 已被复核证伪（同口径实测是 8 条）。

> **`voice`（语音播报）在本版 DSH 不可观测**：DSH 没有 TTS/语音合成服务（asar 内无
> tts 包，官方 README 明确 "no speech synthesis"）；语音输入（STT）的转写只进输入框
> 草稿，提交后与打字产生的 `user/message` **完全不可区分**。因此 DSH 的
> `capabilities.voice` 如实报 `False`，适配器保留 `voice` phase 与映射：若日后部署了
> 名为 `speak`/`tts` 的工具，桌宠会自动按"说话中"呈现，无需改代码。

**摄取通道选型**（两个可编程面都在本机实测过）：

| 通道 | 延迟量级 | 取舍 |
|---|---|---|
| 会话日志 `session.v4.jsonl.zstd`（**本适配器采用**） | 见下方说明（受 DSH 写盘节奏支配） | 无需鉴权、无需发现端口、DSH 重启不失效 |
| Host WS `/api/remote.mux` → `session/follow` | 推送更及时（含 `assistant-stream` 增量） | 需凭据 cookie 签名 + 端口发现（端口临时分配、未持久化） |

> **不要轻信任何写死的延迟数字**（本文件早先版本写过 "p50 215ms"，已被两位独立复核者
> 证伪：他们各自量到 p50 259ms / 400ms，我重测则为 ~1.5s）。跑
> `.venv\Scripts\python.exe -m app.dsh_latency 45` 自己量——它按 `facts.updated_at`
> 变化判定新事件，量到的是"用户真实感知"的端到端值。**本机实测约 1.5s**。

关于延迟，三条经过实测、较稳定的事实：

1. **主要成本在 DSH 自己的写盘节奏**，不在我方管道：DSH 按批落盘而非每条事件即时
   `flush`，所以"事件发生 → 文件里能读到"这一段就占了大头。我方 `poll_ms` 只决定
   额外叠加多少，改成 150ms 后我方部分 ≤150ms。**这也是日志通道的固有代价**——
   它换来的是零鉴权、零端口发现、DSH 重启不失效。
2. **长工具调用期间日志会长时间不写**：本机实测单次 `pwsh` 调用可让日志停止增长
   **40s 以上**（期间 0 条新事件）。这不是故障，是 DSH 的事件粒度——工具调用只在
   开始（`tool/call`）与结束（`tool/result`）落两条，中间没有增量。
   因此**"工具正在跑"这件事必须靠周期补发维持**，见下方"一直在干活"小节。
3. **该量级对桌宠是够用的**：状态徽标本身设计为"短暂展示 4s 后淡出"，桌宠做的是
   氛围表达而非逐帧同步；1.5s 的滞后不影响"看起来在干活"的可读性。若日后要追求
   亚秒级，接 WS 快通道即可（事件内容与日志通道完全一致）。

选日志为主通道的理由：两个通道能拿到**同一批事件**（实测同期条数与 seq 完全一致），
而日志通道在 DSH 重启/换端口/无 GUI 时都不失效——对桌宠这种常驻展示场景，健壮性
比那几百毫秒更重要。WS 快通道留作后续可选加速项。

**启用**：在 `私人AI日记系统\dsh_config.json` 设 `"enabled": true`（或在 MIO 管理窗口 →
「Agent」页打开 DSH 开关）；随后启动 DeepSeek Harness 桌面应用即可。全部字段留空即用默认：

```json
{ "enabled": true, "sessions_root": "", "workspace": "", "session_id": "", "node_path": "", "poll_ms": 150 }
```

| 字段 | 留空时的行为 |
|---|---|
| `sessions_root` | `<DSH_HOME>/sessions`（默认 `~/.dsh/sessions`） |
| `workspace` | 不限定，边车自动跟随"最近活跃的主会话"（优先 `delegationDepth=0`，避免跟到 subagent 子会话） |
| `session_id` | 自动选活跃会话 |
| `node_path` | 依次探测 PATH → DSH 自带 runtime → 常见安装位置 |
| `poll_ms` | 150（边车日志尾随轮询间隔；这是我方唯一能控的延迟项，调小更跟手、代价是空闲时多读几次文件） |
| `base_url` / `api_key` / `ws_url` | **当前无代码读取**（v3.1 遗留的占位键，保留以免旧配置报错）。日志通道不需要它们；若日后启用 WS 快通道才会用到 |

**自检与验证**（backend 目录下）：

```powershell
.venv\Scripts\python.exe -m app.dsh_acceptance          # 验收报告：12 phase 逐条列出注册/可达/驱动来源
.venv\Scripts\python.exe -m app.dsh_adapter_selftest   # 131 项：映射/解码/回放/可达性/总线/回归/前端契约
.venv\Scripts\python.exe -m app.dsh_adapter_e2e 60     # 端到端：轮询总线看 phase 实时变化
.venv\Scripts\python.exe -m app.dsh_ws_check 30        # 桌宠消费的那条 WS 通道
.venv\Scripts\python.exe -m app.dsh_latency 45         # 端到端状态延迟（诚实口径，别抄死数字）
.venv\Scripts\python.exe -m app.dsh_stats              # 真实事件语料统计（条数会过期，现取现用）
.venv\Scripts\python.exe -m app.dsh_gap_analysis       # 事件覆盖缺口（DSH 升级后跑一次）
.venv\Scripts\python.exe -m app.dsh_fixture_build      # 从真实日志重建回放夹具（脱敏+分支覆盖自检）
```

> 控制台若报 `UnicodeEncodeError`（Windows 默认 GBK），先设 `$env:PYTHONIOENCODING='utf-8'`；
> `dsh_acceptance` 已自行把 stdout 重配为 UTF-8，其它脚本未处理。

**接入状态总览**（`app.dsh_acceptance` 的输出口径）：

| 口径 | 数量 | 说明 |
|---|---|---|
| 总线 phase 枚举 | 12 | `agent_bus_service.PHASES` |
| 本适配器注册 | **12** | `DSH_PHASES`，全部在总线枚举内 |
| 实时事件可达 | **10** | `DSH_FACT_PHASES`（`paused`/`heartbeat` 走各自专用路径，见上） |
| 工作细分状态 | 7 | `DSH_WORK_PHASES`，与桌宠 `WORK_PHASES` 逐字一致 |

**排障接口**（比 `/agents` 快照更深，先看这个）：

```http
GET /api/companion/agents/dsh/inspect
```

返回：`phase` / `bus_enabled` / `sidecar_alive` / `sidecar_error` / `dsh_process_running` /
`session_id` / `facts`（最近折叠出的客观事实）/ `phases`（12）/ `fact_phases`（10）/
`work_phases`（7）/ `config_path`（实际生效的配置文件路径）。

**WS 链路检查**（确认桌宠真正消费的那条通道）：`.venv\Scripts\python.exe -m app.dsh_ws_check 30`

**「一直在干活」为什么要周期补发**：桌宠渲染端的动作有时限（`live2d-pet.js`：
speaking 4s、其余 **2.6s** 后回落待机）。DSH 单次工具调用可能持续很久（本机实测日志
可停止增长 **40s 以上**，见上文延迟小节），这期间**没有任何新事件**；若只在事件到达时上报，
桌宠会在工具还在跑时就变回待机，看着像 DSH 停工了。故适配器把补发间隔压到 **2s**（`REEMIT_MS`，
小于 2.6s 活动窗口），在静默期也周期性补发当前工作态——`emit` 内部自带节流，不会刷屏。

**Octop 事件 → phase 映射**（`octop_adapter.parse_octop_event`）：

| Octop WS 消息 | phase |
|---|---|
| `ready` / `hello` / `idle` | `idle` |
| `stream` / `text/stream` / `chunk` | `streaming` |
| `tool` / `tool/call` / `tool_call` | `executing_tool` |
| `approval` / `awaiting_approval` / `ask` | `awaiting_approval` |
| `complete` / `done` / `end` | `complete` |
| `error` | `error` |

### 6.6 小智插桩（参考实现）

小智已在 `routes/xiaozhi.py` 完成总线插桩，是"事件驱动 → phase"的完整范例：

```python
def _xz_register() -> None:      # 启动/重连时注册（voice/text/screen/mcp/observe 全开）
def _xz_emit(phase, **state):    # 官方云事件 → 总线（内部先 heartbeat 再 emit）
def _xz_status(status, *, error=None):  # 上报连接状态（error=None 保留旧值，"" 清除）
```

官方云事件 → phase 对照：

| 小智官方云事件 | 插桩 |
|---|---|
| 握手成功 hello | `_xz_status("online", error="")` + `_xz_emit("idle")` |
| 断线 / goodbye | `_xz_status("offline", error="连接中断，自动重连中")` + `_xz_emit("paused")` |
| MCP 工具调用 | `_xz_emit("executing_tool", tool=…)` |
| STT 识别到用户输入 | `_xz_emit("waiting_input")` |
| LLM 文本输出 | `_xz_emit("streaming")` |
| TTS 语音开始 | `_xz_emit("voice")` |
| TTS 结束 | `_xz_emit("complete")` |

### 6.7 HTTP / WS 对外接口

**HTTP：**

```http
GET  /api/companion/agents                     → 总线快照
POST /api/companion/agents/{agent_id}/enabled  → {"enabled": true|false}
```

快照响应示例：

```json
{
  "active_agent_id": "xiaozhi",
  "active_agent": { "agent_id": "xiaozhi", "name": "小智", "status": "online", "phase": "voice", "enabled": true, "capabilities": {...}, "active": true, ... },
  "agents": [ { "agent_id": "xiaozhi", ... }, { "agent_id": "dsh", "status": "offline", "enabled": false, ... } ],
  "phase_priority": { "voice": 1, "executing_tool": 2, ... },
  "ts": "2026-10-14T12:00:00+08:00"
}
```

**WebSocket（复用 pet_event_service 通道，事件类型）：**

| 事件 | 触发 | payload 关键字段 |
|---|---|---|
| `agent_phase` | 每次 `emit`（heartbeat 除外） | `agent_id` / `agent_name` / `adapter` / `phase` / `state` / `meta` / `seq` / `active` / `active_agent_id` / `ts` |
| `agent_status` | 每次 `set_status` | `agent_id` / `agent_name` / `status` / `enabled` / `ts` |
| `agents_snapshot` | 启用/停用、心跳扫描判离线 | 同快照结构 |

### 6.8 前端渲染映射（无需改动）

桌宠渲染端已内置 phase → 表现映射（`dist/live2d-pet/live2d-pet.js`）：

- `PHASE_LABELS`：phase → 中文标签（待机/规划/思考中/执行工具/回复中/聆听中/说话中/完成/出错/暂停/待确认/在线）；
- `PHASE_TO_ACTIVITY`：phase → 动作组（voice→speaking、waiting_input→listening、其余工作态→responding、完成/出错/暂停→idle）；
- `PHASE_MOTION_HINT`：phase → 表情/动作提示词（executing_tool→observe、awaiting_approval→attention、thinking→thinking、waiting_input→listening 等）；
- `WORK_PHASES`：徽标只对工作中的细分状态显示（见 6.1），连接/断连不打扰；
- 徽标跟随桌宠头顶，4 秒自动淡出；右键菜单可开关（localStorage `mio_agent_badge_enabled`）。

**接入新 Agent 时前端零改动**——只要 phase 落在枚举内，动画/动作/徽标全部自动生效。

### 6.9 验证方法

1. 启动后端后 `GET /api/companion/agents`，应能看到全部已注册 Agent 与状态；
2. Agent 页（MIO 管理窗口 → 左侧「Agent」）显示状态与启用开关；
3. 让 Agent 进入工作状态（如对小智说话），观察桌宠动作/表情切换与头顶徽标 4 秒展示；
4. 停用该 Agent → 立即释放"身体"（active 置空、phase 归 idle）；
5. 模拟断连（如关闭 Agent）→ 总线心跳扫描 30s 内将其标记 offline。

---

## 七、常见问题

| 问题 | 说明 / 处理 |
|---|---|
| 对话/图片识别没声音 | 视觉走官方视觉 MCP 链路（识别文本回灌官方 LLM + 官方 TTS），语音与文本同链路返回；若仍无声音，确认「设置 → 语音」已开启流式播放。 |
| 图片分析发两遍 | 已修复：小智对话记录面板打开时，原版注入脚本的图片暂存自动暂停（`__mioXzChatInjectPaused`），且面板发送有 busy 锁，同一张图只分析一次。 |
| 经常断连重连 | 官方免费云会对空闲连接主动断开（1005）。后端保持长连接自动静默重连，不进主聊天刷屏；注入链路有三层防阻塞（超时自动释放锁）。 |
| Agent 徽标一直闪 | 连接/断连状态不再显示徽标，仅工作细分状态展示 4 秒；若仍异常，确认已加载最新 `live2d-pet.js`（右键菜单开关徽标可临时隐藏）。 |
| Agent 页显示"未启用" | 该 Agent 尚未配置。DSH/Octop 需要按 6.5 填写对应 `*_config.json` 并在设置页启用；停用的 Agent 不显示工作状态（避免无意义信息）。 |
| 停用 Agent 后桌宠还在"工作" | 停用立即 `phase=idle` + `active=False`，并广播快照；若渲染端未恢复，刷新/重启桌宠。 |
| MIO 管理窗口显示旧界面 | Electron 缓存了旧页面。管理窗口每次打开前自动清缓存；若仍异常，确认 URL 版本参数已更新（`?v=...`）。 |
| 桌宠拖拽会弹回/限位 | 已完全移除全部限位：上下/水平自由拖拽，不回弹不拉回，位置原样保存。若仍异常，重启桌宠确认加载最新 `live2d-pet.js`。 |
| 设置页还是旧界面 | 确认 `settings-panel-inject.js` 已挂载（index.html `?v=...`）；新设置页在左侧导航「设置」进入。 |
| 小智不调用 MCP 工具 | 到「小智工具」页确认对应工具开关已开启；开关持久化在 `xiaozhi_mcp_tools.json`，`tools/list` 只返回开启的工具。 |
| 锁定按钮不见了 | 锁定/解锁按钮常驻（右下角圆钮）：非锁定时点击进入"固定并穿透"，锁定时点击解锁。 |
| 模型加载失败 | 确认模型目录在 `dist\live2d-pet\models\` 下且为 Cubism 3/4 格式（`.model3.json`）。 |
| 启动脚本报错 | 统一用 `pwsh` 执行；确认 `.venv` 与 `node_modules` 已安装（见第五节）。 |

---

## 八、参考项目与小智资源

### 参考/上游仓库

| 仓库 | 用途 |
|---|---|
| [ochiru520/Mio](https://github.com/ochiru520/Mio) | 本项目上游：Mio 桌宠（Electron + Vue + FastAPI），本仓库为深度改造发布版 |
| [pixijs/pixijs](https://github.com/pixijs/pixijs) | Live2D 渲染底层（WebGL 渲染器） |
| [guansss/pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | Live2D 模型加载/渲染/交互库 |
| [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) | 小智官方固件（协议/握手/音频帧参照） |
| [78/xiaozhi-esp32-server](https://github.com/78/xiaozhi-esp32-server) | 小智服务端实现（视觉/LLM/TTS 管线参照） |
| [huang-jun-sen/py-xiaozhi](https://gitee.com/huang-jun-sen/py-xiaozhi) | 官方 PC 客户端参考实现 |
| [xkk6663/Harness_ESP32S31](https://github.com/xkk6663/Harness_ESP32S31) | 端侧人脸识别小智项目（官方音色视觉链路参照） |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | DSH（DeepSeek Harness）：可接入的单 Agent 运行时（`dsh_adapter.py` 参照） |
| [TencentCloud/Octop](https://github.com/TencentCloud/Octop) | Octop：自托管多用户多 Agent 助手（`octop_adapter.py` 参照） |
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | 多 Agent 调度参考（`awaiting_approval` phase 借鉴其审批流） |

### 小智官方资源

| 资源 | 地址 |
|---|---|
| 小智控制台（设备绑定/Agent 管理） | https://xiaozhi.me/console/agents |
| 小智官方文档 | https://xiaozhi.me/docs |
| 小智开发文档（协议/MCP/AI Features） | https://xiaozhi.dev |
| 官方云上游（默认，可用环境变量 `MIO_XIAOZHI_UPSTREAM` 覆盖） | `wss://api.tenclass.net/xiaozhi/v1/` |

### 开源 Live2D 模型资源

- Live2D 官方示例模型：https://www.live2d.com/download/sample-data/
- GitHub 开源模型仓库（Cubism 3/4）：搜索 `live2d model`、`live2d 开源模型` 等关键词（导入方法见第五节第 4 条）。

---

## 九、开发守则（改代码必读）

1. **改界面** → 先查 `SRC-MAP-源码地图.md` 确定文件；dist 内压缩分片用 Python 精确字符串替换 + `node --check` 校验。
2. **改后端** → 改 `routes\` 或 `app\` 对应文件，`python -m py_compile` 校验；小智逻辑全在 `xiaozhi.py`，总线逻辑在 `agent_bus_service.py`，新 Agent 适配器独立成文件。
3. **接入新 Agent** → 严格按第六章：适配器只接触原生协议、只输出标准 phase；不要在 `agent_bus_service.py` 里写任何 Agent 私有逻辑。
4. **改完必做**：语法校验 + **git commit**（本地仓库防写坏，每个功能点一次提交）。
5. **改了前端文件记得升 URL 版本参数**（`?v=...`），否则 Electron 缓存不刷新。
6. **配置带密钥的文件入 .gitignore**：`agent_bus_config.json` / `dsh_config.json` / `octop_config.json`。
7. 运行数据（`xiaozhi_chat_history.json` / `status.json` / 日志）不参与功能逻辑的删除操作。

---

## 十、更新记录

详细版本记录见 `CHANGELOG.md`。本项目所有改动均以本地 git 提交管理。

**v3.1（跨 Agent 桌宠迭代）**
- 新增跨 Agent 统一状态总线（`agent_bus_service.py`）：12 phase 枚举、活跃聚焦调度、心跳在线检测、WS 广播；
- 新增 DSH / Octop 可插拔适配器（配置即启用，未配置显示启用引导）；
- 小智全事件插桩进总线（hello/mcp/stt/llm/tts/goodbye/断线 → 标准 phase）；
- 新增 Agent 管理页（导航项 + 状态卡片 + 启用开关）与 `GET/POST /api/companion/agents*` 接口；
- 桌宠渲染端 phase 映射 + 头顶状态徽标（仅工作细分状态短暂展示、4 秒淡出、菜单可开关）；
- 徽标不显示连接/断连状态（避免小智重连闪烁）；停用 Agent 不展示工作状态。

**v3.0（精简发布版）**
- 去除原版无关功能与设置遗留 UI；重建设置页（5 tab 内嵌框架）；
- 小智工具页（15 项本地 MCP 工具集中管理）、小智对话记录面板；
- 自由拖拽无回弹、内存优化（降帧）、开机自启修复、README/CHANGELOG 完善。
