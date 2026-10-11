/* xiaozhi-chat-inject.js — Mio 原版私人空间对话页注入"小智图片提问"
 * 1. composer 栏注入 📷 上传图片按钮（点击选图）
 * 2. 支持 Ctrl+V 粘贴图片
 * 3. 图片 → 后端 /api/xiaozhi/vision（小智官方云视觉，免费）
 *    → 分析文本经小智 WS 自动显示在消息流 + 写入会话历史（刷新/重开后图片与分析可见）
 */
(function () {
  if (window.__mioXzChatInjectLoaded) return
  window.__mioXzChatInjectLoaded = true

  var svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'

  function qs(sel, root) { return (root || document).querySelector(sel) }

  function findComposer() {
    return qs('.composer-actions') || qs('.composer')
  }
  function findDraft() {
    return qs('.composer-input')
  }

  function ensureBtn() {
    var composer = findComposer()
    if (!composer) return
    if (composer.querySelector('.xz-img-btn')) return
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'icon-button xz-img-btn'
    btn.title = '上传图片让小智分析'
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
      fetch('/api/xiaozhi/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: imgB64, question: question }),
      })
        .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { ok: r.ok, j: j } }) })
        .then(function (res) {
          if (!(res.ok && res.j && res.j.text)) {
            console.warn('[xz-img] vision failed', res.j)
          }
        })
        .catch(function (err) { console.warn('[xz-img] vision error', err) })
    })
  }

  // ---- 粘贴图片（composer 区域）----
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
  setInterval(ensureBtn, 2000)
})()
