/* xiaozhi plugin manifest — 小智插件包声明（导航/观察tab/体检条目）
 * 加载顺序：manifest.js 必须先于 kernel/plugin-nav.js 执行（index.html 引用序保证）
 * 状态口径：以后端 /api/companion/agents 的 enabled 为准（与桌宠插件总线同源）
 */
window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['xiaozhi'] = {
  agentId: 'xiaozhi',
  name: '小智',
  // 左侧导航关键词：enabled 时显示这些导航项，停用时隐藏
  nav: { keywords: ['小智工具', '对话'] },
  // 桌宠页(CompanionPage)「观察」子tab 为小智专有：按本插件 enabled 显隐
  observeTab: true,
  // 桌宠体检面板中本插件自检条目
  health: true,
}
