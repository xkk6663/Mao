/* settings-panel-inject.js — 重建设置页：废弃原版设置 UI，内嵌主界面框架的自有设置面板
 *
 * 数据源：
 *   GET  /api/companion/status                     → pet.settings（桌宠/语音/观察键）
 *   GET  /api/xiaozhi/observe/status               → 自动观察配置（enabled/min/max/quiet）
 *   GET  /api/xiaozhi/prompts                      → 图片识别/观察提示词
 *   GET  /api/companion/live2d/schedule            → 模型自动更换
 *   GET  /api/xiaozhi/status                       → 小智绑定/设备码
 * 保存：
 *   PATCH /api/companion/settings                   → 桌宠+语音+屏幕观察键
 *   POST  /api/xiaozhi/observe/start | /observe/stop → 自动观察
 *   PUT   /api/xiaozhi/prompts                      → 提示词
 *   PATCH /api/companion/live2d/schedule            → 模型调度
 *
 * UI：内嵌原版内容区（保留侧边栏/顶栏），样式走原框架 CSS 变量，观感统一。
 * 导航：点击原版「设置」导航项 → 打开本面板（不再进入原版设置页）。
 */
(function () {
  'use strict'
  if (window.__mioSettingsPanelLoaded) return
  window.__mioSettingsPanelLoaded = true

  // ---------- 工具 ----------
  function $q(sel, root) { return (root || document).querySelector(sel) }

  function apiGet(path) {
    return fetch(path).then(function (r) { return r.json() })
  }
  function apiSend(path, method, body) {
    return fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json() })
  }

  // ---------- 原框架内容区探测（与 mcp-tools-panel 一致） ----------
  function findShell() { return $q('.app-shell') }
  function findContentArea() {
    var shell = findShell()
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
          var a = el.offsetWidth * el.offsetHeight
          var b = best.offsetWidth * best.offsetHeight
          if (a > b) best = el
        }
        if (best) return best
      }
    }
    return null
  }

  // ---------- 导航：隐藏原版「设置」项，原位插入自有「设置」按钮（不带 Vue 事件） ----------
  var navBtn = null
  var ourBtn = null
  function ensureNav() {
    var nav = $q('nav')
    if (!nav) return
    var btns = nav.querySelectorAll('button.nav-item')
    var orig = null
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].__mioOurBtn) continue // 跳过我们自己的按钮
      var t = (btns[i].getAttribute('title') || '') + (btns[i].textContent || '')
      if (t.indexOf('设置') >= 0 && t.indexOf('小智') < 0) { orig = btns[i]; break }
    }
    if (!orig) return
    // 隐藏原版设置按钮（Vue 重渲染后恢复 → keepAlive 再次隐藏）
    if (!orig.__mioHidden) {
      orig.style.display = 'none'
      orig.__mioHidden = true
    }
    // 原位插入我们的按钮（clone 外观，去掉数据绑定属性，绑定自有 handler）
    if (!ourBtn || !ourBtn.isConnected) {
      ourBtn = orig.cloneNode(true)
      ourBtn.__mioOurBtn = true
      ourBtn.removeAttribute('data-scu-ref')
      ourBtn.addEventListener('click', function (e) {
        e.preventDefault()
        e.stopPropagation()
        togglePanel()
      })
      orig.parentNode.insertBefore(ourBtn, orig)
    }
    // 确保我们的按钮始终可见（clone 可能复制了 display:none / Vue 可能置 hide）
    ourBtn.style.display = ''
    navBtn = ourBtn
  }

  // ---------- 面板 ----------
  var panel = null
  var state = {
    settings: {}, observe: {}, prompts: {}, schedule: {}, xz: {},
  }
  var activeTab = 'pet'

  var TABS = [
    { id: 'pet', label: '桌宠' },
    { id: 'voice', label: '语音' },
    { id: 'observe', label: '屏幕观察' },
    { id: 'prompts', label: '提示词' },
    { id: 'xz', label: '小智' },
  ]

  function setNavActive(on) {
    if (navBtn) navBtn.classList.toggle('active', !!on)
  }

  function buildPanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = 'mio-settings-panel'
    panel.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;z-index:98;display:none;flex-direction:column;' +
      'background:var(--app-bg, #e9eef0);color:var(--ink, #20303a);' +
      'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;'
    panel.innerHTML =
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:12px 20px;background:var(--sidebar-bg, #f4f7f8);border-bottom:1px solid var(--line, #d9e2e6);">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:var(--accent, #4c8798);flex:none;"></span>' +
        '<strong style="font-size:14px;flex:none;">设置</strong>' +
        '<span style="flex:1;font-size:11px;color:var(--muted, #687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" id="mioSetStatus">桌宠 · 语音 · 观察 · 提示词 · 小智</span>' +
        '<button type="button" id="mioSetClose" title="关闭设置" style="border:none;background:transparent;font-size:16px;cursor:pointer;color:var(--muted, #687984);padding:2px 6px;">✕</button>' +
      '</div>' +
      '<div style="flex:none;display:flex;gap:4px;padding:8px 20px;background:var(--surface-soft, #f2f6f7);border-bottom:1px solid var(--line, #d9e2e6);" id="mioSetTabs"></div>' +
      '<div id="mioSetBody" style="flex:1;overflow-y:auto;padding:16px 20px;"></div>' +
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:10px 20px;border-top:1px solid var(--line, #d9e2e6);background:var(--sidebar-bg, #f4f7f8);">' +
        '<span style="flex:1;font-size:11px;color:var(--muted, #687984);" id="mioSetHint">修改后点击保存生效</span>' +
        '<button type="button" id="mioSetCancel" style="border:1px solid var(--line, #d9e2e6);background:transparent;border-radius:8px;padding:6px 18px;font-size:12px;cursor:pointer;color:var(--ink, #20303a);">取消</button>' +
        '<button type="button" id="mioSetSave" style="border:none;background:var(--accent, #4c8798);color:#fff;border-radius:8px;padding:6px 22px;font-size:12px;cursor:pointer;">保存</button>' +
      '</div>'
    // 内容区可能无 position:relative，补上
    var host = findContentArea()
    if (host && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
      panel.__mioHostFixed = true
    }
    ;(host || document.body).appendChild(panel)
    $q('#mioSetClose', panel).addEventListener('click', deactivate)
    $q('#mioSetCancel', panel).addEventListener('click', deactivate)
    $q('#mioSetSave', panel).addEventListener('click', saveAll)
    buildTabs()
    return panel
  }

  function buildTabs() {
    var bar = $q('#mioSetTabs', panel)
    if (!bar) return
    bar.innerHTML = ''
    TABS.forEach(function (t) {
      var b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('data-tab', t.id)
      b.textContent = t.label
      b.style.cssText = 'border:none;background:transparent;border-radius:8px;padding:5px 14px;font-size:12px;cursor:pointer;color:var(--muted, #687984);'
      b.addEventListener('click', function () { setTab(t.id) })
      bar.appendChild(b)
    })
    setTab(activeTab)
  }

  function setTab(id) {
    activeTab = id
    var bar = $q('#mioSetTabs', panel)
    if (bar) {
      var btns = bar.querySelectorAll('button[data-tab]')
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-tab') === id
        btns[i].style.background = on ? 'var(--accent, #4c8798)' : 'transparent'
        btns[i].style.color = on ? '#fff' : 'var(--muted, #687984)'
      }
    }
    renderBody(id)
  }

  // ---------- 控件 ----------
  function makeSwitch(checked, title) {
    var sw = document.createElement('button')
    sw.type = 'button'
    sw.className = 'mio-set-switch'
    sw.setAttribute('data-on', checked ? '1' : '0')
    sw.title = title || ''
    sw.style.cssText = 'flex:none;width:38px;height:22px;border-radius:11px;border:none;cursor:pointer;position:relative;transition:background .18s;' + (checked ? 'background:var(--accent, #4c8798);' : 'background:var(--line-strong, #c4d1d7);')
    var knob = document.createElement('span')
    knob.style.cssText = 'position:absolute;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .18s;' + (checked ? 'left:18px;' : 'left:2px;')
    sw.appendChild(knob)
    return sw
  }
  function readSwitch(sw) { return sw.getAttribute('data-on') === '1' }
  function setSwitch(sw, on) {
    sw.setAttribute('data-on', on ? '1' : '0')
    sw.style.background = on ? 'var(--accent, #4c8798)' : 'var(--line-strong, #c4d1d7)'
    sw.querySelector('span').style.left = on ? '18px' : '2px'
  }

  function row(label, desc, control, key, onChanged) {
    var r = document.createElement('div')
    r.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface-soft, #f2f6f7);border:1px solid var(--line, #d9e2e6);border-radius:10px;margin-bottom:10px;'
    var info = document.createElement('div')
    info.style.cssText = 'flex:1;min-width:0;'
    var nm = document.createElement('div')
    nm.style.cssText = 'font-size:12px;font-weight:600;color:var(--ink, #20303a);'
    nm.textContent = label
    var ds = document.createElement('div')
    ds.style.cssText = 'font-size:11px;color:var(--muted, #687984);line-height:1.5;margin-top:2px;'
    ds.textContent = desc || ''
    info.appendChild(nm)
    info.appendChild(ds)
    r.appendChild(info)
    if (control) {
      control.setAttribute('__mioKey', key)
      r.appendChild(control)
      // switch 点击自动翻转
      if (control.classList && control.classList.contains('mio-set-switch')) {
        control.addEventListener('click', function () {
          setSwitch(control, !readSwitch(control))
        })
      }
      if (onChanged) {
        control.addEventListener('click', function () { onChanged(control, readSwitch(control)) }, true)
        control.addEventListener('input', function () { onChanged(control, control.value) })
        control.addEventListener('change', function () { onChanged(control, control.value) })
      }
    }
    return r
  }

  function section(title) {
    var s = document.createElement('div')
    s.style.cssText = 'font-size:12px;font-weight:600;color:var(--muted, #687984);margin:14px 0 8px;display:flex;align-items:center;gap:6px;'
    var dot = document.createElement('span')
    dot.style.cssText = 'width:4px;height:12px;border-radius:2px;background:var(--accent, #4c8798);'
    s.appendChild(dot)
    s.appendChild(document.createTextNode(title))
    return s
  }

  function makeSlider(value, min, max, step, suffix) {
    var wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex:none;'
    var inp = document.createElement('input')
    inp.type = 'range'
    inp.min = String(min)
    inp.max = String(max)
    inp.step = String(step || 1)
    inp.value = String(value)
    inp.style.cssText = 'width:120px;accent-color:var(--accent, #4c8798);'
    var val = document.createElement('span')
    val.style.cssText = 'font-size:11px;color:var(--ink, #20303a);min-width:42px;text-align:right;'
    val.textContent = value + (suffix || '')
    inp.addEventListener('input', function () { val.textContent = inp.value + (suffix || '') })
    wrap.appendChild(inp)
    wrap.appendChild(val)
    wrap.__mioInput = inp
    wrap.__mioVal = val
    return wrap
  }
  function readSlider(wrap) { return Number(wrap.__mioInput.value) }

  function makeSelect(value, options) {
    var sel = document.createElement('select')
    sel.style.cssText = 'flex:none;border:1px solid var(--line, #d9e2e6);border-radius:8px;background:var(--surface-soft, #f2f6f7);color:var(--ink, #20303a);font-size:12px;padding:4px 8px;'
    options.forEach(function (o) {
      var op = document.createElement('option')
      op.value = o.v
      op.textContent = o.t
      if (String(o.v) === String(value)) op.selected = true
      sel.appendChild(op)
    })
    return sel
  }
  function readSelect(sel) { return sel.value }

  function makeText(text) {
    var ta = document.createElement('textarea')
    ta.style.cssText = 'flex:none;width:220px;height:52px;border:1px solid var(--line, #d9e2e6);border-radius:8px;background:var(--surface-soft, #f2f6f7);color:var(--ink, #20303a);font-size:12px;padding:6px 8px;resize:none;'
    ta.value = text || ''
    return ta
  }
  function readText(ta) { return ta.value.trim() }

  // ---------- 渲染 ----------
  function renderBody(id) {
    var body = $q('#mioSetBody', panel)
    if (!body) return
    body.innerHTML = ''
    var s = state.settings || {}
    if (id === 'pet') {
      body.appendChild(section('外观'))
      body.appendChild(row('桌宠大小', '整体缩放百分比', makeSlider(s.pet_size_percent != null ? s.pet_size_percent : 80, 20, 200, 5, '%'), 'pet_size_percent'))
      body.appendChild(row('模型缩放', 'Live2D 模型内缩放', makeSlider(s.live2d_scale != null ? s.live2d_scale : 1.0, 0.5, 2.0, 0.05, '×'), 'live2d_scale'))
      body.appendChild(row('垂直偏移', '模型上下偏移', makeSlider(s.live2d_vertical_offset != null ? s.live2d_vertical_offset : 0, -200, 200, 5, 'px'), 'live2d_vertical_offset'))
      body.appendChild(section('行为'))
      body.appendChild(row('跟随鼠标', '角色视线跟随鼠标移动', makeSwitch(!!s.live2d_follow_cursor, '跟随鼠标'), 'live2d_follow_cursor'))
      body.appendChild(row('窗口置顶', '桌宠窗口始终置顶', makeSwitch(!!s.live2d_always_on_top, '窗口置顶'), 'live2d_always_on_top'))
      body.appendChild(row('透明穿透', '鼠标点击穿透（锁定后生效）', makeSwitch(!!s.live2d_smart_passthrough, '透明穿透'), 'live2d_smart_passthrough'))
      body.appendChild(row('对话气泡', '显示小智对话气泡', makeSwitch(!!s.live2d_speech_bubble_enabled, '对话气泡'), 'live2d_speech_bubble_enabled'))
      body.appendChild(section('模型自动更换'))
      body.appendChild(row('自动更换模型', '每天定时随机更换角色', makeSwitch(!!(state.schedule && state.schedule.enabled), '自动更换模型'), 'schedule_enabled'))
      body.appendChild(row('更换时间', '每天此时间触发', makeSelect((state.schedule && state.schedule.time) || '12:00', [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 8, 9, 10, 11].map(function (h) { return { v: h + ':00', t: h + ':00' } })), 'schedule_time'))
    } else if (id === 'voice') {
      body.appendChild(section('小智语音'))
      body.appendChild(row('语音回复', '小智回答时播放语音', makeSwitch(s.voice_enabled !== false, '语音回复'), 'voice_enabled'))
      body.appendChild(row('流式播放', '边接收边播放（低延迟）', makeSwitch(!!s.voice_streaming_enabled, '流式播放'), 'voice_streaming_enabled'))
      body.appendChild(row('音量', '语音播放音量', makeSlider(s.voice_volume != null ? s.voice_volume : 85, 0, 100, 5, '%'), 'voice_volume'))
      body.appendChild(row('回复语言', '小智语音与文字语言', makeSelect(s.pet_speech_language || 'zh', [{ v: 'zh', t: '中文' }, { v: 'ja', t: '日语' }]), 'pet_speech_language'))
      body.appendChild(section('屏幕观察播报'))
      body.appendChild(row('观察时语音播报', '屏幕观察分析后语音播报', makeSwitch(!!s.speak_screen_observations, '观察语音播报'), 'speak_screen_observations'))
    } else if (id === 'observe') {
      body.appendChild(section('自动屏幕观察'))
      body.appendChild(row('启用自动观察', '随机间隔截屏让小智点评', makeSwitch(!!(state.observe && state.observe.enabled), '自动观察'), 'observe_enabled'))
      body.appendChild(row('随机间隔（秒）', '两次自动观察的最小/最大间隔', (function () {
        var w = document.createElement('div')
        w.style.cssText = 'display:flex;align-items:center;gap:6px;flex:none;'
        var mn = document.createElement('input')
        mn.type = 'number'
        mn.min = '60'
        mn.step = '30'
        mn.value = String((state.observe && state.observe.min_seconds) || 300)
        mn.style.cssText = 'width:64px;border:1px solid var(--line, #d9e2e6);border-radius:8px;font-size:12px;padding:4px;background:var(--surface-soft, #f2f6f7);color:var(--ink, #20303a);'
        var mx = document.createElement('input')
        mx.type = 'number'
        mx.min = '120'
        mx.step = '30'
        mx.value = String((state.observe && state.observe.max_seconds) || 900)
        mx.style.cssText = 'width:64px;border:1px solid var(--line, #d9e2e6);border-radius:8px;font-size:12px;padding:4px;background:var(--surface-soft, #f2f6f7);color:var(--ink, #20303a);'
        var lbl = document.createElement('span')
        lbl.style.cssText = 'font-size:11px;color:var(--muted, #687984);'
        lbl.textContent = '～'
        w.appendChild(mn)
        w.appendChild(lbl)
        w.appendChild(mx)
        w.setAttribute('__mioKey', 'observe_interval')
        w.__mioMin = mn
        w.__mioMax = mx
        return w
      })(), 'observe_interval'))
      body.appendChild(row('免打扰时段', '此时间段暂停自动观察', (function () {
        var w = document.createElement('div')
        w.style.cssText = 'display:flex;align-items:center;gap:6px;flex:none;'
        var st = document.createElement('input')
        st.type = 'time'
        st.value = (state.observe && state.observe.quiet_start) || '23:00'
        st.style.cssText = 'border:1px solid var(--line, #d9e2e6);border-radius:8px;font-size:12px;padding:3px;background:var(--surface-soft, #f2f6f7);color:var(--ink, #20303a);'
        var en = document.createElement('input')
        en.type = 'time'
        en.value = (state.observe && state.observe.quiet_end) || '08:00'
        en.style.cssText = 'border:1px solid var(--line, #d9e2e6);border-radius:8px;font-size:12px;padding:3px;background:var(--surface-soft, #f2f6f7);color:var(--ink, #20303a);'
        var lbl = document.createElement('span')
        lbl.textContent = '至'
        lbl.style.cssText = 'font-size:11px;color:var(--muted, #687984);'
        w.appendChild(st)
        w.appendChild(lbl)
        w.appendChild(en)
        w.setAttribute('__mioKey', 'observe_quiet')
        w.__mioStart = st
        w.__mioEnd = en
        return w
      })(), 'observe_quiet'))
      body.appendChild(section('立即观察语音'))
      body.appendChild(row('立即观察播报语音', '手动触发观察时小智语音回答', makeSwitch(s.screen_ai_enabled !== false, '立即观察语音'), 'screen_ai_enabled'))
    } else if (id === 'prompts') {
      body.appendChild(section('图片识别提示词'))
      body.appendChild(row('图片识别前置提示词', '发图给小智时附加的要求', makeText(state.prompts && state.prompts.image_prompt), 'image_prompt'))
      body.appendChild(row('60字以内约束', '强制回答不超过60字', makeSwitch(state.prompts ? state.prompts.force_60 !== false : true, '60字约束'), 'force_60'))
      body.appendChild(section('屏幕观察提示词'))
      body.appendChild(row('观察提示词', '自动/手动观察时附加的要求', makeText(state.prompts && state.prompts.observe_prompt), 'observe_prompt'))
    } else if (id === 'xz') {
      var xz = state.xz || {}
      body.appendChild(section('小智连接'))
      var info = document.createElement('div')
      info.style.cssText = 'background:var(--surface-soft, #f2f6f7);border:1px solid var(--line, #d9e2e6);border-radius:10px;padding:12px 14px;font-size:12px;line-height:2;color:var(--ink, #20303a);'
      info.innerHTML =
        '<div>绑定状态：<b style="color:var(--accent, #4c8798);">' + (xz.bound ? '已绑定' : '未绑定') + '</b></div>' +
        '<div>设备码：<span style="font-family:Consolas,Menlo,monospace;">' + (xz.machine_code || '-') + '</span></div>' +
        '<div>MAC：<span style="font-family:Consolas,Menlo,monospace;">' + (xz.mac || '-') + '</span></div>' +
        '<div>云端：<span style="font-family:Consolas,Menlo,monospace;word-break:break-all;">' + (xz.upstream || '-') + '</span></div>' +
        '<div>连接：' + (xz.connected ? '已连接' : '未连接') + ' · 会话 ' + (xz.session_id || '-') + '</div>'
      body.appendChild(info)
      body.appendChild(section('说明'))
      var note = document.createElement('div')
      note.style.cssText = 'font-size:11px;color:var(--muted, #687984);line-height:1.8;padding:0 4px;'
      note.textContent = '小智官方云免费接入（绑定设备后使用官方音色）。如需更换设备绑定，请到小智控制台处理。'
      body.appendChild(note)
    }
  }

  // ---------- 加载 / 保存 ----------
  function loadAll() {
    var st = $q('#mioSetStatus', panel)
    if (st) st.textContent = '加载中…'
    return Promise.all([
      apiGet('/api/companion/status').then(function (j) {
        state.settings = (j && j.pet && j.pet.settings) || {}
      }).catch(function () { state.settings = {} }),
      apiGet('/api/xiaozhi/observe/status').then(function (j) { state.observe = j || {} }).catch(function () { state.observe = {} }),
      apiGet('/api/xiaozhi/prompts').then(function (j) { state.prompts = j || {} }).catch(function () { state.prompts = {} }),
      apiGet('/api/companion/live2d/schedule').then(function (j) { state.schedule = (j && j.schedule) ? j.schedule : (j || {}) }).catch(function () { state.schedule = {} }),
      apiGet('/api/xiaozhi/status').then(function (j) { state.xz = j || {} }).catch(function () { state.xz = {} }),
    ]).then(function () {
      renderBody(activeTab)
      var st2 = $q('#mioSetStatus', panel)
      if (st2) st2.textContent = '已加载 · 修改后点击保存生效'
    }).catch(function () {
      var st3 = $q('#mioSetStatus', panel)
      if (st3) st3.textContent = '部分数据加载失败'
    })
  }

  function collectValues() {
    var body = $q('#mioSetBody', panel)
    if (!body) return {}
    var out = {}
    var rows = body.querySelectorAll('[data-row]')
    // 按 __mioKey 收集：控件在 row 的 children 里
    var controls = body.querySelectorAll('input[type="range"], button.mio-set-switch, select, textarea, input[type="number"], input[type="time"]')
    var vals = {}
    // 用 row 结构收集：遍历所有带 __mioKey 的容器
    var keys = body.querySelectorAll('[__mioKey]')
    for (var i = 0; i < keys.length; i++) {
      var el = keys[i]
      var k = el.getAttribute('__mioKey')
      var v
      if (el.classList && el.classList.contains('mio-set-switch')) v = readSwitch(el)
      else if (el.tagName === 'SELECT') v = readSelect(el)
      else if (el.tagName === 'TEXTAREA') v = readText(el)
      else if (el.tagName === 'INPUT' && el.type === 'range') v = Number(el.value)
      else if (el.__mioMin) v = { min: Number(el.__mioMin.value), max: Number(el.__mioMax.value) }
      else if (el.__mioStart) v = { start: el.__mioStart.value, end: el.__mioEnd.value }
      if (k && v !== undefined) vals[k] = v
    }
    return vals
  }

  function saveAll() {
    var vals = collectValues()
    var btn = $q('#mioSetSave', panel)
    var st = $q('#mioSetStatus', panel)
    if (btn) { btn.disabled = true; btn.textContent = '保存中…' }
    // 1) 桌宠 + 语音 + 观察键 → PATCH /api/companion/settings
    var settingsBody = {}
    var settingsKeys = [
      'pet_size_percent', 'live2d_scale', 'live2d_vertical_offset',
      'live2d_follow_cursor', 'live2d_always_on_top', 'live2d_smart_passthrough',
      'live2d_speech_bubble_enabled', 'voice_enabled', 'voice_streaming_enabled',
      'voice_volume', 'pet_speech_language', 'speak_screen_observations',
      'screen_ai_enabled',
    ]
    settingsKeys.forEach(function (k) { if (vals[k] !== undefined) settingsBody[k] = vals[k] })
    // 2) 自动观察 → observe/start or stop
    var observeBody = {}
    if (vals.observe_interval) {
      observeBody.min_seconds = vals.observe_interval.min
      observeBody.max_seconds = vals.observe_interval.max
    }
    if (vals.observe_quiet) {
      observeBody.quiet_start = vals.observe_quiet.start
      observeBody.quiet_end = vals.observe_quiet.end
    }
    // 3) 提示词 → PUT prompts
    var promptsBody = {}
    if (vals.image_prompt !== undefined) promptsBody.image_prompt = vals.image_prompt
    if (vals.observe_prompt !== undefined) promptsBody.observe_prompt = vals.observe_prompt
    if (vals.force_60 !== undefined) promptsBody.force_60 = !!vals.force_60
    // 4) 模型调度 → PATCH live2d/schedule
    var schedBody = {}
    if (vals.schedule_enabled !== undefined) schedBody.enabled = !!vals.schedule_enabled
    if (vals.schedule_time !== undefined) schedBody.time = vals.schedule_time

    var proms = []
    if (Object.keys(settingsBody).length) proms.push(apiSend('/api/companion/settings', 'PATCH', settingsBody))
    if (vals.observe_enabled !== undefined) {
      proms.push(apiSend(vals.observe_enabled ? '/api/xiaozhi/observe/start' : '/api/xiaozhi/observe/stop', 'POST', observeBody))
    } else if (Object.keys(observeBody).length) {
      proms.push(apiSend('/api/xiaozhi/observe/start', 'POST', observeBody))
    }
    if (Object.keys(promptsBody).length) proms.push(apiSend('/api/xiaozhi/prompts', 'PUT', promptsBody))
    if (Object.keys(schedBody).length) proms.push(apiSend('/api/companion/live2d/schedule', 'PATCH', schedBody))

    Promise.all(proms.map(function (p) { return p.catch(function (e) { return { __err: String(e && e.message || e) } }) }))
      .then(function (results) {
        var errs = results.filter(function (r) { return r && r.__err || (r && r.detail) })
        if (st) st.textContent = errs.length ? ('保存完成，但有 ' + errs.length + ' 项失败') : '已保存 ✓'
        return loadAll()
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = '保存' }
      })
  }

  // ---------- 激活 / 退出 ----------
  function activate() {
    window.__mioSettingsPanelActive = true
    buildPanel()
    setNavActive(true)
    panel.style.display = 'flex'
    loadAll()
  }
  function deactivate() {
    window.__mioSettingsPanelActive = false
    setNavActive(false)
    if (panel) {
      if (panel.__mioHostFixed) {
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

  // 点击其他导航项时关闭本面板
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('nav button.nav-item')
    if (!b || b === navBtn) return
    if (panel && panel.style.display === 'flex') deactivate()
  }, true)

  // 保活
  function keepAlive() {
    try {
      ensureNav()
      if (panel && panel.style.display === 'flex') {
        if (!panel.isConnected) {
          var host = findContentArea() || document.body
          host.appendChild(panel)
          renderBody(activeTab)
        }
      }
    } catch (e) { /* ignore */ }
  }
  var mo = new MutationObserver(function () { try { keepAlive() } catch (e) {} })
  try {
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true })
  } catch (e) {
    mo.observe(document.documentElement, { childList: true, subtree: true })
  }
  setInterval(keepAlive, 1500)
  setTimeout(ensureNav, 1000)
  setTimeout(ensureNav, 3000)
})()
