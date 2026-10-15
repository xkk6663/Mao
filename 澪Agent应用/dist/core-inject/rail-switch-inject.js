/* rail-switch-inject.js — 对话页右侧 rail 替换：小智专属状态栏 → 通用 Agent 工具切换调用界面
 * 数据：GET /api/companion/agents（总线快照） / POST /api/companion/agents/{id}/enabled（启用/停用）
 * 说明：原版右侧 rail（aside.integrated-right-rail）为小智专属状态栏（小智连接/会话ID/机器码/视觉能力/自动观察/视觉端点/状态刷新/提示词设置）。
 *       替换为跨 Agent 通用面板：各 agent（小智/DSH/Octop…）启用开关 + 实时状态（在线·阶段）+ 能力标识（语音/文字/屏幕/MCP/观察）。
 *       启用即接管显示，停用立即释放——即换即用，无需重启桌宠。与左侧「Agent」页同数据源、同交互，互为入口。
 *       小智诊断信息（连接/会话ID/视觉端点）已由桌宠体检页（health-panel）承载，rail 不再重复。
 * v20261015a：右侧 rail 通用化首版。
 */
(function () {
  if (window.__mioRailSwitchLoaded) return
  window.__mioRailSwitchLoaded = true

  var PHASE_LABELS = {
    idle: '待机', planning: '规划', thinking: '思考中', executing_tool: '执行工具',
    streaming: '回复中', waiting_input: '聆听中', voice: '说话中', complete: '完成',
    error: '出错', paused: '暂停', awaiting_approval: '待确认', heartbeat: '在线',
  }
  var CAP_MAP = { voice: '语音', text: '文字', screen: '屏幕', mcp: 'MCP', observe: '观察' }
  var CAP_ORDER = ['voice', 'text', 'screen', 'mcp', 'observe']
  var agents = []
  var busy = false
  var pollTimer = null
  var panelHost = null

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function loadAgents() {
    return fetch('/api/companion/agents')
      .then(function (r) { return r.json() })
      .then(function (j) { agents = (j && j.agents) || []; return j })
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
      .then(function () {
        // 切换 enabled 后立即刷新左侧导航（agent 功能入口按需显隐）
        try { if (window.__mioPluginNav) window.__mioPluginNav.refresh() } catch (_) {}
        render()
        return null
      })
      .catch(function (e) { throw e })
      .finally(function () { busy = false })
  }

  function statusText(a) {
    var s = String(a.status || 'offline')
    return s === 'online' ? '在线' : s === 'connecting' ? '连接中' : s === 'error' ? '异常' : '离线'
  }
  function statusColor(a) {
    var s = String(a.status || 'offline')
    return s === 'online' ? '#3e9c6f' : s === 'connecting' ? '#d9a13b' : s === 'error' ? '#c25b5b' : '#9aa6ad'
  }

  function buildPanel() {
    var p = document.createElement('div')
    p.id = 'mioRailAgentPanel'
    p.style.cssText = 'height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:var(--ink,#20303a);overflow-y:auto;'
    p.innerHTML =
      '<div style="flex:none;display:flex;align-items:center;gap:8px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent,#4c8798);flex:none;"></span>' +
        '<strong style="font-size:13px;">Agent 工具</strong>' +
        '<span id="mioRailActive" style="flex:1;font-size:11px;color:var(--muted,#687984);text-align:right;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;"></span>' +
      '</div>' +
      '<div style="flex:none;font-size:11px;line-height:1.6;color:var(--muted,#687984);padding:8px 10px;background:var(--surface-soft,#f2f6f7);border:1px solid var(--line,#d9e2e6);border-radius:8px;">' +
        '桌宠是跨 Agent 的"脸"：启用即接管显示，停用立即释放——即换即用，无需重启。' +
      '</div>' +
      '<div id="mioRailList" style="flex:1;display:flex;flex-direction:column;gap:8px;min-height:0;"></div>' +
      '<div id="mioRailErr" style="flex:none;font-size:11px;color:#c25b5b;display:none;"></div>'
    return p
  }

  function renderAgentRow(a) {
    var phaseLabel = PHASE_LABELS[a.phase] || a.phase || '—'
    var chips = ''
    var caps = a.capabilities || {}
    for (var i = 0; i < CAP_ORDER.length; i++) {
      var k = CAP_ORDER[i]
      if (caps[k]) chips += '<span style="display:inline-block;font-size:9px;color:var(--muted,#687984);border:1px solid var(--line,#d9e2e6);border-radius:6px;padding:0 5px;margin:1px 3px 1px 0;">' + (CAP_MAP[k] || k) + '</span>'
    }
    var row = document.createElement('div')
    row.style.cssText = 'flex:none;border:1px solid var(--line,#d9e2e6);border-radius:10px;padding:10px 12px;background:var(--surface,#ffffff);display:flex;flex-direction:column;gap:6px;'
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:7px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + statusColor(a) + ';flex:none;"></span>' +
        '<strong style="font-size:12px;flex:none;">' + (a.name || a.agent_id) + '</strong>' +
        '<span style="font-size:9px;color:var(--muted,#687984);flex:none;">' + (a.adapter || '') + '</span>' +
        '<span style="flex:1;"></span>' +
        (a.active
          ? '<span style="font-size:9px;color:#fff;background:var(--accent,#4c8798);border-radius:6px;padding:0 6px;flex:none;">当前显示</span>'
          : '') +
        '<label style="flex:none;display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;color:var(--muted,#687984);">' +
          '<input type="checkbox" data-rail-toggle="' + a.agent_id + '" ' + (a.enabled ? 'checked' : '') + ' style="accent-color:var(--accent,#4c8798);cursor:pointer;">' +
          (a.enabled ? '启用' : '停用') +
        '</label>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10px;color:var(--muted,#687984);">' +
        '<span>状态：' + statusText(a) + '</span>' +
        '<span>·</span>' +
        '<span>阶段：' + phaseLabel + '</span>' +
        (chips ? '<span style="flex-basis:100%;"></span>' + chips : '') +
      '</div>' +
      (a.error ? '<div style="font-size:10px;color:#c25b5b;">' + a.error + '</div>' : '')
    var toggle = row.querySelector('input[data-rail-toggle]')
    toggle.addEventListener('change', function () {
      var target = toggle.checked
      setEnabled(a.agent_id, target).catch(function () {
        toggle.checked = !target // 失败回滚
      })
    })
    return row
  }

  function render() {
    if (!panelHost) return
    var list = $q('#mioRailList', panelHost)
    if (!list) return
    list.innerHTML = ''
    var active = null
    for (var i = 0; i < agents.length; i++) {
      if (agents[i].active) { active = agents[i]; break }
    }
    var activeEl = $q('#mioRailActive', panelHost)
    if (activeEl) {
      activeEl.textContent = active
        ? '当前显示: ' + (active.name || active.agent_id) + ' · ' + (PHASE_LABELS[active.phase] || active.phase || '')
        : '当前无显示'
    }
    var errEl = $q('#mioRailErr', panelHost)
    if (errEl) errEl.style.display = 'none'
    for (var j = 0; j < agents.length; j++) list.appendChild(renderAgentRow(agents[j]))
  }

  function refresh() {
    loadAgents().then(function () { render() }).catch(function () {
      if (!panelHost) return
      var err = $q('#mioRailErr', panelHost)
      if (err) { err.textContent = '✗ 读取 Agent 状态失败'; err.style.display = 'block' }
    })
  }

  // ---------- 接管 rail：清空原小智状态栏，挂入 Agent 面板 ----------
  function takeOver(rail) {
    if (rail.__mioRailSwitched) return
    rail.__mioRailSwitched = true
    if (!panelHost) panelHost = buildPanel()
    rail.innerHTML = ''
    rail.style.display = ''
    rail.style.overflow = 'hidden'
    rail.appendChild(panelHost)
    refresh()
    if (!pollTimer) pollTimer = setInterval(refresh, 3000)
  }

  function watch() {
    var found = document.querySelector('aside.integrated-right-rail')
    if (!found) found = document.querySelector('section.rail-state-list')
    if (!found) return
    var aside = found.closest ? found.closest('aside.integrated-right-rail') : null
    takeOver(aside || found)
  }

  var observer = new MutationObserver(function () {
    try { watch() } catch (e) { /* ignore */ }
  })
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true })
  watch()
})()
