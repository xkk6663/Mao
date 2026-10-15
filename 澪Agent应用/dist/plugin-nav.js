/* plugin-nav.js — 左侧导航插件化：Agent 导航置顶 + agent 功能入口按 enabled 动态显隐
 * 规则：
 *   - Agent 导航项（mio-agent-nav）始终置顶（第一行）
 *   - 小智相关导航入口（小智工具 xz-mcp-nav、对话）随后端 xiaozhi enabled 显隐：
 *     启用 → 显示；停用 → 隐藏（并收起已打开的小智工具面板）
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

  // Agent 导航置顶：mio-agent-nav 始终是导航栏第一个（第一行）
  function pinAgentNav() {
    var nav = $q('nav')
    if (!nav) return
    var agentBtn = nav.querySelector('.mio-agent-nav')
    if (!agentBtn) return
    var first = nav.firstElementChild
    if (agentBtn !== first) nav.insertBefore(agentBtn, first)
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
        pinAgentNav()
        applyVisibility()
      })
      .catch(function () { /* 后端暂不可达时保持现状 */ })
  }

  // Vue 重渲染 / 其他脚本重建导航时兜底：重新置顶 + 重新显隐
  var mo = new MutationObserver(function () {
    try { pinAgentNav(); applyVisibility() } catch (e) { /* ignore */ }
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
