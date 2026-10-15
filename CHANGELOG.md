# CHANGELOG · Mao 桌宠

> 项目从 Mio（ochiru520/Mio）深度改造而来，发布版命名 **Mao**。
> 所有改动均有本地 git 提交记录（`git log` 可追溯每次提交的根因与方案）。

---

## v3.10（2026-10-15）· A组渲染增强收尾（随机图片 / 泡泡图库 / 模块化泡泡）+ 启动链路加固

**主线**：DSH 融合方案 A 组（渲染层增强，对齐 whale-widget 体验）剩余三项全部落地；
顺带根治两个启动链路问题（venv 中文路径失效、宿主环境变量毒化桌宠进程）。

### A组 3.2 剩余：随机图片（对标 whale-widget #8）
- **后端**（`routes/companion.py`）：新增 `GET /api/companion/bubble-images`（列表）与
  `GET /api/companion/bubble-images/{name}`（图片本体），数据源 = 桌宠数据目录下
  `bubble-imgs/`——**用户把图放进去即生效，无需重启**；文件名白名单（图片扩展名）+
  越界拒绝，与 live2d_assets 的 `_safe_child` 同思路。
- **渲染端**（新文件 `pet-random-image.js`）：加权随机 + 不连续重复（与空闲自语同一
  策略）；自足图片泡泡（桌宠头顶锚点，9s 自动消失）；空闲自语排期 35% 概率改为
  展示图片泡泡（池子为空自动回退文本）。

### A组 3.3 剩余：泡泡图库（对标 #11）
- 新文件 `pet-bubble-styles.js`：8 款气泡皮肤（默认白/墨黑/靛蓝/蜜桃粉/抹茶绿/
  便利贴/终端绿/漫画描边）。机制与 DSH `data-agent-accent` 完全一致——只覆盖
  调色板变量，框/尾巴/投影全复用；插件身份色优先于皮肤。localStorage 持久化，
  右键菜单「泡泡样式」即点即换。

### A组 3.1：模块化泡泡系统（对标 #7，最大项）
- 新文件 `pet-bubble-modules.js`：**6 类模块**（status=跨 Agent 总线状态摘要 /
  quote=随机语句 / image=随机图片 / text=自定义文本 / clock / countdown），
  每模块独立开关、独立 accent（6 色循环）、独立坐标（**拖拽排版**，双击复位）；
  配置 localStorage，默认全关（不打扰）。
- 模块库面板（右键菜单「泡泡模块」）：开关即生效；text/countdown 内联编辑；
  status 模块随徽标事件实时刷新（12 态词汇，whale-widget 只有 4 态等待态——
  这是方案的代差优势项）。
- 3.5（Live2D 动作/表情 × 12 态）审计结论：`PHASE_TO_ACTIVITY`/`PHASE_MOTION_HINT`/
  `emotionParameters`(30+ 情绪)/`semanticMotion`(槽位映射) 已完整覆盖，无需改动。

### 启动链路加固（本次实跑发现的两个真问题）
- **`start_mio.ps1` venv 兜底**：venv launcher 在含中文的项目路径下读不了
  `pyvenv.cfg`（窄字符 API 按 ANSI 解析，报 `Cannot read '...??AI????...'`），
  起的是没有 fastapi 的裸系统 Python——后端永远起不来。现 15s 就绪探测失败即
  自动改用「系统 Python + venv site-packages(PYTHONPATH)」重拉（实测通过）。
- **`companion_service.start_pet` 环境防御**：从 WorkBuddy/IDE 宿主里启动后端会继承
  `ELECTRON_RUN_AS_NODE=1`，它让桌宠 electron.exe 以纯 Node 模式运行、瞬间退出且
  无日志。启动子进程前强制剥除该变量。

### 验证
- 后端路由：列表/取图 200（中文文件名编码正确）、越界 404、非法扩展 400；
- 4 个渲染端文件 `node --check` 通过；headless 渲染整页正常（模型 + 徽标 + 新脚本）；
- start_mio.ps1 完整链路实测：venv 失败 → 兜底启动 → 后端就绪 → 桌宠 WMI 拉起。

---

## v3.9（2026-10-15）· 模型切换 UI 断链修复 + 水印消除加固 + 工作区清理

**主线**：修掉"前端 UI 切模型永远回到大肥鱼"的状态覆盖断链，加固大肥鱼启动水印消除时序，
并完成一次工作区中间产物大清理与文档归位。

