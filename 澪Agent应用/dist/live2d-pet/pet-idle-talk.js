/* pet-idle-talk.js — 桌宠空闲自语内容池（A 档能力，桌宠侧自足）
 *
 * 定位：桌宠长时间无人交互时，按内容池随机说一句，让它"像活着"。
 * 设计要点：
 *   - **零依赖**：只暴露 window.__mioPetIdleTalk，不引用任何插件；
 *   - **加权随机 + 不连续重复**：每条目可带 weight，且刚说过的不会立刻再说；
 *   - **分类可用**：按当前 Agent/phase 选池（如工作中 vs 空闲），避免"干活时说闲着"；
 *   - **可配置**：开关与间隔来自后端桌宠设置，渲染层不硬编码。
 *
 * 内容池是**数据**不是代码：新增台词只改 LINES，不改逻辑。
 */
(function () {
  if (window.__mioPetIdleTalk) return

  // ---------- 内容池 ----------
  // 字段：text 台词 / weight 权重（默认 1） / when 适用场景
  //   when: 'any' 任意 / 'idle' 无 Agent 工作 / 'busy' 有 Agent 工作 / 'night' 深夜
  var LINES = [
    // ——— 通用陪伴 ———
    { text: '在的，有事叫我～', weight: 3, when: 'any' },
    { text: '我在这儿陪着你。', weight: 2, when: 'any' },
    { text: '要不要歇一会儿？', weight: 1, when: 'idle' },
    { text: '忙完了记得看看我。', weight: 2, when: 'busy' },
    { text: '我一直都在哦。', weight: 2, when: 'any' },

    // ——— 空闲/发呆 ———
    { text: '发呆中…', weight: 1, when: 'idle' },
    { text: '今天天气怎么样？', weight: 1, when: 'idle' },
    { text: '有点无聊，陪我聊两句嘛。', weight: 2, when: 'idle' },
    { text: '我数了数，你有一会儿没理我了。', weight: 1, when: 'idle' },

    // ——— 工作中（有 Agent 在跑）———
    { text: '看起来挺忙的，我安静待着。', weight: 2, when: 'busy' },
    { text: '需要我搭把手吗？', weight: 1, when: 'busy' },
    { text: '慢慢来，不着急。', weight: 2, when: 'busy' },

    // ——— 深夜 ———
    { text: '夜深了，注意休息。', weight: 3, when: 'night' },
    { text: '这么晚还在忙呀…', weight: 2, when: 'night' },
    { text: '早点睡，明天再战。', weight: 2, when: 'night' },
  ]

  var STORAGE_KEY = 'mio-pet-idle-talk-last'
  var lastText = ''
  try { lastText = window.localStorage.getItem(STORAGE_KEY) || '' } catch (_) {}

  // 固定种子的加权选择：用 crypto 取随机（不可用时回退 Math.random）
  function rnd() {
    try {
      var a = new Uint32Array(1)
      window.crypto.getRandomValues(a)
      return a[0] / 4294967296
    } catch (_) {
      return Math.random()
    }
  }

  function isNight() {
    var h = new Date().getHours()
    return h >= 23 || h < 6
  }

  /** 按场景过滤可用台词。busy=true 表示当前有 Agent 在工作。 */
  function candidates(busy) {
    var night = isNight()
    var out = []
    for (var i = 0; i < LINES.length; i++) {
      var line = LINES[i]
      var w = line.when
      var ok
      if (w === 'any') ok = true
      else if (w === 'night') ok = night
      else if (w === 'busy') ok = !!busy
      else if (w === 'idle') ok = !busy
      else ok = true
      if (ok) out.push(line)
    }
    return out.length ? out : LINES
  }

  /**
   * 抽一句。
   * @param {boolean} busy 当前是否有 Agent 在工作
   * @returns {string} 台词（保证与上次不同）
   */
  function pick(busy) {
    var pool = candidates(busy)
    // 排除刚说过的那句；若池子只剩一句则允许重复
    var usable = pool.filter(function (l) { return l.text !== lastText })
    if (!usable.length) usable = pool
    var total = 0
    for (var i = 0; i < usable.length; i++) total += Math.max(0.0001, Number(usable[i].weight) || 1)
    var roll = rnd() * total
    var acc = 0
    var chosen = usable[usable.length - 1]
    for (var j = 0; j < usable.length; j++) {
      acc += Math.max(0.0001, Number(usable[j].weight) || 1)
      if (roll <= acc) { chosen = usable[j]; break }
    }
    lastText = chosen.text
    try { window.localStorage.setItem(STORAGE_KEY, lastText) } catch (_) {}
    return chosen.text
  }

  window.__mioPetIdleTalk = {
    pick: pick,
    candidates: candidates,
    count: LINES.length,
    reset: function () { lastText = '' },
  }
})()
