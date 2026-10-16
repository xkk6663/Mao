#!/usr/bin/env node
// ============================================================================
// dist 完整性与痕迹守卫
// ============================================================================
// 为什么需要它：本仓 澪Agent应用/dist 的 Vue 源码**不在本仓**，dist 是由外部源码树
// 构建后拷入的，且历史修复是直接在压缩 bundle 上打补丁。这个工作方式天然会产生几类残留，
// 而且**每重新拷一次就会再来一轮**，所以需要一条可重复的检查线，而不是靠人肉发现：
//
//   A. 补丁备份         *.bak / *.orig / *.bak-<timestamp>
//   B. 备份目录         dist/_cleanup-backup-*/
//   C. 无人引用的 assets 改名/改版后遗留的旧 hash 文件
//   D. 悬空引用         入口 bundle 仍 import/预加载已删掉的 chunk
//                        → 触发时后端 SPA 兜底返回 index.html，import() 报 MIME 错
//   E. mapDeps 结构     Vite 用**下标**引用 __vite__mapDeps 数组；一旦数组被删元素
//                        而调用点没重编号，页面会静默预加载到错误的 chunk
//                        （比 404 更难发现，所以必须自动校验）
//
// 用法：
//   node scripts/clean-dist.mjs            # 只核查，有问题退出码 1（可当提交前门禁）
//   node scripts/clean-dist.mjs --apply    # 执行清理：残留移入回收区（不硬删）
//
// 清理约定：残留统一移到仓库根 .dist-cleanup-safety-<日期>/（保持相对路径），可随时捞回。
// 幂等：清干净后再跑应输出「全部通过」。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(__dirname, '..')
const DIST = process.env.MIO_DIST_DIR ? path.resolve(process.env.MIO_DIST_DIR) : path.join(APP, 'dist')
const ROOT = path.resolve(APP, '..')
const APPLY = process.argv.includes('--apply')
const STAMP = new Date().toISOString().slice(0, 10)
const TRASH = path.join(ROOT, `.dist-cleanup-safety-${STAMP}`)

const RES_DIR = new Set(['models', 'libs', 'node_modules'])
const STUB_JS = '_trimmed-stub.js'
const STUB_CSS = '_trimmed-stub.css'

if (!fs.existsSync(DIST)) {
  console.error(`找不到 dist：${DIST}`)
  process.exit(2)
}

// 备份目录既不该留在 dist（会被后端一起静态托管），也不参与引用解析
const backupDirs = fs.readdirSync(DIST, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^_cleanup-backup-/.test(e.name))
  .map((e) => e.name)
const skipDir = new Set([...RES_DIR, ...backupDirs])

function walk(dir, out = [], skip = null) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!(skip && skip.has(e.name))) walk(p, out, skip) }
    else out.push(p)
  }
  return out
}
const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
function retire(rel) {
  if (!APPLY) return
  const from = path.join(DIST, rel)
  const to = path.join(TRASH, rel)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
}