### 修复 1：前端 UI 切换模型不生效 / 应用后回退大肥鱼
- **根因（证据链）**：模型卡片点击 → `CompanionPage.He` → `PATCH /api/companion/settings
  {live2d_model_id}` 本身是通的（curl 实测 config + runtime.json 均正确持久化）。断点在
  **切换成功后 store 的 `companionStatus.pet.settings` 从不回读**：
  1. 设置页 3s 轮询走 `Xn({preserveSettings:true})`，加载器用**内存里的旧 settings 对象**
     覆盖新 status 的 settings（`i.pet.settings=t`），过期值被永久冻结；
  2. 面板卡片高亮 `$e()` 以 `G.value.live2d_model_id`（=冻结的旧值）比对 → UI 永远高亮大肥鱼；
  3. 点"应用"→ `saveCompanionSettings('pet')` 按 `companionSettingKeys.pet`（**含
     `live2d_model_id`**）整包 PATCH 冻结的旧值 → 刚切好的模型被**热切换回大肥鱼**。
- **修复（两处独立兜底）**：
  - `CompanionPage-D7yDEAVz.js` `He()`：PATCH 成功后立即把新 model_id 写回
    `R.companionStatus.value.pet.settings.live2d_model_id`（store 上下文已确认暴露该 ref），
    卡片高亮即时纠正、后续"应用"不再携带过期值；
  - `index-BBVquePX.js` 保存函数：`t==='pet'` 分支在构建 payload 后**强制用服务端最新
    `live2d_model_id` 覆盖**（`await Ba()` 取 /api/companion/status）——即使还有第二条
    陈旧标签页等路径，"应用"也永远以服务端为准。
- **验证**：PATCH `mao-sakiko-10002` → config/runtime.json 双写正确；PATCH 回 `da-feiyu` 恢复；
  `node --check` 两个 bundle 通过；后端 API 全链路实测。

### 修复 2：大肥鱼初始化水印（时序加固）
- e9e3278f 已修相对 URL 解析抛错（headless 实测水印已消失）；本次消除**首帧竞态**：
  - `loadModel` 改为 `await applyWatermarkRemoval(definition)`——模型可见前水印参数已生效；
  - `applyWatermarkRemoval` 在构建参数表后**立即同步置参一次**（不再等下一帧 ticker /
    expression 淡入），`updateModelPerformance` 每帧保持逻辑不变；
  - `live2d-pet/index.html` 版本号 a7→a8。

### 附带：DSH 插件身份色（上一会话完成未提交的收尾）
- `agent_bus_service.py`：`AgentState`/`register` 支持 `accent`（插件自声明身份色），随
  `agent_phase`/`agent_bubble` 透传——桌宠窗口不加载插件注册表也能正确着色；
- `dsh_adapter.py`：DSH 声明靛蓝 `#4F6BED`；自检补 4 条 accent 链路断言
  （`dsh_adapter_selftest.py`）。

### 工作区清理 + 文档归位
- 移出仓库（可回收于 `C:/Users/xiao1/.workbuddy-trash/mao-v3.9-cleanup/`）：
  `_dsh_src/`(11M)、`_research/`(3.7M)、`workspace_patch/`(3.9M，仅剩 2 个活跃 uvicorn
  日志被占用保留)、pet-data 调试残留 30 个（rail_check*.html / srv_* / chat-dom*.txt /
  探针截图等）、`私人AI日记系统/backend/` 15 个 8 位随机名测试残留；
- `.gitignore` 新增：`pet-data/Live2D桌宠/`、`pet-data/pet-instance/`、backend 8 位随机
  临时文件、`xiaozhi_observe.json`、`uvicorn_v2*.log`——运行时数据留盘不入库；
- 文档归位 `docs/`：`桌宠性能根因分析.html`、`DSH桌宠深度融合技术方案.md`、
  `技术需求与现状分析-桌宠音频对话链路.md`；v3.5 引用路径同步更新。

---

## v3.5（2026-10-15）· 性能优化收尾 + 语音完整播放修复

**主线**：桌宠性能问题（跟随不灵敏、拖动卡顿漂移）的 P0 方案落地，同时根治两个体验问题——
Agent 面板覆盖不退出、小智语音"没讲完就结束"。

