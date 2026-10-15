/* pet-random-image.js — 桌宠「随机图片」泡泡（A组 3.2，对标 whale-widget #8）
 *
 * 定位：桌宠偶尔展示一张随机图片（用户把图放进 bubble-imgs 目录即生效），
 * 让桌宠"有生活气息"。与空闲自语同源排期，但展示形式是图片卡。
 *
 * 设计要点：
 *   - **零依赖**：只暴露 window.__mioPetRandomImage，不引用任何插件；
 *   - **数据来自既有接口**：GET /api/companion/bubble-images（列表）
 *     + /api/companion/bubble-images/{name}（图片本体），后端做文件名校验与越界拒绝；
 *   - **加权随机 + 不连续重复**：与 pet-idle-talk 同一套选择策略（单图池允许权重字段
 *     预留：<name> 同名 .weight.json 后续可扩展；当前先均匀权重）；
 *   - **自足展示**：图片泡泡元素由本模块创建/定位/销毁，锚点由宿主注入
 *     （window.__mioPetAnchor），宿主不在时回退到屏幕右上区域。
 */
(function () {
  if (window.__mioPetRandomImage) return

  var CACHE_KEY = 'mio-pet-random-image-last'
  var HIDE_MS = 9000
  var REFRESH_MS = 5 * 60 * 1000

  var images = []           // [{name,url,bytes,mtime}]
  var lastFetchedAt = 0
  var fetching = null
  var cardEl = null
  var hideTimer = null
  var host = null

  function rnd() {
    try {
      var a = new Uint32Array(1)
      window.crypto.getRandomValues(a)
      return a[0] / 4294967296
    } catch (_) {
      return Math.random()
    }
  }

  /** 拉取图片池（5 分钟缓存；失败沿用上次缓存）。 */
  function refresh(force) {
    if (!force && images.length && Date.now() - lastFetchedAt < REFRESH_MS) {
      return Promise.resolve(images)
    }
    if (fetching) return fetching
    fetching = fetch('/api/companion/bubble-images')
      .then(function (r) { return r.ok ? r.json() : { images: [] } })
      .then(function (data) {
        images = Array.isArray(data && data.images) ? data.images : []
        lastFetchedAt = Date.now()
        return images
      })
      .catch(function () { return images })
      .finally(function () { fetching = null })
    return fetching
  }

  /** 加权随机抽一张（保证与上次不同；池子只剩一张时允许重复）。 */
  function pick() {
    if (!images.length) return null
    var usable = images.filter(function (im) { return im.url !== lastUrl })
    if (!usable.length) usable = images
    var chosen = usable[Math.floor(rnd() * usable.length) % usable.length]
    lastUrl = String(chosen.url)
    try { window.localStorage.setItem(CACHE_KEY, lastUrl) } catch (_) {}
    return chosen
  }

  function ensureCard() {
    if (cardEl) return cardEl
    cardEl = document.createElement('div')
    cardEl.id = 'pet-image-bubble'
    cardEl.className = 'pet-image-bubble'
    cardEl.hidden = true
    cardEl.innerHTML =
      '<img class="pet-image-bubble-img" alt="" />' +
      '<button type="button" class="pet-image-bubble-close" title="关闭">✕</button>'
    ;(host || document.body).appendChild(cardEl)
    cardEl.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    cardEl.querySelector('.pet-image-bubble-close').addEventListener('click', function (e) {
      e.stopPropagation()
      hide()
    })
    return cardEl
  }

  /** 桌宠头顶锚点；宿主未注入时回退右上区域。 */
  function anchorPoint() {
    try {
      if (typeof window.__mioPetAnchor === 'function') {
        var p = window.__mioPetAnchor()
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p
      }
    } catch (_) {}
    return { x: window.innerWidth - 190, y: 90 }
  }

  /** 展示一张随机图片（有池才展示；返回是否展示了）。 */
  function show() {
    var target = images.length ? pick() : null
    if (!target) return false
    var card = ensureCard()
    var img = card.querySelector('.pet-image-bubble-img')
    img.src = target.url + '?v=' + String(target.mtime || Date.now())
    card.hidden = false
    var p = anchorPoint()
    var w = 232
    card.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, p.x - w / 2)) + 'px'
    card.style.top = Math.max(8, p.y - 190) + 'px'
    window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(hide, HIDE_MS)
    return true
  }

  function hide() {
    window.clearTimeout(hideTimer)
    hideTimer = null
    if (cardEl) cardEl.hidden = true
  }

  var lastUrl = ''
  try { lastUrl = window.localStorage.getItem(CACHE_KEY) || '' } catch (_) {}

  window.__mioPetRandomImage = {
    mount: function (container) { host = container || host },
    refresh: refresh,
    pick: pick,
    show: show,
    hide: hide,
    count: function () { return images.length },
  }
})()
