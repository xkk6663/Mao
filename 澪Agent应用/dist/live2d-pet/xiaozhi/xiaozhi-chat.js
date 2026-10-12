/* 小智快速对话横条（经本地后端 /api/xiaozhi/ws 代理）
 * 形态：轻量横条输入窗（标题条 + 状态行 + 图片暂存条 + 输入条），桌宠旁快速发消息。
 * 回复显示：文字对话 → 桌宠 speak 事件（气泡 + 官方语音 + 口型）；
 *           图片分析 → 桌宠 speech-bubble 事件（气泡 6s 自动消失）。
 * 历史查看：点标题栏「历史记录」→ 打开主聊天界面（管理窗口私人空间对话页）。
 * 本窗口不渲染历史列表、不播放音频（音频归桌宠，避免声音叠加）。 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var inputEl = $('input'), sendBtn = $('sendBtn'),
      imgBtn = $('imgBtn'), fileInput = $('fileInput'), statusDot = $('statusDot'),
      statusLine = $('statusLine'), pendingBar = $('pendingBar'),
      histBtn = $('histBtn'), closeBtn = $('closeBtn');

  var ws = null;
  var connected = false;
  var sessionId = '';
  var busy = false;   // 有请求在途（思考中），防止并发发送

  // ---------- 状态行（思考中 / 错误提示 / 连接提示） ----------
  var statusTimer = null;
  function setStatusLine(text, cls, persist) {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (!text) { statusLine.textContent = ''; statusLine.className = 'statusline'; return; }
    statusLine.innerHTML = '';
    if (cls === 'thinking') {
      var spin = document.createElement('span');
      spin.className = 'spin';
      statusLine.appendChild(spin);
      statusLine.appendChild(document.createTextNode(text));
    } else {
      statusLine.textContent = text;
    }
    statusLine.className = 'statusline' + (cls ? ' ' + cls : '');
    if (!persist) {
      statusTimer = setTimeout(function () { setStatusLine(''); }, 6000);
    }
  }

  function setStatus(state) {
    statusDot.className = 'dot ' + state;
    if (state === 'connected') setStatusLine('已连接，随时可以发消息');
    else if (state === 'connecting') setStatusLine('正在连接小智…', '', true);
    else setStatusLine('连接中断，重连中…', '', true);
  }

  // ---------- 图片暂存（选图/粘贴 → 暂存条 → 点发送才发） ----------
  var pendingImages = [];

  function renderPending() {
    pendingBar.innerHTML = '';
    if (!pendingImages.length) { pendingBar.style.display = 'none'; return; }
    pendingBar.style.display = 'flex';
    pendingImages.forEach(function (img, idx) {
      var item = document.createElement('div');
      item.className = 'item';
      var t = document.createElement('img');
      t.src = img.dataUrl;
      var del = document.createElement('button');
      del.type = 'button';
      del.title = '移除图片';
      del.textContent = '✕';
      del.addEventListener('click', function () {
        pendingImages.splice(idx, 1);
        renderPending();
      });
      item.appendChild(t);
      item.appendChild(del);
      pendingBar.appendChild(item);
    });
  }

  function stageImage(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { setStatusLine('⚠ 仅支持图片文件'); return; }
    if (file.size > 4 * 1024 * 1024) { setStatusLine('⚠ 图片过大（>4MB），请压缩后重试'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      pendingImages.push({ dataUrl: String(reader.result) });
      renderPending();
    };
    reader.readAsDataURL(file);
  }

  // ---------- 发送 ----------
  function setBusy(on) {
    busy = on;
    sendBtn.disabled = on;
  }

  function sendText() {
    if (sendPending()) return;   // 有暂存图 → 发图（可附带输入框文字）
    var text = inputEl.value.trim();
    if (!text || !connected) {
      if (text) setStatusLine('⚠ 未连接，稍后再试');
      return;
    }
    inputEl.value = '';
    setBusy(true);
    setStatusLine('正在发送…', 'thinking', true);
    // 走后端音频流注入（官方语音通道）：后端负责 abort→唤醒→listen start→TTS音频流→stop，
    // 官方云 ASR 识别后 LLM 回答 → 桌宠 speak 事件显示气泡 + 播放官方语音 + 口型联动。
    fetch('/api/xiaozhi/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { setBusy(false); setStatusLine('⚠ 发送失败：' + (j.detail || '未知错误')); }
    }).catch(function () {
      setBusy(false); setStatusLine('⚠ 网络错误，发送失败');
    });
  }

  function sendPending() {
    if (!pendingImages.length) return false;
    var img = pendingImages.shift();
    renderPending();
    var base64 = String(img.dataUrl).split(',')[1] || '';
    if (!base64) { setStatusLine('⚠ 读取图片失败'); return true; }
    var question = inputEl.value.trim() || '';  // 留空 → 后端使用可配置的"图片识别前置提示词"
    inputEl.value = '';
    setBusy(true);
    setStatusLine('正在分析图片…', 'thinking', true);
    fetch('/api/xiaozhi/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: base64, question: question })
    }).then(function (r) { return r.json(); }).then(function (j) {
      setBusy(false);
      if (!j.ok) setStatusLine('⚠ 图片分析失败：' + (j.detail || '未知错误'));
      else setStatusLine('已发送图片，桌宠气泡会显示分析结果');
    }).catch(function () {
      setBusy(false);
      setStatusLine('⚠ 网络错误，图片分析失败');
    });
    return true;
  }

  function sendImage() {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    stageImage(file);
    fileInput.value = '';
  }

  // 粘贴图片（Ctrl+V → 暂存）
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData || window.clipboardData);
    if (!items) return;
    for (var i = 0; i < items.items.length; i++) {
      var it = items.items[i];
      if (it.type && it.type.indexOf('image/') === 0) {
        var f = it.getAsFile();
        if (f) { stageImage(f); e.preventDefault(); }
        return;
      }
    }
  });

  // ---------- WebSocket（只收文本状态事件：连接/思考/说话；不渲染消息、不播放音频） ----------
  function connect() {
    setStatus('connecting');
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    // role=chat：对话窗口只收文本状态（音频由桌宠本体播放，避免声音叠加）
    var url = proto + location.host + '/api/xiaozhi/ws?role=chat';
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
      if (typeof ev.data === 'string') handleText(ev.data);
      // 二进制（音频）忽略：音频归桌宠播放
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
        break;
      case 'tts':
        if (j.state === 'start') { setStatusLine('小智正在说话…', 'thinking', true); }
        else if (j.state === 'stop') { setBusy(false); setStatusLine('回答完成，气泡会显示在桌宠旁'); }
        break;
      case 'llm':
        setStatusLine('小智正在思考…', 'thinking', true);
        break;
      case 'error':
        connected = false;
        setStatus('offline');
        setBusy(false);
        setStatusLine('⚠ ' + (j.error || '未知错误'));
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
  closeBtn.addEventListener('click', function () {
    // iframe（打开 MIO 覆盖层）内：通知父页面关闭覆盖层；独立窗口：直接关闭
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'xz-close' }, '*');
        return;
      }
    } catch (e) {}
    window.close();
  });
  histBtn.addEventListener('click', function () {
    // 打开主聊天界面（管理窗口私人空间对话页），查看完整历史
    try {
      if (window.mioPetChat && typeof window.mioPetChat.openAdmin === 'function') {
        window.mioPetChat.openAdmin();
        return;
      }
    } catch (e) {}
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'xz-open-admin' }, '*');
        return;
      }
    } catch (e) {}
    window.open('/agent-app/?workspace=main&v=' + Date.now(), '_blank');
  });

  connect();
})();
