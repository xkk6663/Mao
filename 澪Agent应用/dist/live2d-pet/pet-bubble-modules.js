/* pet-bubble-modules.js — 桌宠「模块化泡泡系统」（A组 3.1，对标 whale-widget #7）
 *
 * 定位：围绕桌宠的一组**可开关、可拖拽、可换色**的小信息卡（模块泡泡）。
 * whale-widget 的护城河是"模块化泡泡 + 拖拽排版"；这里是本仓库的同一能力，
 * 且模块数据源是**跨 Agent 总线**（12 态），不只是单 Agent 余额。
 *
 * 6 类模块（v1）：
 *   status    Agent 状态（哪些 Agent 在跑、当前 phase——来自总线快照）
 *   quote     随机语句（复用 pet-idle-talk 内容池，定时轮换）
 *   image     随机图片（复用 pet-random-image 池，定时轮换）
 *   text      自定义文本（模块库内联编辑）
 *   clock     时钟/日期
 *   countdown 倒计时（目标时间在模块库内编辑，到点变"已到达"）
 *
 * 设计要点：
 *   - **零依赖**：只暴露 window.__mioPetBubbleModules；宿主数据通过
 *     window.__mioPetStatusSnapshot / __mioPetIdleTalk / __mioPetRandomImage /
 *     __mioPetAnchor 注入，没有就降级（对应模块显示占位/隐藏）；
 *   - **配置 = 渲染层 localStorage**（桌宠侧自足，不加后端字段）；
 *   - **布局**：每模块独立坐标（拖拽保存，双击卡片复位默认位）；
 *   - **样式**：每模块独立 accent（预设色循环选择），复用气泡的调色板变量机制。
 */