### 性能优化（P0 方案，穿透去重 + getBounds 收敛）
- **主进程穿透判定状态去重**（`live2d-desktop/main.js`）：新增 `setMainWindowIgnoreMouseEvents(ignore)`
  记录 `lastIgnoreMouseEvents`，**仅状态翻转时才调用** `setIgnoreMouseEvents`——根除此前
  "120ms 轮询 + 无条件调用"导致的**高频 hit-test 切换打断 pointer 事件流**（拖动时 `getBounds`
  高频刷新、鼠标流被反复打断是"拖动卡顿漂移"的直接原因）。
- **渲染层 getBounds 收敛**（`dist/live2d-pet/live2d-pet.js`）：三个每帧调用的 `getBounds()`
  加节流——`updateLockControlAnchor` 80ms、`updateSpeechBubblePosition` 100ms、
  `updateAgentBadgePosition` 80ms；新增 `force` 参数，只在**真正需要立刻刷新**的场景强制
  更新（fitModel / 打字机每字符 / 拖动结束 `finishPointerInteraction` / 徽标显隐 / 双击复位），
  拖动路径 `getBounds` 调用量从约 180 次/秒降到约 12 次/秒。
- **背景**：性能退化调查（2026-10-14 提交链 `8a9c5aa7`→`f2f51fd4`→`7581c6bc`→`c613bc80`）
  发现交互链路从"渲染层 mousemove 实时驱动"退化为"主进程 120ms 轮询 + 无条件穿透刷新"，
  详见 `docs/桌宠性能根因分析.html`（v3.9 起文档统一收进 `docs/`）。

### 修复
- **Agent 面板打开后按其他页面仍被覆盖**（`dist/agent-switch-inject.js`）：补齐与设置面板
  一致的"点击其他导航 `button.nav-item` 即收起"捕获监听——打开 Agent 页后点任意其他页面
  自动收起，不再需要手动点右上角 ✕。
- **小智语音"总是结束得很快、没讲完"**（`dist/live2d-pet/pet-xz-audio.js`）：
  - 根因：官方音频帧（PCM）与 `tts state=stop` 文本在同一 WS 保序到达，但前端 `pump()`
    会把到达的帧**排程到未来播放时刻**（批量/网络缓冲时超前更多），stop 一到就无条件
    `stopPlayback()` 把已排程未播完的尾部音频全部截断 →"没讲完"。
  - 修复：`tts stop` 改为 **drain 模式**——不再立即停止，等已排程音频自然播完后
    （`activeSources`/`playQueue` 清空）再停口型、复位说话状态；口型随 analyser 能量自然归零；
    新一段 `tts start` 仍立即打断旧音频（保证打断/换句正常，不串音）。
- **徽标状态更新延迟排查**（结论性诊断，未改代码）：全链路即时——渲染层 WS 事件直驱、
  后端 `publish→gather` 直推、总线 phase 变化即时发布（300ms 节流仅限同 agent 同 phase 重复）；
  用户感知的延迟主要来自 **DSH 徽标的会话日志尾随（架构性，实测约 200ms~1.5s，DSH 写盘节奏支配）**，
  小智徽标链路无延迟点。

