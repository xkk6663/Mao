/* mcp-tools-panel.js — Mio 左侧导航「小智工具」管理页：MCP 工具集中开关管理
 * 数据：GET /api/xiaozhi/mcp-tools（注册表+开关状态） / PUT（实时开关，持久化到 JSON）
 * 说明：开关只影响"AI 自主调用"（tools/list 只返回开启的工具，云端 LLM 在对话中自动调用）；
 *       截图提问 / 立即观察 / 聊天发图等手动功能走 /vision 接口，不受开关影响。
 * 生效：开关即时保存，云端在下次会话初始化（通常重连后几分钟内）刷新工具列表。
 * v20261013b：UI 重构——不再使用 position:fixed 全屏覆盖面板，改为内嵌原版 MIO 框架
 *             内容区渲染（保留侧边栏/顶栏，观感统一），配色全部走原框架 CSS 变量
 *             （--app-bg/--ink/--muted/--line/--accent/--surface-soft），跟随主题切换。
 */
(function () {
  if (window.__mioMcpToolsPanelLoaded) return
  window.__mioMcpToolsPanelLoaded = true

  var CAT_ORDER = ['视觉', '基础', '资讯', '娱乐', '系统', '效率']
  var tools = []           // [{name, description, category, enabled, default_enabled}]
  var busy = false

  // ---------- 工具 ----------
  function $q(sel, root) { return (root || document).querySelector(sel) }

  function loadTools() {
    return fetch('/api/xiaozhi/mcp-tools')
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.detail) || '加载失败')
        tools = (j.tools || []).slice()
      })
  }
  function setTool(name, enabled) {
    if (busy) return Promise.reject(new Error('操作进行中'))
    busy = true
    return fetch('/api/xiaozhi/mcp-tools', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: {} }),
    }).then(function () {
      return fetch('/api/xiaozhi/mcp-tools', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: (function () { var o = {}; o[name] = enabled; return o })() }),
      })
    }).then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.detail) || '保存失败')
        for (var i = 0; i < tools.length; i++) {
          if (tools[i].name === name) tools[i].enabled = !!enabled
        }
      })
      .catch(function (e) { throw e })
      .finally(function () { busy = false })
  }

  // ---------- 原框架探测 ----------
  // Vue 应用结构：.app-shell > .sidebar(nav 在其中) + 内容区。运行时探测内容区容器。
  function findShell() { return $q('.app-shell') }
  function findContentArea() {
    var shell = findShell()
    if (shell) {
      var main = shell.querySelector('main')
      if (main && main.offsetParent !== null) return main
    }
    // 侧边栏 nav 的父节点之后的可见兄弟，取面积最大者
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
          var a = el.offsetWidth * el.offsetHeight
          var b = best.offsetWidth * best.offsetHeight
          if (a > b) best = el
        }
        if (best) return best
      }
    }
    return null
  }

  // ---------- 导航项 ----------
  var navBtn = null
  var NAV_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>'

  function ensureNav() {
    if (navBtn && navBtn.isConnected) return
    var nav = $q('nav')
    if (!nav) return
    var ref = null
    var btns = nav.querySelectorAll('button.nav-item')
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].getAttribute('title') || '') + (btns[i].textContent || '')
      if (t.indexOf('设置') >= 0 || t.indexOf('settings') >= 0) { ref = btns[i]; break }
    }
    navBtn = document.createElement('button')
    navBtn.type = 'button'
    navBtn.className = 'nav-item xz-mcp-nav'
    navBtn.title = '小智工具'
    navBtn.innerHTML = NAV_SVG + '<span>小智工具</span>'
    navBtn.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      togglePanel()
    })
    if (ref && ref.nextSibling) nav.insertBefore(navBtn, ref.nextSibling)
    else nav.appendChild(navBtn)
  }

  // ---------- 内嵌页面（渲染在原框架内容区，不是 fixed 覆盖层） ----------
  var panel = null

  function setNavActive(on) {
    if (navBtn) navBtn.classList.toggle('active', !!on)
  }

  function buildPanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = 'xz-mcp-panel'
    // 样式全部走原框架 CSS 变量 → 自动跟随主题（clear/rose/forest...）
    panel.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;z-index:99;display:none;flex-direction:column;' +
      'background:var(--app-bg, #e9eef0);color:var(--ink, #20303a);' +
      'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;'
    panel.innerHTML =
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px;background:var(--sidebar-bg, #f4f7f8);border-bottom:1px solid var(--line, #d9e2e6);">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:var(--accent, #4c8798);flex:none;"></span>' +
        '<strong style="font-size:14px;flex:none;">小智工具</strong>' +
        '<span style="flex:1;font-size:11px;color:var(--muted, #687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" id="xzMcpStatus">MCP 工具集中管理</span>' +
        '<button type="button" id="xzMcpClose" title="关闭小智工具页" style="border:none;background:transparent;font-size:16px;cursor:pointer;color:var(--muted, #687984);padding:2px 6px;">✕</button>' +
      '</div>' +
      '<div style="flex:none;padding:10px 20px;font-size:11px;line-height:1.7;color:var(--muted, #687984);background:var(--surface-soft, #f2f6f7);border-bottom:1px solid var(--line, #d9e2e6);">' +
        '开启的工具会出现在小智的能力列表里，AI 会在对话中自动调用（官方音色回答）。开关即时保存，云端在下次会话刷新时生效。' +
        '截图提问 / 立即观察 / 聊天发图不受开关影响。' +
      '</div>' +
      '<div id="xzMcpList" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;"></div>'
    // 内容区可能没有 position:relative，临时补上，移除页面时恢复
    var host = findContentArea()
    if (host && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
      panel.__xzHostFixed = true
    }
    ;(host || document.body).appendChild(panel)
    panel.addEventListener('click', function (e) {
      var sw = e.target.closest && e.target.closest('.xz-mcp-switch')
      if (!sw) return
      var name = sw.getAttribute('data-name')
      var on = sw.getAttribute('data-on') !== '1'
      toggleSwitch(sw, name, on)
    })
    $q('#xzMcpClose', panel).addEventListener('click', function () {
      deactivate()
    })
    return panel
  }

  function renderList() {
    var list = $q('#xzMcpList', panel)
    if (!list) return
    list.innerHTML = ''
    var byCat = {}
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i]
      ;(byCat[t.category || '其他'] = byCat[t.category || '其他'] || []).push(t)
    }
    CAT_ORDER.forEach(function (cat) {
      var items = byCat[cat] || []
      if (!items.length) return
      var sec = document.createElement('div')
      sec.style.cssText = 'display:flex;flex-direction:column;gap:8px;'
      var h = document.createElement('div')
      h.style.cssText = 'font-size:12px;font-weight:600;color:var(--muted, #687984);margin-bottom:2px;display:flex;align-items:center;gap:6px;'
      var dot = document.createElement('span')
      dot.style.cssText = 'width:4px;height:12px;border-radius:2px;background:var(--accent, #4c8798);'
      h.appendChild(dot)
      h.appendChild(document.createTextNode(cat))
      sec.appendChild(h)
      items.forEach(function (t) {
        var card = document.createElement('div')
        card.style.cssText = 'display:flex;align-items:flex-start;gap:10px;background:var(--surface-soft, #f2f6f7);border:1px solid var(--line, #d9e2e6);border-radius:10px;padding:10px 12px;'
        var info = document.createElement('div')
        info.style.cssText = 'flex:1;min-width:0;'
        var nm = document.createElement('div')
        nm.style.cssText = 'font-size:12px;font-weight:600;color:var(--ink, #20303a);font-family:Consolas,Menlo,monospace;word-break:break-all;'
        nm.textContent = t.name
        var ds = document.createElement('div')
        ds.style.cssText = 'font-size:11px;color:var(--muted, #687984);line-height:1.5;margin-top:3px;'
        ds.textContent = t.description || ''
        info.appendChild(nm)
        info.appendChild(ds)
        card.appendChild(info)
        card.appendChild(makeSwitch(t))
        sec.appendChild(card)
      })
      list.appendChild(sec)
    })
    if (!tools.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--muted, #687984);padding:40px 0;font-size:12px;">加载中…</div>'
    }
  }

  function makeSwitch(t) {
    var sw = document.createElement('button')
    sw.type = 'button'
    sw.className = 'xz-mcp-switch'
    sw.setAttribute('data-name', t.name)
    sw.setAttribute('data-on', t.enabled ? '1' : '0')
    sw.title = t.enabled ? '已开启：AI 可自主调用' : '已关闭：AI 不会调用'
    sw.style.cssText = 'flex:none;width:38px;height:22px;border-radius:11px;border:none;cursor:pointer;position:relative;transition:background .18s;margin-top:2px;' + (t.enabled ? 'background:var(--accent, #4c8798);' : 'background:var(--line-strong, #c4d1d7);')
    var knob = document.createElement('span')
    knob.style.cssText = 'position:absolute;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .18s;' + (t.enabled ? 'left:18px;' : 'left:2px;')
    sw.appendChild(knob)
    return sw
  }

  function toggleSwitch(sw, name, on) {
    sw.setAttribute('data-on', on ? '1' : '0')
    sw.style.background = on ? 'var(--accent, #4c8798)' : 'var(--line-strong, #c4d1d7)'
    sw.querySelector('span').style.left = on ? '18px' : '2px'
    sw.title = on ? '已开启：AI 可自主调用' : '已关闭：AI 不会调用'
    var old = sw.style.opacity
    sw.style.opacity = '0.55'
    setTool(name, on).then(function () {
      sw.style.opacity = old
    }).catch(function (e) {
      sw.setAttribute('data-on', on ? '0' : '1')
      sw.style.background = on ? 'var(--line-strong, #c4d1d7)' : 'var(--accent, #4c8798)'
      sw.querySelector('span').style.left = on ? '2px' : '18px'
      sw.style.opacity = old
      var st = $q('#xzMcpStatus', panel)
      if (st) st.textContent = '保存失败：' + ((e && e.message) || '未知错误')
    })
  }

  // ---------- 激活 / 退出 ----------
  function activate() {
    buildPanel()
    setNavActive(true)
    panel.style.display = 'flex'
    var st = $q('#xzMcpStatus', panel)
    if (st) st.textContent = '加载中…'
    loadTools().then(function () {
      renderList()
      if (st) st.textContent = tools.length + ' 个工具 · ' + tools.filter(function (t) { return t.enabled }).length + ' 个已开启'
    }).catch(function (e) {
      if (st) st.textContent = '加载失败：' + ((e && e.message) || '未知错误')
      renderList()
    })
  }
  function deactivate() {
    setNavActive(false)
    if (panel) {
      if (panel.__xzHostFixed) {
        var host = findContentArea()
        if (host) host.style.position = ''
      }
      panel.style.display = 'none'
    }
  }
  function togglePanel() {
    if (panel && panel.style.display === 'flex') deactivate()
    else activate()
  }

  // 点击其他导航项（对话/桌宠/设置）时自动关闭本页
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('nav button.nav-item')
    if (!b || b === navBtn) return
    deactivate()
  }, true)

  // 保活：Vue 重渲染后导航按钮不丢失；激活状态下内容区被重渲染清空时自动重建页面
  function keepAlive() {
    try {
      ensureNav()
      if (panel && panel.style.display === 'flex') {
        if (!panel.isConnected) {
          var host = findContentArea() || document.body
          host.appendChild(panel)
          var st = $q('#xzMcpStatus', panel)
          if (st) st.textContent = tools.length ? (tools.length + ' 个工具 · ' + tools.filter(function (t) { return t.enabled }).length + ' 个已开启') : '加载中…'
          renderList()
        }
      }
    } catch (e) { /* ignore */ }
  }
  var mo = new MutationObserver(function () { try { keepAlive() } catch (e) {} })
  mo.observe(document.body, { childList: true, subtree: true })
  setInterval(keepAlive, 1500)
  ensureNav()
})()