(function () {
  if (window.__mioPetBubbleModules) return

  var CONFIG_KEY = 'mio-pet-bubble-modules'
  var ROTATE_MS = 5 * 60 * 1000
  var ACCENTS = ['#4f6bed', '#e8618c', '#3aa675', '#e8973a', '#7a5fd0', '#2d4148']

  // 模块定义：type → 标题/默认文案。开关/位置/accent 在用户配置里。
  var DEFS = {
    status: { title: 'Agent 状态', hint: '跨 Agent 总线快照' },
    quote: { title: '随机语句', hint: '来自空闲自语内容池' },
    image: { title: '随机图片', hint: '来自 bubble-imgs 图片池' },
    text: { title: '自定义文本', hint: '在模块库里编辑内容' },
    clock: { title: '时钟', hint: '时间与日期' },
    countdown: { title: '倒计时', hint: '在模块库里设定目标时间' },
  }

  var host = null
  var panel = null
  var cards = new Map()      // type -> {el, bodyEl}
  var config = null
  var statusText = ''

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function defaultConfig() {
    var c = { order: [], modules: {} }
    Object.keys(DEFS).forEach(function (type, i) {
      c.order.push(type)
      c.modules[type] = {
        enabled: false,          // 默认全关：不加打扰，用户在模块库里按需开
        x: null, y: null,        // null = 首次开启时按桌宠锚点自动落位
        accent: ACCENTS[i % ACCENTS.length],
        text: '',
        target: '',              // countdown 目标 ISO 时间
      }
    })
    return c
  }

  function loadConfig() {
    if (config) return config
    try {
      var raw = JSON.parse(window.localStorage.getItem(CONFIG_KEY) || '')
      if (raw && typeof raw === 'object' && raw.modules) {
        config = defaultConfig()
        Object.keys(config.modules).forEach(function (type) {
          var saved = raw.modules[type]
          if (saved && typeof saved === 'object') {
            var dst = config.modules[type]
            dst.enabled = !!saved.enabled
            dst.x = Number.isFinite(saved.x) ? saved.x : null
            dst.y = Number.isFinite(saved.y) ? saved.y : null
            if (typeof saved.accent === 'string' && saved.accent) dst.accent = saved.accent
            if (typeof saved.text === 'string') dst.text = saved.text
            if (typeof saved.target === 'string') dst.target = saved.target
          }
        })
        return config
      }
    } catch (_) {}
    config = defaultConfig()
    return config
  }

  function saveConfig() {
    try { window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config)) } catch (_) {}
  }

  function anchorPoint() {
    try {
      if (typeof window.__mioPetAnchor === 'function') {
        var p = window.__mioPetAnchor()
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p
      }
    } catch (_) {}
    return { x: window.innerWidth - 220, y: 140 }
  }

  function defaultPos(type) {
    var p = anchorPoint()
    var idx = config.order.indexOf(type)
    // 环绕桌宠头顶：从锚点起向右排开，每 3 个换行
    var col = idx % 3
    var row = Math.floor(idx / 3)
    return {
      x: Math.max(8, Math.min(window.innerWidth - 190, p.x + 60 + col * 178)),
      y: Math.max(8, Math.min(window.innerHeight - 120, p.y - 40 + row * 96)),
    }
  }

  // ---------- 卡片 ----------

  function ensureCard(type) {
    var entry = cards.get(type)
    if (entry) return entry
    var el = document.createElement('div')
    el.className = 'pet-bubble-mod'
    el.dataset.mod = type
    el.innerHTML =
      '<header class="pet-bubble-mod-head">' +
        '<span class="pet-bubble-mod-dot"></span>' +
        '<strong>' + DEFS[type].title + '</strong>' +
        '<button type="button" class="pet-bubble-mod-close" title="隐藏该模块">✕</button>' +
      '</header>' +
      '<div class="pet-bubble-mod-body"></div>'
    ;(host || document.body).appendChild(el)
    el.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    $q('.pet-bubble-mod-close', el).addEventListener('click', function (e) {
      e.stopPropagation()
      setEnabled(type, false)
    })
    var entry = { el: el, bodyEl: $q('.pet-bubble-mod-body', el) }
    cards.set(type, entry)
    enableDrag(type, el)
    el.addEventListener('dblclick', function () {
      var pos = defaultPos(type)
      config.modules[type].x = pos.x
      config.modules[type].y = pos.y
      place(type)
      saveConfig()
    })
    return entry
  }

  function place(type) {
    var entry = cards.get(type)
    if (!entry) return
    var cfg = config.modules[type]
    var pos = (Number.isFinite(cfg.x) && Number.isFinite(cfg.y))
      ? { x: cfg.x, y: cfg.y }
      : defaultPos(type)
    var w = entry.el.offsetWidth || 168
    entry.el.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, pos.x)) + 'px'
    entry.el.style.top = Math.max(4, Math.min(window.innerHeight - 60, pos.y)) + 'px'
  }

  function enableDrag(type, el) {
    var head = $q('.pet-bubble-mod-head', el)
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.pet-bubble-mod-close')) return
      e.preventDefault()
      e.stopPropagation()
      var rect = el.getBoundingClientRect()
      var offX = e.clientX - rect.left
      var offY = e.clientY - rect.top
      el.style.cursor = 'grabbing'
      var move = function (ev) {
        el.style.left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, ev.clientX - offX)) + 'px'
        el.style.top = Math.max(4, Math.min(window.innerHeight - 40, ev.clientY - offY)) + 'px'
      }
      var up = function () {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        el.style.cursor = ''
        config.modules[type].x = Math.round(parseFloat(el.style.left))
        config.modules[type].y = Math.round(parseFloat(el.style.top))
        saveConfig()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })
  }

  // ---------- 各模块内容渲染 ----------

  function pad(n) { return n < 10 ? '0' + n : '' + n }

  function renderStatus(entry) {
    var text = ''
    try {
      if (typeof window.__mioPetStatusSnapshot === 'function') {
        text = String(window.__mioPetStatusSnapshot() || '')
      }
    } catch (_) {}
    entry.bodyEl.textContent = text || '所有 Agent 都在休息'
  }

  function renderQuote(entry) {
    var text = ''
    try {
      var busy = false
      if (typeof window.__mioPetStatusSnapshot === 'function') {
        busy = /工作|执行|思考|等待/.test(window.__mioPetStatusSnapshot() || '')
      }
      if (window.__mioPetIdleTalk) text = String(window.__mioPetIdleTalk.pick(busy) || '')
    } catch (_) {}
    entry.bodyEl.textContent = text || '（内容池为空）'
  }

  function renderImage(entry) {
    var body = entry.bodyEl
    try {
      var api = window.__mioPetRandomImage
      if (!api) { body.textContent = '（图片模块不可用）'; return }
      api.refresh().then(function (list) {
        if (!list || !list.length) {
          body.textContent = '把图片放进 Live2D桌宠/bubble-imgs 目录'
          return
        }
        var im = api.pick()
        if (!im) { body.textContent = '（图片池为空）'; return }
        body.replaceChildren()
        var img = document.createElement('img')
        img.className = 'pet-bubble-mod-img'
        img.alt = ''
        img.src = im.url + '?v=' + String(im.mtime || Date.now())
        img.addEventListener('error', function () { body.textContent = '（图片加载失败）' })
        body.appendChild(img)
      })
    } catch (_) {
      body.textContent = '（图片模块不可用）'
    }
  }

  function renderText(entry) {
    var cfg = config.modules.text
    entry.bodyEl.textContent = cfg.text || '（在模块库里写点什么）'
  }

  function renderClock(entry) {
    var now = new Date()
    var week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
    entry.bodyEl.textContent =
      pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) +
      ' · ' + (now.getMonth() + 1) + '月' + now.getDate() + '日 周' + week
  }

  function renderCountdown(entry) {
    var cfg = config.modules.countdown
    var body = entry.bodyEl
    if (!cfg.target) {
      body.textContent = '在模块库里设定目标时间'
      return
    }
    var target = new Date(cfg.target).getTime()
    if (!Number.isFinite(target)) {
      body.textContent = '目标时间无效'
      return
    }
    var diff = target - Date.now()
    if (diff <= 0) {
      body.textContent = '⏰ 已到达'
      return
    }
    var days = Math.floor(diff / 86400000)
    var hours = Math.floor((diff % 86400000) / 3600000)
    var mins = Math.floor((diff % 3600000) / 60000)
    var secs = Math.floor((diff % 60000) / 1000)
    body.textContent = days > 0
      ? days + ' 天 ' + hours + ' 时 ' + mins + ' 分'
      : hours + ' 时 ' + mins + ' 分 ' + pad(secs) + ' 秒'
  }

  var RENDERERS = {
    status: renderStatus,
    quote: renderQuote,
    image: renderImage,
    text: renderText,
    clock: renderClock,
    countdown: renderCountdown,
  }

  function renderBody(type) {
    var entry = cards.get(type)
    if (!entry || !config.modules[type].enabled) return
    try { RENDERERS[type](entry) } catch (_) {}
  }

  // ---------- 开关 / 同步 ----------

  function setEnabled(type, enabled) {
    loadConfig()
    config.modules[type].enabled = !!enabled
    saveConfig()
    if (enabled) {
      var entry = ensureCard(type)
      var cfg = config.modules[type]
      entry.el.style.setProperty('--mod-accent', cfg.accent)
      entry.el.hidden = false
      place(type)
      renderBody(type)
      if (type === 'image') {
        try { window.__mioPetRandomImage && window.__mioPetRandomImage.refresh() } catch (_) {}
      }
    } else {
      var e2 = cards.get(type)
      if (e2) e2.el.hidden = true
    }
    if (panel) renderPanelList()
  }

  function syncAll() {
    loadConfig()
    Object.keys(DEFS).forEach(function (type) {
      setEnabled(type, config.modules[type].enabled)
    })
  }

  // 周期刷新：1s（时钟/倒计时）+ 轮换计时（quote/image）
  var rotateTimer = null
  function startTimers() {
    if (rotateTimer) return
    window.setInterval(function () {
      if (config && config.modules.clock && config.modules.clock.enabled) renderBody('clock')
      if (config && config.modules.countdown && config.modules.countdown.enabled) renderBody('countdown')
    }, 1000)
    rotateTimer = window.setInterval(function () {
      if (!config) return
      if (config.modules.quote && config.modules.quote.enabled) renderBody('quote')
      if (config.modules.image && config.modules.image.enabled) renderBody('image')
      if (config.modules.status && config.modules.status.enabled) renderBody('status')
    }, ROTATE_MS)
  }

  // ---------- 模块库面板 ----------

  function buildPanel() {
    if (panel) return panel
    panel = document.createElement('section')
    panel.id = 'pet-bubble-lib'
    panel.className = 'pet-bubble-lib'
    panel.hidden = true
    panel.innerHTML =
      '<header id="pet-bubble-lib-header">' +
        '<strong>泡泡模块库</strong>' +
        '<button type="button" id="pet-bubble-lib-close" title="关闭">✕</button>' +
      '</header>' +
      '<div id="pet-bubble-lib-list" class="pet-bubble-lib-list"></div>' +
      '<div class="pet-bubble-lib-foot">开关即生效；拖卡片排版，双击卡片复位</div>'
    ;(host || document.body).appendChild(panel)
    $q('#pet-bubble-lib-close', panel).addEventListener('click', function (e) {
      e.stopPropagation()
      hide()
    })
    panel.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    return panel
  }

  function renderPanelList() {
    var listEl = $q('#pet-bubble-lib-list', panel)
    if (!listEl) return
    listEl.replaceChildren()
    loadConfig()
    config.order.forEach(function (type) {
      var cfg = config.modules[type]
      var row = document.createElement('div')
      row.className = 'pet-bubble-lib-row'

      var check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = cfg.enabled
      check.id = 'pet-mod-check-' + type
      check.addEventListener('change', function () {
        setEnabled(type, check.checked)
      })

      var label = document.createElement('label')
      label.htmlFor = check.id
      label.innerHTML = '<strong>' + DEFS[type].title + '</strong><small>' + DEFS[type].hint + '</small>'

      var accentBtn = document.createElement('button')
      accentBtn.type = 'button'
      accentBtn.className = 'pet-bubble-lib-accent'
      accentBtn.title = '换颜色'
      accentBtn.style.background = cfg.accent
      accentBtn.addEventListener('click', function () {
        var i = ACCENTS.indexOf(cfg.accent)
        cfg.accent = ACCENTS[(i + 1) % ACCENTS.length]
        accentBtn.style.background = cfg.accent
        var entry = cards.get(type)
        if (entry) entry.el.style.setProperty('--mod-accent', cfg.accent)
        saveConfig()
      })

      row.appendChild(check)
      row.appendChild(label)
      row.appendChild(accentBtn)

      // text 模块：内联编辑内容
      if (type === 'text') {
        var textInput = document.createElement('input')
        textInput.type = 'text'
        textInput.className = 'pet-bubble-lib-input'
        textInput.placeholder = '写点什么…'
        textInput.maxLength = 120
        textInput.value = cfg.text
        textInput.addEventListener('input', function () {
          cfg.text = textInput.value
          saveConfig()
          renderBody('text')
        })
        row.appendChild(textInput)
      }
      // countdown 模块：目标时间编辑（datetime-local）
      if (type === 'countdown') {
        var timeInput = document.createElement('input')
        timeInput.type = 'datetime-local'
        timeInput.className = 'pet-bubble-lib-input'
        if (cfg.target) timeInput.value = cfg.target
        timeInput.addEventListener('change', function () {
          cfg.target = timeInput.value
          saveConfig()
          renderBody('countdown')
        })
        row.appendChild(timeInput)
      }
      listEl.appendChild(row)
    })
  }

  function openPanel() {
    buildPanel()
    renderPanelList()
    panel.hidden = false
  }

  function hidePanel() {
    if (panel) panel.hidden = true
  }

  window.__mioPetBubbleModules = {
    mount: function (container) { host = container || host },
    /** 开机静默恢复：重建已启用的卡片并启动刷新计时（不开面板）。 */
    init: function () { loadConfig(); syncAll(); startTimers() },
    open: function () { syncAll(); openPanel(); startTimers() },
    hide: hidePanel,
    toggle: function () {
      if (panel && !panel.hidden) { hidePanel(); return false }
      openPanel()
      return true
    },
    refreshStatus: function () {
      if (config && config.modules.status && config.modules.status.enabled) renderBody('status')
    },
    isOpen: function () { return !!(panel && !panel.hidden) },
  }
})()
