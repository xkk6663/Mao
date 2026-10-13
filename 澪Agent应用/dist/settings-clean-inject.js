/* settings-clean-inject.js — 设置页收敛：隐藏原版已弃用的设置项与分类
 *
 * 背景：后端已删除原版遗留功能（启动打招呼/主动联系/QQ/本地TTS等），
 * 但原版 SettingsPage 组件骨架仍渲染"基础与启动"分类下的遗留设置项，
 * 且导航"设置"下仍显示原版分类入口。
 *
 * 方案：DOM 文本匹配 + 向上定位设置行/分类容器并隐藏，只保留"桌宠"分类。
 * 不改动压缩混淆的构建产物。MutationObserver 持续监听，兼容路由切换后重渲染。
 */
(function () {
  'use strict';
  // 要隐藏的设置项/分类（按 UI 文案匹配；命中任意即隐藏所在行/分类）
  var HIDE_ITEMS = [
    '主动打招呼', '主动联系', '关闭窗口后留在后台', '默认打开页面',
    '启动行为', '启动行为和主动联系', '打开应用时主动打招呼',
  ];
  var HIDE_CATEGORIES = ['基础与启动', '启动、后台与主动消息'];

  function hideRow(elm) {
    // 从命中文本所在元素向上爬，找"设置行/分类"容器：
    // 特征 = 至少 2 个子元素（label+控件）或包含开关，宽度较宽
    var node = elm;
    for (var i = 0; i < 8; i++) {
      if (!node || !node.parentElement) break;
      node = node.parentElement;
      if (node.children.length >= 2) {
        try {
          var r = node.getBoundingClientRect();
          if (r.width > 200 && r.height > 20) {
            node.style.display = 'none';
            node.style.visibility = 'hidden';
            return true;
          }
        } catch (e) { /* ignore */ }
      }
      if (node === document.body) break;
    }
    // 兜底：隐藏文本所在元素本身
    elm.style.display = 'none';
    return true;
  }

  function clean() {
    if (!document.body) return;
    var texts = HIDE_ITEMS.concat(HIDE_CATEGORIES);
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) {
      var t = walker.currentNode.textContent || '';
      if (t.length < 2 || t.length > 60) continue;
      for (var i = 0; i < texts.length; i++) {
        if (t.indexOf(texts[i]) >= 0) {
          nodes.push({ el: walker.currentNode, key: texts[i] });
          break;
        }
      }
    }
    for (var j = 0; j < nodes.length; j++) {
      hideRow(nodes[j].el);
    }
  }

  // 设置页/导航渲染是异步的（Vue 挂载后），用 MutationObserver 持续清理
  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(clean, 150);
  }
  try {
    var obs = new MutationObserver(schedule);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
  } catch (e) { /* ignore */ }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', clean);
  } else {
    setTimeout(clean, 300);
  }
})();
