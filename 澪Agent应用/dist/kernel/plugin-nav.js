/* plugin-nav.js — 左侧导航插件化：固定导航前置 + agent 功能入口按 enabled 动态显隐
 * 规则：
 *   - 固定导航固定顺序：Agent（置顶）→ 桌宠 → 设置，始终显示
 *   - 插件导航统一追加在固定导航之后（按出现顺序往后排），随后端 agent enabled 显隐：
 *     小智启用 → 显示「小智工具」「对话」；停用 → 隐藏（并收起已打开的小智工具面板）
 * 状态源：GET /api/companion/agents（与桌宠插件总线同口径，以后端 enabled 为准）
 * 暴露：window.__mioPluginNav.refresh()（Agent 页切换 enabled 后立即调用）
 */
(function () {
  if (window.__mioPluginNav) return
  var agentEnabled = {}
  var POLL_MS = 8000

  // 固定导航：始终显示且固定顺序（桌宠 → 设置；Agent 管理已收敛至对话页右侧 rail 面板，不再占左侧导航）
  var FIXED_NAV_ORDER = ['桌宠', '设置']

  // 从插件注册表/ manifest 动态收集导航规则（插件零相互依赖：各自声明，这里只聚合）
  // 优先走 kernel/plugin-registry.js（统一状态），不存在时回退直读 manifest 对象
  function collectNavRules() {
    var reg = window.__mioPluginRegistry
    if (reg && reg.navRules) return reg.navRules()
    var rules = {}
    var ms = window.__mioPluginManifests || {}
    for (var id in ms) {
      var m = ms[id]
      if (m && m.nav && m.nav.keywords) rules[id] = m.nav.keywords
    }
    return rules
  }

  // 声明 observeTab（桌宠页「观察」子tab）的插件：任意一个 enabled 时显示观察tab
  function observeTabEnabled() {
    var reg = window.__mioPluginRegistry
    if (reg && reg.observeTabEnabled) return reg.observeTabEnabled()
    var ms = window.__mioPluginManifests || {}
    for (var id in ms) {
      var m = ms[id]
      if (m && m.observeTab === true && agentEnabled[id] === true) return true
    }
    return false
  }

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function getNavItems() {
    var nav = $q('nav')
    return nav ? Array.prototype.slice.call(nav.querySelectorAll('button.nav-item')) : []
  }

  function matchItem(btn, keywords) {
    var t = (btn.getAttribute('title') || '') + ' ' + (btn.textContent || '')
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i]) >= 0) return true
    }
    return false
  }

  // 导航排序：固定导航（Agent → 桌宠 → 设置）前置，插件导航按出现顺序追加其后
  // 防递归：顺序已一致时不动 DOM（appendChild 会触发 MutationObserver，避免无限循环卡死 UI）
  function reorderNav() {
    var nav = $q('nav')
    if (!nav) return
    var items = getNavItems()
    // 固定导航按槽位收集（同标题可能出现多个，如 settings-panel 插的"设置"+ 原版"设置"，全部保留不覆盖）
    var fixed = []
    for (var f = 0; f < FIXED_NAV_ORDER.length; f++) fixed.push([])
    var plugins = []
    for (var i = 0; i < items.length; i++) {
      var btn = items[i]
      var t = (btn.getAttribute('title') || '') + ' ' + (btn.textContent || '')
      var idx = -1
      for (var f2 = 0; f2 < FIXED_NAV_ORDER.length; f2++) {
        if (t.indexOf(FIXED_NAV_ORDER[f2]) >= 0) { idx = f2; break }
      }
      if (idx >= 0) fixed[idx].push(btn)
      else plugins.push(btn)
    }
    var ordered = []
    for (var j = 0; j < fixed.length; j++) ordered = ordered.concat(fixed[j])
    ordered = ordered.concat(plugins)
    // 提取 nav 中 button.nav-item 的实际顺序（跳过头像/Logo/分隔符等非按钮元素）
    var current = []
    for (var c = 0; c < nav.children.length; c++) {
      var child = nav.children[c]
      if (child && child.classList && child.classList.contains('nav-item')) current.push(child)
    }
    // 当前按钮顺序已符合目标顺序 → 直接返回，不触发 DOM 变更
    if (current.length === ordered.length) {
      var same = true
      for (var k = 0; k < ordered.length; k++) {
        if (current[k] !== ordered[k]) { same = false; break }
      }
      if (same) return
    }
    // 按固定顺序依次 append（append 即移到末尾，保持传入顺序），插件导航自然排在固定导航之后
    for (var m = 0; m < ordered.length; m++) nav.appendChild(ordered[m])
  }

  // 停用小智时收起已打开的小智工具面板（对话页为原版路由，只隐藏入口）
  function closePanelsFor(agentId) {
    if (agentId !== 'xiaozhi') return
    var p = document.getElementById('xz-mcp-panel')
    if (p && p.style.display === 'flex') p.style.display = 'none'
    var d = $q('.xz-mcp-nav')
    if (d) d.classList.remove('active')
  }

  // 桌宠页(CompanionPage)内的「观察」子 tab 是小智专有功能：按 xiaozhi enabled 显隐
  // 停用时若正在观察面板 → 模拟点击「桌宠」切回（Vue state 同步）
  function applyObserveTab() {
    var bar = $q('.companion-tab-bar')
    if (!bar) return
    var btns = bar.querySelectorAll('button')
    var obsBtn = null
    var petBtn = null
    var obsActive = false
    for (var i = 0; i < btns.length; i++) {
      var t = btns[i].textContent || ''
      if (t.indexOf('观察') >= 0) obsBtn = btns[i]
      else if (t.indexOf('桌宠') >= 0) petBtn = btns[i]
      if (obsBtn && btns[i] === obsBtn && btns[i].classList.contains('active')) obsActive = true
    }
    if (!obsBtn) return
    var on = observeTabEnabled()
    obsBtn.style.display = on ? '' : 'none'
    if (on) obsBtn.classList.remove('plugin-off')
    else obsBtn.classList.add('plugin-off')
    if (!on && obsActive && petBtn && petBtn.style.display !== 'none') {
      petBtn.click()
    }
  }

  function applyVisibility() {
    var items = getNavItems()
    var rules = collectNavRules()
    for (var agentId in rules) {
      var keywords = rules[agentId]
      var enabled = agentEnabled[agentId] === true
      for (var i = 0; i < items.length; i++) {
        var btn = items[i]
        if (!matchItem(btn, keywords)) continue
        btn.style.display = enabled ? '' : 'none'
        if (!enabled) closePanelsFor(agentId)
      }
    }
    applyObserveTab()
  }

  function refresh() {
    return fetch('/api/companion/agents', { headers: { 'Cache-Control': 'no-cache' } })
      .then(function (r) { return r.json() })
      .then(function (data) {
        var list = (data && data.agents) || []
        var next = {}
        for (var i = 0; i < list.length; i++) {
          var a = list[i]
          if (a && a.agent_id) next[String(a.agent_id)] = a.enabled !== false
        }
        agentEnabled = next
        var reg = window.__mioPluginRegistry
        if (reg && reg.reconcile) reg.reconcile(list)
        reorderNav()
        applyVisibility()
      })
      .catch(function () { /* 后端暂不可达时保持现状 */ })
  }

  // Vue 重渲染 / 其他脚本重建导航时兜底：重新排序 + 重新显隐
  // 去抖 + 重入保护：mutation 事件合并到宏任务执行，避免高频 DOM 写引发递归
  var repairScheduled = false
  function scheduleRepair() {
    if (repairScheduled) return
    repairScheduled = true
    setTimeout(function () {
      repairScheduled = false
      try { reorderNav(); applyVisibility() } catch (e) { /* ignore */ }
    }, 0)
  }
  var mo = new MutationObserver(function () { scheduleRepair() })
  mo.observe(document.body, { childList: true, subtree: true })

  // 启动：尽快执行一次（导航渲染完成前静默等待），8s 轮询兜底覆盖外部 enabled 变化
  function start() {
    refresh()
    setInterval(refresh, POLL_MS)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()

  window.__mioPluginNav = { refresh: refresh }
})()
