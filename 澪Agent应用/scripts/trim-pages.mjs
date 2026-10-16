#!/usr/bin/env node
// ============================================================================
// trim-pages.mjs · 阉割上游被裁掉的 5 个页面（M3 构建管线加固）
// ============================================================================
//
// 背景：本项目的 dist 是「上游完整 20 页构建产物 + 手工阉割」的混合体。
// 被裁掉的 5 个页面（AgentHomePage / AgentRightRail / AgentSettingsPage /
// RecordsPage / TasksPage）在上游 src 里仍然存在，所以每次 `vite build` 都会
// 把它们重新产出来；本脚本负责把「阉割」这一步**脚本化**，替代过去的手工改。
//
// 过去手工改的坑（本脚本要根治的）：
//   手工替换 import 指向后，忘了同步 `__vite__mapDeps` 数组里的同名字符串 →
//   留下悬空引用 → 触发时后端 SPA 兜底返回 index.html → `import()` 报 MIME 错。
//
// 本脚本的做法（关键约束）：
//   ★ **不增删 `__vite__mapDeps` 数组元素、不改下标顺序**，只把被裁页面对应的
//     **字符串值**换成 `./_trimmed-stub.js` / `./_trimmed-stub.css`。
//     数组是按下标被 9 个 `__vite__mapDeps([...])` 调用引用的，增删元素会静默串位。
//
// 用法：
//   node 澪Agent应用/scripts/trim-pages.mjs            # 干跑（只核查，退出码 1 = 需要阉割）
//   node 澪Agent应用/scripts/trim-pages.mjs --apply    # 实际执行
//
// 前置：先跑 compose-dist --apply（dist/assets 已与 dist-build 同步）
// 收尾：跑 clean-dist.mjs 期望 A/B/C/D 全 0
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
// 默认作用于 dist/；可用环境变量 MIO_DIST_DIR 指向别处（便于在 dist-build 上安全试跑）
const DIST = process.env.MIO_DIST_DIR ? path.resolve(process.env.MIO_DIST_DIR) : path.join(APP, 'dist')
const ASSETS = path.join(DIST, 'assets')

const APPLY = process.argv.includes('--apply')

// 要阉割的页面（chunk 名前缀，与上游 App.vue 的 defineAsyncComponent 一一对应）
const TRIM_PAGES = ['AgentHomePage', 'AgentRightRail', 'AgentSettingsPage', 'RecordsPage', 'TasksPage']

const STUB_JS = '_trimmed-stub.js'
const STUB_CSS = '_trimmed-stub.css'

const STUB_JS_CONTENT = `// 上游被裁掉的页面占位。原 chunk 已随阉割移除，这里保证引用不悬空、
// 万一被触达也只是渲染空白，而不是拿到 index.html 触发 MIME 报错。
export default { name: "TrimmedStub", render() { return null } }
`
const STUB_CSS_CONTENT = `/* 上游被裁掉的页面样式占位（空）*/\n`

const info = (m) => console.log('  ' + m)
function die(msg) { console.error('✗ ' + msg); process.exit(2) }

console.log('='.repeat(72))
console.log('trim-pages · 阉割被裁掉的 5 个页面')
console.log('='.repeat(72))
console.log(`dist   = ${DIST}`)
console.log(`模式   = ${APPLY ? '应用（--apply）' : '干跑（默认，只核查）'}`)
console.log('')

if (!fs.existsSync(ASSETS)) die(`找不到 ${ASSETS}，请先跑 compose-dist`)

// 1) 从 dist/index.html 找入口 bundle
const distHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
const entryM = /<script[^>]*\bsrc="\.\/assets\/([^"?]+)/.exec(distHtml)
if (!entryM) die('无法从 dist/index.html 解析出入口 bundle')
const ENTRY = entryM[1]
info(`入口 bundle : assets/${ENTRY}`)

// 2) 扫描 dist/assets/ 找出被裁页面对应的真实 chunk 文件名
const allAssets = fs.readdirSync(ASSETS)
const targets = []
for (const page of TRIM_PAGES) {
  const re = new RegExp(`^${page}-[A-Za-z0-9_\\-]+\\.(js|css)$`)
  const hits = allAssets.filter((f) => re.test(f))
  if (!hits.length) { info(`  ${page.padEnd(20)} 未找到 chunk（可能已阉割）`) ; continue }
  for (const h of hits) targets.push(h)
}

console.log('')
console.log('— 待阉割 chunk —')
if (!targets.length) {
  console.log('  （无）—— 已经阉割过，无需处理。')
} else {
  for (const t of targets) info(`${t}  →  ./${t.endsWith('.css') ? STUB_CSS : STUB_JS}`)
}

// 3) 读入口 bundle，检查每个目标是否仍被引用
let src = fs.readFileSync(path.join(ASSETS, ENTRY), 'utf8')
const stillRef = targets.filter((t) => src.includes(`./${t}`))

console.log('')
console.log('— 入口 bundle 中的引用 —')
info(`入口里仍出现的被裁 chunk：${stillRef.length} / ${targets.length}`)

