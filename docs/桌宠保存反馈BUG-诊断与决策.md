# 桌宠保存反馈 BUG · 诊断与决策

> 对齐对象：另一 AI 在 `CompanionPage-D7yDEAW1.js` / `PetAppearancePanel-CAsGsCDg.js` 上的进行中工作区改动（未提交）。
> 本文为**只读静态取证**（未改动任何文件），用于与其方案对齐后决策。
> 取证时间：2026-10-16 00:30 ｜ 基线：工作区（HEAD = 960fce50 + 未提交改动）

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 方案 3（常驻 div + display）写法对不对？ | **对**。patchFlag / dynamicChildren / props 白名单 / provide 全链已静态验证通过 |
| 失败在渲染层吗？ | **大概率不是**。渲染数据链无断点 |
| 那真·根因在哪？ | **`saveCompanionSettings` 里一段手工插入的 `await Ba()`** —— 它在 PATCH 之前，一旦不返回即整函数永挂 |
| 反馈状态有几个写入端？ | **2 个**（App 的 `saveCompanionSettings` + CompanionPage 的 `onSave`）→ 双写，应收敛 |
| 推荐决策 | **A 的第一步（验证方案 3）→ 立刻转 C（清插桩）→ 停止在 dist 上继续加功能，转源码回仓** |
| 不建议 B 的原因 | 回滚会丢掉**已验证的真·功能修复**（绕开永挂的 `saveCompanionSettings`） |

---

## 1. 渲染链静态验证（逐环节结论）

### 1.1 子组件读的是 inject，不是 props

`PetAppearancePanel-CAsGsCDg.js`：

```js
setup(m,{emit:x}){
  let _ctx=null; try{_ctx=iv(`mio-companion-page`)}catch(_x){_ctx=null}
  function _fb(){
    try{ let _s=_ctx&&_ctx.settingsFeedback; return _s?(_s.value||_s):m.feedback }
    catch(_e){ return m.feedback }
  }
```

`feedback` 这个字面量在全文件只出现 **1 次**（props 声明），渲染里的 6 处取值全部走 `_fb()`。
→ 即**绕过 props，直接从 `provide` 通道读**。两条通道各自都是通的（见下），所以不是断点，但属于**冗余的第二数据通路**，建议后期收敛到单通道。

### 1.2 provide 字段在位

`index-BBVquePX.js`（App 层）：

```js
oe(`mio-companion-page`, p({
  activeCompanionSection:Mi, companionAvatarUrl:xl, companionBusy:Ss, companionStatus:ac,
  … pullLocalVisionModel:G, saveCompanionSettings:nr, saveCompanionSize:Qn,
  … importLive2DModel:zzzMaoImport, deleteLive2DModel:zzzMaoDelete, replaceLive2DPreview:zzzMaoSave,
  settingsFeedback:Fi }))
```

- `settingsFeedback:Fi` **在**，`Fi` 就是 App setup 里那个 ref（`e.settingsFeedback.value=…` 用的同一个）✓
- `p` 无论解析为 `reactive`（ref 自动解包）还是普通包装，`_fb()` 的 `_s.value||_s` 两种形态都兼容 ✓
- 注意 `zzzMaoImport` / `zzzMaoDelete` / `zzzMaoSave` —— **这是提交 `f30140c6` 手工插入的自定义标识符**，说明整个 provide 对象是**人工拼装**的，非编译器产物。

### 1.3 父组件 props 白名单含 feedback

`CompanionPage-D7yDEAW1.js`：

```js
o(),te(ie,{key:0,status:…, busy:…, "management-mode":`1`, onSave:…, onSaveSize:…,
           onManage:…, feedback:R.settingsFeedback}, null, 8,
  [`status`,`avatar-url`,`display-name`,`busy`,`management-mode`,`onControl`,
   `onImportLive2d`,`onDeleteLive2d`,`onReplaceLive2dPreview`,`onPreviewMotion`,
   `onPreviewExpression`,`onSelectLive2d`,`onSaveSize`,`feedback`])
```

patchFlag `8`(PROPS) 的动态白名单里 **`feedback` 在末位** ✓ → `shouldUpdateComponent` 会因它变化而放行更新。

### 1.4 方案 3 的渲染代码结构正确

```js
f(`div`,{key:2,style:{padding:`10px 0 0`,fontSize:`13px`,fontWeight:600,
  display:(m.busy||(_fb()&&_fb().section===`pet`))?``:`none`,
  color:m.busy?`#8a8f98`:(_fb()&&_fb().type===`success`?`#2e7d32`:`#c62828`)}},
  [f(`span`,null,m.busy?`保存中…`:(_fb()&&_fb().message||``),1)],4)
