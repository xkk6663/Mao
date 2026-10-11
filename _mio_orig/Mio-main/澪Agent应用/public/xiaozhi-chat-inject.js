/* xiaozhi-chat-inject.js — 在 Mio 原版私人空间对话页注入"小智图片提问"能力
 * 1. composer 栏注入 📷 上传图片按钮（点击选图）
 * 2. 支持 Ctrl+V 粘贴图片
 * 3. 图片 → 后端 /api/xiaozhi/vision（小智官方云视觉，免费）→ 分析文本写入会话历史
 * 4. 图片与分析文本即时插入对话消息流（user 图气泡 + assistant 文本气泡）
 */
(function () {
  if (window.__mioXzChatInjectLoaded) return
  window.__mioXzChatInjectLoaded = true

  var BUTTON_TITLE = '上传图片让小智分析'
  var svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'

  function qs(sel, root) { return (root || document).querySelector(sel) }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }

  function findComposer() {
    return qs('.composer-actions') || qs('.composer')
  }

  function findMessageList() {
    return qs('.message-list') || qs('.message-scroll')
  }

  function findDraft() {
    return qs('.composer-input')
  }

  function ensureBtn() {
    var composer = findComposer()
    if (!composer) return null
    var existing = composer.querySelector('.xz-img-btn')
    if (existing) return existing
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'icon-button xz-img-btn'
    btn.title = BUTTON_TITLE
    btn.innerHTML = svgIcon
    btn.style.cssText = 'order:-1;flex:none;'
    composer.insertBefore(btn, composer.firstChild)
    return btn
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
      if (f) sendImage(f)
      fileInput.remove()
      fileInput = null
    })
    fileInput.click()
  }

  function readFileAsDataURL(file, cb) {
    var reader = new FileReader()
    reader.onload = function () { cb(reader.result) }
    reader.onerror = function () { cb(null) }
    reader.readAsDataURL(file)
  }

  function sendImage(file) {
    if (!file || file.type.indexOf('image/') !== 0) return
    readFileAsDataURL(file, function (dataUrl) {
      if (!dataUrl) return
      var draft = findDraft()
      var question = (draft && draft.value && draft.value.trim()) || '请详细描述这张图片里的内容。'
      if (draft) draft.value = ''
      var imgB64 = dataUrl.indexOf('data:') === 0 ? dataUrl.split(',')[1] : dataUrl
      // 1. 图片气泡立即显示在消息流
      appendImageBubble(imgB64)
      appendTextBubble('assistant', '（思考中…）', 'xz-thinking')
      // 2. 调用小智官方视觉
      fetch('/api/xiaozhi/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: imgB64, question: question }),
      })
        .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { ok: r.ok, j: j } }) })
        .then(function (res) {
          removeThinkingBubble()
          if (res.ok && res.j && res.j.text) {
            appendTextBubble('assistant', res.j.text, 'xz-vision-text')
          } else {
            appendTextBubble('assistant', '图片分析失败：' + (res.j.detail || ('HTTP ' + res.j.status || '未知错误')), 'xz-vision-text')
          }
        })
        .catch(function (err) {
          removeThinkingBubble()
          appendTextBubble('assistant', '图片分析失败：' + err.message, 'xz-vision-text')
        })
    })
  }

  function appendBubble(rowClass, innerHtml) {
    var list = findMessageList()
    if (!list) return
    var article = document.createElement('article')
    article.className = 'message-row ' + rowClass
    article.innerHTML = innerHtml
    list.appendChild(article)
    var scroll = qs('.message-scroll')
    if (scroll) scroll.scrollTop = scroll.scrollHeight
    return article
  }

  function appendImageBubble(imgB64) {
    appendBubble('user', '<div class="message-body"><div class="message-heading"><strong>你</strong></div>' +
      '<div class="message-part xz-img-part"><img src="data:image/jpeg;base64,' + imgB64 + '" style="max-width:240px;max-height:180px;border-radius:8px;display:block;background:#fff;" alt="上传图片"/></div></div>')
  }

  function appendTextBubble(role, text, extraCls) {
    var avatar = role === 'assistant'
      ? (function () { var a = qs('.message-avatar.assistant-avatar'); return a ? a.outerHTML : '' })()
      : ''
    appendBubble(role, avatar + '<div class="message-body"><div class="message-heading"><strong>' +
      (role === 'assistant' ? '小智' : '你') + '</strong></div>' +
      '<div class="message-part ' + (extraCls || '') + '"><p style="margin:0;white-space:pre-wrap;">' + escapeHtml(text) + '</p></div></div>')
  }

  function removeThinkingBubble() {
    qsa('.xz-thinking').forEach(function (el) { el.closest('.message-row') && el.closest('.message-row').remove() })
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  // ---- 粘贴图片（在 composer 区域）----
  document.addEventListener('paste', function (e) {
    var composer = findComposer()
    if (!composer) return
    if (!composer.contains(e.target)) return
    var items = (e.clipboardData || window.clipboardData)
    if (!items || !items.items) return
    for (var i = 0; i < items.items.length; i++) {
      var it = items.items[i]
      if (it.type && it.type.indexOf('image/') === 0) {
        var f = it.getAsFile && it.getAsFile()
        if (f) { sendImage(f); e.preventDefault() }
        return
      }
    }
  })

  // ---- MutationObserver 持续注入按钮（Vue 重渲染后不丢失）----
  var observer = new MutationObserver(function () { ensureBtn() })
  observer.observe(document.body, { childList: true, subtree: true })
  ensureBtn()

  // 页面可见后轮询确保按钮存在
  setInterval(ensureBtn, 2000)
})()
