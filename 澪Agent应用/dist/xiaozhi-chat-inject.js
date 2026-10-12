/* xiaozhi-chat-inject.js — Mio 原版私人空间对话页注入"小智图片提问"（图片暂存模式）
 * 1. composer 栏注入 📷 上传图片按钮（点击选图）+ ⚙ 提示词设置按钮
 * 2. 支持 Ctrl+V 粘贴图片
 * 3. 图片**暂存**在输入框上方（缩略图可预览、可删除），点发送按钮（或 Enter）才发送
 * 4. 发送 → 后端 /api/xiaozhi/vision（小智官方云视觉，免费）
 *    → 分析文本经小智 WS 自动显示在消息流 + 写入会话历史（刷新/重开后图片与分析可见）
 * 5. ⚙ 提示词设置：编辑"图片识别前置提示词"与"屏幕观察提示词"，持久化到后端 JSON
 */
(function () {
  if (window.__mioXzChatInjectLoaded) return
  window.__mioXzChatInjectLoaded = true

  var svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'
  var gearIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>'
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

  // ---- 📷 上传按钮 + ⚙ 提示词设置按钮 ----
  function ensureBtn() {
    var composer = findComposer()
    if (!composer) return
    if (!composer.querySelector('.xz-img-btn')) {
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'icon-button xz-img-btn'
      btn.title = '上传图片让小智分析（点发送才发送）'
      btn.innerHTML = svgIcon
      btn.style.cssText = 'order:-1;flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;cursor:pointer;'
      btn.addEventListener('click', pickImage)
      composer.insertBefore(btn, composer.firstChild)
    }
    if (!composer.querySelector('.xz-prompt-btn')) {
      var pbtn = document.createElement('button')
      pbtn.type = 'button'
      pbtn.className = 'icon-button xz-prompt-btn'
      pbtn.title = '编辑小智提示词（图片识别 / 屏幕观察）'
      pbtn.innerHTML = gearIcon
      pbtn.style.cssText = 'order:-1;flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;cursor:pointer;'
      pbtn.addEventListener('click', openPromptsPanel)
      composer.insertBefore(pbtn, composer.firstChild)
    }
  }

  // ---- ⚙ 提示词设置面板 ----
  var promptsPanel = null
  var promptsBusy = false
  var promptsDraft = { image_prompt: '', observe_prompt: '', force_60: true }

  function openPromptsPanel() {
    if (promptsPanel && promptsPanel.isConnected) { closePromptsPanel(); return }
    loadPrompts().then(function (cfg) {
      if (cfg) promptsDraft = cfg
      renderPromptsPanel()
    }).catch(function () { renderPromptsPanel() })
  }
  function closePromptsPanel() {
    if (promptsPanel && promptsPanel.isConnected) promptsPanel.remove()
    promptsPanel = null
  }

  function loadPrompts() {
    return fetch('/api/xiaozhi/prompts', { method: 'GET' })
      .then(function (r) { return r.json() })
      .then(function (j) { return j && j.ok ? { image_prompt: j.image_prompt || '', observe_prompt: j.observe_prompt || '', force_60: j.force_60 !== false } : null })
  }

  function renderPromptsPanel() {
    closePromptsPanel()
    promptsPanel = document.createElement('div')
    promptsPanel.className = 'xz-prompts-panel'
    promptsPanel.style.cssText = 'position:fixed;right:18px;top:70px;z-index:99998;width:380px;max-width:calc(100vw - 36px);background:#fff;border:1px solid rgba(0,0,0,0.12);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,0.18);padding:16px 18px;font-size:13px;color:#1f2329;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;'
    var head = document.createElement('div')
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;'
    head.innerHTML = '<strong style="font-size:14px;">小智提示词设置</strong>'
    var xbtn = document.createElement('button')
    xbtn.type = 'button'
    xbtn.textContent = '✕'
    xbtn.style.cssText = 'border:none;background:transparent;font-size:15px;cursor:pointer;color:#8a9099;padding:2px 6px;'
    xbtn.addEventListener('click', closePromptsPanel)
    head.appendChild(xbtn)
    promptsPanel.appendChild(head)

    // 图片识别提示词
    promptsPanel.appendChild(makeField('图片识别前置提示词', '上传图片/截图提问/立即观察 未填问题时使用（发送给小智云端）', 'image_prompt'))
    // 屏幕观察提示词
    promptsPanel.appendChild(makeField('屏幕观察提示词', '随机屏幕观察（冷不丁评价）使用的提问', 'observe_prompt'))
    // 60字限制
    var forceRow = document.createElement('label')
    forceRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:10px 0 4px;cursor:pointer;'
    var forceChk = document.createElement('input')
    forceChk.type = 'checkbox'
    forceChk.checked = promptsDraft.force_60 !== false
    forceChk.style.cssText = 'width:15px;height:15px;cursor:pointer;'
    forceRow.appendChild(forceChk)
    forceRow.appendChild(document.createTextNode('自动追加「请用60字以内的简洁口语回答」（保证语音/气泡可读）'))
    promptsPanel.appendChild(forceRow)

    // 底部按钮
    var foot = document.createElement('div')
    foot.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;'
    var cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.textContent = '取消'
    cancelBtn.style.cssText = btnStyle('#f2f3f5', '#1f2329')
    cancelBtn.addEventListener('click', closePromptsPanel)
    foot.appendChild(cancelBtn)
    var saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.textContent = '保存'
    saveBtn.style.cssText = btnStyle('#3370ff', '#fff')
    saveBtn.addEventListener('click', function () { savePrompts(saveBtn) })
    foot.appendChild(saveBtn)
    promptsPanel.appendChild(foot)

    document.body.appendChild(promptsPanel)

    function makeField(label, tip, key) {
      var wrap = document.createElement('div')
      wrap.style.cssText = 'margin-bottom:10px;'
      var lab = document.createElement('div')
      lab.style.cssText = 'font-weight:600;margin-bottom:4px;'
      lab.textContent = label
      wrap.appendChild(lab)
      var tipEl = document.createElement('div')
      tipEl.style.cssText = 'color:#8a9099;font-size:12px;margin-bottom:6px;'
      tipEl.textContent = tip
      wrap.appendChild(tipEl)
      var ta = document.createElement('textarea')
      ta.rows = 3
      ta.value = promptsDraft[key] || ''
      ta.dataset.key = key
      ta.style.cssText = 'width:100%;box-sizing:border-box;border:1px solid #d0d3d9;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;resize:vertical;outline:none;'
      ta.addEventListener('focus', function () { ta.style.borderColor = '#3370ff' })
      ta.addEventListener('blur', function () { ta.style.borderColor = '#d0d3d9' })
      wrap.appendChild(ta)
      return wrap
    }
    function btnStyle(bg, fg) {
      return 'border:none;border-radius:8px;padding:7px 16px;font-size:13px;cursor:pointer;background:' + bg + ';color:' + fg + ';'
    }
    return promptsPanel
  }

  function savePrompts(saveBtn) {
    if (promptsBusy) return
    var taList = promptsPanel ? promptsPanel.querySelectorAll('textarea') : []
    var next = { image_prompt: '', observe_prompt: '', force_60: true }
    taList.forEach(function (ta) { next[ta.dataset.key] = ta.value || '' })
    var chk = promptsPanel ? promptsPanel.querySelector('input[type=checkbox]') : null
    next.force_60 = chk ? chk.checked : true
    promptsBusy = true
    var oldText = saveBtn.textContent
    saveBtn.textContent = '保存中…'
    saveBtn.disabled = true
    fetch('/api/xiaozhi/prompts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.ok) { promptsDraft = j; closePromptsPanel() }
        else { alert('保存失败：' + ((j && j.detail) || '未知错误')) }
      })
      .catch(function (err) { alert('保存失败：' + err.message) })
      .finally(function () {
        promptsBusy = false
        saveBtn.textContent = oldText
        saveBtn.disabled = false
      })
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

  // ---- 保活：Vue 重渲染后按钮/暂存条/拦截不丢失 ----
  function keepAlive() {
    try { ensureBtn() } catch (e) { /* ignore */ }
    try { interceptSend() } catch (e) { /* ignore */ }
    try { ensurePendingBar() } catch (e) { /* ignore */ }
    try { ensureBadge() } catch (e) { /* ignore */ }
  }  var observer = new MutationObserver(keepAlive)
  observer.observe(document.body, { childList: true, subtree: true })
  keepAlive()
  setInterval(keepAlive, 2000)
  // 角标颜色独立高频刷新（不依赖 keepAlive，确保 Vue 渲染后及时变绿）
  setInterval(function () { try { ensureBadge() } catch (e) {} }, 500)
})()
