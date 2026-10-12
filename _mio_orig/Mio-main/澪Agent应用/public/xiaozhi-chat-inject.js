/* xiaozhi-chat-inject.js — Mio 原版私人空间对话页注入"小智图片提问"（图片暂存模式）
 * 1. composer 栏注入 📷 上传图片按钮（点击选图）
 * 2. 支持 Ctrl+V 粘贴图片
 * 3. 图片**暂存**在输入框上方（缩略图可预览、可删除），点发送按钮（或 Enter）才发送
 * 4. 发送 → 后端 /api/xiaozhi/vision（小智官方云视觉，免费）
 *    → 分析文本经小智 WS 自动显示在消息流 + 写入会话历史（刷新/重开后图片与分析可见）
 */
(function () {
  if (window.__mioXzChatInjectLoaded) return
  window.__mioXzChatInjectLoaded = true

  var svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'
  var pendingImages = [] // [{dataUrl, name}]

  function qs(sel, root) { return (root || document).querySelector(sel) }

  function findComposer() { return qs('.composer-actions') || qs('.composer') }
  function findDraft() { return qs('.composer-input') }
  function findSendBtn() { return qs('.send-button') }

  // ---- 暂存条 UI ----
  var pendingBar = null
  function ensurePendingBar() {
    if (pendingBar && pendingBar.isConnected) return pendingBar
    var composer = findComposer()
    if (!composer) return null
    var wrap = composer.closest('.composer-wrap') || composer.parentElement
    if (!wrap) return null
    pendingBar = document.createElement('div')
    pendingBar.className = 'xz-pending-bar'
    pendingBar.style.cssText = 'display:none;flex-wrap:wrap;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(0,0,0,0.06);background:rgba(0,0,0,0.02);'
    wrap.insertBefore(pendingBar, composer)
    return pendingBar
  }

  function renderPending() {
    var bar = ensurePendingBar()
    if (!bar) return
    bar.innerHTML = ''
    if (!pendingImages.length) { bar.style.display = 'none'; return }
    bar.style.display = 'flex'
    pendingImages.forEach(function (img, idx) {
      var item = document.createElement('div')
      item.style.cssText = 'position:relative;width:56px;height:56px;border-radius:8px;overflow:hidden;border:1px solid rgba(0,0,0,0.1);flex:none;'
      var thumb = document.createElement('img')
      thumb.src = img.dataUrl
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;'
      var del = document.createElement('button')
      del.type = 'button'
      del.title = '移除图片'
      del.textContent = '✕'
      del.style.cssText = 'position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;border:none;background:rgba(0,0,0,0.55);color:#fff;font-size:11px;line-height:18px;cursor:pointer;padding:0;'
      del.addEventListener('click', function () {
        pendingImages.splice(idx, 1)
        renderPending()
      })
      item.appendChild(thumb)
      item.appendChild(del)
      bar.appendChild(item)
    })
  }

  function stageImage(file) {
    if (!file || file.type.indexOf('image/') !== 0) return
    var reader = new FileReader()
    reader.onload = function () {
      if (!reader.result) return
      pendingImages.push({ dataUrl: reader.result, name: file.name || '' })
      renderPending()
    }
    reader.onerror = function () { /* ignore */ }
    reader.readAsDataURL(file)
  }

  // ---- 发送（图片+文字 → vision）----
  function sendPending() {
    if (!pendingImages.length) return false
    var img = pendingImages.shift()
    var draft = findDraft()
    var question = (draft && draft.value && draft.value.trim()) || '请详细描述这张图片里的内容。'
    if (draft) draft.value = ''
    renderPending()
    var imgB64 = img.dataUrl.indexOf('data:') === 0 ? img.dataUrl.split(',')[1] : img.dataUrl
    fetch('/api/xiaozhi/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: imgB64, question: question }),
    })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { ok: r.ok, j: j } }) })
      .then(function (res) {
        if (!(res.ok && res.j && res.j.text)) console.warn('[xz-img] vision failed', res.j)
      })
      .catch(function (err) { console.warn('[xz-img] vision error', err) })
    return true
  }

  // ---- 拦截发送按钮（capture 阶段，优先于 Vue 原逻辑）----
  function interceptSend() {
    var btn = findSendBtn()
    if (!btn || btn.__xzHandled) return
    btn.__xzHandled = true
    btn.addEventListener('click', function (e) {
      if (!pendingImages.length) return // 无暂存图 → 放行原文字发送逻辑
      e.preventDefault()
      e.stopPropagation()
      sendPending()
    }, true)
  }
  // Enter 键：有暂存图时优先发图
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing) return
    if (!pendingImages.length) return
    var draft = findDraft()
    if (!draft || draft !== document.activeElement) return
    e.preventDefault()
    e.stopPropagation()
    sendPending()
  }, true)

  // ---- 📷 上传按钮 ----
  function ensureBtn() {
    var composer = findComposer()
    if (!composer) return
    if (composer.querySelector('.xz-img-btn')) return
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'icon-button xz-img-btn'
    btn.title = '上传图片让小智分析（点发送才发送）'
    btn.innerHTML = svgIcon
    btn.style.cssText = 'order:-1;flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;cursor:pointer;'
    btn.addEventListener('click', pickImage)
    composer.insertBefore(btn, composer.firstChild)
  }

  var fileInput = null
  function pickImage() {
    if (fileInput) fileInput.remove()
    fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/*'
    fileInput.style.display = 'none'
    document.body.appendChild(fileInput)
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0]
      if (f) stageImage(f)
      fileInput.remove()
      fileInput = null
    })
    fileInput.click()
  }

  // ---- 粘贴图片 → 暂存（全局拦截：焦点不必在输入框内，防止粘贴图片无反应）----
  document.addEventListener('paste', function (e) {
    var composer = findComposer()
    if (!composer) return
    var items = (e.clipboardData || window.clipboardData)
    if (!items || !items.items) return
    for (var i = 0; i < items.items.length; i++) {
      var it = items.items[i]
      if (it.type && it.type.indexOf('image/') === 0) {
        var f = it.getAsFile && it.getAsFile()
        if (f) { stageImage(f); e.preventDefault(); return }
      }
    }
  })

  // ---- 调试角标：左下角小圆点，一眼看出注入状态（绿=输入区+按钮都OK，黄=输入区在但按钮未注入，红=没找到输入区）----
  var badgeShown = false
  function ensureBadge() {
    if (document.getElementById('xz-inject-badge')) return
    var composer = findComposer()
    var btn = composer && composer.querySelector('.xz-img-btn')
    var b = document.createElement('div')
    b.id = 'xz-inject-badge'
    b.title = '小智图片注入诊断 ' + 'v20261012d' + '（点此关闭）'
    b.style.cssText = 'position:fixed;left:6px;bottom:6px;width:10px;height:10px;border-radius:50%;z-index:99999;cursor:pointer;box-shadow:0 0 0 1px rgba(0,0,0,0.2);'
    b.style.background = (composer && btn) ? '#22c55e' : (composer ? '#eab308' : '#ef4444')
    b.addEventListener('click', function () { b.remove() })
    document.body.appendChild(b)
    badgeShown = true
  }

  // ---- 保活：Vue 重渲染后按钮/暂存条/拦截不丢失 ----
  function keepAlive() {
    ensureBtn()
    interceptSend()
    ensurePendingBar()
    ensureBadge()
  }
  var observer = new MutationObserver(keepAlive)
  observer.observe(document.body, { childList: true, subtree: true })
  keepAlive()
  setInterval(keepAlive, 2000)
})()
