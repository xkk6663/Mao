/* pet-gallery.js — 桌宠「角色图库」（A7，桌宠侧自足）
 *
 * 定位：在桌宠里直接浏览/更换 Live2D 形象（不必打开管理页），带预览图。
 *
 * 设计要点：
 *   - **零依赖**：只暴露 window.__mioPetGallery，不引用任何插件；
 *   - **数据来自既有接口**：GET /api/companion/live2d/models（含 preview_url），
 *     不新增后端接口、不重复实现模型发现逻辑；
 *   - **只负责画 UI**：选中回调交给调用方（live2d-pet.js 决定怎么切模型），
 *     这样切模型的副作用（重载/持久化）只有一处。
 *
 * 泡泡图库（同一模块的第二段）同理：只画预览 + 回调，不碰存储。
 */
(function () {
  if (window.__mioPetGallery) return

  var panel = null
  var listEl = null
  var host = null            // 挂载容器（由调用方给，通常是 #pet-root）
  var onPick = null
  var currentId = ''
  var models = []

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function build() {
    if (panel) return panel
    panel = document.createElement('section')
    panel.id = 'pet-gallery'
    panel.className = 'pet-gallery'
    panel.hidden = true
    panel.innerHTML =
      '<header id="pet-gallery-header">' +
        '<strong>角色图库</strong>' +
        '<output id="pet-gallery-count"></output>' +
        '<button type="button" id="pet-gallery-close" title="关闭">✕</button>' +
      '</header>' +
      '<div id="pet-gallery-list" class="pet-gallery-list"></div>' +
      '<div class="pet-gallery-foot">点选即切换；导入新形象请到 Mio「桌宠」页</div>'
    ;(host || document.body).appendChild(panel)

    $q('#pet-gallery-close', panel).addEventListener('click', function (e) {
      e.stopPropagation()
      hide()
    })
    // 阻止面板内的点击穿透到 canvas（否则点图库会顺带拖桌宠）
    panel.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    return panel
  }

  function renderList() {
    listEl = $q('#pet-gallery-list', panel)
    if (!listEl) return
    if (!models.length) {
      listEl.innerHTML = '<div class="pet-gallery-empty">没有可用形象</div>'
      return
    }
    listEl.replaceChildren()
    models.forEach(function (m) {
      var card = document.createElement('button')
      card.type = 'button'
      card.className = 'pet-gallery-card' + (String(m.id) === currentId ? ' is-current' : '')
      card.title = String(m.name || m.id)
      // 预览优先用接口给的 preview_url；没有就显示占位（不伪造图片）
      var thumb = document.createElement('span')
      thumb.className = 'pet-gallery-thumb'
      if (m.preview_url) {
        var img = document.createElement('img')
        img.src = String(m.preview_url)
        img.alt = ''
        img.loading = 'lazy'
        // 用 JS 绑 onerror 而不是内联属性：内联事件处理器会被 CSP 拦掉
        img.addEventListener('error', function () { img.style.display = 'none' })
        thumb.appendChild(img)
      }
      var name = document.createElement('span')
      name.className = 'pet-gallery-name'
      name.textContent = String(m.name || m.id)
      card.appendChild(thumb)
      card.appendChild(name)
      if (m.imported) {
        var tag = document.createElement('span')
        tag.className = 'pet-gallery-tag'
        tag.textContent = '导入'
        card.appendChild(tag)
      }
      card.addEventListener('click', function (e) {
        e.stopPropagation()
        if (String(m.id) === currentId) { hide(); return }
        currentId = String(m.id)
        renderList()
        if (typeof onPick === 'function') onPick(currentId, m)
      })
      listEl.appendChild(card)
    })
    var cnt = $q('#pet-gallery-count', panel)
    if (cnt) cnt.value = models.length + ' 个'
  }

  function setModels(entries) {
    models = Array.isArray(entries) ? entries.slice() : []
    if (panel) renderList()
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

  function isOpen() { return !!(panel && !panel.hidden) }

  window.__mioPetGallery = {
    mount: function (container) { host = container || host },
    setModels: setModels,
    setCurrent: function (id) { currentId = String(id || ''); if (panel) renderList() },
    onPick: function (fn) { onPick = fn },
    show: show,
    hide: hide,
    toggle: toggle,
    isOpen: isOpen,
    count: function () { return models.length },
  }
})()
