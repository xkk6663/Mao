# CHANGELOG · Mao 桌宠

> 项目从 Mio（ochiru520/Mio）深度改造而来，发布版命名 **Mao**。
> 所有改动均有本地 git 提交记录（`git log` 可追溯每次提交的根因与方案）。

---

## v3.1（2026-10-14）· 跨 Agent 桌宠迭代

**主线**：桌宠定位升级为**跨 Agent 的"脸"**——后端统一状态总线 + 可插拔适配器（小智/DSH/Octop），桌宠只认标准 phase，即换即用无需重启。

### 跨 Agent 统一状态总线（agent_bus_service.py）
- **12 个标准 phase**：idle/planning/thinking/executing_tool/streaming/waiting_input/voice/complete/error/paused/awaiting_approval/heartbeat
- **活跃聚焦调度**：按 phase 优先级决定"谁占据桌宠身体"（voice 最优先、idle 最低）；同 Agent 同 phase 300ms 节流；非活跃静默 8s 允许更高优先级抢占；`awaiting_approval` 借鉴 Paperclip 审批流
- **心跳在线检测**：适配器定期上报，超 30s 判离线并广播快照
- **启用状态持久化**：`agent_bus_config.json`（运行时生成，已 gitignore）

### 适配器层（可插拔，原生协议全部隔离）
- **小智插桩**（routes/xiaozhi.py）：`_xz_register/_xz_emit/_xz_status` 三 helper 全事件接入——hello→online+idle、goodbye→paused、MCP→executing_tool、STT→waiting_input、LLM→streaming、TTS→voice、TTS 结束→complete、断线→offline+paused；重连成功显式清除 error
- **DSH 适配器**（dsh_adapter.py）：DeepSeek Harness 事件 → phase 映射（turn/step/tool/text/approval 状态机），配置即启用
- **Octop 适配器**（octop_adapter.py）：TencentCloud Octop WS 事件 → phase 映射，配置即启用

### 渲染端与前端
- **phase → 表现映射**（live2d-pet.js）：PHASE_LABELS / PHASE_TO_ACTIVITY（speaking/responding/listening/idle）/ PHASE_MOTION_HINT（表情动作提示词）
- **Agent 状态徽标**：工作细分状态（思考/执行工具/回复/说话等）在桌宠头顶短暂展示 4 秒自动淡出；**连接/断连不显示**（消除小智重连闪烁）；右键菜单可开关（localStorage `mio_agent_badge_enabled`）
- **Agent 管理页**（agent-switch-inject.js）：导航项 + 状态卡片 + 能力标签 + 启用开关；停用 Agent 只显示"未启用"+配置引导
- **agents API**：`GET /api/companion/agents`（总线快照）、`POST /api/companion/agents/{id}/enabled`（即换即用）

### 接入新 Agent 的最小改动
- 新建适配器文件（照 dsh_adapter 骨架）→ `main.py` 后台任务注册一行 → 项目根 `xx_config.json` + gitignore；前端零改动（详见 README 第六章「Agent 接入指南」）

---

## v3.0（2026-10-13）· 设置与工具管理重构版

**主线**：设置界面彻底重建（弃用原版 Mio 设置体系）+ 本地 MCP 工具集中管理 + 桌宠完全自由拖拽，发布版 v3.0。

### 设置页彻底重建
- **弃用原版 Mio 设置 UI**：基础与启动 / 云端语音 / 本地音色 / GPT-SoVITS 等已删功能的遗留界面全部移除，不再渲染
- **新建内嵌设置面板**（`settings-panel-inject.js`），与主界面其余三界面（对话/桌宠/小智工具）框架完全一致：**桌宠 / 语音 / 屏幕观察 / 提示词 / 小智** 5 个 tab
- 数据源全部为已验证后端接口（`GET/PATCH /api/companion/settings`、`GET/POST /api/xiaozhi/observe/*`、`GET/PUT /api/xiaozhi/prompts` 等），保存真实生效
- **根治注入脚本运行中断**：`MutationObserver.observe(document.body)` 在 body 未解析时抛 TypeError 导致整脚本中断（此前一直误判为缓存/Vue 事件问题）；导航"设置"按钮接管改为隐藏原版按钮 + 原位插入自有按钮 + 保活强制显示

### MCP 工具集中管理（小智工具页）
- **本地免费 MCP 工具配置化**：system / 网络 / 时间 / 天气 / 记事本等 15 项本地工具，开关持久化，`tools/list` 按开关过滤、`tools/call` 分发，按需使用
- **小智工具管理页**（`mcp-tools-panel.js`）：与主界面框架一致的内嵌面板，打开即用，不再覆盖式浮窗
- 官方视觉 MCP 链路保持：`tools/call` → 官方 `/vision/explain` → 文本回灌官方 LLM → 官方 TTS 音色播报

