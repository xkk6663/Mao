/* pet-xz-audio.js — 桌宠主窗直连本地代理 /api/xiaozhi/ws，被动接收小智语音并播放
 * 解决"观察评价有文字但无声音"：此前音频只转发给对话浮窗订阅者，浮窗未开时消息被丢弃。
 * 现在桌宠主窗常驻订阅：浮窗开着 → 音频去浮窗（活跃订阅者优先）；浮窗没开 → 桌宠主窗播放。
 * 断连/重连静默处理，不打扰气泡。口型通过 CustomEvent('mio-xz-speaking') 通知 live2d-pet.js。
 */
(function () {
  if (window.__mioPetXzAudioLoaded) return
  window.__mioPetXzAudioLoaded = true

  // ---- DOM ----
  var bubbleEl = document.getElementById('speech-bubble')
  var bubbleTextEl = document.getElementById('speech-bubble-text')
  var bubbleHideTimer = null

  // ---- 音频播放（48kHz 双声道 float32 planar，后端代理解码后的 PCM）----
  var audioCtx = null
  var analyserNode = null
  var playQueue = []
  var playing = false
  var nextStartTime = 0
  var activeSources = new Set()

  function ensureAudioCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext
      if (AC) { try { audioCtx = new AC() } catch (e) { audioCtx = null } }
    }
    if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume() } catch (e) {} }
    if (audioCtx && !analyserNode) {
      try {
        analyserNode = audioCtx.createAnalyser()
        analyserNode.fftSize = 256
        analyserNode.smoothingTimeConstant = 0.55
        analyserNode.connect(audioCtx.destination)
      } catch (e) { analyserNode = null }
    }
    return audioCtx
  }
  function pump() {
    if (!audioCtx || playing || playQueue.length === 0) return
    playing = true
    while (playQueue.length > 0) {
      var buf = playQueue.shift()
      var src = audioCtx.createBufferSource()
      src.buffer = buf
      // 音频先过 AnalyserNode（供口型能量分析），再接输出
      if (analyserNode) src.connect(analyserNode)
      else src.connect(audioCtx.destination)
      var now = audioCtx.currentTime
      if (nextStartTime < now + 0.03) nextStartTime = now + 0.03
      src.start(nextStartTime)
      nextStartTime += buf.duration
      src.onended = function () { activeSources.delete(src); try { src.disconnect() } catch (e) {} }
      activeSources.add(src)
    }
    playing = false
  }
  function stopPlayback() {
    for (var s of activeSources) { try { s.onended = null; s.stop() } catch (e) {} }
    activeSources.clear()
    playQueue = []; playing = false; nextStartTime = 0
  }
  // 正常结束（tts stop）：不强制停止，等已排程音频自然播完后收尾。
  // 官方音频帧与 stop 文本在同一 WS 保序到达，但前端 pump 会把到达的帧排程到
  // 未来播放时刻（批量/网络缓冲时超前更多），立即 stopPlayback 会截断尾部 → "没讲完"。
  var drainTimer = null
  function scheduleDrain() {
    if (drainTimer) return
    drainTimer = window.setInterval(function () {
      if (activeSources.size > 0 || playQueue.length > 0) return
      window.clearInterval(drainTimer)
      drainTimer = null
      stopMouthFeed()
      setSpeaking(false)
    }, 40)
  }
  function handlePcm(data) {
    var ctx = ensureAudioCtx()
    if (!ctx || data.byteLength < 8) return
    var view = new DataView(data, 0, data.byteLength)
    var samples = view.getUint32(0, true)
    var channels = view.getUint32(4, true)
    if (samples < 1 || channels < 1 || channels > 8) return
    var frameBytes = samples * 4
    if (8 + frameBytes * channels > data.byteLength) return
    var buffer = ctx.createBuffer(channels, samples, 48000)
    for (var c = 0; c < channels; c++) {
      var off = 8 + c * frameBytes
      buffer.copyToChannel(new Float32Array(data, off, samples), c)
    }
    playQueue.push(buffer)
    pump()
  }

  // ---- 气泡（复用桌宠主窗现有 bubble DOM）----
  function showBubble(text) {
    if (!bubbleEl || !bubbleTextEl) return
    bubbleTextEl.textContent = text || ''
    bubbleEl.hidden = false
    window.clearTimeout(bubbleHideTimer)
    bubbleHideTimer = window.setTimeout(hideBubble, Math.max(4000, (text || '').length * 180))
  }
  function hideBubble() {
    window.clearTimeout(bubbleHideTimer)
    if (bubbleEl) bubbleEl.hidden = true
  }

  // ---- 口型通知（live2d-pet.js 监听 mio-xz-speaking）----
  function setSpeaking(active, durationMs) {
    try {
      window.dispatchEvent(new CustomEvent('mio-xz-speaking', { detail: { active: !!active, durationMs: durationMs || 5000 } }))
    } catch (e) {}
  }

  // ---- 真实口型：分析播放中的音频能量，高频派发 mio-xz-mouth（live2d-pet.js 设置 ParamMouthOpenY）----
  var mouthTimer = null
  var mouthData = null
  function startMouthFeed() {
    stopMouthFeed()
    if (!analyserNode) return
    mouthData = new Uint8Array(analyserNode.fftSize)
    mouthTimer = window.setInterval(function () {
      if (!analyserNode) { stopMouthFeed(); return }
      analyserNode.getByteTimeDomainData(mouthData)
      var sum = 0
      for (var i = 0; i < mouthData.length; i++) {
        var v = (mouthData[i] - 128) / 128
        sum += v * v
      }
      var level = Math.min(1, Math.sqrt(sum / mouthData.length) * 5.2)
      window.dispatchEvent(new CustomEvent('mio-xz-mouth', { detail: { level: level } }))
    }, 80)
  }
  function stopMouthFeed() {
    window.clearInterval(mouthTimer)
    mouthTimer = null
    try { window.dispatchEvent(new CustomEvent('mio-xz-mouth', { detail: { level: 0 } })) } catch (e) {}
  }

  // ---- WebSocket（本地代理 → 小智官方云）----
  var ws = null
  var reconnectTimer = null
  var retryDelay = 3000
  var sessionId = ''

  function connect() {
    // role=main：桌宠本体是唯一音频播放者（后端只把音频帧发给 main，避免多窗口声音叠加）
    var url = 'ws://' + location.host + '/api/xiaozhi/ws?role=main'
    var wsTry
    try { wsTry = new WebSocket(url) } catch (e) { scheduleReconnect(); return }
    ws = wsTry
    ws.binaryType = 'arraybuffer'
    ws.onopen = function () { retryDelay = 3000 }
    ws.onclose = function () { ws = null; scheduleReconnect() }
    ws.onerror = function () {}
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') handleText(ev.data)
      else handlePcm(ev.data)
    }
  }
  function scheduleReconnect() {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(connect, retryDelay)
    retryDelay = Math.min(15000, Math.round(retryDelay * 1.6))
  }

  function handleText(raw) {
    var j
    try { j = JSON.parse(raw) } catch (e) { return }
    if (!j || typeof j !== 'object') return
    switch (j.type) {
      case 'hello':
        sessionId = j.session_id || ''
        retryDelay = 3000
        break
      case 'llm':
        // 思考中/回答文本：短暂显示，不打断已播放语音
        if (j.emotion) setEmotion(j.emotion)
        break
      case 'tts':
        if (j.state === 'start') {
          // 新一段语音：立即打断旧的（含清理 drain），重新开始口型
          stopPlayback()
          if (drainTimer) { window.clearInterval(drainTimer); drainTimer = null }
          startMouthFeed()
          setSpeaking(true, 5000)
        } else if (j.state === 'sentence_start' && j.text) {
          showBubble(j.text)
          setSpeaking(true, Math.max(4000, j.text.length * 190))
        } else if (j.state === 'stop') {
          // 正常结束：让已排程音频自然播完（drain），播完后自动停口型/说话态；
          // 不立即 stopPlayback，避免截断"还没播完"的尾部语音
          scheduleDrain()
          hideBubble()
        }
        break
      case 'pet_text':
        // 小智回复文本流：附加 emotion（后端以用户输入推断），本地关键词兜底
        if (j.text) {
          var emo = j.emotion || localEmotion(j.text)
          if (emo) setEmotion(emo)
        }
        break
      case 'error':
        // 断连/重连静默，不弹气泡打扰
        break
      default: break
    }
  }

  // ---- 本地情绪关键词兜底（后端未推断时）----
  function localEmotion(text) {
    var t = String(text || '')
    if (/(哭|泪|呜呜|想哭|难过|伤心|抽泣)/.test(t)) return 'concerned'
    if (/(生气|气死|凶|发火|愤怒|恼怒)/.test(t)) return 'serious'
    if (/(害羞|脸红|羞涩|不好意思)/.test(t)) return 'shy'
    if (/(开心|高兴|哈哈|嘿嘿|笑|好耶)/.test(t)) return 'cheerful'
    if (/(温柔|轻柔|抱抱|哄|抱一下)/.test(t)) return 'gentle'
    return ''
  }

  // ---- 表情（小智 emotion → 桌宠表情）----
  function setEmotion(emotion) {
    try {
      window.dispatchEvent(new CustomEvent('mio-xz-emotion', { detail: { emotion: emotion || '' } }))
    } catch (e) {}
  }

  // ---- 插件化生命周期：不再加载即连接，由 xiaozhi 插件 onMount/onUnmount 驱动 ----
  function disconnect() {
    try {
      window.clearInterval(mouthTimer); mouthTimer = null
    } catch (_) {}
    try {
      window.clearTimeout(reconnectTimer); reconnectTimer = null
    } catch (_) {}
    try {
      window.clearInterval(drainTimer); drainTimer = null
    } catch (_) {}
    try { window.clearTimeout(bubbleHideTimer); bubbleHideTimer = null } catch (_) {}
    try { window.clearInterval(pumpTimer); pumpTimer = null } catch (_) {}
    if (ws) {
      try { ws.onclose = null; ws.close() } catch (_) {}
      ws = null
    }
    stopPlayback()
    setSpeaking(false, 0)
    stopMouthFeed()
  }

  window.__mioPetXzAudio = {
    connect: function () { connect() },
    disconnect: disconnect,
    get connected() { return !!ws },
  }
})()
