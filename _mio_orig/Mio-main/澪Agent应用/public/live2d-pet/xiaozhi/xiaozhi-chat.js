/* 小智官方云对话客户端（经本地后端 /api/xiaozhi/ws 代理） */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var msgsEl = $('msgs'), inputEl = $('input'), sendBtn = $('sendBtn'), statusDot = $('statusDot');

  var ws = null;
  var connected = false;
  var sessionId = '';
  var thinkingEl = null;

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

  function setStatus(state) {
    statusDot.className = 'dot ' + state;
  }

  // ---------- WebSocket ----------
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
      addMsg('sys', '连接断开，正在重连…');
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
        addMsg('sys', '已连接小智 · 可以开始聊天啦');
        break;
      case 'stt':
        if (j.text) addMsg('user', j.text, '你说');
        break;
      case 'llm':
        showThinking();
        if (j.emotion) addMsg('sys', '情绪：' + j.emotion + (j.text ? ' ' + j.text : ''));
        break;
      case 'tts':
        if (j.state === 'start') {
          hideThinking();
          addMsg('sys', '正在说话…');
        } else if (j.state === 'sentence_start') {
          if (j.text) addMsg('ai', j.text, '她说');
        } else if (j.state === 'stop') {
          hideThinking();
          addMsg('sys', '—');
        }
        break;
      case 'error':
        setStatus('offline');
        addMsg('sys', '⚠ ' + (j.error || '未知错误'));
        break;
      default:
        break;
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function sendText() {
    var text = inputEl.value.trim();
    if (!text || !connected) return;
    inputEl.value = '';
    addMsg('user', text, '你说');
    stopPlayback();
    // 官方云限制：空闲会话 detect 长文本会被拒，先短词唤醒；等唤醒回复播完(3s)再注入长文本（不能abort打断，会搞乱会话导致中断）
    send({ session_id: sessionId, type: 'listen', state: 'detect', text: '你好', source: 'text' });
    setTimeout(function () {
      send({ session_id: sessionId, type: 'listen', state: 'detect', text: text, source: 'text' });
      showThinking();
    }, 3000);
  }

  // ---------- 事件 ----------
  sendBtn.addEventListener('click', sendText);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendText();
  });
  $('closeBtn').addEventListener('click', function () { window.close(); });

  // 首次点击页面时恢复音频上下文（浏览器自动播放策略）
  document.addEventListener('pointerdown', function () { ensureAudioCtx(); }, { once: true });

  connect();
})();
