/* settings-clean-inject.js — 设置页收敛：隐藏原版已弃用的设置项与分类（保守版）
 *
 * 背景：后端已删除原版遗留功能（启动打招呼/主动联系/QQ/本地TTS等），
 * 但原版 SettingsPage 组件骨架仍渲染"基础与启动"分类下的遗留设置项。
 *
 * 保守策略（防误杀白屏）：
 * 1) 文本匹配命中后，只在"小尺寸容器"内向上定位：
 *    - 含开关控件（role=switch / checkbox / radio）的容器 → 视为"设置行"，隐藏
 *    - 无控件的 → 只隐藏文本所在最近的小块级容器（≤2 层，尺寸小）
 * 2) 绝不隐藏大容器（宽度>600 或 高度>200），避免隐藏到页面/主区域导致白屏
 */
(function () {
  'use strict';
  var HIDE_ITEMS = [
    '主动打招呼', '主动联系', '关闭窗口后留在后台', '默认打开页面',
    '启动行为', '启动行为和主动联系', '打开应用时主动打招呼',
  ];

  function isBigContainer(el) {
    try {
      var r = el.getBoundingClientRect();
      return r.width > 600 || r.height > 200;
    } catch (e) {
      return true; // 测量失败视为大容器，不隐藏
    }
  }

  function hideRow(elm) {
    // 文本节点没有 style → 先提升到父元素
    if (elm.nodeType === 3) {
      elm = elm.parentElement
      if (!elm) return true
    }
    // 方案1：向上找含开关控件的"设置行"容器（最多4层，不碰大容器）
    var node = elm;
    for (var i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      if (isBigContainer(node)) break;
      try {
        if (node.querySelector && node.querySelector('[role="switch"], input[type="checkbox"], input[type="radio"]')) {
          node.style.display = 'none';
          return true;
        }
      } catch (e) { /* ignore */ }
    }
    // 方案2：无开关控件 → 隐藏文本最近的小块级容器（≤2 层）
    node = elm;
    var target = elm;
    for (var j = 0; j < 2 && node.parentElement; j++) {
      node = node.parentElement;
      if (isBigContainer(node)) break;
      target = node;
    }
    if (!isBigContainer(target)) {
      target.style.display = 'none';
      return true;
    }
    // 兜底：只隐藏文本节点本身所在的元素
    elm.style.display = 'none';
    return true;
  }

  function clean() {
    if (!document.body) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) {
      var t = walker.currentNode.textContent || '';
      if (t.length < 2 || t.length > 60) continue;
      for (var i = 0; i < HIDE_ITEMS.length; i++) {
        if (t.indexOf(HIDE_ITEMS[i]) >= 0) {
          nodes.push(walker.currentNode);
          break;
        }
      }
    }
    for (var j = 0; j < nodes.length; j++) {
      hideRow(nodes[j]);
    }
  }

  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(clean, 200);
  }
  try {
    var obs = new MutationObserver(schedule);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* ignore */ }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', clean);
  } else {
    setTimeout(clean, 300);
  }
})();
