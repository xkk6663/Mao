/* pet-bubble-modules.js — 桌宠「模块化泡泡系统」（A组 3.1，对标 whale-widget #7）
 *
 * 定位：围绕桌宠的一组**可开关、可拖拽、可换色**的小信息卡（模块泡泡）。
 * 模块的开关/编辑/配色在 Mio 管理页「泡泡工坊」（core-inject/bubble-panel-inject.js），
 * 走后端 settings.live2d_bubble_modules（跨窗口同步：settings_changed → 热应用）。
 * 本文件只负责：卡片渲染 / 拖拽排版 / 内容定时刷新 / 配置应用。
 *
 * 6 类模块：
 *   status    Agent 状态（跨 Agent 总线快照，12 态）
 *   quote     随机语句（复用 pet-idle-talk 内容池，定时轮换）
 *   image     随机图片（复用 pet-random-image 池，定时轮换）
 *   text      自定义文本（泡泡工坊内编辑）
 *   clock     时钟/日期
 *   countdown 倒计时（目标时间在泡泡工坊设定，到点变"已到达"）
 *
 * 持久化：settings.live2d_bubble_modules 为准（跨窗口）；localStorage 仅作
 * 首次迁移回退（老版本面板时代的本地配置自动带入 settings 之前的会话）。
 */
