#!/usr/bin/env node
// ============================================================================
// compose-dist.mjs · 把 vite 构建产物组装回 dist/（M3 构建管线加固）
// ============================================================================
//
// 背景：本项目是「dist 即源码」——dist/ 里除了 assets/（vite 产物）之外，
// 还住着三层**手写原生 JS**：core-inject/(7) + kernel/(2) + plugins/(6) + live2d-pet/(242)。
// 直接 `vite build`（默认 emptyOutDir）会把它们全抹掉。
//
// 本脚本的做法：vite 只往 dist-build/ 写 → 本脚本只把 assets/ 与 index.html 合并回 dist/，
// **绝不触碰** core-inject / kernel / plugins / live2d-pet 及 dist 根下其它文件。
//
// 用法：
//   node 澪Agent应用/scripts/compose-dist.mjs            # 干跑（只核查，退出码 1 = 不同步）
//   node 澪Agent应用/scripts/compose-dist.mjs --apply    # 实际执行
//
// 前置：
//   cd 澪Agent应用 && npm ci && node node_modules/vite/bin/vite.js build --outDir dist-build
//
// 推荐顺序：
//   build → compose-dist --apply → trim-pages --apply → clean-dist（期望全 0）
//
// 幂等：连跑两次结果一致（清空 assets → 拷贝 → 按模板重写 index.html）。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')            // 澪Agent应用/
const DIST = path.join(APP, 'dist')
const BUILD = path.join(APP, 'dist-build')
const TEMPLATE = path.join(HERE, 'index.template.html')

const APPLY = process.argv.includes('--apply')

// 这些目录/文件在 dist/ 里是手写资产，组装时【绝不触碰】
const PROTECTED = ['core-inject', 'kernel', 'plugins', 'live2d-pet']

const problems = []
const info = (m) => console.log('  ' + m)

function die(msg) { console.error('✗ ' + msg); process.exit(2) }

// ---------------------------------------------------------------- 前置检查
if (!fs.existsSync(BUILD)) die(`找不到构建产物目录：${BUILD}\n  请先跑：cd 澪Agent应用 && node node_modules/vite/bin/vite.js build --outDir dist-build`)
if (!fs.existsSync(path.join(BUILD, 'index.html'))) die(`dist-build/index.html 不存在，构建似乎未完成`)
if (!fs.existsSync(TEMPLATE)) die(`找不到模板：${TEMPLATE}`)

// -------------------------------------------- 从 vite 产物里取 3 个 hash 文件名
const builtHtml = fs.readFileSync(path.join(BUILD, 'index.html'), 'utf8')
const grab = (re, label) => {
  const m = re.exec(builtHtml)
  if (!m) die(`无法从 dist-build/index.html 解析出 ${label}`)
  return m[1]
}
const ENTRY_FILE = grab(/<script[^>]*\bsrc="\.\/assets\/([^"]+)"/, '入口 bundle')
const PRELOAD_FILE = grab(/rel="modulepreload"[^>]*\bhref="\.\/assets\/([^"]+)"/, 'modulepreload')
const CSS_FILE = grab(/rel="stylesheet"[^>]*\bhref="\.\/assets\/([^"]+)"/, '样式表')

console.log('='.repeat(72))
console.log('compose-dist · 把 vite 产物组装回 dist/')
console.log('='.repeat(72))
console.log(`dist      = ${DIST}`)
console.log(`dist-build= ${BUILD}`)
console.log(`模式      = ${APPLY ? '应用（--apply）' : '干跑（默认，只核查）'}`)
console.log('')
info(`入口 bundle   : assets/${ENTRY_FILE}`)
info(`modulepreload : assets/${PRELOAD_FILE}`)
info(`样式表        : assets/${CSS_FILE}`)

// -------------------------------------------------- 渲染 index.html（模板）
const tpl = fs.readFileSync(TEMPLATE, 'utf8')
const renderedHtml = tpl
  .replaceAll('{{ENTRY_FILE}}', ENTRY_FILE)
  .replaceAll('{{PRELOAD_FILE}}', PRELOAD_FILE)
  .replaceAll('{{CSS_FILE}}', CSS_FILE)

for (const ph of ['{{ENTRY_FILE}}', '{{PRELOAD_FILE}}', '{{CSS_FILE}}']) {
  if (renderedHtml.includes(ph)) die(`模板占位符未被替换：${ph}`)
}

// ------------------------------------------------------------ 计算差异
const builtAssets = fs.readdirSync(path.join(BUILD, 'assets')).sort()
const distAssetsDir = path.join(DIST, 'assets')
const distAssets = fs.existsSync(distAssetsDir) ? fs.readdirSync(distAssetsDir).sort() : []