// --------------------------------------------------- 1) 引用关系全量扫描
// 两个清单必须分开：`diskAll` 是**完整性**依据（必须包含 models/libs，否则引用到
// 资源目录会被误判成"缺失"）；`scanFiles` 只是**遍历范围**（跳过重目录省时间）。
const TEXT = /\.(js|mjs|cjs|css|html|json)$/
const CAND = /["'`(]\.?\/?([A-Za-z0-9_./@-]+\.(?:js|css|png|jpg|jpeg|svg|woff2?|ttf|json|moc3|wasm|model3|motion3|exp3))(?:\?[^"'`\s]*)?["'`)]/g

const diskAll = walk(DIST, [], new Set(backupDirs))
const allFiles = walk(DIST, [], skipDir)
const relOf = (f) => path.relative(DIST, f).replace(/\\/g, '/')
const onDisk = new Set(diskAll.map(relOf))
const referenced = new Map() // 目标 -> Set(引用者)
const dangling = new Map()   // 缺失目标 -> Set(引用者)

for (const f of allFiles) {
  const rel = relOf(f)
  if (!TEXT.test(rel)) continue
  const src = fs.readFileSync(f, 'utf8')
  const dir = path.posix.dirname(rel)
  CAND.lastIndex = 0
  let m
  while ((m = CAND.exec(src))) {
    const t = dir === '.' ? m[1] : path.posix.normalize(path.posix.join(dir, m[1]))
    if (!referenced.has(t)) referenced.set(t, new Set())
    referenced.get(t).add(rel)
    if (!onDisk.has(t)) {
      if (!dangling.has(t)) dangling.set(t, new Set())
      dangling.get(t).add(rel)
    }
  }
}

// --------------------------------------------------- 2) A/B/C/D 四类残留
const backups = allFiles
  .filter((f) => /\.(bak|orig)$/.test(f) || /\.bak-\d{8}-\d{6}$/.test(f))
  .map(relOf).sort()

const hashes = new Map()
for (const rel of onDisk) if (rel.startsWith('assets/')) hashes.set(rel, sha(path.join(DIST, rel)))
const byHash = new Map()
for (const [rel, h] of hashes) {
  if (!byHash.has(h)) byHash.set(h, [])
  byHash.get(h).push(rel)
}
const orphans = []
for (const [rel, h] of hashes) {
  if (referenced.has(rel)) continue
  const twin = (byHash.get(h) || []).find((g) => g !== rel && referenced.has(g))
  orphans.push({ rel, twin })
}
orphans.sort((a, b) => a.rel.localeCompare(b.rel))

// live2d-pet 里模型清单引用（如 capabilities.expressions 的 expressions/love.exp3.json）
// 是相对【模型目录】（live2d-pet/models/<模型>/）的，不是相对 live2d-pet/ 根。
// 静态扫描无法知道引用者属于哪个模型目录，故按「models/*/ 下存在同名相对路径」兜底解析，
// 命中即不计入悬空（此前每次构建都在 D' 里报一条 love.exp3.json 误报）。
const modelRelativeResolved = []
for (const k of [...dangling.keys()]) {
  if (!k.startsWith('live2d-pet/')) continue
  const suffix = k.slice('live2d-pet/'.length)
  const hit = [...onDisk].find((r) => r.startsWith('live2d-pet/models/') && r.endsWith('/' + suffix))
  if (hit) {
    modelRelativeResolved.push(`${k}  →  ${hit}`)
    dangling.delete(k)
  }
}

const stubHits = [...dangling.keys()].filter((d) => d.startsWith('assets/')).sort()
// assets/ 之外的悬空引用不计入问题：它们多是"生成出来的文件名字符串"（如裁剪音效的
// _trim.wav）或"相对模型目录的清单路径"（如 expressions/love.exp3.json），
// 由静态扫描无法分辨。单独列出来仅供人工扫一眼，避免真问题被淹没。
const otherDangling = [...dangling.keys()].filter((d) => !d.startsWith('assets/')).sort()
const needStubJs = stubHits.some((d) => d.endsWith('.js'))
const needStubCss = stubHits.some((d) => d.endsWith('.css'))

// --------------------------------------------------- 3) E 类：mapDeps 结构校验
const entryRel = [...onDisk].find((r) => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(r))
const struct = { checked: false, problems: [], calls: 0, len: 0, stubRefs: 0 }
if (entryRel) {
  const src = fs.readFileSync(path.join(DIST, entryRel), 'utf8')
  const arr = src.slice(src.indexOf('__vite__mapDeps')).match(/m\.f\s*=\s*\[([^\]]*)\]/)
  if (arr) {
    struct.checked = true
    const items = [...arr[1].matchAll(/[`"']([^`"']+)[`"']/g)].map((m) => m[1])
    struct.len = items.length
    struct.stubRefs = items.filter((i) => i.includes('_trimmed-stub')).length
    items.forEach((it, i) => {
      const abs = path.join(DIST, 'assets', it.replace(/^\.\//, ''))
      if (!fs.existsSync(abs)) struct.problems.push(`mapDeps[${i}] 指向不存在的 ${it}`)
    })
    const re = /__vite__mapDeps\(\[([0-9,\s]*)\]\)/g
    let m
    while ((m = re.exec(src))) {
      struct.calls += 1
      const idx = m[1].split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x))
      const oob = idx.filter((i) => i < 0 || i >= items.length)
      if (oob.length) struct.problems.push(`第 ${struct.calls} 处调用下标越界：${oob.join(',')}（数组长度 ${items.length}）`)
    }
    for (const t of new Set([...src.matchAll(/import\(\s*`\.\/([^`]+?)`\s*\)/g)].map((m) => m[1]))) {
      if (!fs.existsSync(path.join(DIST, 'assets', t))) struct.problems.push(`动态 import(\`./${t}\`) 目标不存在`)
    }
  }
}

// --------------------------------------------------- 4) 报告
const problems = []
if (backups.length) problems.push(`A 补丁备份 ${backups.length} 个`)
if (backupDirs.length) problems.push(`B 备份目录 ${backupDirs.length} 个`)
if (orphans.length) problems.push(`C 无人引用的 assets ${orphans.length} 个`)
if (stubHits.length) problems.push(`D 悬空引用 ${stubHits.length} 个`)
if (struct.problems.length) problems.push(`E mapDeps 结构问题 ${struct.problems.length} 条`)