### 桌宠拖拽完全自由
- **移除全部上下/水平限位**：任何方向自由拖拽，不回弹、不拉回、不限位，位置原样保存、重启原样恢复
- **修复 `/api/companion/position` 路由装饰器丢失**：瘦身时误删 `@router.patch("/position")`，导致拖拽保存一直 404、状态轮询把旧位置弹回

### 稳定性与体验
- 注入防阻塞三层：`conn.send` 5s 超时 + 注入整体 30s 超时自动释放锁 + 半死连接主动重置重连
- 对话文字随语音**逐句显示**（tts 分句实时推送聊天列表，不再等整句或消失合并）
- 自动观察设置持久化（`xiaozhi_observe.json`），重启不恢复默认
- 图片消息在历史中同时显示图片与附带文本；历史上限 1000 条
- 桌宠渲染采样恢复 2x，点对点清晰（内存优化不牺牲清晰度）

---


**主线**：图像识别（发图/截图提问/立即观察）全链路稳定闭环——官方小智视觉识别 → 文本回灌 → 官方音色语音，不再反复唤醒、不再卡死。

### 打通官方视觉 MCP 工具链路
- **官方 MCP 工具协议**：设备侧实现 MCP server（`initialize` / `tools/list` / `tools/call`），官方视觉 API（`/vision/explain`）识别文本作为 `tools/result` 回灌官方 LLM，由官方 LLM + TTS 产出官方音色语音（对照 `xkk6663/Harness_ESP32S31` 端侧人脸识别项目的实现）
- **触发语改为用户可编辑提示词**（`xiaozhi_prompts.json` 的 `image_prompt` / `observe_prompt`，管理面板可改），不再写死
- **每次发图/观察前强制断开重连重置官方会话**：修复"重启后第一张图必通、第二张起全失败"——同一官方会话内第一次工具调用后 LLM 认为图片已在上下文、后续指令不再调工具

### 注入链路防阻塞（卡死根治）
- **根因**：官方连接"半死"（TCP 活、应用层无响应，官方禁心跳无法感知）时 `conn.send` 永久挂起，占用注入串行锁 → 卡住后所有对话/观察/截图提问排队阻塞
- **修复三层**：`conn.send` 加 5s 超时；注入整体 30s 超时自动释放锁；发送失败主动重置半死连接触发重连
- 所有注入路径（对话/发图/观察/截图提问/自动观察/分段注入）统一走 `_inject_say`，全覆盖受益

### 修复
- **快速连续发图识别旧图**（"这张跟刚才那张是一样的呀"）：设置新暂存图时作废旧图副本；前端清空输入框后派发 `input` 事件同步 Vue v-model
- **长触发语导致官方不调工具**：官方 ASR 对长文本识别乱码 → LLM 不调工具；改用短触发语（识别场景 8s STT 确认）
- **发图 PNG 转 JPEG 上传**，修复"连不上"与误用上一张图
- 回滚 vision 无条件 abort（实测导致识别触发语却不调工具），恢复仅 TTS 播放中才中断

### 桌宠清晰度
- **渲染分辨率 1.5x → 2x 恢复**：内存优化曾把渲染采样降到 1.5x 导致桌宠变糊；恢复 2x 后点对点达到屏幕物理清晰（175% 缩放屏 = 1.75x）

---

**主线**：对话历史完整化 + 实时体验稳定化。自 v2.0 后累计 7 项修复/优化，全部本地 git 可追溯。

### 修复
- **小智回复文字缺失 / 图片附带信息缺失 / 历史不完整**：
  - 根因 1：上游 llm 事件 text 只有表情碎片（如 `😊`），完整回复在 tts 分句里——改为 tts 分句累积、`tts stop` 时拼接完整回复写历史（含 `global` 声明缺失修复）
  - 根因 2：历史文件 id 冲突导致前端按 id 去重误吞新消息——加载时按序重建单调唯一 id
  - 前端 ChatPage：图片消息同时显示图片+附带文本；重连时回填去重集合防重复；历史上限 500→1000
- **自动观察设置重启后恢复默认值**：配置持久化到 `xiaozhi_observe.json`，启动时恢复
- **打开 MIO 误触发一次观察**：后端启动时首次排程硬编码 20 秒——改为按用户设置间隔随机排首次
- **文字随语音逐句出现却消失/合并成整句**：分句改为独立气泡保留（逐句显示、不消失）；轮询按文本前缀匹配跳过已逐句显示的回复完整条目（会话内看逐句、重开看完整历史）
- **气泡偶尔飞到屏幕左上角**：模型切换/加载中 `getBounds()` 退化为 0,0——增加有效性保护，模型不可用时保持上次位置

