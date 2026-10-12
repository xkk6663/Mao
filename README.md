# Mio 桌宠 × 小智 · 免费开源 Live2D 看板娘

> 把开源桌宠 Mio 与**小智 AI 官方免费云**融合：一个完全本地运行、不花一分 API 钱的 Live2D 桌宠。
> 能说话（官方音色）、能看屏、能聊天、会换装，全部免费。

---

## 一、这是什么

本项目 fork 自 [ochiru520/Mio](https://github.com/ochiru520/Mio)（Windows 个人 AI 桌宠），在其基础上：

- **保留原版 Live2D 桌宠能力**：PixiJS + Cubism 4 渲染、拖拽、右键菜单、模型加载/切换、说话口型与表情联动、多屏移动。
- **去掉原版臃肿功能**：Agent 工作台、QQ 对话、原版付费模型供应商等与桌宠无关的界面与链路已阉割。
- **接入小智官方免费云**：通过小智的免费 test-token 通道（`wss://api.tenclass.net/xiaozhi/v1/`）实现：
  - 文字对话（长连接、免唤醒）
  - **官方音色语音**（云端 ASR→LLM→TTS，桌宠本体播放并同步口型）
  - **图片识别 / 屏幕观察**（官方视觉分析，纯文本气泡呈现，提示词可自定义）
  - 对话历史持久化与通信链路全可视化（MIO 管理窗口主聊天界面）
- **免费**：不填任何模型 API Key。视觉、语音、对话全部由小智官方免费云提供。

---

## 二、功能总览

| 能力 | 说明 | 入口 |
|---|---|---|
| 文字对话 | 长连接免唤醒，发送即答，官方音色语音播报 + 口型同步 | 桌宠右键「打开/关闭对话窗口」或双击桌宠 |
| 语音播放 | 云端 TTS 音频流，桌宠本体播放（防止多个窗口声音叠加） | 对话自动播放 |
| 图片识别 | 上传/粘贴图片 → 小智官方视觉分析 → 文本气泡（不唤醒、不复述） | 主聊天输入框 📷 / 横条对话框 📷 |
| 截图提问 | 截取屏幕任意区域 → 小智识别画面内容并吐槽 | 右键「截图提问」/ 全局快捷键 `Ctrl+Shift+S` |
| 屏幕观察 | 随机时间种子自动截屏，让桌宠点评你在做什么 | 桌宠管理 → 屏幕观察 |
| 模型管理 | 导入 Cubism 模型、切换形象、调整大小（80%~240%） | 桌宠右键「调整大小」/ 桌宠管理 |
| 对话历史 | 主聊天界面保存全部来往记录，重开不丢 | 打开 MIO → 主聊天界面 |
| 提示词配置 | 图片识别/屏幕观察的前置提示词可在线编辑 | 小智状态栏 →「提示词设置」 |
| 设备绑定 | 机器码（MAC 后 6 位）与连接状态实时显示 | 小智状态栏 →「机器码」 |

---

## 三、项目架构

```
┌───────────────────────────── 本地（你的电脑）─────────────────────────────┐
│                                                                          │
│  ┌─ 前端：Electron（澪Agent应用/live2d-desktop/main.js）──────────────┐  │
│  │  · 桌宠本体    live2d-pet（PixiJS + Cubism4 渲染 Live2D）          │  │
│  │  · 对话浮窗    xiaozhi-chat.html（横条快速输入 460×178）           │  │
│  │  · MIO 管理窗  /agent-app（私人空间主聊天 + 模型管理 + 屏幕观察）  │  │
│  │  · 截图选区    overlay.html（沉浸式区域选择）                      │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                              ▲ HTTP / WebSocket                          │
│  ┌─ 后端：FastAPI（私人AI日记系统/backend，端口 8000）────────────────┐  │
│  │  routes/xiaozhi.py：WS 长连接代理 / say / vision / observe /        │  │
│  │                     prompts / status（机器码）/ chat-history        │  │
│  │  routes/companion.py：截图 / 窗口拓扑 / 音频体检 / 桌宠状态          │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                              │ wss://api.tenclass.net/xiaozhi/v1/
                              ▼
┌───────────────────────────── 小智官方免费云 ─────────────────────────────┐
│  · ASR 语音识别  →  LLM 对话  →  TTS 官方音色（音频流下发）              │
│  · 视觉分析（vision/explain HTTP 端点，返回文本）                        │
│  · test-token 通道，无需付费 API Key                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键设计（踩坑后定型的架构决策）：**

1. **音频只在桌宠本体播放**：对话窗（role=chat）只收文本，音频由桌宠（role=main）播放，从根上避免"多窗口声音叠加"。
2. **图片识别纯文本气泡**：官方视觉端点只返回文本（协议如此，官方 API 签名即 `char* out_buf`）。分析结果直接显示气泡，**不注入对话、不本地 TTS、不复述**——避免唤醒词/拜拜/音色不对等副作用。
3. **长连接免唤醒**：后端保持一条到官方云的长连接（`ping_interval=None`，官方协议无心跳，禁用库 ping 以兼容官方 LB），重连自动且静默（不进主聊天刷屏）。
4. **角色机制级解耦**：官方 STT 回传文本一律不写"你说"历史，"你说"只来自浏览器真实输入，"她说"只来自 AI 输出，杜绝信息错乱。
5. **前端直接改 dist 产物**：原版是 Vite 构建的压缩 SPA，本项目采用"dist 即源码"方式直接修改压缩产物（`node --check` 校验），不再走构建流程。

---

## 四、目录结构

```
C:\Users\xiao1\Mio
├── 澪Agent应用\                    # 前端
│   ├── live2d-desktop\             # Electron 主进程（窗口/菜单/快捷键/截图）
│   │   ├── main.js                 # 4 个窗口 + 托盘菜单 + 全局快捷键 + 副屏边界
│   │   └── preload*.js             # 各窗口安全桥
│   ├── dist\                       # 构建产物（本项目直接修改的"源码"）
│   │   ├── index.html              # MIO 管理窗口入口（/agent-app）
│   │   ├── assets\                 # SPA 分片（index-*.js 主入口、ChatPage 对话页等）
│   │   ├── xiaozhi-chat-inject.js  # 主聊天图片暂存注入（📷 + 粘贴）
│   │   └── live2d-pet\             # 桌宠本体
│   │       ├── live2d-pet.js       # 渲染/右键菜单/模型/气泡/小智事件
│   │       ├── pet-xz-audio.js     # 小智音频流解码播放 + 口型同步
│   │       ├── overlay.html        # 截图选区覆盖层
│   │       ├── xiaozhi\xiaozhi-chat.html/.js  # 横条对话浮窗
│   │       ├── models\             # Live2D 模型（导入模型放这里）
│   │       └── libs\               # pixi / cubism4 渲染库
│   └── src\ public\ desktop\ scripts\   # ⚠ 原版上游源码与发布工具链（运行时不用，可后续精简）
│
├── 私人AI日记系统\backend\         # 后端（FastAPI）
│   ├── app\main.py                 # 应用入口（挂载全部路由）
│   ├── app\routes\xiaozhi.py       # ★ 小智核心：WS 代理/say/vision/observe/prompts/status
│   ├── app\routes\companion.py     # 桌宠状态/截图/窗口/音频体检
│   └── requirements.txt             # 后端依赖
│
├── start_mio.ps1                   # ★ 一键启动（后端 + Electron，脱离控制台）
├── xiaozhi_device.json             # 小智设备身份（mac_address + client_id）
├── xiaozhi_prompts.json            # 图片/观察提示词配置
├── xiaozhi_chat_history.json       # 对话历史持久化（运行数据）
├── status.json                     # 运行状态（运行数据）
├── SRC-MAP-源码地图.md              # 界面导航手册（改代码先看它）
└── _mio_orig\                      # 上游原版发布备份（只读参照）
```

---

## 五、从零开始上手

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

**① 创建设备身份**：在小智控制台（https://xiaozhi.me/console）注册/登录，按官方文档创建设备，取得设备的 `mac_address` 与 `client_id`，写入项目根目录 `xiaozhi_device.json`：

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

**③ 绑定状态可视化**：打开 MIO 管理窗口 → 右侧「小智状态栏」，可实时查看连接状态、会话 ID、机器码与完整 MAC。

### 3. 启动桌宠

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File start_mio.ps1
```

脚本自动完成：启动/检测后端（uvicorn :8000）→ 拉起 Electron 桌宠窗口。所有子进程以 `CreateNoWindow` 方式启动，**关闭启动终端不影响桌宠运行**（启动窗口会自动关闭）。

**开机自启**：运行 `私人AI日记系统\工具\安装开机自启动.ps1`（写入注册表 `HKCU\...\Run` → `Mio桌宠自启动`）。

### 4. 日常使用

**桌宠右键菜单：**

| 菜单项 | 作用 |
|---|---|
| 打开/关闭对话窗口 | 横条快速输入浮窗（460×178），回复由桌宠气泡+语音呈现；点「历史记录」打开主聊天 |
| 调整大小 | 滑条调整桌宠尺寸（80%~240%） |
| 截图提问 | 截取屏幕 → 小智识别 → 气泡显示分析（全局快捷键 `Ctrl+Shift+S` 可框选区域） |
| 隐藏说话气泡 | 切换气泡显示 |
| 打开 Mio | 打开 MIO 管理窗口（主聊天界面） |
| 关闭桌宠 | 退出桌宠 |

**MIO 管理窗口（主聊天界面）：**
- 与小智的所有来往记录（你说/她说/系统状态）实时同步，历史持久化；
- 输入框支持文字、图片（📷 选择 / 直接粘贴，图片先暂存再发送）；
- 右侧「小智状态栏」：连接状态、机器码、提示词设置；
- 「模型管理 / 屏幕观察 / 体检」在桌宠管理页。

**导入新模型**：把 Cubism 3/4 模型目录放进 `澪Agent应用\dist\live2d-pet\models\`，然后在桌宠管理页切换形象。

### 5. 常用后端接口

| 接口 | 作用 |
|---|---|
| `WS /api/xiaozhi/ws?role=main\|chat` | 小智官方云长连接（main=桌宠播音频，chat=对话窗收文本） |
| `POST /api/xiaozhi/say` | 文字对话（写历史 + 注入官方音频流） |
| `POST /api/xiaozhi/vision` | 图片识别（纯文本返回） |
| `POST /api/xiaozhi/vision-bubble` | 截图提问/屏幕观察（分析文本广播到桌宠气泡） |
| `GET /api/xiaozhi/chat-history` | 会话历史 |
| `GET /api/xiaozhi/status` | 连接状态 + 机器码 |
| `GET/PUT /api/xiaozhi/prompts` | 提示词配置读写 |
| `GET/POST /api/xiaozhi/observe/status\|start\|stop` | 屏幕观察任务 |
| `GET /api/companion/status` | 桌宠状态 |
| `POST /api/companion/screen-shot` | 截屏 |

---

## 六、常见问题

| 问题 | 说明 / 处理 |
|---|---|
| 对话/图片识别没声音 | 官方视觉端点**协议上只返回文本**（不附带音频）；音频只能来自对话链路 TTS。当前设计为图片识别走文本气泡，对话语音正常。 |
| 经常断连重连 | 官方免费云会对空闲连接主动断开（1005）。本项目已禁用协议层 ping（官方无心跳协议），重连自动静默进行，不影响使用。 |
| MIO 管理窗口显示旧界面（红点角标） | Electron 缓存了旧页面。管理窗口每次打开前自动清缓存；若仍异常，确认 URL 版本参数已更新（`?v=...`）。 |
| 桌宠跑到副屏找不回来 | 桌宠支持跨屏任意位置（含副屏顶格），拖拽即可拉回；多屏边界由 `live2d-desktop/main.js` 按真实显示器拓扑处理。 |
| 模型加载失败 | 确认模型目录在 `dist\live2d-pet\models\` 下且为 Cubism 3/4 格式（`.model3.json`）。 |
| 启动脚本报错 | 统一用 `pwsh` 执行；确认 `.venv` 与 `node_modules` 已安装（见第五节）。 |

---

## 七、参考项目与小智资源

### 参考/上游仓库

| 仓库 | 用途 |
|---|---|
| [ochiru520/Mio](https://github.com/ochiru520/Mio) | 本项目上游：Mio 桌宠（Electron + Vue + FastAPI） |
| [pixijs/pixijs](https://github.com/pixijs/pixijs) | Live2D 渲染底层（WebGL 渲染器） |
| [guansss/pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | Live2D 模型加载/渲染/交互库 |
| [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) | 小智官方固件（协议/握手/音频帧参照） |
| [78/xiaozhi-esp32-server](https://github.com/78/xiaozhi-esp32-server) | 小智服务端实现（视觉/LLM/TTS 管线参照） |
| [huang-jun-sen/py-xiaozhi](https://gitee.com/huang-jun-sen/py-xiaozhi) | 官方 PC 客户端参考实现 |

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

## 八、开发守则（改代码必读）

1. **改界面** → 先查 `SRC-MAP-源码地图.md` 确定文件；dist 内压缩分片用 Python 精确字符串替换 + `node --check` 校验。
2. **改后端** → 改 `routes\` 对应文件，`python -m py_compile` 校验；小智逻辑全在 `xiaozhi.py`。
3. **改完必做**：语法校验 + **git commit**（本地仓库防写坏，每个功能点一次提交）。
4. **改了前端文件记得升 URL 版本参数**（`?v=...`），否则 Electron 缓存不刷新。
5. 运行数据（`xiaozhi_chat_history.json` / `status.json` / 日志）不参与功能逻辑的删除操作。

---

## 九、更新记录

详细的逐次改动记录见 `CHANGELOG.md`（含每次提交的根因与方案）。本项目所有改动均以本地 git 提交管理。