### 模型内置改造（鲸鱼娘 / 大肥鱼 → 内置模型）
- **模型入库**：把「DeepSeek娘(鲸鱼娘)」（原外部导入 `model-1a11f9ad3f7`）与「大肥鱼」（原 `大肥鱼-2`）迁入内置目录
  `澪Agent应用\dist\live2d-pet\models\`（新目录 `whale-deepseek` / `da-feiyu`），随仓库 git 分发、克隆即用；
  迁移时剔除 `.mio-render-cache`、`items_pinned_to_model.json`、`.大肥鱼.mio-render-2048.model3.json`、
  `大肥鱼.vtube.json` 等运行时产物；旧外部导入副本已从 `pet-data\Live2D桌宠\models\` 移除（避免重复显示）。
- **默认模型**：`companion_service.py` 设置默认 `live2d_model_id` 由 `hiyori` 改为 `whale-deepseek`（DeepSeek娘）；
  本地 `runtime.json` 迁移为 `da-feiyu`（保持用户当前选择的大肥鱼）。
- **前端注册**：`live2d-pet.js` `builtInModels` 登记两个模型（含 44 / 15 个表达式、口型/眨眼参数、motionSlots、
  expressionSlots），大肥鱼"13 水印消除"表达式自动触发去水印；`index.html` 版本参数 bump 为 `v=20261015-models`。
- **后端识别**：`companion_service._builtin_live2d_models()` 扫描内置目录时读取 `mio-model.json`
  （name / preview / capabilities / 授权提示），内置模型显示正确中文名与来源；`live2d_assets._write_live2d_runtime_selected`
  放开为可用模型全集（含内置 id），内置模型切换后 runtime 记录不再落空。
- **分区显示**：桌宠管理页「模型」列表与桌宠页形象列表按 `imported` 分区为「内置模型（随项目分发）」与
  「外部导入（仅本机）」两区，内置区不显示删除/封面管理（不可删），外部导入区保留删除 / 换封面。

### 工程
- 前端文件版本参数统一为 `v=20261015-*`（live2d-pet.js `calmfocus`、pet-xz-audio.js `drain`、
  live2d-pet.css `phasecolors`）。

### 验证
- `node --check` 通过（main.js / live2d-pet.js / pet-xz-audio.js / agent-switch-inject.js）；
  文件 BOM（EF BB BF）与 CRLF 行尾保留；git diff 干净可追踪。

---

## v3.4（2026-10-15）· 语音引擎切换 + 桌宠表现强化

**主线**：本机 SAPI 语音引擎损坏导致语音全挂，切换 edge-tts 并做预合成缓存；同时强化桌宠
表现（视线跟随、表情兜底、徽标着色、启动定位稳定）。

### 语音引擎（SAPI → edge-tts）
- **fix(tts)**：本机 SAPI 引擎损坏（`0x80045040` 全语音失败，疑似 10/01 系统更新导致），
  改用 **edge-tts 微软在线 TTS（晓晓音色）**：合成 16k mono WAV + opus 转换测试通过，
  本地播放与官方 ASR 注入链路恢复，不再依赖损坏的 Windows 语音引擎。
- **perf(tts)**：**edge-tts 预合成缓存**——后端启动后台预热全部视觉/观察触发语（10 条），
  wav + opus 双层 LRU 缓存，触发语注入从 2-3s 降到 0ms；重复文本零合成延迟。

### 桌宠表现
- **鼠标视线跟随**：主进程 16Hz 推送鼠标位置（`mio-desktop:mouse-move`）+ 渲染层
  `model.focus()`——桌宠眼睛跟随鼠标移动；穿透模式下渲染层收不到 mousemove，必须由
  主进程高频喂数据。
- **视线跟随幅度压缩**：跟随范围限制在模型周围区域，消除大幅转头/"多动症"。
- **表情恢复兜底**：找不到自然表情时重置默认表情。
- **Agent 状态徽标 12 态专属着色**：按 phase 全表着色（思考蓝/工具橙/语音金/错误红/
  等待审批紫/连接中灰蓝等，深底白字），连接中/异常单独色。

### 稳定与工程
- **fix: 桌宠启动跳位根治**：窗口虚拟边界修正完成前隐藏模型，修正后统一 `fit` 定位显示
  （`window-stable` 协议）；窗口稳定事件丢失时 10 秒兜底显示模型。
- **桌宠数据目录统一**：新增 `MIO_PET_STATE_DIR` 环境变量，后端 `live2d_assets.py` 与
  Electron `main.js` 解析到**同一个** "Live2D桌宠" 目录——修复此前
  `MIO_PROJECT_ROOT/Mao/pet-data` 拼错导致的空目录（后端读不到自定义模型、切角色静默失败）。
- **start_mio.ps1**：就绪探测改用 `/api/companion/agents`（纯读总线，稳定），不再用
  依赖 Live2D 资源与磁盘写入的 `/api/companion/status`（资源异常时返回 500 会误判后端未运行）。

---

## v3.3（2026-10-14）· 桌宠交互与性能优化

**主线**：解决桌宠卡顿与交互失灵两大问题，并强化状态显示（多 Agent 状态栏、水印消除、调大小面板）。

### 性能与交互
- **perf: 桌宠卡顿优化**（渲染降帧 + 后端轮询降频）：空闲 8s 自动降帧到 9fps、mousemove
  不再标记活动（CPU 占用 95% → 21.5%）；代价是 hover 时帧率受限（v3.5 已用穿透去重缓解）。
- **fix(pet): 交互失灵根因**：`--no-sandbox` 下渲染层鼠标事件转发（`{forward:true}`）失效，
  窗口永久穿透；改为**主进程轮询鼠标位置 + 渲染层上报模型区域/UI 状态**驱动穿透判定，
  不再依赖 forward 转发。
- **fix(pet): 拖动/菜单期间保持可交互**：`rendererInteractive` 参与穿透判断，
  `pointerup` 后恢复穿透上报。
- **ui: 调整大小面板整体可拖动**（标题区手柄 + pointer capture）；滑块样式优化。

### 状态显示与模型
- **Agent 状态徽标升级为多 Agent 状态栏**：每个 agent 一个状态 chip 实时并排显示、
  即插即用、停用即移除（v3.5 再加 12 态专属着色）。
- **模型自带水印消除表达式默认自动应用并每帧保持**（大肥鱼去水印）。

---

## v3.2（2026-10-14）· DSH 实时工作状态接入（真实事件摄取）

**主线**：把 v3.1 里只是"配置就绪占位"的 DSH 适配器，改成**真实事件驱动**——DSH 真的在
干什么，桌宠就实时演什么。接入后 DSH 能显示 v3.1 全部 12 个标准 phase。

### DSH 事件摄取（dsh_log_stream.mjs + dsh_adapter.py）
- **发现真实事件源**：DSH 把会话完整事件流持久化为**拼接式 Zstandard 帧**的 JSONL
  （`~/.dsh/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`）。每个追加批次一个独立
  zstd 帧，**不能一次性解压**，只能逐帧解。
- **新增零依赖 Node 边车** `dsh_log_stream.mjs`：逐帧解 zstd（`node:zlib` 自带）→ 解析
  DSH 官方 `SessionEvent` → 折叠成**客观事实 facts** → NDJSON 输出。之所以放 Node 侧：
  本项目 Python venv 无 zstd 绑定。协议细节（帧格式/事件字段）全部隔离在边车里，
  Python 只做 facts → phase 的策略映射，两边规则不重复实现。
- **会话选择**：优先"最近活跃的**主**会话"（`delegationDepth=0`），避免跟到 subagent
  子会话；带迟滞（2.5s）防止两会话来回抖动；附着时不回放历史事件（只发一条推导出的
  facts），否则桌宠会把几百条旧事件当实时状态闪一遍。
- **12 个 phase 全部注册**（真实事件驱动）：
  `turn/start`→planning、`step/start`/`llm/retry`→thinking、`tool/call`→executing_tool、
  `assistant/message`(text)→streaming、`ask_user_question`→waiting_input、
  `approval/asked`→awaiting_approval（未 decided）、`turn/end{completed}`→complete、
  `tool/result{isError}`/`turn/end{error|max-tokens|interrupted}`→error、
  进程退出→paused、无工作→idle、保活→heartbeat。
- **失败识别口径修正**：DSH 的失败标记是 `tool/result.data.message.isError === true`，
  **不是** `data.error`（实测 330 条 tool/result 全部带 `isError` 布尔，仅 2 条带 `data.error`）。
  且 error 只在"最近一个事件本身失败"时进入，后续进展事件立即恢复工作态——**失败不粘轮**。
- **如实的能力声明**：本版 DSH 无 TTS/语音合成服务（asar 内无 tts 包，官方 README 明确
  "no speech synthesis"），STT 转写提交后与打字产生的 `user/message` 完全不可区分，故
  `voice`/录音状态在 DSH 侧**不可观测** → `capabilities.voice=False`。适配器仍保留
  `voice` phase 与 `speak`/`tts` 工具映射，日后部署了此类工具即自动生效，无需改代码。

### 通道选型（实测，不靠猜）
- A/B 实测同一段时间两条通道：**Host WS `/api/remote.mux` → `session/follow`**
  p50 **10ms** / p90 78ms（含 `assistant-stream` 增量，但需凭据 cookie 签名 + 端口发现，
  端口为临时分配未持久化）；**会话日志尾随** p50 **215ms** / p90 237ms（无需鉴权、无需端口、
  DSH 重启不失效）。两者拿到的事件**完全一致**（同期各 12 条、seq 相同）。
- **结论**：取日志为主通道——215ms 远优于 300ms 节流窗口与人眼感知，且在最无依赖、
  最不易失效的一侧。WS 快通道留作后续可选加速项。

### 修复
- **`agent_bus_service.set_enabled` 未真正释放"身体"**：停用某 Agent 后 `enabled=False`、
  `phase=idle`，但 `active` 仍为 `True`、`active_agent_id` 仍指向它——快照里它依旧是
  "当前显示者"，桌宠看着像没停用（与 README 6.3/6.9 的"停用立即释放"契约相悖）。
  现修正为：停用时清 `active`、清 `_active_agent_id`，并把身体让给最近有活动的其它已启用
  Agent；`_decide_active_locked` 增加"已停用者绝不能占据身体"的硬门。
- **停用后重新启用不立即恢复**：改用当前 facts 补发一次状态（`_publish_facts(force=True)`），
  不必等下一个 DSH 事件；否则会停在 idle 直到 DSH 动一下。

### 验证（可复现）
- **自检 122/122 通过** `python -m app.dsh_adapter_selftest`：phase 映射全覆盖（含优先级
  冲突组合）、单事件映射、边车真实日志解码、**真实事件回放**（夹具由
  `app.dsh_fixture_build` 从真实会话日志脱敏抽取，84 步回放无异常且 phase 全合法）、
  **可达性断言**（枚举事实网格，断言 `phase_for_facts` 恰好产出 `DSH_FACT_PHASES` 10 个，
  且 `paused`/`heartbeat` 不由 facts 产出）、总线集成、**前端契约**（解析 `live2d-pet.js`
  内嵌的 `PHASE_LABELS`/`WORK_PHASES`，断言 12 个 phase 都有中文标签且工作态口径一致；
  已用变异测试证明该断言非空过）。
- **端到端** `python -m app.dsh_adapter_e2e`：轮询总线观测 DSH `online` 110/110 采样、
  全程 `active=True` 且 `active_agent_id=dsh`，`state` 带真实 `tool/turn/step/session`。
- **WS 链路** `python -m app.dsh_ws_check`：确认 DSH 的 `agent_phase` 确实经桌宠消费的
  `/api/companion/ws` 推送（25s 窗口 8~12 条，与 HTTP 快照 `active_agent_id=dsh` 一致）。
- **边界行为实测**：停用 → `active=False` 且身体让给小智；重新启用 → 立即恢复工作 phase；
  杀掉边车进程 → 14s 内自动重启并恢复 online；结构性损坏日志 → 去重报错并隔离，不再刷屏。
- **事件覆盖缺口分析** `python -m app.dsh_gap_analysis`：对照真实事件类型与折叠逻辑，
  列出未处理类型（当前 18 种、169 条，均为协议元数据/子会话/标题等无关类型）。
  此工具先报出"planning 不可达"，从而暴露并修掉了 `todo_write → planning` 的接线缺失。
- **排障接口**：新增 `GET /api/companion/agents/{id}/inspect`（`phase`/`bus_enabled`/
  `sidecar_alive`/`dsh_process_running`/`facts`/`phases`/`fact_phases`/`config_path`）。

### 文档
- README 第六章重写 6.4/6.5：新增 **6.5.1 DSH 接入**（事件→phase 对照表、失败口径、
  `voice` 不可观测的原因、通道选型实测表、配置字段表、自检命令）；6.4 补两条实战经验
  （Windows 下不要用 `asyncio.create_subprocess_exec` 起边车——走 overlapped 命名管道会
  `WinError 5`，改用 `Popen`+线程；区分 `xx_config.json.enabled` 与总线 `enabled` 两个层次）。

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
- **DSH 适配器**（dsh_adapter.py）：DeepSeek Harness 事件 → phase 映射（turn/step/tool/text/approval 状态机），配置即启用（**v3.2 已升级为真实事件摄取**，见上）
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
| Mao v3.0 | 设置与工具管理重构版：设置页重建、MCP 工具集中管理、完全自由拖拽 |
| Mao v3.1 | 跨 Agent 桌宠迭代：统一状态总线（12 phase）+ 小智/DSH/Octop 适配器 + Agent 管理页与状态徽标 |
| Mao v3.2 | DSH 实时工作状态接入（真实事件摄取，日志尾随通道 + Node 边车） |
| Mao v3.3 | 桌宠交互与性能优化：穿透架构根治、卡顿降帧、多 Agent 状态栏、水印消除 |
| Mao v3.4 | 语音引擎切换（edge-tts + 预合成缓存）、视线跟随、徽标 12 态着色、启动定位稳定 |
| Mao v3.5 | 性能优化收尾（穿透去重 + getBounds 收敛）、Agent 面板自动收起、小智语音完整播放修复 |