### 优化
- **对话延迟**：tts 分句实时推送到聊天列表，文字随语音逐句冒出（不再等语音说完才显示）
- ChatPage 无缝衔接原版 UI 框架（恢复左侧会话抽屉 + 右上角跟随对话按钮），完整展示小智对话历史

---

## v2.0（2026-10-12）· 发布版 2.0

**主线**：可发布、可复现、稳定长挂机。项目更名 Mao，推向独立远程仓库。

### 新增
- **小智对话记录面板**（`dist/xiaozhi-history-panel.js`）：打开 MIO 管理窗口即自动显示，覆盖原版消息区。
  - 加载 `/api/xiaozhi/chat-history` 全部历史（你/小智/系统消息 + 图片缩略图）
  - WS `role=chat` 实时追加（llm/tts/sysmsg/error 状态）
  - 可直接发送文字（`/say`）与图片（`/vision`，暂存 + 粘贴）
  - 右上角 ✕ 关闭，右下角"小智对话"悬浮按钮重开
- **发布版脚本**：`安装依赖.ps1`（一键装依赖）、`打包发布.ps1`（生成 zip）、`start_mio.ps1` 路径相对化（`$PSScriptRoot`）
- 开机自启动键名更新为 `Mao桌宠自启动`

### 修复
- **图片分析双发**：根因 = 面板与原版注入脚本的全局粘贴监听都会暂存同一张图（双暂存 → 双发两次 `/vision`）。
  修复：面板打开时置 `window.__mioXzChatInjectPaused` 暂停原版注入的暂存/发送拦截；面板发送加 busy 锁。
- **图片分析结果未显示在桌宠气泡**：`/vision` 返回前广播 `speech-bubble` → 分析文本显示在桌宠旁气泡（6s 自动消失）。
- **锁定桌宠按钮消失**：按需创建优化误删了"非锁定模式的锁定入口"，恢复按钮常驻。
- **清理双后端混乱**：杀掉系统 Python 残留（119MB）+ 僵尸实例，统一 `.venv`。

### 优化
- 内存：渲染分辨率 2x→1.5x（WebGL 纹理 -44%）；空闲 30s 无交互自动降帧 12fps（交互/说话即恢复 60fps）；
  Electron 总内存 790MB → 650MB。
- 横条对话窗恢复"单条胶囊"形态（460×66）：去掉标题条/状态行/暂存条/历史按钮，状态提示并入 placeholder。

---

## v1.0（2026-10-08 ~ 2026-10-11）· 首个可用版本

**主线**：把开源 Mio 桌宠改造为"本地免费 Live2D 看板娘 × 小智官方免费云"。

### 核心能力
- 小智接入：test-token 通道长连接、文字对话、官方音色语音（桌宠本体播放 + 口型同步）、免唤醒
- 图片识别 / 屏幕观察：官方视觉分析、提示词可配置（`xiaozhi_prompts.json`）、结果文本气泡
- 会话历史：`xiaozhi_chat_history.json` 持久化 + `/chat-history` 接口 + 截图提问/观察统一入历史
- UI 融合：原版私人空间对话页注入 📷 发图 + 粘贴暂存；左侧导航精简；桌宠管理页（模型管理/屏幕观察/体检）
- 全局快捷键 `Ctrl+Shift+S` 区域截图提问；沉浸式选区 overlay
- 模型：导入 Cubism 3/4 模型、切换形象、每日定时自动更换、口型/表情联动

### 修复（节选）
- 音频链路：官方视觉只返回文本（协议限制），改为文本气泡呈现，不本地 TTS
- 断连重连：禁用协议层 ping（官方无心跳），重连静默不进主聊天刷屏
- 角色解耦：官方 STT 回传不写"你说"历史，杜绝信息错乱
- 副屏显示、开机自启、横条输入等多项体验问题

---

## 上游对照

| 版本 | 说明 |
|---|---|
| ochiru520/Mio（上游） | 原版桌宠：Electron + Vue SPA + FastAPI，含 Agent 工作台/QQ 对话/付费模型等 |
| Mao v1.0 | 阉割原版无关功能，接入小智免费云（核心融合完成） |
| Mao v2.0 | 发布版：历史全可视化、双发/气泡修复、内存优化、更名 Mao、独立仓库 |