(function () {
  if (window.__mioPetBubbleModules) return

  var LEGACY_KEY = 'mio-pet-bubble-modules'
  var ROTATE_MS = 5 * 60 * 1000
  var ACCENTS = ['#4f6bed', '#e8618c', '#3aa675', '#e8973a', '#7a5fd0', '#2d4148']

  var DEFS = {
    status: { title: 'Agent 状态', hint: '跨 Agent 总线快照' },
    quote: { title: '随机语句', hint: '来自空闲自语内容池' },
    image: { title: '随机图片', hint: '来自 bubble-imgs 图片池' },
    text: { title: '自定义文本', hint: '在泡泡工坊里编辑内容' },
    clock: { title: '时钟', hint: '时间与日期' },
    countdown: { title: '倒计时', hint: '在泡泡工坊里设定目标时间' },
  }

  var host = null
  var cards = new Map()      // type -> {el, bodyEl}
  var config = null          // {order, modules}
  var boundsDirty = true     // 卡片增删/拖动后置 true，由宿主拉取 bounds 上报

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function normalizeModules(raw) {
    var c = { order: Object.keys(DEFS), modules: {} }
    Object.keys(DEFS).forEach(function (type, i) {
      c.modules[type] = {
        enabled: false,
        x: null, y: null,
        accent: ACCENTS[i % ACCENTS.length],
        text: '',
        target: '',
      }
    })
    // 兼容两种形态：{order, modules:{...}}（本模块持久化结构）与
    // 扁平 map {status:{...}, ...}（settings.live2d_bubble_modules 直接存的形态）
    var source = raw && typeof raw === 'object' ? (raw.modules || raw) : null
    if (source) {
      Object.keys(c.modules).forEach(function (type) {
        var saved = source[type]
        if (!saved || typeof saved !== 'object') return
        var dst = c.modules[type]
        dst.enabled = !!saved.enabled
        dst.x = Number.isFinite(saved.x) ? saved.x : null
        dst.y = Number.isFinite(saved.y) ? saved.y : null
        if (typeof saved.accent === 'string' && saved.accent) dst.accent = saved.accent
        if (typeof saved.text === 'string') dst.text = saved.text
        if (typeof saved.target === 'string') dst.target = saved.target
      })
    }
    return c
  }

  /** settings_changed / 初始化入口：全量应用配置（差异部分自动重建/隐藏卡片）。 */
  function applyConfig(raw) {
    config = normalizeModules(raw)
    Object.keys(DEFS).forEach(function (type) {
      setEnabled(type, config.modules[type].enabled, true)
    })
    boundsDirty = true
    startTimers()
  }

  function legacyConfig() {
    try {
      var raw = JSON.parse(window.localStorage.getItem(LEGACY_KEY) || '')
      if (raw && raw.modules) return raw
    } catch (_) {}
    return null
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
        '<button type="button" class="pet-bubble-mod-close" title="隐藏该模块（可在 Mio「泡泡」页重新开启）">✕</button>' +
      '</header>' +
      '<div class="pet-bubble-mod-body"></div>'
    ;(host || document.body).appendChild(el)
    el.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    $q('.pet-bubble-mod-close', el).addEventListener('click', function (e) {
      e.stopPropagation()
      config.modules[type].enabled = false
      persist(type)
    })
    var entry = { el: el, bodyEl: $q('.pet-bubble-mod-body', el) }
    cards.set(type, entry)
    enableDrag(type, el)
    el.addEventListener('dblclick', function () {
      var pos = defaultPos(type)
      config.modules[type].x = pos.x
      config.modules[type].y = pos.y
      place(type)
      persist(type)
    })
    return entry
  }

  /** 写回 settings（经宿主注入的回调）；位置/开关变更即时上报。 */
  function persist(type) {
    boundsDirty = true
    try {
      if (typeof window.__mioPetPersistModules === 'function') {
        window.__mioPetPersistModules(JSON.parse(JSON.stringify(config)))
      }
    } catch (_) {}
    if (config.modules[type].enabled) {
      var entry = cards.get(type)
      if (entry) entry.el.hidden = false
    } else {
      var e2 = cards.get(type)
      if (e2) e2.el.hidden = true
    }
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
        persist(type)
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
          body.textContent = '在 Mio「泡泡」页导入图片素材'
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
    entry.bodyEl.textContent = cfg.text || '（在泡泡工坊里写点什么）'
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
      body.textContent = '在泡泡工坊里设定目标时间'
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
    if (!entry || !config || !config.modules[type].enabled) return
    try { RENDERERS[type](entry) } catch (_) {}
  }

  function setEnabled(type, enabled, fromConfigSync) {
    var cfg = config.modules[type]
    cfg.enabled = !!enabled
    if (enabled) {
      var entry = ensureCard(type)
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
    if (!fromConfigSync) persist(type)
  }

  // 周期刷新：1s（时钟/倒计时）+ 轮换计时（quote/image/status）
  var timersOn = false
  function startTimers() {
    if (timersOn) return
    timersOn = true
    window.setInterval(function () {
      if (!config) return
      if (config.modules.clock && config.modules.clock.enabled) renderBody('clock')
      if (config.modules.countdown && config.modules.countdown.enabled) renderBody('countdown')
    }, 1000)
    window.setInterval(function () {
      if (!config) return
      if (config.modules.quote && config.modules.quote.enabled) renderBody('quote')
      if (config.modules.image && config.modules.image.enabled) renderBody('image')
      if (config.modules.status && config.modules.status.enabled) renderBody('status')
    }, ROTATE_MS)
  }

  /** 宿主收集可交互 UI bounds 时调用：返回当前可见模块卡片的矩形列表（窗口坐标）。 */
  function collectBounds() {
    var out = []
    if (!config) return out
    cards.forEach(function (entry, type) {
      if (!config.modules[type] || !config.modules[type].enabled) return
      if (entry.el.hidden) return
      var r = entry.el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        out.push({ x: r.left, y: r.top, width: r.width, height: r.height })
      }
    })
    return out
  }

  window.__mioPetBubbleModules = {
    mount: function (container) { host = container || host },
    /** 初始化：settings 未下发时回退老 localStorage 配置。 */
    init: function () { if (!config) applyConfig(legacyConfig()) },
    /** settings_changed 入口。 */
    applyConfig: applyConfig,
    currentConfig: function () { return config ? JSON.parse(JSON.stringify(config)) : null },
    refreshStatus: function () {
      if (config && config.modules.status && config.modules.status.enabled) renderBody('status')
    },
    /** 卡片有增删/拖动后由本模块置 dirty，宿主轮询拉取。 */
    isBoundsDirty: function () { return boundsDirty },
    clearBoundsDirty: function () { boundsDirty = false },
    collectBounds: collectBounds,
    ACCENTS: ACCENTS,
  }
})()
