# Vue 源码回仓可行性评估

> 目的：在 fork 仓库交给 DSH「创造模式」改造之前，把 `澪Agent应用/src`（Vue 源码）恢复回仓、打通 `vite build`。
> 本文只做**可行性取证与方案设计**，不含实施。
> 取证时间：2026-10-16 ｜ 基线：`HEAD = 960fce50`

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 源码还在吗？ | **在**。`git show eb520213^:澪Agent应用/src` = 108 文件 / 1.02 MB，是 **0.3.1 完整上游源码** |
| 它是不是当前 bundle 的构建源？ | **是**（工具链版本逐字段吻合，见 §2.3） |
| 能重建吗？ | **能**。`package.json` + `vite.config.js` 都在历史里，`npm i && vite build` 即可 |
| 重建产物 == 现状？ | **否**。`eb520213` 之后有 **112 个提交**的前端改动**直接写在压缩 chunk 上**（"dist 即源码模式"），src 里没有对应 |
| 回仓 = 直接覆盖吗？ | **否**。需要「恢复 src + 把 19 个提交的 chunk 改动逆向回写进 3 个 `.vue`」 |
| 工作量可控吗？ | **可控**。改动**只集中在 3 个 `.vue` 文件**（ChatPage / CompanionPage / App），而非全量 |
| 最大风险 | `vite build` 默认 `emptyOutDir` **会清空整个 dist**，连带删掉 `core-inject/` `kernel/` `plugins/` `live2d-pet/` 全部注入层 |

**一句话**：源在、工具链在、落差面窄；真正的工作量是「按 19 条提交的业务意图重写 3 个 Vue 组件」，而不是"逐字节逆向压缩代码"。

---

## 1. 现状架构解剖（先搞清 dist 是什么）

当前 `澪Agent应用/dist/` 由**三个互不相干的层**拼成：

| 层 | 内容 | 文件数 | 是不是 vite 产物 | 回仓是否受影响 |
|---|---|---|---|---|
| A. `assets/` | Vue 编译产物（主 bundle、页面 chunk、图标 chunk、CSS） | 22 | ✅ 是（但被手改过） | ⚠️ 会被重建覆盖 |
| B. `core-inject/` | 手写 DOM 注入层（重建设置页 38 KB、泡泡工坊 43 KB、rail 16 KB、体检 12.8 KB…） | 7 | ❌ 否，纯原生 JS | ✅ 不受影响 |
| C. `kernel/` + `plugins/` | 前端微内核 + 插件包（registry / nav / xiaozhi / dsh / octop manifest） | 8 | ❌ 否，纯原生 JS | ✅ 不受影响 |
| D. `live2d-pet/` | 桌宠独立渲染端（原 `public/live2d-pet/`，vite 原样拷贝） | 242 | ❌ 否，等于源码 | ✅ 不受影响 |

**关键事实**：本项目 `eb520213..HEAD` 共 **159 个提交**，各层改动分布：

| 层 | 改动提交数 | 说明 |
|---|---|---|
| `dist/assets/` | **19** | 唯一需要逆向回写的部分 |
| `dist/core-inject/` | 9 | 原生 JS，天然可维护 |
| `dist/live2d-pet/` | **53** | 独立渲染端，天然可维护 |

即：**新功能几乎全走 B/C/D 三层（原生 JS），只有"必须改页面内部逻辑"时才动 A 层**。这是回仓成本低的结构性原因。

---

## 2. 证据链

### 2.1 src 的定位与规模

```
$ git ls-tree -r --name-only "eb520213^" -- 澪Agent应用/src | wc -l
108
$ git ls-tree -r -l "eb520213^" -- 澪Agent应用/src | awk '{s+=$4} END {print s}'
1069225        # ≈ 1.02 MB
```

构成：`App.vue`(128 KB) + `components/*.vue`(25 个) + `composables/*.js`(17 个) + `services/*.js`(15 个) + `styles/*.css`(11 个) + 15 个 `*.test.js`。

**该目录的完整提交历史只有 6 条**，且前 5 条全是上游 release，第 6 条是删除：

```
eb520213 瘦身第1批:…删除澪Agent应用src(原版Vue源码)/public/desktop/vite.config.js/…
d92d0089 Release 0.3.1: model removal, UI and monthly record fixes
43a6011e Release 0.3.0: signed updates, memory corrections and task recovery
f1cf1f22 补齐桌面依赖安装修复
faa01adc 发布 Mio 0.2：独立 Agent、工作流工具与可靠性优化
7c9f7962 Prepare Mio v0.7.0 preview for GitHub
```

→ **项目自身从未改过 `src`，全部开发都在 `dist` 上**。

### 2.2 删除动作原文（`eb520213`，2026-10-12）