console.log('='.repeat(72))
console.log(`dist 完整性与痕迹核查${APPLY ? ' · 【清理模式】' : ''}`)
console.log('='.repeat(72))
console.log(`dist = ${DIST}`)
console.log(`扫描 ${allFiles.length} 个文件｜被引用目标 ${referenced.size} 个｜入口 ${entryRel || '?'}\n`)

console.log(`A. 补丁备份：${backups.length}`)
backups.forEach((f) => console.log(`     ${f}`))
console.log(`B. 备份目录：${backupDirs.length}`)
backupDirs.forEach((d) => console.log(`     ${d}/`))
console.log(`C. 无人引用的 assets：${orphans.length}`)
orphans.forEach((o) => console.log(`     ${o.rel}${o.twin ? `   [内容同 ${o.twin}]` : '   [旧版本残留]'}`))
console.log(`D. 悬空引用（assets/，需处理）：${stubHits.length}`)
stubHits.forEach((d) => console.log(`     ${d}  ← ${[...dangling.get(d)].join(', ')}`))
console.log(`D'. 其他目录悬空引用（供人工过目，不计入问题）：${otherDangling.length}`)
console.log(`D''.模型相对路径已解析（模型目录清单，不计问题）：${modelRelativeResolved.length}`)
modelRelativeResolved.forEach((d) => console.log(`     ${d}`))
otherDangling.forEach((d) => console.log(`     ${d}  ← ${[...dangling.get(d)].join(', ')}`))
console.log(`E. mapDeps：${struct.checked ? `数组 ${struct.len} 项｜调用点 ${struct.calls} 个｜占位条目 ${struct.stubRefs} 个` : '未找到入口 bundle'}${struct.problems.length ? '' : '｜自洽 ✓'}`)
struct.problems.forEach((p) => console.log(`     ✗ ${p}`))

console.log('\n' + '-'.repeat(72))
if (!problems.length) {
  console.log('全部通过：无残留、无悬空引用、mapDeps 自洽。')
  console.log('-'.repeat(72))
  process.exit(0)
}
console.log('发现：' + problems.join('；'))
if (!APPLY) {
  console.log('\n（本次仅核查，未改动任何文件）执行清理：')
  console.log('  node scripts/clean-dist.mjs --apply')
  console.log('-'.repeat(72))
  process.exit(1)
}

// --------------------------------------------------- 5) 清理
let moved = 0
for (const f of backups) { retire(f); moved += 1 }
for (const d of backupDirs) { retire(d); moved += 1 }
for (const o of orphans) { retire(o.rel); moved += 1 }

let stubs = 0
let rewrites = 0
if (stubHits.length) {
  if (needStubJs) {
    fs.writeFileSync(path.join(DIST, 'assets', STUB_JS),
      '// 上游被裁掉的页面占位。原 chunk 已随阉割移除；留此占位保证引用不悬空，\n' +
      '// 万一被触达也只是渲染空白，而不是拿到 index.html 触发 MIME 报错。\n' +
      'export default { name: "TrimmedStub", render() { return null } }\n', 'utf8')
    stubs += 1
  }
  if (needStubCss) {
    fs.writeFileSync(path.join(DIST, 'assets', STUB_CSS), '/* 上游被裁掉的页面样式占位（空）*/\n', 'utf8')
    stubs += 1
  }
  const byFile = new Map()
  for (const d of stubHits) {
    for (const owner of dangling.get(d)) {
      if (!byFile.has(owner)) byFile.set(owner, new Set())
      byFile.get(owner).add(d)
    }
  }
  for (const [owner, targets] of byFile) {
    const abs = path.join(DIST, owner)
    let src = fs.readFileSync(abs, 'utf8')
    const before = src
    for (const t of targets) {
      const kind = t.endsWith('.css') ? STUB_CSS : STUB_JS
      for (const q of ['`', '"', "'"]) src = src.split(`${q}./${t}${q}`).join(`${q}./assets/${kind}${q}`)
    }
    if (src !== before) { fs.writeFileSync(abs, src, 'utf8'); rewrites += 1 }
  }
}

console.log(`\n完成：移入回收区 ${moved} 项；新增占位 ${stubs} 个；改写 ${rewrites} 个文件`)
console.log(`回收区：${TRASH}`)
console.log('-'.repeat(72))
process.exit(struct.problems.length ? 1 : 0)
