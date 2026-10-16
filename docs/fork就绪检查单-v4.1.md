# fork 就绪检查单（v4.1）

> 生成日：2026-10-16 ｜ 对应版本：**v4.1（Vue 源码回仓 + 构建管线恢复）**
> 用途：接手方/fork 者按此单逐项确认「这个仓库能不能独立跑起来、改得动、测得了」。

---

## 1. 结论速览

| # | 维度 | 状态 | 依据 |
|---|---|---|---|
| 1 | **可构建** | ✅ | `npm ci && npm run build:dist` 全绿；构建隔离输出，`dist/` 注入层不受损 |
| 2 | **可测试** | ✅ | 单元 88 项 / 后端自检 184 项 / E2E 15 项（14 通过，1 项为既有不稳定） |
| 3 | **守卫可跑** | ✅ | `npm run guard` → A/B/C/D 全 0，mapDeps 自洽 |
| 4 | **文档一致** | ✅ | README 目录树含 `src/`；构建章节完整；CHANGELOG v4.1 有据 |
| 5 | **源码可改** | ✅ | `src/` 108 文件为真实构建源（G1 字节级证明） |

---

## 2. 环境要求

| 项 | 要求 | 备注 |
|---|---|---|
| OS | Windows 10/11 x64 | 桌宠壳为 Electron + Windows 特定能力（穿透/托盘/截图） |
| PowerShell | 7（pwsh） | `start_mio.ps1` / `安装依赖.ps1` 用 pwsh |
| Node.js | **≥ 22.12.0** | `package.json` 的 `engines` 约束 |
| Python | 3.10+ | 后端 FastAPI |

---

## 3. 首次跑通（三步）

```powershell
# 1) 安装全部依赖（自动检测 Python/Node → venv → Electron，约 5 分钟）
pwsh -NoProfile -ExecutionPolicy Bypass -File 安装依赖.ps1

# 2) 启动（后端 + Electron 一次拉起）
pwsh -NoProfile -ExecutionPolicy Bypass -File start_mio.ps1

# 3) 前端单独重建（仅当你要改 Vue 源码）
cd 澪Agent应用
npm ci                 # 严格按 lockfile；勿用 npm i（会漂移传递依赖）
npm run build:dist     # 构建 → 组装 → 阉割 → 守卫
```

---

## 4. 逐项验收（fork 前请全部跑一遍）

### 4.1 可构建

```powershell
cd 澪Agent应用
npm ci
npm run build
```

**期望**：
- 产物只出现在 `dist-build/`（约 27 个文件）
- **`dist/` 文件数不变**（构建前后都应是 278 左右）
- `dist/index.html` 哈希不变

> ⚠ 若 `dist/` 被清空 → 说明 `vite.config.js` 的 `build.outDir` 被移走了，
> **立即停止**并用 git 恢复该配置。`dist/` 里 257 个手写注入层文件不在构建产物里，丢了要重新 clone。

### 4.2 可测试

```powershell
cd 澪Agent应用
npm test                                  # 期望 88 通过 / 0 失败
npm run guard                             # 期望 A/B/C/D 全 0

# 后端自检（期望 184 通过 / 0 失败）
cd ..\私人AI日记系统\backend
python -m app.agents.dsh.dsh_adapter_selftest

# 渲染端 E2E（期望 14~15 通过；失败项见 §5）
cd ..\..\澪Agent应用
npm run e2e
```

### 4.3 可重建 dist（完整管线）

```powershell
cd 澪Agent应用
npm run build:dist
```

**期望**：`dist/assets` 最终 **19 个文件**，`clean-dist` 报「全部通过」。

### 4.4 文档一致

- [ ] `README.md` 目录树含 `src/`、`vite.config.js`、`scripts/`
- [ ] `README.md` 有「前端开发与构建」章节
- [ ] `CHANGELOG.md` 有 v4.1 章节
- [ ] `SRC-MAP-源码地图.md` 的注入脚本路径与 `dist/` 实际一致

---

## 5. 已知问题（不阻塞 fork，但请知悉）

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | E2E 用例 `[2] 气泡内容被新流替换` 偶发失败 | 无（渲染端既有不稳定，非本版引入） | 已二分法证明与 v4.1 无关；换入旧版渲染端失败更严重（0/8） |
| 2 | **Node `fs.rmSync` 在本仓 `dist/` 下静默失效** | 高（会让构建管线"假装成功"） | 环境层限制；**绕过：用 `Move-Item` 移出旧文件**，并靠 `npm run guard` 的 C 项复核 |
| 3 | `clean-dist` 报 `D'` 悬空引用 1 项（`live2d-pet/expressions/love.exp3.json`） | 无 | 属「其他目录」提示项，不计入问题；修复 `hiyori` 大小写后已从 2 降到 1 |
| 4 | 5 个被裁页面的策略（`trim-pages`） | 中（影响可裁剪范围） | 见 §6 |

---

## 6. 被裁页面清单（`trim-pages.mjs` 的策略）

以下页面在 `dist/` 中被裁成 `_trimmed-stub.js`（源码 `src/` 里**完整存在**）：

| 页面 | 说明 |
|---|---|
| `AgentHomePage` | Agent 首页 |
| `AgentRightRail` | Agent 右栏 |
| `AgentSettingsPage` | Agent 设置 |
| `RecordsPage` | 记录页 |
| `TasksPage` | 任务页 |

> **想恢复这些页面**：删掉/注释 `scripts/trim-pages.mjs` 的对应条目，重跑 `npm run build:dist`。
> 源码完整，无需回填任何代码。

---

## 7. fork 后的建议动作

1. **改包名/标识**：`澪Agent应用/package.json` 的 `name`（当前 `mio-agent-app`）。
2. **改后端端口**（若冲突）：`私人AI日记系统/backend` 的 `settings`（默认 8000）。
3. **勿入库的内容**：`xiaozhi_device.json`（设备身份，已忽略）、`pet-data/`（运行时数据）、
   `dist-build/`（构建中间产物）、`node_modules/`。
4. **素材许可**：代码 MIT 可 fork；Live2D 模型素材请按 `THIRD_PARTY_NOTICES.md` 如实标注 as-is。
5. **改界面前先读** `README.md` 的「前端开发与构建」章节 —— 那里写了 `dist/` 的双成分与改动纪律。

---

## 8. 版本历史说明（重要）

| 版本 | 内容 | tag |
|---|---|---|
| **v4.1** | **Vue 源码回仓 + 构建管线恢复**（本版，fork 起点） | 待打（提交后） |
| v4.0 | A 档收口：泡泡/音效归主体 + M1 逐 token 流式 | **尚未打 tag**（CHANGELOG 已写，能力已在 HEAD 中） |
| v3.12 | 泡泡交互重构 | ✅ |

> ⚠ **v4.0 的 tag 缺失**是历史遗留：其内容已写入 CHANGELOG 并已合入代码，但漏打 tag。
> 建议后续补打 `v4.0` 指向写入该章节的提交（`d4f3b295`），以闭合版本历史。
