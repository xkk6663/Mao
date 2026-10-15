/* pet-bubble-styles.js — 桌宠「泡泡图库」（A组 3.3 剩余，对标 whale-widget #11）
 *
 * 定位：在桌宠里直接更换说话气泡的样式（皮肤），所见即所得。
 *
 * 设计要点：
 *   - **零依赖**：只暴露 window.__mioPetBubbleStyles，不引用任何插件；
 *   - **样式 = CSS 类，不是代码**：每款皮肤只是 #speech-bubble 上的一组 CSS
 *     调色板变量覆盖（与 DSH data-agent-accent 同一机制），框/尾巴/投影全复用；
 *   - **持久化在渲染层**：localStorage（桌宠侧自足，不加后端字段）；
 *   - **只画 UI**：选中回调交给调用方（live2d-pet.js 决定套用到哪些元素）。
 */
(function () {
  if (window.__mioPetBubbleStyles) return

  var STORAGE_KEY = 'mio-pet-bubble-style'

  // 字段：id / name / cls 挂到 #speech-bubble 上的类名 / swatch 预览色
  var STYLES = [
    { id: 'default', name: '默认白', cls: '', swatch: '#ffffff' },
    { id: 'mono', name: '墨黑', cls: 'style-mono', swatch: '#243036' },
    { id: 'navy', name: '靛蓝', cls: 'style-navy', swatch: '#4f6bed' },
    { id: 'peach', name: '蜜桃粉', cls: 'style-peach', swatch: '#f7b8c4' },
    { id: 'matcha', name: '抹茶绿', cls: 'style-matcha', swatch: '#9db87a' },
    { id: 'note', name: '便利贴', cls: 'style-note', swatch: '#ffe27a' },
    { id: 'terminal', name: '终端绿', cls: 'style-terminal', swatch: '#17301f' },
    { id: 'comic', name: '漫画描边', cls: 'style-comic', swatch: '#ffffff' },
  ]

  var panel = null
  var listEl = null
  var host = null
  var onPick = null
  var currentId = ''

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function current() {
    var found = null
    STYLES.forEach(function (s) { if (s.id === currentId) found = s })
    return found || STYLES[0]
  }

  function build() {
    if (panel) return panel
    panel = document.createElement('section')
    panel.id = 'pet-style-gallery'
    panel.className = 'pet-style-gallery'
    panel.hidden = true
    panel.innerHTML =
      '<header id="pet-style-gallery-header">' +
        '<strong>泡泡图库</strong>' +
        '<output id="pet-style-gallery-count"></output>' +
        '<button type="button" id="pet-style-gallery-close" title="关闭">✕</button>' +
      '</header>' +
      '<div id="pet-style-gallery-list" class="pet-style-gallery-list"></div>' +
      '<div class="pet-style-gallery-foot">点选即换肤；插件身份色（如 DSH 蓝）优先于皮肤</div>'
    ;(host || document.body).appendChild(panel)
    $q('#pet-style-gallery-close', panel).addEventListener('click', function (e) {
      e.stopPropagation()
      hide()
    })
    panel.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    return panel
  }

  function renderList() {
    listEl = $q('#pet-style-gallery-list', panel)
    if (!listEl) return
    listEl.replaceChildren()
    STYLES.forEach(function (s) {
      var card = document.createElement('button')
      card.type = 'button'
      card.className = 'pet-style-gallery-card' + (s.id === currentId ? ' is-current' : '')
      card.title = s.name
      var swatch = document.createElement('span')
      swatch.className = 'pet-style-gallery-swatch'
      swatch.style.background = s.swatch
      // 终端绿/墨黑是深色皮肤，给预览块加个边避免和面板底色糊在一起
      if (s.id === 'terminal' || s.id === 'mono') swatch.style.borderColor = '#94a7ad'
      var name = document.createElement('span')
      name.className = 'pet-style-gallery-name'
      name.textContent = s.name
      card.appendChild(swatch)
      card.appendChild(name)
      card.addEventListener('click', function (e) {
        e.stopPropagation()
        currentId = s.id
        try { window.localStorage.setItem(STORAGE_KEY, s.id) } catch (_) {}
        renderList()
        if (typeof onPick === 'function') onPick(currentId, s)
      })
      listEl.appendChild(card)
    })
    var cnt = $q('#pet-style-gallery-count', panel)
    if (cnt) cnt.value = STYLES.length + ' 款'
  }

  function show() {
    build()
    renderList()
    panel.hidden = false
    return true
  }

  function hide() {
    if (panel) panel.hidden = true
  }

  function toggle() {
    if (panel && !panel.hidden) { hide(); return false }
    return show()
  }

  try { currentId = window.localStorage.getItem(STORAGE_KEY) || 'default' } catch (_) {}
  if (!current()) currentId = 'default'

  window.__mioPetBubbleStyles = {
    mount: function (container) { host = container || host },
    STYLES: STYLES,
    current: current,
    currentId: function () { return currentId },
    /** 套用皮肤：targetEl 上先清掉本模块的样式类再挂新的（不动 data-agent-accent）。 */
    apply: function (targetEl) {
      if (!targetEl) return
      var c = current()
      STYLES.forEach(function (s) {
        if (s.cls) targetEl.classList.remove(s.cls)
      })
      if (c.cls) targetEl.classList.add(c.cls)
    },
    onPick: function (fn) { onPick = fn },
    show: show,
    hide: hide,
    toggle: toggle,
    isOpen: function () { return !!(panel && !panel.hidden) },
  }
})()
