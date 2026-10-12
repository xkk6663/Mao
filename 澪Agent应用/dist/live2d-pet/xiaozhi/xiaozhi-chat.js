/* 小智快速对话横条（经本地后端 /api/xiaozhi/ws 代理）
 * 形态：一条胶囊（状态点 + 输入框 + 发图 + 发送 + 关闭），桌宠旁快速发消息。
 * 状态提示：状态点颜色（绿=已连接/黄=连接中/红=断线）+ 输入框 placeholder 动态提示，不占额外空间。
 * 回复显示：文字对话 → 桌宠 speak 事件（气泡 + 官方语音 + 口型）；
 *           图片分析 → 桌宠 speech-bubble 事件（气泡 6s 自动消失）。
 * 历史查看：打开主聊天界面（管理窗口私人空间对话页），横条保持极简不重复入口。
 * 本窗口不渲染历史列表、不播放音频（音频归桌宠，避免声音叠加）。 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var inputEl = $('input'), sendBtn = $('sendBtn'),
      imgBtn = $('imgBtn'), fileInput = $('fileInput'), statusDot = $('statusDot'),
      closeBtn = $('closeBtn');

  var DEFAULT_HINT = '和小智说点什么…';
  var ws = null;
  var connected = false;
  var sessionId = '';
  var busy = false;   // 有请求在途（思考中），防止并发发送

  // ---------- 状态提示（placeholder 动态显示，不占空间） ----------
  var hintTimer = null;
  function setHint(text, persist) {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    if (!text) { inputEl.placeholder = DEFAULT_HINT; return; }
    inputEl.placeholder = text;
    if (!persist) {
      hintTimer = setTimeout(function () { inputEl.placeholder = DEFAULT_HINT; }, 6000);
    }
  }

  function setStatus(state) {
    statusDot.className = 'dot ' + state;
    if (state === 'connected') setHint('已连接，随时可以发消息');
    else if (state === 'connecting') setHint('正在连接小智…', true);
    else setHint('连接中断，重连中…', true);
  }

  // ---------- 发送 ----------
  function setBusy(on) {
    busy = on;
    sendBtn.disabled = on;
  }

  function sendText() {
    var text = inputEl.value.trim();
    if (!text || !connected) {
      if (text) setHint('⚠ 未连接，稍后再试');
      return;
    }
    inputEl.value = '';
    setBusy(true);
    setHint('正在发送…', true);
    // 走后端音频流注入（官方语音通道）：后端负责 abort→唤醒→listen start→TTS音频流→stop，
    // 官方云 ASR 识别后 LLM 回答 → 桌宠 speak 事件显示气泡 + 播放官方语音 + 口型联动。
    fetch('/api/xiaozhi/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { setBusy(false); setHint('⚠ 发送失败：' + (j.detail || '未知错误')); }
    }).catch(function () {
      setBusy(false); setHint('⚠ 网络错误，发送失败');
    });
  }

  function sendImage(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { setHint('⚠ 仅支持图片文件'); return; }
    if (file.size > 4 * 1024 * 1024) { setHint('⚠ 图片过大（>4MB），请压缩后重试'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result);
      var base64 = dataUrl.split(',')[1] || '';
      if (!base64) { setHint('⚠ 读取图片失败'); return; }
      var question = inputEl.value.trim() || '';  // 留空 → 后端使用可配置的"图片识别前置提示词"
      inputEl.value = '';
      setBusy(true);
      setHint('正在分析图片…', true);
      fetch('/api/xiaozhi/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, question: question })
      }).then(function (r) { return r.json(); }).then(function (j) {
        setBusy(false);
        if (!j.ok) setHint('⚠ 图片分析失败：' + (j.detail || '未知错误'));
        else setHint('已发送图片，桌宠气泡会显示分析结果');
      }).catch(function () {
        setBusy(false);
        setHint('⚠ 网络错误，图片分析失败');
      });
    };
    reader.readAsDataURL(file);
  }

  // 粘贴图片（Ctrl+V → 直接发送）
  document.addEventListener('paste', function (e) {
    if (busy) return;
    var items = (e.clipboardData || window.clipboardData);
    if (!items) return;
    for (var i = 0; i < items.items.length; i++) {
      var it = items.items[i];
      if (it.type && it.type.indexOf('image/') === 0) {
        var f = it.getAsFile();
        if (f) { e.preventDefault(); sendImage(f); }
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
        if (j.state === 'start') { setHint('小智正在说话…', true); }
        else if (j.state === 'stop') { setBusy(false); setHint('回答完成，气泡会显示在桌宠旁'); }
        break;
      case 'llm':
        setHint('小智正在思考…', true);
        break;
      case 'error':
        connected = false;
        setStatus('offline');
        setBusy(false);
        setHint('⚠ ' + (j.error || '未知错误'), true);
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
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (file) sendImage(file);
    fileInput.value = '';
  });
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

  connect();
})();