const onlyInBuild = builtAssets.filter((f) => !distAssets.includes(f))
const onlyInDist = distAssets.filter((f) => !builtAssets.includes(f))

const curHtml = fs.existsSync(path.join(DIST, 'index.html'))
  ? fs.readFileSync(path.join(DIST, 'index.html'), 'utf8') : ''
const htmlSame = curHtml === renderedHtml

console.log('')
console.log('— 差异 —')
info(`dist-build/assets : ${builtAssets.length} 个`)
info(`dist/assets       : ${distAssets.length} 个`)
info(`仅 dist-build 有  : ${onlyInBuild.length} 个${onlyInBuild.length ? ' → ' + onlyInBuild.slice(0, 6).join(', ') + (onlyInBuild.length > 6 ? ' …' : '') : ''}`)
info(`仅 dist 有        : ${onlyInDist.length} 个${onlyInDist.length ? ' → ' + onlyInDist.slice(0, 6).join(', ') + (onlyInDist.length > 6 ? ' …' : '') : ''}`)
info(`index.html        : ${htmlSame ? '已一致' : '需重生成'}`)

// -------------------------------------------------- 保护目录存在性检查
console.log('')
console.log('— 受保护目录（本脚本绝不触碰）—')
for (const d of PROTECTED) {
  const p = path.join(DIST, d)
  const n = fs.existsSync(p) ? fs.readdirSync(p).length : -1
  info(`${d.padEnd(14)} ${n >= 0 ? n + ' 项' : '【缺失！】'}`)
  if (n < 0) problems.push(`受保护目录缺失：${d}`)
}

const inSync = htmlSame && onlyInBuild.length === 0 && onlyInDist.length === 0
console.log('')

if (!APPLY) {
  if (inSync && problems.length === 0) {
    console.log('✓ dist 与 dist-build 已同步（无需组装）。')
    process.exit(0)
  }
  console.log('⚠ dist 与 dist-build 不同步。加 --apply 执行组装。')
  process.exit(1)
}

if (problems.length) die(problems.join('\n'))

// ------------------------------------------------------------ 执行组装
console.log('— 执行 —')
// 1) 清空 dist/assets/（只清这个目录，绝不递归到 dist 根）
if (fs.existsSync(distAssetsDir)) {
  for (const f of fs.readdirSync(distAssetsDir)) {
    fs.rmSync(path.join(distAssetsDir, f), { recursive: true, force: true })
  }
  info(`已清空 dist/assets/（${distAssets.length} 项）`)
} else {
  fs.mkdirSync(distAssetsDir, { recursive: true })
  info('已创建 dist/assets/')
}
// 2) 拷贝 dist-build/assets/* → dist/assets/
let copied = 0
for (const f of builtAssets) {
  fs.copyFileSync(path.join(BUILD, 'assets', f), path.join(distAssetsDir, f))
  copied += 1
}
info(`已拷贝 ${copied} 个文件 → dist/assets/`)
// 3) 重生成 dist/index.html
fs.writeFileSync(path.join(DIST, 'index.html'), renderedHtml, 'utf8')
info('已重生成 dist/index.html（模板渲染）')

// ------------------------------------------------------------ 组装后自检
console.log('')
console.log('— 组装后自检 —')
const afterAssets = fs.readdirSync(distAssetsDir).sort()
info(`dist/assets/ : ${afterAssets.length} 个`)
const afterHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
const okEntry = afterHtml.includes(`./assets/${ENTRY_FILE}`)
const okCss = afterHtml.includes(`./assets/${CSS_FILE}`)
const injectCount = (afterHtml.match(/<script\s[^>]*src="\.\/(core-inject|kernel|plugins)\//g) || []).length
info(`index.html 引用入口 : ${okEntry ? '✓' : '✗'}`)
info(`index.html 引用样式 : ${okCss ? '✓' : '✗'}`)
info(`注入 script 标签数 : ${injectCount}（期望 14）`)
for (const d of PROTECTED) {
  const n = fs.readdirSync(path.join(DIST, d)).length
  info(`${d.padEnd(14)} ${n} 项（应未被触碰）`)
}
if (!okEntry || !okCss) die('组装后 index.html 自检失败')
if (injectCount !== 14) problems.push(`注入 script 标签数异常：${injectCount}（期望 14）`)

console.log('')
if (problems.length) {
  console.log('⚠ 组装完成，但有告警：'); problems.forEach((p) => console.log('   - ' + p))
  process.exit(1)
}
console.log('✓ 组装完成。下一步建议：node 澪Agent应用/scripts/trim-pages.mjs --apply')
