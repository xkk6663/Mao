/* rail-switch-inject.js — 对话页右侧 rail 通用化：小智专属状态栏 → 跨 Agent 工具切换调用界面
 * 数据：GET /api/companion/agents（总线快照） / POST /api/companion/agents/{id}/enabled（启用/停用）
 * 说明：原版右侧 rail（aside.integrated-right-rail）为小智专属状态栏。本脚本完全接管 rail：
 *       - 收起态（rail 未展开，宽 ~92px）：仅显示各 Agent 运行状态点（绿=在线/黄=连接中/红=异常/灰=离线，
 *         title 悬浮显示 "名称·阶段"），简洁不挤压；
 *       - 展开态（点 header 展开，宽 ~312px）：完整 Agent 工具切换面板——各 agent 卡片（启用开关 + 状态·阶段 +
 *         能力 chips 语音/文字/屏幕/MCP/观察）+ 顶部当前显示；
 *       - 点面板 header 图标切换展开/收起（复用原版 .expanded 机制）。
 * 小智诊断信息（连接/会话ID/视觉端点）已由桌宠体检页（health-panel）承载，rail 不再重复。
 * v20261015b：收起态精简显示 + 展开态完整面板（双模式）。
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
  var rail = null

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

  // 注入 rail 双模式样式（收起 92px → 精简状态点；展开 312px → 完整面板）
  function injectStyle() {
    if (document.getElementById('mio-rail-switch-style')) return
    var st = document.createElement('style')
    st.id = 'mio-rail-switch-style'
    st.textContent =
      '.integrated-right-rail{overflow:hidden!important;}' +
      '#mioRailAgentPanel{height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:10px 8px;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:var(--ink,#20303a);min-height:0;}' +
      '#mioRailAgentPanel .mio-rail-header{flex:none;display:flex;align-items:center;gap:8px;min-height:36px;cursor:pointer;user-select:none;}' +
      '#mioRailAgentPanel .mio-rail-header .mio-rail-dot{width:8px;height:8px;border-radius:50%;background:var(--accent,#4c8798);flex:none;}' +
      '#mioRailAgentPanel .mio-rail-header strong{font-size:12px;flex:none;white-space:nowrap;}' +
      '#mioRailAgentPanel .mio-rail-header .mio-rail-spacer{flex:1;}' +
      '#mioRailAgentPanel .mio-rail-header .mio-rail-btn{flex:none;border:none;background:transparent;color:var(--muted,#687984);cursor:pointer;padding:4px;border-radius:6px;line-height:1;}' +
      '#mioRailAgentPanel .mio-rail-header .mio-rail-btn:hover{background:rgba(76,135,152,.12);}' +
      '#mioRailCompact{flex:1;display:flex;flex-direction:column;align-items:center;gap:10px;min-height:0;overflow-y:auto;padding-top:4px;}' +
      '#mioRailCompact .mio-cpt{position:relative;width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 0 2px rgba(255,255,255,.6);}' +
      '#mioRailFull{flex:1;display:none;flex-direction:column;gap:10px;min-height:0;overflow-y:auto;}' +
      '#mioRailFull .mio-rail-note{flex:none;font-size:11px;line-height:1.6;color:var(--muted,#687984);padding:8px 10px;background:var(--surface-soft,#f2f6f7);border:1px solid var(--line,#d9e2e6);border-radius:8px;}' +
      '#mioRailFull .mio-rail-card{flex:none;border:1px solid var(--line,#d9e2e6);border-radius:10px;padding:10px 12px;background:var(--surface,#ffffff);display:flex;flex-direction:column;gap:6px;}' +
      '#mioRailFull .mio-rail-card .mio-card-top{display:flex;align-items:center;gap:7px;}' +
      '#mioRailFull .mio-rail-card .mio-card-state{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10px;color:var(--muted,#687984);}' +
      '#mioRailErr{flex:none;font-size:11px;color:#c25b5b;display:none;}' +
      '.integrated-right-rail.expanded #mioRailAgentPanel{padding:14px;}' +
      '.integrated-right-rail.expanded #mioRailCompact{display:none;}' +
      '.integrated-right-rail.expanded #mioRailFull{display:flex;}' +
      '.integrated-right-rail:not(.expanded) #mioRailFull{display:none;}' +
      '.integrated-right-rail:not(.expanded) #mioRailCompact{display:flex;}'
    document.head.appendChild(st)
  }

  function buildPanel() {
    var p = document.createElement('div')
    p.id = 'mioRailAgentPanel'
    p.innerHTML =
      '<div class="mio-rail-header" title="点击展开/收起 Agent 工具">' +
        '<span class="mio-rail-dot"></span>' +
        '<strong>Agent 工具</strong>' +
        '<span class="mio-rail-spacer"></span>' +
        '<button type="button" class="mio-rail-btn" id="mioRailToggle" title="展开/收起">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>' +
        '</button>' +
      '</div>' +
      '<div id="mioRailCompact"></div>' +
      '<div id="mioRailFull">' +
        '<div class="mio-rail-note">桌宠是跨 Agent 的"脸"：启用即接管显示，停用立即释放——即换即用，无需重启。</div>' +
        '<div id="mioRailList" style="display:flex;flex-direction:column;gap:8px;"></div>' +
      '</div>' +
      '<div id="mioRailErr"></div>'
    $q('#mioRailToggle', p).addEventListener('click', function (e) {
      e.stopPropagation()
      toggleExpand()
    })
    p.querySelector('.mio-rail-header').addEventListener('click', function () {
      toggleExpand()
    })
    return p
  }

  function toggleExpand() {
    if (!rail) return
    var expanded = rail.classList.contains('expanded')
    if (expanded) rail.classList.remove('expanded')
    else rail.classList.add('expanded')
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
    row.className = 'mio-rail-card'
    row.innerHTML =
      '<div class="mio-card-top">' +
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
      '<div class="mio-card-state">' +
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
    if (!rail) return
    // 收起态：状态点列（title=名称·阶段）
    var compact = $q('#mioRailCompact')
    if (compact) {
      compact.innerHTML = ''
      for (var i = 0; i < agents.length; i++) {
        var a = agents[i]
        var dot = document.createElement('span')
        dot.className = 'mio-cpt'
        dot.style.background = statusColor(a)
        dot.title = (a.name || a.agent_id) + ' · ' + (a.enabled ? statusText(a) + ' · ' + (PHASE_LABELS[a.phase] || a.phase || '') : '未启用')
        compact.appendChild(dot)
      }
    }
    // 展开态：完整面板
    var list = $q('#mioRailList')
    if (!list) return
    list.innerHTML = ''
    var active = null
    for (var j = 0; j < agents.length; j++) {
      if (agents[j].active) { active = agents[j]; break }
    }
    var activeEl = $q('.mio-rail-header strong')
    if (activeEl) {
      activeEl.textContent = active
        ? 'Agent 工具 · ' + (active.name || active.agent_id) + (PHASE_LABELS[active.phase] ? ' · ' + PHASE_LABELS[active.phase] : '')
        : 'Agent 工具'
    }
    var errEl = $q('#mioRailErr')
    if (errEl) errEl.style.display = 'none'
    for (var k = 0; k < agents.length; k++) list.appendChild(renderAgentRow(agents[k]))
  }

  function refresh() {
    loadAgents().then(function () { render() }).catch(function () {
      if (!rail) return
      var err = $q('#mioRailErr')
      if (err) { err.textContent = '✗ 读取 Agent 状态失败'; err.style.display = 'block' }
    })
  }

  // ---------- 接管 rail ----------
  function takeOver(el) {
    rail = el
    if (rail.__mioRailSwitched) return
    rail.__mioRailSwitched = true
    injectStyle()
    rail.innerHTML = ''
    rail.style.display = ''
    rail.style.overflow = 'hidden'
    rail.appendChild(buildPanel())
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
