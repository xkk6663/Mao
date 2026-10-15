/* pet-bubble-styles.js — 桌宠气泡皮肤（A组 3.3，泡泡工坊渲染端应用器）
 *
 * 定位：**只负责"把当前皮肤套到气泡上"**，不做任何 UI。
 * 皮肤的选择/预览/持久化在 Mio 管理页「泡泡工坊」（core-inject/bubble-panel-inject.js），
 * 走后端 settings.live2d_bubble_style（跨窗口同步：settings_changed → 热应用）。
 *
 * 设计要点：
 *   - **样式 = CSS 类**：每款皮肤只是 #speech-bubble 上的一组调色板变量覆盖
 *     （与 DSH data-agent-accent 同一机制），框/尾巴/投影全复用；
 *   - **零依赖**：只暴露 window.__mioPetBubbleStyles；
 *   - localStorage 仅作 settings 缺省时的回退（老配置迁移）。
 */
(function () {
  if (window.__mioPetBubbleStyles) return

  var FALLBACK_KEY = 'mio-pet-bubble-style'

  // 与管理页 bubble-panel-inject.js 的 STYLE_DEFS 保持一致（id/cls/swatch）
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

  var currentId = 'default'

  function current() {
    var found = null
    STYLES.forEach(function (s) { if (s.id === currentId) found = s })
    return found || STYLES[0]
  }

  /** 把当前皮肤套到气泡元素上（先清掉本模块的样式类再挂新的）。 */
  function apply(targetEl) {
    if (!targetEl) return
    var c = current()
    STYLES.forEach(function (s) {
      if (s.cls) targetEl.classList.remove(s.cls)
    })
    if (c.cls) targetEl.classList.add(c.cls)
  }

  /** settings_changed / 初始化时调用：切换皮肤并可选地立即套用。 */
  function setStyle(id, applyEl) {
    var wanted = String(id || '').trim()
    var ok = STYLES.some(function (s) { return s.id === wanted })
    currentId = ok ? wanted : 'default'
    try { window.localStorage.setItem(FALLBACK_KEY, currentId) } catch (_) {}
    if (applyEl) apply(applyEl)
    return currentId
  }

  try {
    var saved = window.localStorage.getItem(FALLBACK_KEY)
    if (saved && STYLES.some(function (s) { return s.id === saved })) currentId = saved
  } catch (_) {}

  window.__mioPetBubbleStyles = {
    STYLES: STYLES,
    current: current,
    currentId: function () { return currentId },
    apply: apply,
    setStyle: setStyle,
  }
})()
