/* agent-kill-inject.js — 拦截原版 MIO 已弃用的 /api/agent/* 端点调用
 *
 * 背景：后端已彻底删除原版 agent 工作台/QQ 对话路由，但原版 ChatPage
 * （私人空间对话页）组件仍轮询 /api/agent/self/active-view 与
 * /api/agent/qq/status，导致每个轮询周期都打 404，界面顶部反复出现
 * "Not Found" 粉色提示条。
 *
 * 方案：在页面脚本执行前同步包装 window.fetch，命中 /api/agent/* 的
 * 请求一律返回空 JSON 200，从源头消除 404 与 Not Found 提示，
 * 不改动压缩混淆的原版 bundle（避免重新构建风险）。
 */
(function () {
  'use strict';
  try {
    var ORIG_FETCH = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = '';
      if (typeof input === 'string') {
        url = input;
      } else if (input && input.url) {
        url = input.url;
      }
      // 命中已弃用的原版 agent 端点 → 返回空 JSON 200
      if (typeof url === 'string' && /\/api\/agent\//.test(url)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, data: null, items: [], conversations: [], status: 'idle' }),
            {
              status: 200,
              statusText: 'OK',
              headers: { 'Content-Type': 'application/json' },
            }
          )
        );
      }
      return ORIG_FETCH(input, init);
    };
    // 也兜底 XHR（原版部分组件可能用 XMLHttpRequest）
    var ORIG_XHR_OPEN = XMLHttpRequest.prototype.open;
    var ORIG_XHR_SEND = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__mio_url = String(url || '');
      return ORIG_XHR_OPEN.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.__mio_url && /\/api\/agent\//.test(this.__mio_url)) {
        var self = this;
        // 模拟成功空响应，避免 404
        setTimeout(function () {
          try {
            Object.defineProperty(self, 'responseText', {
              value: JSON.stringify({ ok: true, data: null }),
              configurable: true,
            });
            Object.defineProperty(self, 'status', { value: 200, configurable: true });
            self.onreadystatechange && self.onreadystatechange.call(self);
            self.onload && self.onload.call(self);
          } catch (e) { /* ignore */ }
        }, 0);
        return;
      }
      return ORIG_XHR_SEND.apply(this, arguments);
    };
  } catch (e) {
    // 拦截失败不影响页面其他功能
  }
})();
