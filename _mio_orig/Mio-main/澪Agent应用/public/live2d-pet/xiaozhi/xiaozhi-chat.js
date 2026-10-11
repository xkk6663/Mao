/* 小智官方云对话客户端（经本地后端 /api/xiaozhi/ws 代理）
 * 会话界面 = 长连接以来的所有来往记录（历史驱动渲染，3s 轮询同步截图提问/观察结果）
 * 支持：文字对话（后端音频流注入）/ 图片对话（官方视觉→语音回答）/ 历史可视化 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var msgsEl = $('msgs'), inputEl = $('input'), sendBtn = $('sendBtn'),
      imgBtn = $('imgBtn'), fileInput = $('fileInput'), statusDot = $('statusDot');

  var ws = null;
  var connected = false;
  var sessionId = '';
  var histShown = 0;      // 已渲染的历史条数
  var thinkingEl = null;
  var speakingEl = null;

  // ---------- 音频播放 ----------
  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  var audioCtx = null;
  var playQueue = [];   // AudioBuffer 队列
  var playing = false;
  var currentSource = null;

  function ensureAudioCtx() {
    if (!audioCtx) {
      try { audioCtx = new AudioCtx(); } catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === 'suspended') { audioCtx.resume(); }
    return audioCtx;
  }

  function schedulePlay(buffer) {
    playQueue.push(buffer);
    pumpQueue();
  }

  function pumpQueue() {
    if (!audioCtx || playing) return;
    if (playQueue.length === 0) { return; }
    playing = true;
    var buf = playQueue.shift();
    var src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.onended = function () {
      playing = false;
      pumpQueue();
    };
    src.start();
    currentSource = src;
  }

  function stopPlayback() {
    if (currentSource) {
      try { currentSource.onended = null; currentSource.stop(); } catch (e) { /* noop */ }
      currentSource = null;
    }
    playQueue = [];
    playing = false;
  }

  // 二进制：4B 样本数 + 4B 声道数 + planar float32（各声道连续）
  function handlePcm(data) {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.byteLength < 8) return;
    var samples = view.getUint32(0, true);
    var channels = view.getUint32(4, true);
    if (samples < 1 || channels < 1 || channels > 8) return;
    var frameBytes = samples * 4;
    if (8 + frameBytes * channels > data.byteLength) return;
    var buffer = ctx.createBuffer(channels, samples, 48000);
    for (var c = 0; c < channels; c++) {
      var off = 8 + c * frameBytes;
      var arr = new Float32Array(data.buffer, data.byteOffset + off, samples);
      buffer.copyToChannel(arr, c);
    }
    schedulePlay(buffer);
  }

  // ---------- UI ----------
  function addMsg(kind, text, meta) {
    var div = document.createElement('div');
    div.className = 'msg ' + kind;
    if (meta) {
      var m = document.createElement('span');
      m.className = 'meta';
      m.textContent = meta;
      div.appendChild(m);
    }
    var t = document.createElement('span');
    t.textContent = text;
    div.appendChild(t);
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function addMsgImage(kind, imageBase64, caption) {
    var div = document.createElement('div');
    div.className = 'msg img ' + kind;
    if (caption) {
      var m = document.createElement('span');
      m.className = 'cap';
      m.textContent = caption;
      div.appendChild(m);
    }
    var img = document.createElement('img');
    var src = imageBase64.indexOf('data:') === 0 ? imageBase64 : 'data:image/jpeg;base64,' + imageBase64;
    img.src = src;
    div.appendChild(img);
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function showThinking() {
    if (thinkingEl) return;
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking';
    thinkingEl.innerHTML = '<span class="spin"></span><span>思考中…</span>';
    msgsEl.appendChild(thinkingEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function hideThinking() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function showSpeaking() {
    if (speakingEl) return;
    speakingEl = document.createElement('div');
    speakingEl.className = 'speaking';
    speakingEl.innerHTML = '<span class="bar"></span><span class="bar"></span><span class="bar"></span><span>正在说话…</span>';
    msgsEl.appendChild(speakingEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function hideSpeaking() {
    if (speakingEl) {
      speakingEl.remove();
      speakingEl = null;
    }
  }

  function setStatus(state) {
    statusDot.className = 'dot ' + state;
  }

  // ---------- 会话历史（唯一消息来源，3s 轮询） ----------
  function fetchHistory() {
    return fetch('/api/xiaozhi/chat-history?limit=200')
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, history: [] }; });
  }

  function renderHistory(history) {
    for (var i = histShown; i < history.length; i++) {
      var it = history[i];
      if (it.type === 'image') {
        var cap = it.role === 'user' ? (it.text || (it.tag === 'observe' ? '（屏幕观察）' : '（图片）')) : '';
        addMsgImage(it.role === 'user' ? 'user' : 'ai', it.image_base64, cap);
      } else if (it.role === 'user') {
        addMsg('user', it.text, it.tag === 'observe' ? '屏幕观察' : (it.tag === 'stt' ? '你说' : '你说'));
      } else if (it.role === 'pet') {
        addMsg('ai', it.text, '她说');
      } else {
        addMsg('sys', it.text);
      }
    }
    histShown = history.length;
  }

  function pollHistory() {
    fetchHistory().then(function (j) {
      if (j.ok && j.history && j.history.length > histShown) {
        renderHistory(j.history);
      }
    });
  }

  // ---------- 发送 ----------
  function sendText() {
    var text = inputEl.value.trim();
    if (!text || !connected) return;
    inputEl.value = '';
    showThinking();
    // 走后端音频流注入（官方语音通道）：后端负责 abort→唤醒→listen start→TTS音频流→stop，
    // 官方云 ASR 识别后 LLM 回答并播报。文本/回答由会话历史统一渲染。
    fetch('/api/xiaozhi/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { hideThinking(); addMsg('sys', '⚠ 注入失败：' + (j.detail || '未知错误')); }
    }).catch(function () {
      hideThinking(); addMsg('sys', '⚠ 网络错误，注入失败');
    });
    setTimeout(pollHistory, 400);
  }

  function sendImage() {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    sendImageFile(file);
    fileInput.value = '';
  }

  // 支持粘贴图片（Ctrl+V → 剪贴板图片 → 直接上传识别）
  function sendImageFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { addMsg('sys', '⚠ 仅支持图片文件'); return; }
    if (file.size > 4 * 1024 * 1024) { addMsg('sys', '⚠ 图片过大（>4MB），请压缩后重试'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var base64 = String(reader.result).split(',')[1] || '';
      if (!base64) { addMsg('sys', '⚠ 读取图片失败'); return; }
      addMsgImage('user', base64, '（图片已发送，识别中…）');
      showThinking();
      fetch('/api/xiaozhi/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, question: '请详细描述这张图片里的内容。' })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) {
          hideThinking();
          addMsg('sys', '⚠ 图片分析失败：' + (j.detail || '未知错误'));
        }
      }).catch(function () {
        hideThinking();
        addMsg('sys', '⚠ 网络错误，图片分析失败');
      });
      setTimeout(pollHistory, 600);
    };
    reader.readAsDataURL(file);
  }

  // ---------- WebSocket（连接状态 / 音频 / 说话状态；文本显示由历史驱动） ----------
  function connect() {
    setStatus('connecting');
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var url = proto + location.host + '/api/xiaozhi/ws';
    try { ws = new WebSocket(url); } catch (e) { setStatus('offline'); return; }

    ws.onopen = function () {
      send({ type: 'hello', version: 1, transport: 'websocket',
             audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } });
    };
    ws.onclose = function () {
      connected = false;
      setStatus('offline');
      setTimeout(connect, 3000);
    };
    ws.onerror = function () { /* onclose 处理 */ };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') { handleText(ev.data); }
      else { handlePcm(ev.data); }
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); }
  }

  function handleText(raw) {
    var j;
    try { j = JSON.parse(raw); } catch (e) { return; }
    switch (j.type) {
      case 'hello':
        connected = true;
        setStatus('connected');
        sessionId = j.session_id || '';
        if (histShown === 0) pollHistory();  // 首次连接拉历史
        break;
      case 'tts':
        if (j.state === 'start') { hideThinking(); showSpeaking(); }
        else if (j.state === 'stop') { hideSpeaking(); hideThinking(); pollHistory(); }
        break;
      case 'llm':
        showThinking();
        break;
      case 'error':
        setStatus('offline');
        addMsg('sys', '⚠ ' + (j.error || '未知错误'));
        break;
      default:
        break;
    }
  }

  // ---------- 事件 ----------
  sendBtn.addEventListener('click', sendText);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendText();
  });
  imgBtn.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', sendImage);
  $('closeBtn').addEventListener('click', function () { window.close(); });

  // 粘贴图片上传（Ctrl+V / 右键粘贴）
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData || window.clipboardData);
    if (!items) return;
    for (var i = 0; i < items.items.length; i++) {
      var it = items.items[i];
      if (it.type && it.type.indexOf('image/') === 0) {
        var f = it.getAsFile();
        if (f) { sendImageFile(f); e.preventDefault(); }
        return;
      }
    }
  });

  // 首次点击页面时恢复音频上下文（浏览器自动播放策略）
  document.addEventListener('pointerdown', function () { ensureAudioCtx(); }, { once: true });

  // 历史轮询：3s 拉取一次，同步截图提问/观察/回答
  setInterval(pollHistory, 3000);

  connect();
})();
