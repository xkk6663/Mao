/* xiaozhi-history-panel.js — 小智对话记录：替代原版左侧"对话"栏的内容区（不是独立浮窗）
 * 目的：打开 MIO 管理窗口后，左侧导航（对话/桌宠/设置）保持原版，其中"对话"栏的右侧内容区
 *      显示小智长连接以来所有来往记录（历史+实时+发送文字/图片），原版聊天界面内容被取代。
 * 数据：GET /api/xiaozhi/chat-history（历史）+ WS /api/xiaozhi/ws?role=chat（实时文本事件）
 * 发送：文本 → POST /api/xiaozhi/say；图片（暂存）→ POST /api/xiaozhi/vision
 * 视图：监听侧边栏 nav-item.active —— 对话视图显示本面板（覆盖原版聊天区），桌宠/设置视图隐藏。
 */
(function () {
  if (window.__mioXzHistoryPanelLoaded) return
  window.__mioXzHistoryPanelLoaded = true

  var API = {
    history: '/api/xiaozhi/chat-history?limit=200',
    say: '/api/xiaozhi/say',
    vision: '/api/xiaozhi/vision',
    ws: function () {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
      return proto + location.host + '/api/xiaozhi/ws?role=chat'
    },
  }

  var state = { ws: null, connected: false, pendingImages: [], busy: false }
  var $ = function (sel) { return document.querySelector(sel) }

  // ---------- 布局：覆盖右侧内容区（不盖左侧边栏） ----------
  function contentLeft() {
    var sb = $('.sidebar')
    if (sb) return sb.getBoundingClientRect().right
    var nav = $('nav')
    if (nav) return nav.getBoundingClientRect().right
    return 0
  }
  function relayout() {
    if (panel) panel.style.left = contentLeft() + 'px'
  }

  // ---------- 视图判断：当前是否"对话"视图 ----------
  function isChatView() {
    var items = document.querySelectorAll('nav button.nav-item')
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains('active')) {
        var t = (items[i].getAttribute('title') || '') + (items[i].textContent || '')
        return t.indexOf('对话') >= 0 || t.indexOf('chat') >= 0
      }
    }
    return true // 未检测到（Vue 未渲染/默认初始页）→ 视为对话视图
  }
  function applyView() {
    if (!panel) return
    var chat = isChatView()
    panel.style.display = chat ? 'flex' : 'none'
    // 对话视图时暂停原版注入脚本（防原版 composer 与面板双发图片）
    window.__mioXzChatInjectPaused = chat
    if (chat) relayout()
  }

  // ---------- UI 骨架 ----------
  var panel = null
  function css(el, obj) { for (var k in obj) el.style[k] = obj[k] }

  function buildPanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = 'xz-history-panel'
    css(panel, {
      position: 'fixed', top: '0', bottom: '0', left: '0', right: '0', zIndex: '9999',
      display: 'flex', flexDirection: 'column',
      background: '#f5f7f9', fontFamily: '"Microsoft YaHei","PingFang SC",system-ui,sans-serif',
    })
    panel.innerHTML =
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:10px 16px;background:#fff;border-bottom:1px solid #e8eaee;">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:#f0785e;flex:none;" id="xzHpDot"></span>' +
        '<strong style="font-size:14px;flex:none;">小智对话记录</strong>' +
        '<span style="flex:1;font-size:11px;color:#8a919c;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" id="xzHpStatus">连接中…</span>' +
      '</div>' +
      '<div id="xzHpList" style="flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;"></div>' +
      '<div id="xzHpPending" style="flex:none;display:none;flex-wrap:wrap;gap:6px;padding:6px 16px 0;background:#f5f7f9;"></div>' +
      '<div style="flex:none;display:flex;gap:8px;padding:10px 16px;background:#fff;border-top:1px solid #e8eaee;">' +
        '<button type="button" id="xzHpImg" title="上传图片让小智分析" style="flex:none;width:36px;height:36px;border:1px solid #dcdfe4;border-radius:10px;background:#fff;color:#8a919c;font-size:16px;cursor:pointer;">&#128247;</button>' +
        '<input id="xzHpInput" type="text" placeholder="和小智说点什么…" style="flex:1;min-width:0;border:1px solid #dcdfe4;border-radius:10px;padding:8px 12px;font-size:14px;outline:none;background:#fff;">' +
        '<button type="button" id="xzHpSend" style="flex:none;border:none;border-radius:10px;padding:0 16px;background:#4f6ef7;color:#fff;font-size:13px;cursor:pointer;">发送</button>' +
        '<input type="file" id="xzHpFile" accept="image/*" style="display:none;">' +
      '</div>'
    document.body.appendChild(panel)
    bindEvents()
    return panel
  }

  // ---------- 事件 ----------
  function bindEvents() {
    panel.querySelector('#xzHpImg').addEventListener('click', function () {
      panel.querySelector('#xzHpFile').click()
    })
    panel.querySelector('#xzHpFile').addEventListener('change', function () {
      var f = panel.querySelector('#xzHpFile').files && panel.querySelector('#xzHpFile').files[0]
      if (f) stageImage(f)
      panel.querySelector('#xzHpFile').value = ''
    })
    panel.querySelector('#xzHpSend').addEventListener('click', sendCurrent)
    panel.querySelector('#xzHpInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) sendCurrent()
    })
    // 粘贴图片 → 暂存（仅对话视图有效）
    document.addEventListener('paste', function (e) {
      if (panel.style.display !== 'flex') return
      var items = (e.clipboardData || window.clipboardData)
      if (!items || !items.items) return
      for (var i = 0; i < items.items.length; i++) {
        var it = items.items[i]
        if (it.type && it.type.indexOf('image/') === 0) {
          var f = it.getAsFile && it.getAsFile()
          if (f) { e.preventDefault(); stageImage(f); return }
        }
      }
    })
  }

  // ---------- 图片暂存条 ----------
  function stageImage(file) {
    if (!file || file.type.indexOf('image/') !== 0) return
    if (file.size > 4 * 1024 * 1024) { setStatus('⚠ 图片过大（>4MB）'); return }
    var reader = new FileReader()
    reader.onload = function () {
      if (!reader.result) return
      state.pendingImages.push({ dataUrl: String(reader.result) })
      renderPending()
    }
    reader.readAsDataURL(file)
  }

  function renderPending() {
    var bar = panel.querySelector('#xzHpPending')
    bar.innerHTML = ''
    if (!state.pendingImages.length) { bar.style.display = 'none'; return }
    bar.style.display = 'flex'
    state.pendingImages.forEach(function (img, idx) {
      var item = document.createElement('div')
      css(item, { position: 'relative', width: '52px', height: '52px', borderRadius: '8px', overflow: 'hidden', border: '1px solid #dcdfe4', flex: 'none' })
      var t = document.createElement('img')
      t.src = img.dataUrl
      css(t, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' })
      var del = document.createElement('button')
      del.type = 'button'
      del.title = '移除'
      del.textContent = '✕'
      css(del, { position: 'absolute', top: '2px', right: '2px', width: '16px', height: '16px', borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: '10px', lineHeight: '16px', cursor: 'pointer', padding: '0' })
      del.addEventListener('click', function () {
        state.pendingImages.splice(idx, 1)
        renderPending()
      })
      item.appendChild(t)
      item.appendChild(del)
      bar.appendChild(item)
    })
  }

  // ---------- 消息渲染 ----------
  function appendMessage(m) {
    var list = panel.querySelector('#xzHpList')
    var role = m.role, text = m.text || '', type = m.type || 'text'
    var el = document.createElement('div')
    if (role === 'system') {
      el.style.cssText = 'align-self:center;font-size:11px;color:#a0a6af;background:rgba(0,0,0,0.03);padding:3px 10px;border-radius:8px;max-width:80%;text-align:center;'
      el.textContent = text
    } else {
      var mine = role === 'user'
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;' + (mine ? 'flex-direction:row-reverse;' : '')
      var avatar = document.createElement('div')
      avatar.textContent = mine ? '你' : 'MIO'
      css(avatar, { flex: 'none', width: '30px', height: '30px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '600', color: '#fff', background: mine ? '#4f6ef7' : 'linear-gradient(135deg,#7a5cf0,#b06cf0)' })
      var bubble = document.createElement('div')
      bubble.style.cssText = 'max-width:72%;padding:9px 13px;border-radius:12px;font-size:13px;line-height:1.6;word-break:break-word;white-space:pre-wrap;background:' + (mine ? '#4f6ef7' : '#fff') + ';color:' + (mine ? '#fff' : '#1f2328') + ';box-shadow:0 1px 3px rgba(0,0,0,0.06);'
      if (type === 'image' && m.image_base64) {
        var imgWrap = document.createElement('div')
        imgWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;'
        var img = document.createElement('img')
        var src = String(m.image_base64)
        img.src = src.indexOf('data:') === 0 ? src : 'data:image/jpeg;base64,' + src
        css(img, { maxWidth: '220px', maxHeight: '220px', borderRadius: '8px', display: 'block' })
        imgWrap.appendChild(img)
        if (text) {
          var q = document.createElement('div')
          q.textContent = text
          q.style.cssText = 'font-size:12px;opacity:0.9;'
          imgWrap.appendChild(q)
        }
        bubble.appendChild(imgWrap)
      } else if (text) {
        bubble.textContent = text
      } else {
        bubble.style.display = 'none'
      }
      row.appendChild(avatar)
      row.appendChild(bubble)
      el.appendChild(row)
    }
    list.appendChild(el)
    // 跟随最新
    list.scrollTop = list.scrollHeight
  }

  function setStatus(text, stateName) {
    var st = panel.querySelector('#xzHpStatus')
    var dot = panel.querySelector('#xzHpDot')
    if (st) st.textContent = text || ''
    if (dot) {
      dot.style.background = stateName === 'connected' ? '#22c55e' : stateName === 'connecting' ? '#eab308' : '#f0785e'
    }
  }

  // ---------- 发送 ----------
  function sendCurrent() {
    if (state.busy) return  // 防重复触发：发送进行中忽略再次点击/回车
    if (state.pendingImages.length) { sendImage(); return }
    var input = panel.querySelector('#xzHpInput')
    var text = (input.value || '').trim()
    if (!text) return
    input.value = ''
    state.busy = true
    setStatus('正在发送…', 'connecting')
    fetch(API.say, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    }).then(function (r) { return r.json().catch(function () { return {} }) })
      .then(function (j) {
        state.busy = false
        if (!j.ok) setStatus('⚠ ' + (j.detail || '发送失败'), 'connecting')
      })
      .catch(function () { state.busy = false; setStatus('⚠ 网络错误', 'connecting') })
    // 本地立即回显"你"（历史接口已写入，刷新一致）
    appendMessage({ role: 'user', type: 'text', text: text })
  }

  function sendImage() {
    if (state.busy) return
    var img = state.pendingImages.shift()
    renderPending()
    var input = panel.querySelector('#xzHpInput')
    var question = (input.value || '').trim() || ''
    input.value = ''
    var b64 = String(img.dataUrl).split(',')[1] || ''
    if (!b64) { setStatus('⚠ 读取图片失败', 'connecting'); return }
    state.busy = true
    appendMessage({ role: 'user', type: 'image', text: question || '图片', image_base64: img.dataUrl })
    setStatus('正在分析图片…', 'connecting')
    fetch(API.vision, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: b64, question: question }),
    }).then(function (r) { return r.json().catch(function () { return {} }) })
      .then(function (j) {
        state.busy = false
        // /vision 返回 {ok, trigger}（MCP 工具链路，识别文本经 WS/历史显示），不再返回 text
        if (!j.ok) setStatus('⚠ ' + (j.detail || '图片分析失败'), 'connecting')
        else setStatus('已发送，等待小智分析…', 'connected')
      })
      .catch(function () { state.busy = false; setStatus('⚠ 网络错误', 'connecting') })
  }

  // ---------- WS 实时 ----------
  function connectWs() {
    if (state.ws && state.ws.readyState === 1) return
    setStatus('连接中…', 'connecting')
    try { state.ws = new WebSocket(API.ws()) } catch (e) { setStatus('连接失败', 'offline'); return }
    state.ws.onopen = function () {
      try { state.ws.send(JSON.stringify({ type: 'hello', version: 1, transport: 'websocket' })) } catch (e) {}
    }
    state.ws.onclose = function () {
      state.connected = false
      setStatus('连接中断，重连中…', 'offline')
      setTimeout(connectWs, 3000)
    }
    state.ws.onerror = function () { /* onclose 处理 */ }
    state.ws.onmessage = function (ev) {
      if (typeof ev.data !== 'string') return
      var j
      try { j = JSON.parse(ev.data) } catch (e) { return }
      if (!j || !j.type) return
      if (j.type === 'hello') {
        state.connected = true
        setStatus('已连接（会话 ' + (j.session_id || '') + '）', 'connected')
      } else if (j.type === 'llm' && j.text) {
        setStatus('小智正在说话…', 'connected')
        appendMessage({ role: 'pet', type: 'text', text: String(j.text) })
      } else if (j.type === 'tts') {
        if (j.state === 'start') setStatus('小智正在说话…', 'connected')
        else if (j.state === 'stop') setStatus('已连接', 'connected')
      } else if (j.type === 'sysmsg' && j.text) {
        appendMessage({ role: 'system', type: 'text', text: String(j.text) })
      } else if (j.type === 'error') {
        if (j.error === 'connecting') setStatus('连接中断，重连中…', 'offline')
        else if (j.error && j.error !== 'connecting') setStatus('⚠ ' + j.error, 'offline')
      }
    }
  }

  // ---------- 历史加载 ----------
  var lastSeenId = 0
  function loadHistory() {
    var list = panel.querySelector('#xzHpList')
    list.innerHTML = ''
    fetch(API.history)
      .then(function (r) { return r.json().catch(function () { return { history: [] } }) })
      .then(function (j) {
        var h = (j.history || []).slice()
        if (!h.length) {
          var empty = document.createElement('div')
          empty.style.cssText = 'align-self:center;font-size:12px;color:#a0a6af;margin-top:60px;'
          empty.textContent = '还没有对话记录，和小智说点什么吧～'
          list.appendChild(empty)
          return
        }
        h.forEach(function (m) {
          if (m && m.id) lastSeenId = Math.max(lastSeenId, Number(m.id) || 0)
          appendMessage(m)
        })
        list.scrollTop = list.scrollHeight
      })
      .catch(function () { /* 忽略 */ })
  }

  // 增量刷新：每 5s 拉取最新记录，只追加新条目（图片/识别/回答自动出现，不整表重载不闪烁）
  function refreshIncremental() {
    if (!panel || panel.style.display !== 'flex') return
    fetch('/api/xiaozhi/chat-history?limit=50')
      .then(function (r) { return r.json().catch(function () { return { history: [] } }) })
      .then(function (j) {
        var list = panel.querySelector('#xzHpList')
        if (!list) return
        var h = (j.history || []).slice()
        var maxId = lastSeenId
        h.forEach(function (m) {
          if (!m || !m.id) return
          var id = Number(m.id) || 0
          if (id > lastSeenId) {
            maxId = Math.max(maxId, id)
            appendMessage(m)
          }
        })
        lastSeenId = maxId
      })
      .catch(function () { /* 忽略 */ })
  }

  // ---------- 启动：打开管理窗口即显示（对话视图 = 内容区主体） ----------
  buildPanel()
  applyView()
  relayout()
  loadHistory()
  connectWs()
  setInterval(refreshIncremental, 5000)  // 增量刷新：新图片/识别/回答自动出现
  // 监听 Vue 视图切换（对话/桌宠/设置）与窗口尺寸变化
  var mo = new MutationObserver(function () { try { applyView() } catch (e) { /* ignore */ } })
  mo.observe(document.body, { childList: true, subtree: true })
  setInterval(function () { try { applyView() } catch (e) { /* ignore */ } }, 1500)
  window.addEventListener('resize', function () { try { relayout() } catch (e) { /* ignore */ } })
})()
