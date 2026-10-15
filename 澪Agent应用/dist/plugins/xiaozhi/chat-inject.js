/* xiaozhi-chat-inject.js — Mio 原版私人空间对话页注入"小智图片提问"（图片暂存模式）
 * 1. composer 栏注入 📷 上传图片按钮（点击选图）
 * 2. 支持 Ctrl+V 粘贴图片
 * 3. 图片**暂存**在输入框上方（缩略图可预览、可删除），点发送按钮（或 Enter）才发送
 * 4. 发送 → 后端 /api/xiaozhi/vision（小智官方云视觉，免费）
 *    → 分析文本经小智 WS 自动显示在消息流 + 写入会话历史（刷新/重开后图片与分析可见）
 * 提示词设置入口已移至右侧"小智状态"栏（⚙ 提示词设置按钮）
 */
(function () {
  if (window.__mioXzChatInjectLoaded) return
  window.__mioXzChatInjectLoaded = true

  // 插件化：小智未启用（后端 xiaozhi agent enabled=false）时不注入任何小智 UI
  ;(async function gateByAgentEnabled() {
    try {
      const res = await fetch('/api/companion/agents', { headers: { 'Cache-Control': 'no-cache' } })
      const data = await res.json()
      const agents = data && Array.isArray(data.agents) ? data.agents : []
      const xz = agents.find((a) => a && String(a.agent_id) === 'xiaozhi')
      if (xz && xz.enabled === false) {
        window.__mioXzChatInjectPaused = true
        return
      }
      window.__mioXzChatInjectPaused = false
    } catch (_) {
      // 后端暂不可达时不阻塞注入（保持原行为）
      window.__mioXzChatInjectPaused = false
    }
    boot()
  })()

  function boot() {
  var svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'

  var pendingImages = [] // [{dataUrl, name}]

  function qs(sel, root) { return (root || document).querySelector(sel) }

  function findComposer() {
    var c = qs('.composer-actions') || qs('.composer')
    if (c) return c
    // fallback：找 composer-input textarea 的父容器（Vue 类名可能变化）
    var ta = qs('.composer-input') || qs('textarea[placeholder*="输入"]') || qs('textarea')
    if (ta) return ta.closest('.composer') || ta.parentElement
    return null
  }
  function findDraft() { return qs('.composer-input') }
  function findSendBtn() { return qs('.send-button') }

  // ---- 暂存条 UI ----
  var pendingBar = null
  function ensurePendingBar() {
    if (pendingBar && pendingBar.isConnected) return pendingBar
    var composer = findComposer()
    if (!composer) return null
    // 暂存条和 .composer 同级（插入到 .composer 前面），不能用 .composer-actions 当参考节点
    // （.composer-actions 是 .composer 的子元素，不是 .composer-wrap 的直接子元素，insertBefore 会抛 NotFoundError）
    var composerEl = composer.closest('.composer') || composer
    var wrap = composerEl.parentElement
    if (!wrap) return null
    pendingBar = document.createElement('div')
    pendingBar.className = 'xz-pending-bar'
    pendingBar.style.cssText = 'display:none;flex-wrap:wrap;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(0,0,0,0.06);background:rgba(0,0,0,0.02);'
    wrap.insertBefore(pendingBar, composerEl)
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
    var question = (draft && draft.value && draft.value.trim()) || ''  // 留空 → 后端使用可配置的"图片识别前置提示词"
    if (draft) {
      draft.value = ''
      // 同步 Vue 的 v-model（ChatPage 用 onUpdate:modelValue 绑定内部 ref）：
      // 只改 DOM 不清 ref，历史轮询触发重渲染会把旧文字恢复回输入框（"文字发出后停留输入框"根因）
      try { draft.dispatchEvent(new Event('input', { bubbles: true })) } catch (e) { /* ignore */ }
    }
    renderPending()
    var imgB64 = img.dataUrl.indexOf('data:') === 0 ? img.dataUrl.split(',')[1] : img.dataUrl
    fetch('/api/xiaozhi/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: imgB64, question: question }),
    })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { ok: r.ok, j: j } }) })
      .then(function (res) {
        // /vision 返回 {ok, trigger}（MCP 工具链路），不再返回 text
        if (!(res.ok && res.j && res.j.ok)) console.warn('[xz-img] vision failed', res.j)
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
      if (window.__mioXzChatInjectPaused) return // 小智历史面板打开时不拦截原版发送
      if (!pendingImages.length) return // 无暂存图 → 放行原文字发送逻辑
      e.preventDefault()
      e.stopPropagation()
      sendPending()
    }, true)
  }
  // Enter 键：有暂存图时优先发图
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing) return
    if (window.__mioXzChatInjectPaused) return
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

  // 粘贴图片 → 暂存（全局拦截：焦点不必在输入框内，防止粘贴图片无反应）
  // 小智历史面板打开时（window.__mioXzChatInjectPaused）暂停暂存，避免同一张图被两个脚本
  // 各自暂存、导致发送时双发两次 /vision 分析。
  document.addEventListener('paste', function (e) {
    if (window.__mioXzChatInjectPaused) return
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

  // ---- 调试角标：左下角小圆点（绿=输入区+按钮都OK，黄=输入区在但按钮未注入，红=没找到输入区）----
  var badgeClosed = false
  function ensureBadge() {
    if (badgeClosed) return
    var composer = findComposer()
    var btn = composer && composer.querySelector('.xz-img-btn')
    var b = document.getElementById('xz-inject-badge')
    if (!b) {
      b = document.createElement('div')
      b.id = 'xz-inject-badge'
      b.title = '小智图片注入诊断 v20261012e（点此关闭）'
      b.style.cssText = 'position:fixed;left:6px;bottom:6px;width:10px;height:10px;border-radius:50%;z-index:99999;cursor:pointer;box-shadow:0 0 0 1px rgba(0,0,0,0.2);'
      b.addEventListener('click', function () { badgeClosed = true; b.remove() })
      document.body.appendChild(b)
    }
    // 每次都更新颜色（修复：Vue 异步渲染后角标不再是永久红点）
    b.style.background = (composer && btn) ? '#22c55e' : (composer ? '#eab308' : '#ef4444')
  }

  // ---- 对话头像：发送方（你）头像替换（user 消息旁图标 → 用户头像图，未设置则保留图标） ----
  function applyChatAvatar() {
    var avatars = document.querySelectorAll('span.message-avatar.user-avatar')
    if (!avatars.length) return
    for (var i = 0; i < avatars.length; i++) {
      var span = avatars[i]
      if (span.__mioAvatarApplied) continue
      span.__mioAvatarApplied = true
      ;(function (s) {
        var img = new Image()
        img.onload = function () {
          if (!s.isConnected) return
          img.style.cssText = 'width:32px;height:32px;border-radius:50%;object-fit:cover;display:block;'
          s.innerHTML = ''
          s.appendChild(img)
        }
        img.onerror = function () { /* 未设置用户头像 → 保留原图标 */ }
        img.src = '/api/settings/user-avatar?v=' + Date.now()
      })(span)
    }
  }

  // ---- 保活：Vue 重渲染后按钮/暂存条/拦截/头像不丢失 ----
  function keepAlive() {
    try { ensureBtn() } catch (e) { /* ignore */ }
    try { interceptSend() } catch (e) { /* ignore */ }
    try { ensurePendingBar() } catch (e) { /* ignore */ }
    try { ensureBadge() } catch (e) { /* ignore */ }
    try { applyChatAvatar() } catch (e) { /* ignore */ }
  }  var observer = new MutationObserver(keepAlive)
  observer.observe(document.body, { childList: true, subtree: true })
  keepAlive()
  setInterval(keepAlive, 2000)
  // 角标颜色独立高频刷新（不依赖 keepAlive，确保 Vue 渲染后及时变绿）
  setInterval(function () { try { ensureBadge() } catch (e) {} }, 500)
  }  // end boot
})()