> 瘦身第1批:删除原版构建源与发布链+上游备份
> 1)git rm _mio_orig(120MB上游备份,含回收站垃圾,git历史可回溯)
> 2)**物理删除顶层node_modules(83MB,vite构建依赖,dist即源码模式不再构建)**
> 3)删除澪Agent应用src(原版Vue源码)/public/desktop(原版发布工具链)/vite.config.js/启动预览.ps1/构建Windows应用.ps1/顶层package.json
> 5)保留scripts(后端agent_control_scripts_dir引用system_audio/genie_tts/so_vits worker)

"**dist 即源码模式不再构建**" —— 这是整个问题的起点：源码删除 + 后续所有前端改动只能写进编译产物。

### 2.3 工具链版本逐字段吻合（判定 src 就是构建源）

`eb520213^:澪Agent应用/package.json` 与当前 `澪Agent应用/package.json` **完全一致**：

```json
"engines": { "node": ">=22.12.0" },
"scripts": { "dev": "vite --host 127.0.0.1", "build": "vite build",
             "preview": "vite preview --host 127.0.0.1",
             "test": "node --test src/*.test.js" },
"dependencies": { "@lucide/vue": "1.28.0", "@vitejs/plugin-vue": "6.0.8",
                  "dompurify": "3.4.13", "marked": "18.0.7",
                  "vite": "8.2.0", "vue": "3.5.40" },
"overrides": { "nanoid": "3.3.18" }
```

`vite.config.js`（同步取回）：

```js
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: { port: 1420, strictPort: false, proxy: {
    '/api': localBackendProxy(), '/onebot': …, '/diaries': …, '/reviews': …,
    '/weekly': …, '/stats': …, '/static': …, '/agent-files': … } }
})
```

→ 后端代理口径（`/api` 走 127.0.0.1:8000、`base: './'` 相对路径）与当前部署方式一致，**构建配置可直接复用**。

### 2.4 阉割的真相：dist 层手工替换，未动 src

当前主 bundle `assets/index-BBVquePX.js` 里 9 个页面异步组件：

```js
ii=defineAsyncComponent(()=>import(`./ChatPage-DUGVoyFe.js`),      __vite__mapDeps([0,1,2,3,4]),…),
ai=…import(`./CompanionPage-D7yDEAW1.js`)…,
oi=…import(`./HomePage-BqZuefeX.js`)…,
si=…import(`./_trimmed-stub.js`),  __vite__mapDeps([12,1]),…          ← 阉割
ci=…import(`./_trimmed-stub.js`),  __vite__mapDeps([13,1,14,7]),…     ← 阉割
li=…import(`./_trimmed-stub.js`),  __vite__mapDeps([15,1,14,16,17,7,18,4,19]),…  ← 阉割
ui=…import(`./_trimmed-stub.js`),  __vite__mapDeps([20,1,21,9,10,3,18,4,22]),…   ← 阉割
di=…import(`./SettingsPage-DbPySwhB.js`)…,
fi=…import(`./_trimmed-stub.js`),  __vite__mapDeps([26,1,24,3]),…     ← 阉割
```

**判据**：`_trimmed-stub.js` **没有 hash 后缀** —— vite 输出必定是 `[name]-[hash].js`，故这 5 处是**人工替换**；而 `defineAsyncComponent` 的 9 个位置与源码 `App.vue:478-486` **逐一对应**：

| App.vue 行 | 组件 | bundle 现状 |
|---|---|---|
| 478 | `ChatPage` | ✅ 真实 chunk |
| 479 | `CompanionPage` | ✅ 真实 chunk |
| 480 | `HomePage` | ✅ 真实 chunk |
| 481 | `AgentHomePage` | ❌ → stub |
| 482 | `AgentRightRail` | ❌ → stub |
| 483 | `AgentSettingsPage` | ❌ → stub |
| 484 | `RecordsPage` | ❌ → stub |
| 485 | `SettingsPage` | ✅ 真实 chunk |
| 486 | `TasksPage` | ❌ → stub |

被阉割页面 = **AgentHomePage / AgentRightRail / AgentSettingsPage / RecordsPage / TasksPage**（5 个）。
配套改动：删除对应原 chunk、新增 `_trimmed-stub.js`(254 B) / `_trimmed-stub.css`(51 B)、`save-D7rMjPJ0.js` 一并移除。

**结论**：阉割是**在 dist 上手工做的，src 保持完整** —— 这意味着恢复 src 后重建，能拿回**阉割前的 20 页面完整版**。

### 2.5 被"当源码维护"的 chunk（回仓的真正成本所在）

`eb520213^ → HEAD` 的 assets 差异：

