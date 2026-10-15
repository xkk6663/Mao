// plugin-nav 单测：验证 Agent 置顶 + agent 功能导航按 enabled 显隐 + 停用收起面板
const fs = require('fs')
const vm = require('vm')

// ---- 轻量 DOM stub ----
function makeEl(tag, attrs, text) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: attrs.className || '',
    _title: attrs.title || '',
    _text: text || '',
    style: {},
    children: [],
    parentNode: null,
    classList: {
      _set: new Set((attrs.className || '').split(/\s+/).filter(Boolean)),
      add(c) { this._set.add(c) },
      remove(c) { this._set.delete(c) },
      contains(c) { return this._set.has(c) },
      toggle(c, on) { if (on === undefined) on = !this._set.has(c); on ? this._set.add(c) : this._set.delete(c) },
    },
    get firstElementChild() { return this.children[0] || null },
    getAttribute(n) { return n === 'title' ? this._title : null },
    get textContent() { return this._text },
    querySelector(sel) {
      if (sel === '.mio-agent-nav') return this.children.find(c => c.classList.contains('mio-agent-nav')) || null
      if (sel === '.xz-mcp-nav') return this.children.find(c => c.classList.contains('xz-mcp-nav')) || null
      return null
    },
    querySelectorAll(sel) {
      if (sel === 'button.nav-item') return this.children.filter(c => c.tagName === 'BUTTON' && c.classList.contains('nav-item'))
      return []
    },
    insertBefore(node, ref) {
      // 模拟真实 DOM：先从原位置移除
      const oldIdx = this.children.indexOf(node)
      if (oldIdx >= 0) this.children.splice(oldIdx, 1)
      if (ref === null) { this.children.push(node); node.parentNode = this; return node }
      const i = this.children.indexOf(ref)
      if (i < 0) this.children.push(node)
      else this.children.splice(i, 0, node)
      node.parentNode = this
      return node
    },
    appendChild(node) {
      const oldIdx = this.children.indexOf(node)
      if (oldIdx >= 0) this.children.splice(oldIdx, 1)
      this.children.push(node)
      node.parentNode = this
      return node
    },
    get isConnected() { return true },
  }
  return el
}

const nav = makeEl('nav', {}, '')
const xzNav = makeEl('button', { className: 'nav-item xz-mcp-nav', title: '小智工具' }, '小智工具')
const agentNav = makeEl('button', { className: 'nav-item mio-agent-nav', title: 'Agent' }, 'Agent')
const dialogNav = makeEl('button', { className: 'nav-item', title: '' }, '对话')
const petNav = makeEl('button', { className: 'nav-item', title: '' }, '桌宠')
const settingsNav = makeEl('button', { className: 'nav-item', title: '' }, '设置')
// 模拟导航栏里的非按钮元素（头像区/Logo/分隔符）——曾导致排序比较失效死循环
const navLogo = makeEl('div', { className: 'nav-logo' }, 'MIO')
nav.children = [navLogo, dialogNav, petNav, settingsNav, xzNav, agentNav]

const xzPanel = { id: 'xz-mcp-panel', style: { display: 'flex' } }
// 桌宠页(CompanionPage)子导航：桌宠/观察/模型/体检（观察 = 小智专有）
function makeTabBtn(label, active) {
  const b = makeEl('button', { className: active ? 'active' : '' }, label)
  b.classList.add('companion-tab')
  b.clicked = 0
  b.click = function () { this.clicked++ }
  return b
}
const petTab = makeTabBtn('桌宠', true)
const obsTab = makeTabBtn('观察', false)
const modelTab = makeTabBtn('模型', false)
const healthTab = makeTabBtn('体检', false)
const tabBar = makeEl('div', { className: 'companion-tab-bar' }, '')
tabBar.children = [petTab, obsTab, modelTab, healthTab]
tabBar.querySelectorAll = function (sel) {
  if (sel === 'button') return this.children.filter(c => c.tagName === 'BUTTON')
  return []
}
let AGENTS = [
  { agent_id: 'xiaozhi', enabled: true },
  { agent_id: 'dsh', enabled: true },
]
const global = {
  document: {
    readyState: 'complete',
    body: {},
    querySelector(sel) {
      if (sel === 'nav') return nav
      if (sel === '.xz-mcp-nav') return xzNav
      if (sel === '.companion-tab-bar') return tabBar
      return null
    },
    addEventListener() {},
    getElementById(id) { return id === 'xz-mcp-panel' ? xzPanel : null },
  },
  MutationObserver: function (cb) { this.cb = cb; this.observe = () => {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ agents: AGENTS }) }),
  setInterval: () => 1,
  window: {},
  __mioPluginManifests: {
    xiaozhi: { agentId: 'xiaozhi', name: '小智', nav: { keywords: ['小智工具', '对话'] }, observeTab: true },
    dsh: { agentId: 'dsh', name: 'DSH', nav: null, observeTab: false },
  },
}
global.window = global
vm.createContext(global)

const src = fs.readFileSync('C:\\Users\\xiao1\\Mao\\澪Agent应用\\dist\\kernel\\plugin-nav.js', 'utf8')
vm.runInContext(src, global)
const navApi = global.window.__mioPluginNav

