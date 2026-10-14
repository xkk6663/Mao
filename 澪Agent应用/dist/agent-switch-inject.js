/* agent-switch-inject.js — Mio 左侧导航「Agent」管理页：跨 Agent 桌宠状态与即换即用
 * 数据：GET /api/companion/agents（总线快照） / POST /api/companion/agents/{id}/enabled（启用/停用）
 * 说明：桌宠是跨 Agent 的"脸"，只认统一 phase；本页集中查看/切换 Agent 平台（小智/DSH/Octop…）。
 *       停用立即释放"身体"，启用立即可接收事件——即换即用，无需重启桌宠。
 * 样式：内嵌原版 MIO 框架内容区渲染，配色走原框架 CSS 变量，与「小智工具」页一致。
 * v20261014a：跨 Agent 总线管理页首版。
 */
(function () {
  if (window.__mioAgentSwitchLoaded) return
  window.__mioAgentSwitchLoaded = true

  var PHASE_LABELS = {
    idle: '待机', planning: '规划', thinking: '思考中', executing_tool: '执行工具',
    streaming: '回复中', waiting_input: '聆听中', voice: '说话中', complete: '完成',
    error: '出错', paused: '暂停', awaiting_approval: '待确认', heartbeat: '在线',
  }
  var agents = []
  var busy = false
  var pollTimer = null

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function loadAgents() {
    return fetch('/api/companion/agents')
      .then(function (r) { return r.json() })
      .then(function (j) {
        agents = (j && j.agents) || []
        return j
      })
  }

  function setEnabled(agentId, enabled) {
    if (busy) return Promise.reject(new Error('操作进行中'))
    busy = true
    return fetch('/api/companion/agents/' + encodeURIComponent(agentId) + '/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !!enabled }),
    }).then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.detail) || '保存失败')
        return loadAgents()
      })
      .catch(function (e) { throw e })
      .finally(function () { busy = false })
  }

  // ---------- 原框架探测（与 mcp-tools-panel 相同策略） ----------
  function findContentArea() {
    var shell = $q('.app-shell')
    if (shell) {
      var main = shell.querySelector('main')
      if (main && main.offsetParent !== null) return main
    }
    var nav = $q('nav')
    if (nav && nav.parentElement) {
      var parent = nav.parentElement.parentElement || nav.parentElement
      var kids = Array.prototype.slice.call(parent.children)
      var idx = kids.indexOf(nav.parentElement)
      if (idx >= 0) {
        var best = null
        for (var i = idx + 1; i < kids.length; i++) {
          var el = kids[i]
          if (el.offsetParent === null || el.getAttribute('aria-hidden') === 'true') continue
          if (!best) { best = el; continue }
          if (el.offsetWidth * el.offsetHeight > best.offsetWidth * best.offsetHeight) best = el
        }
        if (best) return best
      }
    }
    return null
  }

  // ---------- 导航项 ----------
  var navBtn = null
  var NAV_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>'

  function ensureNav() {
    if (navBtn && navBtn.isConnected) return
    var nav = $q('nav')
    if (!nav) return
    var ref = null
    var btns = nav.querySelectorAll('button.nav-item')
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].getAttribute('title') || '') + (btns[i].textContent || '')
      if (t.indexOf('小智工具') >= 0) { ref = btns[i]; break }
    }
    navBtn = document.createElement('button')
    navBtn.type = 'button'
    navBtn.className = 'nav-item mio-agent-nav'
    navBtn.title = 'Agent'
    navBtn.innerHTML = NAV_SVG + '<span>Agent</span>'
    navBtn.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      togglePanel()
    })
    if (ref && ref.nextSibling) nav.insertBefore(navBtn, ref.nextSibling)
    else nav.appendChild(navBtn)
  }

  // ---------- 内嵌面板 ----------
  var panel = null

  function setNavActive(on) {
    if (navBtn) navBtn.classList.toggle('active', !!on)
  }

  function statusText(agent) {
    var st = String(agent.status || 'offline')
    if (st === 'online') return '在线'
    if (st === 'connecting') return '连接中'
    if (st === 'error') return '异常'
    return '离线'
  }

  function statusColor(agent) {
    var st = String(agent.status || 'offline')
    if (st === 'online') return '#3e9c6f'
    if (st === 'connecting') return '#d9a13b'
    if (st === 'error') return '#c25b5b'
    return '#9aa6ad'
  }

  function buildPanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = 'mio-agent-panel'
    panel.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;z-index:99;display:none;flex-direction:column;' +
      'background:var(--app-bg, #e9eef0);color:var(--ink, #20303a);' +
      'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;'
    panel.innerHTML =
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px;background:var(--sidebar-bg, #f4f7f8);border-bottom:1px solid var(--line, #d9e2e6);">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:var(--accent, #4c8798);flex:none;"></span>' +
        '<strong style="font-size:14px;flex:none;">Agent</strong>' +
        '<span style="flex:1;font-size:11px;color:var(--muted, #687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" id="mioAgentStatus">跨 Agent 桌宠状态</span>' +
        '<button type="button" id="mioAgentClose" title="关闭 Agent 页" style="border:none;background:transparent;font-size:16px;cursor:pointer;color:var(--muted, #687984);padding:2px 6px;">✕</button>' +
      '</div>' +
      '<div style="flex:none;padding:10px 20px;font-size:11px;line-height:1.7;color:var(--muted, #687984);background:var(--surface-soft, #f2f6f7);border-bottom:1px solid var(--line, #d9e2e6);">' +
        '桌宠是跨 Agent 的"脸"：统一显示各 Agent 的工作状态（思考/执行工具/说话/待机…）。' +
        '启用即接管显示，停用立即释放——即换即用，无需重启桌宠。' +
      '</div>' +
      '<div id="mioAgentList" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;"></div>'
    var host = findContentArea()
    if (host && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
      panel.__mioAgentHostFixed = true
    }
    ;(host || document.body).appendChild(panel)
    $q('#mioAgentClose', panel).addEventListener('click', function () {
      hidePanel()
    })
    return panel
  }

  function renderAgentCard(agent) {
    var phaseLabel = PHASE_LABELS[agent.phase] || agent.phase || '—'
    var caps = agent.capabilities || {}
    var capChips = ''
    var capMap = { voice: '语音', text: '文字', screen: '屏幕', mcp: 'MCP', observe: '观察' }
    var capOrder = ['voice', 'text', 'screen', 'mcp', 'observe']
    for (var i = 0; i < capOrder.length; i++) {
      var k = capOrder[i]
      if (caps[k]) capChips += '<span style="display:inline-block;font-size:10px;color:var(--muted,#687984);border:1px solid var(--line,#d9e2e6);border-radius:8px;padding:0 6px;margin-right:4px;">' + (capMap[k] || k) + '</span>'
    }
    var errHtml = agent.error ? '<div style="font-size:11px;color:#c25b5b;margin-top:4px;">' + agent.error + '</div>' : ''
    var activeTag = agent.active
      ? '<span style="display:inline-block;font-size:10px;color:#fff;background:var(--accent,#4c8798);border-radius:8px;padding:0 7px;margin-left:6px;">当前显示</span>'
      : ''
    var card = document.createElement('div')
    card.style.cssText =
      'border:1px solid var(--line,#d9e2e6);border-radius:10px;padding:12px 14px;background:var(--surface,#ffffff);' +
      'display:flex;flex-direction:column;gap:8px;'
    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + statusColor(agent) + ';flex:none;"></span>' +
        '<strong style="font-size:13px;">' + (agent.name || agent.agent_id) + '</strong>' +
        '<span style="font-size:10px;color:var(--muted,#687984);">' + (agent.adapter || '') + '</span>' +
        activeTag +
        '<span style="flex:1;"></span>' +
        '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted,#687984);cursor:pointer;">' +
          '<input type="checkbox" class="mio-agent-switch" data-agent="' + agent.agent_id + '" ' + (agent.enabled ? 'checked' : '') + '>' +
          (agent.enabled ? '启用' : '停用') +
        '</label>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted,#687984);">' +
        '<span>状态：' + statusText(agent) + '</span>' +
        '<span>·</span>' +
        '<span>阶段：' + phaseLabel + '</span>' +
        (capChips ? '<span style="flex:1;"></span>' + capChips : '') +
      '</div>' +
      errHtml
    var sw = $q('.mio-agent-switch', card)
    sw.addEventListener('change', function (e) {
      var id = sw.getAttribute('data-agent')
      var on = sw.checked
      setEnabled(id, on)
        .then(function () {
          sw.checked = on
          sw.nextSibling.textContent = on ? '启用' : '停用'
          refresh()
        })
        .catch(function (err) {
          sw.checked = !on
          sw.nextSibling.textContent = !on ? '启用' : '停用'
          var st = $q('#mioAgentStatus', panel)
          if (st) st.textContent = '保存失败：' + String(err.message || err)
        })
    })
    return card
  }

  function refresh() {
    if (!panel || panel.style.display === 'none') return
    loadAgents().then(function (snap) {
      var list = $q('#mioAgentList', panel)
      if (!list) return
      list.textContent = ''
      var active = snap.active_agent
      var st = $q('#mioAgentStatus', panel)
      if (st) {
        st.textContent = active
          ? '当前显示：' + (active.name || active.agent_id) + ' · ' + (PHASE_LABELS[active.phase] || active.phase)
          : '无活跃 Agent'
      }
      var cards = (snap.agents || []).map(renderAgentCard)
      for (var i = 0; i < cards.length; i++) list.appendChild(cards[i])
      if (!cards.length) {
        var empty = document.createElement('div')
        empty.style.cssText = 'text-align:center;color:var(--muted,#687984);font-size:12px;padding:30px 0;'
        empty.textContent = '暂无 Agent，后端启动后自动注册。'
        list.appendChild(empty)
      }
    }).catch(function (err) {
      var st = $q('#mioAgentStatus', panel)
      if (st) st.textContent = '加载失败：' + String(err.message || err)
    })
  }

  function showPanel() {
    buildPanel()
    panel.style.display = 'flex'
    setNavActive(true)
    refresh()
    if (!pollTimer) {
      pollTimer = window.setInterval(function () {
        if (panel && panel.style.display !== 'none') refresh()
      }, 5000)
    }
  }

  function hidePanel() {
    setNavActive(false)
    if (panel) panel.style.display = 'none'
  }

  function togglePanel() {
    if (panel && panel.style.display !== 'none') hidePanel()
    else showPanel()
  }

  // ---------- 启动：等 Vue 渲染出侧边栏后再挂导航 ----------
  function boot() {
    if (!$q('nav')) { window.setTimeout(boot, 400); return }
    ensureNav()
    hidePanel()
    if (window.__mioAgentPollTimer) window.clearInterval(window.__mioAgentPollTimer)
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot()
  else window.addEventListener('DOMContentLoaded', boot)
  window.addEventListener('load', function () { if (!navBtn || !navBtn.isConnected) boot() })
})()