const needsWork = stillRef.length > 0
  || !fs.existsSync(path.join(ASSETS, STUB_JS))
  || !fs.existsSync(path.join(ASSETS, STUB_CSS))
  || stillRef.some((t) => fs.existsSync(path.join(ASSETS, t)))

console.log('')
if (!APPLY) {
  if (!needsWork) { console.log('✓ 已阉割（无需处理）。'); process.exit(0) }
  console.log('⚠ 需要阉割。加 --apply 执行。')
  process.exit(1)
}

// ------------------------------------------------------------ 执行阉割
console.log('— 执行 —')
let replaced = 0
for (const t of stillRef) {
  const stub = t.endsWith('.css') ? STUB_CSS : STUB_JS
  // 全局替换字符串字面量（反引号 / 双引号 / 单引号三种写法都覆盖）
  const before = src
  src = src.split(`./${t}`).join(`./${stub}`)
  if (src !== before) { replaced += 1; info(`已改写引用：./${t} → ./${stub}`) }
}
fs.writeFileSync(path.join(ASSETS, ENTRY), src, 'utf8')
info(`入口 bundle 已写回（改写 ${replaced} 处）`)

// 生成 stub
fs.writeFileSync(path.join(ASSETS, STUB_JS), STUB_JS_CONTENT, 'utf8')
fs.writeFileSync(path.join(ASSETS, STUB_CSS), STUB_CSS_CONTENT, 'utf8')
info(`已生成 ${STUB_JS} / ${STUB_CSS}`)

// 删除被裁 chunk（这些文件已无人引用）
let removed = 0
for (const t of targets) {
  const p = path.join(ASSETS, t)
  if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed += 1; info(`已删除 assets/${t}`) }
}
info(`共删除 ${removed} 个 chunk`)

// ------------------------------------------------ 第二遍：剪掉只服务被裁页面的 chunk
// 有些 chunk（如 creationApi / save）只出现在被裁组件的 __vite__mapDeps 里，
// 裁掉组件后它们就成了「只被预加载、永不被使用」的死重量。这里一并剪掉。
console.log('')
console.log('— 第二遍：孤儿 chunk 剪枝 —')
const compRe = /import\(`(\.\/[^`]+)`\),__vite__mapDeps\(\[([0-9,\s]+)\]\)/g
const comps = [...src.matchAll(compRe)].map((m) => ({ target: m[1], idx: m[2].split(',').map((n) => Number(n.trim())) }))
const liveIdx = new Set(comps.filter((c) => c.target !== `./${STUB_JS}`).flatMap((c) => c.idx))
const mdM = /__vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=(\[[^\]]*\])\)\)\)/.exec(src)
let mdArr = mdM ? JSON.parse(mdM[1]) : []
const orphans = []
for (let i = 0; i < mdArr.length; i += 1) {
  if (liveIdx.has(i)) continue
  const v = mdArr[i]
  if (v === `./${STUB_JS}` || v === `./${STUB_CSS}`) continue
  orphans.push({ i, v })
}
if (!orphans.length) {
  info('无孤儿 chunk。')
} else {
  for (const o of orphans) {
    const file = o.v.replace(/^\.\//, '')
    const stub = file.endsWith('.css') ? STUB_CSS : STUB_JS
    const before = src
    src = src.split(`./${file}`).join(`./${stub}`)
    if (src !== before) info(`[${o.i}] ${file} → ${stub}（只服务被裁页面）`)
    const p = path.join(ASSETS, file)
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); info(`       已删除 assets/${file}`) }
  }
  fs.writeFileSync(path.join(ASSETS, ENTRY), src, 'utf8')
  info(`入口 bundle 已写回（孤儿剪枝后）`)
}

// ------------------------------------------------------------ 收尾自检
console.log('')
console.log('— 阉割后自检 —')
const afterSrc = fs.readFileSync(path.join(ASSETS, ENTRY), 'utf8')
const leftover = TRIM_PAGES.filter((p) => new RegExp(`\\./${p}-`).test(afterSrc))
info(`入口中残留的被裁页 chunk 引用：${leftover.length ? leftover.join(', ') : '无 ✓'}`)

// mapDeps 数组长度与下标自洽（长度必须保持，且元素都指向存在的文件或 stub）
const md = /__vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=(\[[^\]]*\])\)\)\)/.exec(afterSrc)
if (!md) {
  console.log('  ⚠ 未能解析 __vite__mapDeps（不影响阉割结果）')
} else {
  let arr
  try { arr = JSON.parse(md[1]) } catch (e) { arr = null }
  if (arr) {
    info(`__vite__mapDeps 长度：${arr.length}（保持）`)
    const dangling = arr.filter((v) => !fs.existsSync(path.join(ASSETS, v.replace(/^\.\//, ''))))
    info(`mapDeps 悬空条目：${dangling.length ? dangling.join(', ') : '无 ✓'}`)
  }
}

console.log('')
console.log('✓ 阉割完成。下一步：node 澪Agent应用/scripts/clean-dist.mjs（期望 A/B/C/D 全 0）')