```

| 检查项 | 结果 |
|---|---|
| 是否结构翻转（v-if 三元） | **否** —— 元素常驻，只切 STYLE，无分支翻转 |
| patchFlag | `4` = STYLE（外层）/ `1` = TEXT（内层 span）✓ |
| dynamicChildren 索引是否稳定 | **稳定** —— 每次 render 都创建同样的 span+div，无条件增减 |
| 是否有 `v-if` 注释占位 | 「v-if」字面量出现 **0** 次（方案 1/2 已清干净）✓ |
| 是否 section 的无条件末位子节点 | **是** —— 代码以 `…],4)]))}}` 结束，反馈 div 是 children 数组最后一员 |

**推论**：方案 3 生效时，DOM 里**必然**出现一个第 5 个子 div（初始 `display:none`），且**不应有**该位置的 `<!---->` 注释。
→ 若验证后仍看不到该 div、且仍见 `<!---->`，说明**渲染根本没执行到这段代码**，应优先怀疑**观察对象错位**（见 §4）。

---

## 2. 真·根因：被绕过的 `saveCompanionSettings` 为什么永挂

### 2.1 现场代码（`index-BBVquePX.js`）

```js
if(t===`pet`){
  try{
    let _fs = await Ba()                                    // ← 挂在这里
    let _fm = (_fs.pet||{}).settings||{}
    _fm.live2d_model_id && (a.live2d_model_id = _fm.live2d_model_id)
  }catch(_fe){}
}
e.companionStatus.value = await e.request(`/api/companion/settings`,{method:`PATCH`,body:JSON.stringify(a)})
```

`_fs` / `_fm` / `_fe` 这套下划线前缀命名与 `onSave` 里的 `_set` / `_body` / `_st` / `_ps` 同源 —— **都是手工插入到压缩产物里的代码**，不是编译器输出。

### 2.2 `Ba` 是什么

```js
var Ba = () => X(`/api/companion/status`)     // X = apiRequest
```

所以 `await Ba()` = 一次 **GET `/api/companion/status`**，位置在 PATCH **之前**。

### 2.3 为什么"永久 pending"

`apiRequest` 本身**带 AbortController 死线**：

```js
function X(e,t={}){
  let{deadlineClass:n=Ii(e,t.method), timeoutMs:r=Fi[n]||Fi.mutation, …}=t
  let c=new AbortController(), l=``, u=null
  …
  Number(r)>0 && (u=setTimeout(()=>{ c.signal.aborted||(l=`deadline`,c.abort(`deadline_exceeded`)) }, Number(r)))
```

即：**只有当 `Number(r) > 0` 成立时才会挂死线**。若 `deadlineClass` 推导出的 key 在该表里缺失（`Fi[n]` 与 `Fi.mutation` 双缺）→ `r = undefined` → `NaN > 0` 为假 → **不挂死线** → 后端若不响应即**无限等待**。

这条与既往记录吻合：项目里 `/api/companion/status` 一直有"请求挂起"病史，另一 AI 最近的提交正是在给它加自愈（`companionStatusLoading` 超 8s 强制复位、`busy` 超 10s 强制清）。

**结论**：症状「`saveCompanionSettings('pet')` 返回的 Promise 永久 pending、`.then()/.catch()` 一次未跑、而直接 `fetch(PATCH)` 能到网络」——**与"卡在 `await Ba()`"完全自洽**，且直接 fetch 恰好绕开了它。

**但注意**：绕过它是**治标**。真正的两个问题是
1. 为什么这次 GET 不返回（后端 status 端点阻塞？还是死线表缺 key 导致无超时？）
2. 这段"先 GET 拿 live2d_model_id 再 PATCH"的手工注入逻辑，本应在源码层用 `saveCompanionSettings` 内的预读去实现

---

## 3. 架构气味：反馈状态有两个写入端

| 写入端 | 位置 | 写法 |
|---|---|---|
| App `saveCompanionSettings`（原设计） | `index-BBVquePX.js` | 写 `Fi`（ref），并写 dataPrivacy 等其它 section |
| CompanionPage `onSave`（手改注入） | `CompanionPage-D7yDEAW1.js` | `_set()` → `R.settingsFeedback` |

同一个状态被两处写，且**两处对"该写哪个 ref"的判断方式不同**：

```js
// CompanionPage onSave 内部
let _f = R.settingsFeedback;
_f && _f.value ? (_f.value = _v) : (R.settingsFeedback = _v)
```

这个"`.value` 有则写 `.value`、无则整体赋值"的双分支，说明**手改时并不确定 `R.settingsFeedback` 是 ref 还是已解包对象**。
（静态推演：两种形态最终都能触发响应式 —— 前者命中 reactive 的 ref 替换分支，后者直接改 ref。所以**这不是当前 bug 的原因**，但它是明确的技术债。）

**建议**：反馈文案是**桌宠管理页的 UI 关注点**，其写入端应**只保留一处**。推荐保留 App 层（`saveCompanionSettings` 内统一写），CompanionPage 只读。这样也能顺带修掉 §2 的根因 —— 一处改，两处（数据+渲染）同时正确。

---

## 4. 若方案 3 验证失败：优先怀疑"观察错位"

`PetAppearancePanel` 在**两个地方**被渲染：

| 宿主 | provide `mio-companion-page` | `_fb()` 走哪条路 |
|---|---|---|
| `CompanionPage` 的 `pet-panel`（桌宠管理页） | **有** | inject 通道 |
| `SettingsPage` 的桌宠 tab | **无** | 回退 `m.feedback`（**若那边没传 feedback，则永远空**） |

再叠加 `management-mode: '1'`（父组件确实传了管理态），模板里可能还有其他条件分支。
所以「section 直系子节点 HEADER+DIV×4 + 末尾 `<!---->`」这个观察，**很可能来自另一个实例或另一个分支**。

**验证判据（三选一即可定位）**：
1. 方案 3 生效后，DOM 里应出现**第 5 个子 div**且初始 `display:none`；顺手 `document.querySelectorAll('section > div').length` 对比。
2. 直接对反馈 div 加一个可辨识的 `data-*` 属性，然后再查 DOM —— 有则说明渲染成功、之前查的节点不对。
3. 在渲染函数入口打一次 `window.__BR.push(...)`，确认**该实例的 render 是否被调用过**。

---

## 5. 决策建议

### A / B / C 逐项评估

| 选项 | 评估 |
|---|---|
| **A. 继续攻（先验证方案 3）** | ✅ **低成本、先做**。§1 已静态证明其结构正确，跑一次即可判定；失败也有明确判据（§4）。但**「继续攻」到此为止** —— 不要在 dist 上再展开下一轮渲染改法 |
| **B. 回滚到干净版，反馈文案先不做** | ❌ **不建议**。会把**已验证的真·功能修复**（绕开永挂的 `saveCompanionSettings`）一并丢掉，得不偿失 |
| **C. 先清插桩，保功能，再决定** | ✅ **必做，但排在 A 之后**。清完再验证等于重做一遍 |

### 推荐节拍

**第一步（先做，约十几分钟）**
1. 原样跑一次方案 3 → 按 §4 三条判据确认
2. 通过 → 进入第二步；不通过 → 用 §4 判据定位观察错位，**不再新增渲染改法**

**第二步 · 清插桩（C）**
- `CompanionPage-D7yDEAW1.js`：`window.__SET_SEEN` **3 处** + `onSave` 里的 `_set` 闭包 / `_body` / `_st` / `_ps` 临时变量全部换成正常写法
- `PetAppearancePanel-CAsGsCDg.js`：`_fb()` 的 `_ctx` 双通道收敛为单通道（建议直接用 `m.feedback`，因为 props 白名单已含它）
- 清理 `pet-data/_verify/` 下 20+ 探针脚本与 `chrome-profile/`
- 更新 `SRC-MAP-源码地图.md` 中已过期的行（`xiaozhi-history-panel.js`、注入脚本路径）
- 跑 `node 澪Agent应用/scripts/clean-dist.mjs`（应 A/B/C/D 全 0）+ `node 澪Agent应用/tests/e2e_stream_pet.cjs`

**第三步 · 把反馈写入端收敛到 App 层**
即让 `saveCompanionSettings` 承担反馈状态写入，CompanionPage 只读 → 顺带消除 §2 根因（并保留 `live2d_model_id` 预读逻辑，只是搬回它该在的位置）。

**第四步 · 停止在 dist 上加功能，转源码回仓**
见 `docs/Vue源码回仓可行性评估.md`。本轮 BUG 是那份评估的最强论据：
- 一个"反馈文案显示不出来"的 UI 问题，最终根因落在**一段手工注入的 `await`**上；
- 另一个 AI 为此已写 20+ 探针脚本、试了 3 轮渲染写法；
- 而这两个文件（`CompanionPage.vue` / `PetAppearancePanel.vue`）**恰好就在待回写的 3 个 `.vue` 清单里**（共 19 个提交中的 11 个）。

---

## 6. 未验证 / 待确认

| 项 | 状态 |
|---|---|
| `Fi`（超时表）里是否缺 `deadlineClass` 推导出的 key → 导致无死线 | **未验证**，需运行时读 `Fi` 内容 |
| `/api/companion/status` 后端是否真的阻塞 | **未验证**，需查后端 `routes/companion.py` 该端点实现 |
| `p` 是 `reactive` 还是普通包装 | 未取到别名定义；**两种情形静态推演均成立**，不影响结论 |
| 方案 3 实跑结果 | **待测**（另一 AI 被中断的那一步） |
