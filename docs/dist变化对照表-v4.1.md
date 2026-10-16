# dist 变化对照表（v4.1 回仓产物 vs 原 M0 手改版）

> 用途：供**人工验证页面效果**时对照。本次 `dist/` 由 Vue 源码重建（M2 回仓产物），
> 不再是「手工编辑的 minified 产物」。本表列出变了什么、为什么变、该看什么。
> 生成日：2026-10-16

---

## 1. 一句话总览

`dist/assets/` 从 **21 个** → **19 个**：所有 chunk 的 hash 都变了（源码重建必然），
其中 **7 个**是业务改动（含 2.1 小智），其余是分块归属差异（图标 chunk 合并）。

---

## 2. 关键 chunk 对应关系

| 组件 | 旧（M0 手改版） | 新（v4.1 源码重建） | 说明 |
|---|---|---|---|
| **对话页** | `ChatPage-DUGVoyFe.js` | `ChatPage-cv0cyJqK.js` | ★ **小智 2.1 主改动**（15161 → 20164 字节） |
| 桌宠管理页 | `CompanionPage-D7yDEAWz.js` | `CompanionPage-DYzzRR_x.js` | 2.2/2.3 回写 |
| 外观面板 | `PetAppearancePanel-CAsGsCDg.js` | `PetAppearancePanel-Rn6sJ16q.js` | 2.2/2.4 回写 |
| 首页 | `HomePage-BqZuefeX.js` | `HomePage-DhbJtI8j.js` | 分块差异 |
| 设置页 | `SettingsPage-DbPySwhB.js` | `SettingsPage-DLaPSgtm.js` | 分块差异 |
| **入口** | `index-BBVquePX.js` | `index-DXsAeXiF.js` | 349,257 → 347,744 字节（−1513） |
| **样式** | `index-CnRrRFJT.css` | `index-WPT0_GRB.css` | 285,667 → 279,422 字节（−6245） |

---

## 3. 变了哪些文件（业务原因）

| # | 文件 | 变化原因 |
|---|---|---|
| 1 | `ChatPage.vue` | ★ 2.1 小智对话历史：接管消息区/输入区、历史轮询、WS、音频帧 |
| 2 | `CompanionPage.vue` | 2.2 体检页/管理模式/刷新回传 + 2.3 切模型事件 |
| 3 | `PetAppearancePanel.vue` | 2.2 模型管理 + 2.4 反馈三态 |
| 4 | `App.vue` | 2.3 busy 10s 自愈 / 状态加载 8s 自愈 + 2.4 单一反馈写入端 |
| 5 | `chat.css` | 新增 `.sys-msg` + `.xz-link-status` 系列（2.1） |
| 6 | 各图标 chunk | 分组归属变化（见 §4） |
| 7 | `index.html` | 由模板重生成（**14 个注入 script 标签原样保留**） |

---

## 4. 为什么 assets 少了 2 个（21 → 19）

源码是**完整 20 页**，重建会产出全部 chunk；`trim-pages` 按既定策略裁掉 5 个页面：

| 被裁 | 产出 |
|---|---|
| `AgentHomePage` / `AgentRightRail` / `AgentSettingsPage` / `RecordsPage` / `TasksPage` | 替换为 `_trimmed-stub.js`（+2 个 CSS stub） |
| 孤儿剪枝第二遍 | `creationApi` 与 `save` 只服务被裁页面 → 一并剪掉 |

**另外**：旧版有独立的 `archive` / `book-open` / `calendar-days` / `heart` 图标 chunk，
重建后这些图标被并入其他 chunk（rollup 共享模块图变化所致）——
**这是 §11.2 已预测并解释的现象，不是丢失**。

> 源码完整，5 个被裁页面想恢复：注释 `scripts/trim-pages.mjs` 对应条目后重跑 `npm run build:dist`。

---

## 5. 验证时该看什么（按优先级）

### 5.1 ★ 对话页（2.1 主改动）

打开 MIO 管理窗 → 左侧「对话」：

| 检查点 | 期望 |
|---|---|
| 历史记录 | 显示小智来往记录（后端现有 **909 条**，首载拉 1000 条） |
| **系统时间线** | 灰色居中文字（如「🎙️ 识别到：…」「🗣️ 小智开始说话…」）—— 这是新增的 `.sys-msg` 样式 |
| **连接状态** | 输入框右下角显示「小智已连接」（绿点）/「小智连接中…」（黄点）—— 新增 `.xz-link-status` |
| 输入框占位 | 「和小智聊点什么...」 |
| 图片消息 | 显示图片 + 附带文字（旧版曾丢文字） |
| 逐句显示 | 小智说话时逐句冒字（`pet_text` 事件），重开页面看完整历史 |

### 5.2 其他页面（我改动**未覆盖**，应保持原样）

- **桌宠页**：体检 tab、管理模式、模型导入/删除/封面/预览、保存反馈三态
- **设置 → 桌宠**：刷新按钮 + `✓ 已刷新`

### 5.3 桌宠渲染端（本次**未触碰**，242 文件）

气泡、音效、Live2D 动画应与之前**完全一致**。

---

## 6. 出问题时的回退

```powershell
# 回到 M0 手改版 dist（源码回写仍保留，随时可重建）
git checkout -- 澪Agent应用/dist

# 或重新构建
cd 澪Agent应用 ; npm run build:dist
```

---

## 7. 已知的显示噪声（非 bug）

| 现象 | 说明 |
|---|---|
| `clean-dist` 报 `D'` 悬空 1 项 | `live2d-pet/expressions/love.exp3.json` 属提示项，不计入问题 |
| 历史里的「重连/连接中断」 | 后端已用 `_syslog(quiet=True)` 不写入历史，前端仍有防御性过滤（实测 508 条 system 中 0 条命中） |
| E2E `[2]` 偶发失败 | 渲染端既有不稳定，与本次改动无关（已二分法证明） |
