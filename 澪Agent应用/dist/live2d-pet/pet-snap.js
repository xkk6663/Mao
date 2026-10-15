/* pet-snap.js — 桌宠拖拽吸附与水平翻转（A4，桌宠侧自足）
 *
 * 定位：拖到屏幕边缘附近时吸附贴边；贴左/贴右时水平镜像翻转，让角色"面朝屏内"。
 *
 * 设计要点：
 *   - **纯函数 + 状态查询**，不直接碰 DOM/模型：由 live2d-pet.js 决定何时调用，
 *     本模块只算"该吸附到哪、该不该翻转"；
 *   - **零依赖**：只暴露 window.__mioPetSnap，不引用任何插件；
 *   - **可关闭**：吸附距离为 0 即视为不吸附（与 whale-widget 的"上侧默认 0=关闭"同义）。
 *
 * 为什么单独成模块：吸附/翻转是**几何计算**，与渲染解耦后可以脱离浏览器单测，
 * 也能被未来别的渲染端（如插件形态）复用。
 */
(function () {
  if (window.__mioPetSnap) return

  /**
   * 计算吸附结果。
   * @param {{x:number,y:number}} pos    当前虚拟桌面坐标
   * @param {{width:number,height:number}} size 桌宠窗口尺寸
   * @param {{width:number,height:number}} screen 虚拟桌面尺寸
   * @param {{edges?:{left:string,right:string,top:string,bottom:string}, threshold?:number}} [opts]
   *        edges 每侧为 'ratio:0.05' 或 'px:24' 或 ''（空=该侧不吸附）
   * @returns {{x:number,y:number,snappedX:boolean,snappedY:boolean,flip:boolean}}
   */
  function resolve(pos, size, screen, opts) {
    var o = opts || {}
    var edges = o.edges || {}
    var threshold = Number(o.threshold)
    if (!isFinite(threshold)) threshold = 24

    var x = Number(pos.x) || 0
    var y = Number(pos.y) || 0
    var w = Math.max(1, Number(size.width) || 1)
    var h = Math.max(1, Number(size.height) || 1)
    var sw = Math.max(1, Number(screen.width) || 1)
    var sh = Math.max(1, Number(screen.height) || 1)

    // 解析某一侧的吸附判据为像素值
    function zone(spec) {
      var s = String(spec == null ? '' : spec).trim()
      if (!s) return 0
      var m = /^ratio:([\d.]+)$/.exec(s)
      if (m) return Math.max(0, Number(m[1]) || 0) * Math.min(sw, sh)
      m = /^px:([\d.]+)$/.exec(s)
      if (m) return Math.max(0, Number(m[1]) || 0)
      // 裸数字按像素处理（兼容手填）
      var n = Number(s)
      return isFinite(n) ? Math.max(0, n) : 0
    }

    // 每侧的实际吸附区 = min(用户配置, 通用阈值)。取 min 保证"靠得很近才吸"，
    // 用户把区域调大也只是放宽到阈值，不会出现"拖到屏幕中间就被吸走"。
    function eff(spec) {
      var v = zone(spec)
      return v <= 0 ? 0 : Math.min(v, threshold)
    }

    var zl = eff(edges.left), zr = eff(edges.right)
    var zt = eff(edges.top), zb = eff(edges.bottom)

    var snappedX = false, snappedY = false

    if (zl > 0 && x <= zl) { x = 0; snappedX = true }
    else if (zr > 0 && x + w >= sw - zr) { x = sw - w; snappedX = true }

    if (zt > 0 && y <= zt) { y = 0; snappedY = true }
    else if (zb > 0 && y + h >= sh - zb) { y = sh - h; snappedY = true }

    // 翻转判据：吸附在左边缘时水平镜像（角色转向屏内）。
    // 只对**横向吸附**翻转——上下吸附不改变朝向，否则"贴顶"也会莫名其妙翻过去。
    var flip = snappedX && x <= 0

    return { x: Math.round(x), y: Math.round(y), snappedX: snappedX, snappedY: snappedY, flip: flip }
  }

  /** 把 'ratio:0.05' / 'px:24' 规格解析成像素（供设置页预览用）。 */
  function zonePx(spec, screenMin) {
    var s = String(spec == null ? '' : spec).trim()
    if (!s) return 0
    var m = /^ratio:([\d.]+)$/.exec(s)
    if (m) return Math.max(0, Number(m[1]) || 0) * (Number(screenMin) || 0)
    m = /^px:([\d.]+)$/.exec(s)
    if (m) return Math.max(0, Number(m[1]) || 0)
    var n = Number(s)
    return isFinite(n) ? Math.max(0, n) : 0
  }

  window.__mioPetSnap = { resolve: resolve, zonePx: zonePx, version: 1 }
})()
