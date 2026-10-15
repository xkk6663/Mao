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

  // agentId -> 导航匹配关键词（title + 文本 包含即命中）
  var AGENT_NAV_RULES = {
    xiaozhi: ['小智工具', '对话'],
  }

  // 固定导航：始终显示且固定顺序（Agent 置顶 → 桌宠 → 设置），插件导航统一追加其后
  var FIXED_NAV_ORDER = ['Agent', '桌宠', '设置']

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
    var fixed = []
    var plugins = []
    for (var i = 0; i < items.length; i++) {
      var btn = items[i]
      var t = (btn.getAttribute('title') || '') + ' ' + (btn.textContent || '')
      var idx = -1
      for (var f = 0; f < FIXED_NAV_ORDER.length; f++) {
        if (t.indexOf(FIXED_NAV_ORDER[f]) >= 0) { idx = f; break }
      }
      if (idx >= 0) fixed[idx] = btn
      else plugins.push(btn)
    }
    var ordered = fixed.filter(function (b) { return !!b }).concat(plugins)
    // 当前顺序已符合目标顺序 → 直接返回，不触发 DOM 变更
    if (nav.children.length === ordered.length) {
      var same = true
      for (var k = 0; k < ordered.length; k++) {
        if (nav.children[k] !== ordered[k]) { same = false; break }
      }
      if (same) return
    }
    // 按固定顺序依次 append（append 即移到末尾，保持传入顺序），插件导航自然排在固定导航之后
    for (var j = 0; j < ordered.length; j++) nav.appendChild(ordered[j])
  }

  // 停用小智时收起已打开的小智工具面板（对话页为原版路由，只隐藏入口）
  function closePanelsFor(agentId) {
    if (agentId !== 'xiaozhi') return
    var p = document.getElementById('xz-mcp-panel')
    if (p && p.style.display === 'flex') p.style.display = 'none'
    var d = $q('.xz-mcp-nav')
    if (d) d.classList.remove('active')
  }

  function applyVisibility() {
    var items = getNavItems()
    for (var agentId in AGENT_NAV_RULES) {
      var keywords = AGENT_NAV_RULES[agentId]
      var enabled = agentEnabled[agentId] === true
      for (var i = 0; i < items.length; i++) {
        var btn = items[i]
        if (!matchItem(btn, keywords)) continue
        btn.style.display = enabled ? '' : 'none'
        if (!enabled) closePanelsFor(agentId)
      }
    }
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
        reorderNav()
        applyVisibility()
      })
      .catch(function () { /* 后端暂不可达时保持现状 */ })
  }

  // Vue 重渲染 / 其他脚本重建导航时兜底：重新排序 + 重新显隐
  var mo = new MutationObserver(function () {
    try { reorderNav(); applyVisibility() } catch (e) { /* ignore */ }
  })
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