```
ChatPage-DUGVoyFe.js           |  2 +-
CompanionPage-D7yDEAVz.js      |  2 +-
PetAppearancePanel-CAsGsCDg.js |  2 +-
index-BBVquePX.js              | 10 +++++-----
index-CnRrRFJT.css             | 18 +++++++++++++++++-
5 files changed, 25 insertions(+), 9 deletions(-)
```

（minified 单行文件，任何改动都表现为"整行替换"，stat 无法反映行数）

**手改痕迹的硬证据**：`ChatPage-DUGVoyFe.js` 是标准 rollup 压缩输出（`import{A as e,D as t,…}from"./createLucideIcon-…"`），但其中夹杂**未压缩的模板字符串**：

```js
//`+location.host+`/api/xiaozhi/ws?role=chat`)}catch{Je();retu
```

→ 压缩产物里不可能出现可读的 `location.host` 拼接，**这是手工插入的代码**。

**另一处痕迹**：`CompanionPage-D7yDEAVz.js`(eb520213^) → `D7yDEAW1.js`(当前) 只差尾部 2 位（`Vz`→`W1`）。真正的 vite 内容 hash 变更会整串改变，**只改尾 2 位是手工改名刷缓存的手法**。

**历史支持**：提交 `da1ca024` 原文 —— "④**自研前端关键文件强制入库 git 管理（dist/assets/对话页/注入脚本等）**"；`ChatPage-DUGVoyFe.js` 有 **10+ 个功能性提交**，且提交信息直接使用 `Ja` 导航分支、`K&&chat` 这类**压缩后变量名**，证明维护者在**读改压缩代码**。

---

## 3. 回仓的真实工作量

`eb520213..HEAD` 中动过 `dist/assets/` 的提交：**19 个**（占 159 个总提交的 12%）。按业务线归并后落到 **3 个 `.vue` 文件**：

| 业务线 | 提交 | 落到 |
|---|---|---|
| 小智对话历史（逐句显示 / id 去重 / 图片文本 / 轮询） | `0b8731f3` `be1049bd` `e9128f8d` `3a26ab01` `02d97ba7` `e8ba8563` | **`ChatPage.vue`** |
| 桌宠模型管理 UI 搬运（导入/删除/封面/动作/表情预览） | `f30140c6` `45c45cc7` `152c4925` `23b91cc0` `b302d27b` `9320c844` `0f5bc008` `e4df5cd7` | **`CompanionPage.vue` + `PetAppearancePanel.vue`** |
| busy/loading 卡死自愈 | `960fce50` `ad6ed541` | **`CompanionPage.vue`** |
| select-live2d emit / 切模型不被覆盖 | `694eaac0` `79d2dde5` | **`CompanionPage.vue` + `App.vue`** |
| 前端插件包目录化 P3a | `3c54f512` | — 与 Vue 源码无关（dist 分层，在 B/C 层已独立） |

**优势**：这 19 条提交信息写得极详细（含根因、含 `_load`/`Ja` 等定位锚点），可以用「**按业务意图重写**」而非「逐字节逆向」的方式落地。这是把不可读的 minified diff 转成可执行任务的关键。

---

## 4. 实施方案（分阶段）

### 阶段一 · 打通构建管线（低风险，推荐立即做）

```bash
# 1) 恢复源码与构建配置（package.json 已在仓，无需恢复）
git checkout eb520213^ -- 澪Agent应用/src 澪Agent应用/vite.config.js

# 2) 装依赖 + 基线重建（隔离目录，不动 dist）
cd 澪Agent应用 && npm i && npx vite build --outDir dist-build
```

**验收标准（决定性）**：`dist-build/assets/` 应产出与现存**同名同 hash** 的 chunk：

```
ChatPage-DUGVoyFe.js   CompanionPage-*.js   HomePage-BqZuefeX.js
SettingsPage-DbPySwhB.js   index-BBVquePX.js   createLucideIcon-CoqYpl-V.js
```

若 hash 一致 → **铁证 `eb520213^` 的 src 就是原构建源**，阶段二可信；若不一致 → 说明构建源曾另有其人，需重新评估。

阶段一完成后仓库即具备"**能改 `.vue` 且能构建**"的能力（页面逻辑暂时停留在上游 0.3.1 版本）。

### 阶段二 · 逆向回写 19 个提交

按 §3 的五个分组逐组做，每组流程：

1. `git show <sha> -- 澪Agent应用/dist/assets/<chunk>` 取 minified diff
2. 用提交信息里的业务意图 + diff 里的**可读字符串**（API 路径、中文文案、模板串）定位源码对应位置
3. 改写 `ChatPage.vue` / `CompanionPage.vue` / `PetAppearancePanel.vue` / `App.vue`
4. 重建 → 跑 E2E 对照 → 提交

### 阶段三 · 构建管线加固（与阶段一并行，必做）

⚠️ **最高风险**：`vite build` 默认 `emptyOutDir: true`，会**清空整个 dist 目录**，连带删除 `core-inject/` `kernel/` `plugins/` `live2d-pet/`（约 250 个文件、手写注入层 + 桌宠渲染端）。

修法：构建输出隔离到 `dist-build/`，再用一个组装脚本合并：

```js
// 建议 scripts/compose-dist.mjs
// 1. 清空 dist/assets/          2. 拷贝 dist-build/assets/* → dist/assets/
// 3. 用模板重生成 dist/index.html（保留 13 行注入 script 标签）
// 4. 绝不触碰 core-inject/ kernel/ plugins/ live2d-pet/
```

`dist/index.html` 当前含 **13 个手工注入的 `<script>` 标签**（`?v=` 版本参数用于刷缓存），vite 重建会整份覆盖 → 必须由模板重新生成，否则注入层全线失效。

### 阶段四 · 阉割重做（可选）

若仍需阉割那 5 个页面，建议脚本化 `scripts/trim-pages.mjs`：自动替换 5 处 `defineAsyncComponent` 的 import 指向 + **重编号 `__vite__mapDeps`** + 生成 stub。比现在的手工改可靠（手工改正是上一轮"mapDeps 悬空 → MIME 报错"的根源）。

---

## 5. 风险与前置条件

| 风险 | 影响 | 处置 |
|---|---|---|
| `emptyOutDir` 清空 dist | 注入层 + 桌宠渲染端全丢 | 输出隔离到 `dist-build/`（阶段三） |
| `npm i` 需联网下载 vite/vue（约 50–100 MB） | 构建无法启动 | 已有 Clash 代理；必要时走镜像 |
| 并行会话正在改 dist | 回仓操作与并行改动冲突 | **回仓前两边停手**，或用 `git worktree` 隔离 |
| 当前工作区有 35 项未提交改动 | 直接操作会混淆基线 | 先处置未提交改动（§6） |
| 重建产物 ≠ 现状 | fork 后 UI 行为回退 | 阶段二逐组回写 + E2E 对照 |
| `models/hiyori/` 大小写问题（已知） | Linux 部署 404 | 回仓时顺手修（源码里改常量） |

---

## 6. 当前工作区未提交改动（回仓前必须处置）

```
 M .gitignore / CHANGELOG.md / README.md / docs/DSH桌宠深度融合技术方案.md
 D 发布/{Mao桌宠_v2,Mao桌宠_v3,Mio桌宠_v1}.zip          ← 我这侧：转出索引
 D 澪Agent应用/dist/assets/CompanionPage-D7yDEAVz.js    ← 并行会话：改名
?? 澪Agent应用/dist/assets/CompanionPage-D7yDEAW1.js
 M 澪Agent应用/dist/assets/{PetAppearancePanel-CAsGsCDg,createLucideIcon-CoqYpl-V,
                            index-BBVquePX,index-CnRrRFJT}.{js,css}
?? 澪Agent应用/dist/assets/_trimmed-stub.{js,css}        ← 阉割产物
 D 澪Agent应用/dist/assets/save-D7rMjPJ0.js
 M 澪Agent应用/dist/core-inject/{bubble-panel-inject,settings-panel-inject}.js
 M 澪Agent应用/dist/index.html
 M 澪Agent应用/dist/live2d-pet/{index.html,live2d-pet.js,pet-random-image.js,
                                pet-sound.js,pet-xz-audio.js,xiaozhi-plugin.js}
 D 澪Agent应用/dist/xiaozhi-history-panel.js
 M 私人AI日记系统/backend/app/{agents/dsh/*,companion/companion_service.py,
                              kernel/agent_bus_service.py,routes/companion.py}
?? 澪Agent应用/scripts/clean-dist.mjs
?? 澪Agent应用/tests/
```

→ **阉割产物与 chunk 改名目前都还在工作区**。建议先落到一个提交（或按 my/other 双侧分开提交），使回仓基线干净，再启动阶段一。

---

## 7. 建议

1. **回仓值得做，且应排在 fork 之前第一位** —— 它直接消解 §7.2 记录的最高优先风险「fork 出去也改不动前端」。
2. **先做阶段一**（src 回仓 + 基线重建 + hash 对照验证），成本低、风险低、信息量大：一次 hash 对照就能确认整条路径是否成立。
3. **阶段二按业务线分批**，而不是按时间序逐个提交逆推 —— 同一 `.vue` 的多条提交应一次重写。
4. **阶段三不可省**：不做输出隔离，第一次 `vite build` 就会抹掉 `live2d-pet/` 242 个文件。
5. 阶段一到三完成后，方可 fork 给 DSH「创造模式」。