function assert(name, cond) {
  if (!cond) throw new Error('FAIL: ' + name)
  console.log('PASS: ' + name)
}

async function main() {
  // 1) 小智启用：固定导航 Agent→桌宠→设置 前置，插件导航（对话/小智工具）后置（Logo 保持在最前）
  await navApi.refresh()
  assert('顺序 Agent→桌宠→设置→对话→小智工具',
    nav.children[0] === navLogo && nav.children[1] === agentNav && nav.children[2] === petNav &&
    nav.children[3] === settingsNav && nav.children[4] === dialogNav &&
    nav.children[5] === xzNav)
  assert('小智工具可见', xzNav.style.display === '' || xzNav.style.display === undefined)
  assert('对话可见', dialogNav.style.display === '' || dialogNav.style.display === undefined)

  // 2) 小智停用：插件导航隐藏，固定导航顺序不变
  AGENTS = [
    { agent_id: 'xiaozhi', enabled: false },
    { agent_id: 'dsh', enabled: true },
  ]
  await navApi.refresh()
  assert('停用后小智工具隐藏', xzNav.style.display === 'none')
  assert('停用后对话隐藏', dialogNav.style.display === 'none')
  assert('停用后面板收起', xzPanel.style.display === 'none')
  assert('停用后固定导航顺序不变', nav.children[1] === agentNav && nav.children[2] === petNav && nav.children[3] === settingsNav)
  assert('停用后桌宠/设置不受影响', petNav.style.display !== 'none' && settingsNav.style.display !== 'none')

  // 3) 重新启用恢复
  AGENTS = [
    { agent_id: 'xiaozhi', enabled: true },
    { agent_id: 'dsh', enabled: true },
  ]
  await navApi.refresh()
  assert('重新启用后小智工具恢复', xzNav.style.display !== 'none')
  assert('重新启用后对话恢复', dialogNav.style.display !== 'none')

  // 4) 新插件导航（模拟未来插件注入）默认追加在最后
  const extraNav = makeEl('button', { className: 'nav-item mio-extra-nav', title: '新插件' }, '新插件')
  nav.appendChild(extraNav)
  await navApi.refresh()
  assert('新插件导航排最后', nav.children[nav.children.length - 1] === extraNav)
  assert('固定导航仍前置', nav.children[1] === agentNav && nav.children[2] === petNav && nav.children[3] === settingsNav)
  assert('新插件导航可见', extraNav.style.display !== 'none')

  // 5) 重复"设置"导航（settings-panel 插的 + 原版）不丢失、不覆盖、按序保留
  const settingsNav2 = makeEl('button', { className: 'nav-item', title: '' }, '设置')
  nav.appendChild(settingsNav2)
  await navApi.refresh()
  assert('重复设置导航保留不覆盖', nav.children[3] === settingsNav && nav.children[4] === settingsNav2)
  assert('重复设置后仍接对话/小智工具', nav.children[5] === dialogNav && nav.children[6] === xzNav)

  // 6) 防递归：同状态连续 refresh（等价于 MutationObserver 回调重入）不改变 DOM 引用/顺序
  const snapshot = nav.children.slice()
  await navApi.refresh()
  await navApi.refresh()
  assert('重复 refresh 不改 DOM 顺序（防循环卡死）',
    nav.children.length === snapshot.length &&
    nav.children.every((c, idx) => c === snapshot[idx]))

  // 7) 观察 tab（小智专有）：启用显示 / 停用隐藏 / 停用时若在观察面板则切回桌宠
  obsTab.classList.remove('active')
  AGENTS = [
    { agent_id: 'xiaozhi', enabled: true },
    { agent_id: 'dsh', enabled: true },
  ]
  await navApi.refresh()
  assert('启用时观察 tab 可见', obsTab.style.display !== 'none')
  assert('启用时观察 tab 无 plugin-off', !obsTab.classList.contains('plugin-off'))

  obsTab.classList.add('active')
  AGENTS = [
    { agent_id: 'xiaozhi', enabled: false },
    { agent_id: 'dsh', enabled: true },
  ]
  const clickedBefore = petTab.clicked
  await navApi.refresh()
  assert('停用时观察 tab 隐藏', obsTab.style.display === 'none')
  assert('停用时观察 tab 标记 plugin-off', obsTab.classList.contains('plugin-off'))
  assert('停用时正在观察面板自动切回桌宠', petTab.clicked > clickedBefore)
  assert('停用后切回不重复触发（防递归）', petTab.clicked === clickedBefore + 1)

  // 8) 观察 tab 在停用后保持隐藏，启用恢复
  obsTab.classList.remove('active')
  AGENTS = [
    { agent_id: 'xiaozhi', enabled: true },
    { agent_id: 'dsh', enabled: true },
  ]
  await navApi.refresh()
  assert('重新启用后观察 tab 恢复', obsTab.style.display !== 'none' && !obsTab.classList.contains('plugin-off'))

  console.log('\nALL PASS')
}

main().catch((e) => { console.error(e.message); process.exit(1) })
