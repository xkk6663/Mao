/* bubble-panel-inject.js — Mio 左侧导航「泡泡」功能页：泡泡工坊
 *
 * 定位：桌宠气泡皮肤 + 模块化泡泡 + 图片素材库的**统一管理页**（用户裁决：
 * 这些定制不该藏在桌宠右键里，应是 Mio 的一等功能页）。
 * 数据：GET  /api/companion/status               （当前 settings，含泡泡配置）
 *       PATCH /api/companion/settings            （保存皮肤/模块配置 → settings_changed → 桌宠热应用）
 *       GET/POST/DELETE /api/companion/bubble-images（素材库）
 * 桌宠端应用器：dist/live2d-pet/pet-bubble-styles.js + pet-bubble-modules.js。
 * 配色走原框架 CSS 变量，强调色沿用桌宠蓝 #2d7ff9 系。
 */
(function () {
  if (window.__mioBubblePanelLoaded) return
  window.__mioBubblePanelLoaded = true

  var ACCENT = '#2d7ff9'
  var POLL_MS = 5000
  var svg = function (p) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="14.5" cy="8.5" r="0.9" fill="currentColor" stroke="none"/></svg>'
  }
  var NAV_SVG = svg('')

  // 与桌宠端 pet-bubble-styles.js 的 STYLES 保持一致（id/cls/swatch）
  var STYLE_DEFS = [
    { id: 'default', name: '默认白', swatch: '#ffffff' },
    { id: 'mono', name: '墨黑', swatch: '#243036' },
    { id: 'navy', name: '靛蓝', swatch: '#4f6bed' },
    { id: 'peach', name: '蜜桃粉', swatch: '#f7b8c4' },
    { id: 'matcha', name: '抹茶绿', swatch: '#9db87a' },
    { id: 'note', name: '便利贴', swatch: '#ffe27a' },
    { id: 'terminal', name: '终端绿', swatch: '#17301f' },
    { id: 'comic', name: '漫画描边', swatch: '#ffffff' },
  ]


  var panel = null
  var navBtn = null
  var pollTimer = null
  var clickTalk = true    // 点击互动开关（点桌宠随机语句/图片）
  var styleId = 'default'
  var images = []

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function findContentArea() {
    var shell = $q('.app-shell')
    if (shell) {
      var main = shell.querySelector('main')
      if (main && main.offsetParent !== null) return main
    }
    var nav = $q('nav')
    if (nav && nav.parentElement) {
      var parent = nav.parentElement.parentElement || nav.parentElement
      var kids = Array.prototype.slice.call(parent.children)
      var idx = kids.indexOf(nav.parentElement)
      if (idx >= 0) {
        var best = null
        for (var i = idx + 1; i < kids.length; i++) {
          var el = kids[i]
          if (el.offsetParent === null || el.getAttribute('aria-hidden') === 'true') continue
          if (!best) { best = el; continue }
          if (el.offsetWidth * el.offsetHeight > best.offsetWidth * best.offsetHeight) best = el
        }
        if (best) return best
      }
    }
    return null
  }

  function card(title, body) {
    return '<div style="border:1px solid var(--line,#d9e2e6);border-radius:10px;background:var(--surface,#fff);padding:14px 16px;">' +
      (title ? '<div style="font-size:12px;font-weight:700;margin-bottom:10px;color:var(--ink,#20303a);">' + title + '</div>' : '') +
      body + '</div>'
  }

  function ensurePanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = 'bubble-panel'
    panel.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;z-index:99;display:none;flex-direction:column;' +
      'background:var(--app-bg,#e9eef0);color:var(--ink,#20303a);' +
      'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;'
    panel.innerHTML =
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px;background:var(--sidebar-bg,#f4f7f8);border-bottom:1px solid var(--line,#d9e2e6);">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:' + ACCENT + ';flex:none;"></span>' +
        '<strong style="font-size:14px;flex:none;">泡泡工坊</strong>' +
        '<span id="bpSub" style="flex:1;font-size:11px;color:var(--muted,#687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">桌宠气泡皮肤 · 模块化泡泡 · 图片素材库</span>' +
        '<button type="button" id="bpReload" title="立即刷新" style="border:none;background:transparent;font-size:15px;cursor:pointer;color:var(--muted,#687984);padding:2px 6px;">⟳</button>' +
        '<button type="button" id="bpClose" title="关闭泡泡页" style="border:none;background:transparent;font-size:16px;cursor:pointer;color:var(--muted,#687984);padding:2px 6px;">✕</button>' +
      '</div>' +
      '<div style="flex:none;padding:10px 20px;font-size:11px;line-height:1.7;color:var(--muted,#687984);background:var(--surface-soft,#f2f6f7);border-bottom:1px solid var(--line,#d9e2e6);">' +
        '所有改动保存后桌宠<b>即时热应用</b>（无需重启）。皮肤只影响说话气泡；' +
        '模块卡片可拖拽排版（双击卡片复位位置），✕ 隐藏后可在此重新开启。' +
      '</div>' +
      '<div id="bpBody" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;"></div>'
    var host = findContentArea()
    if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative'
    ;(host || document.body).appendChild(panel)
    $q('#bpClose', panel).addEventListener('click', function (e) { e.stopPropagation(); hidePanel() })
    $q('#bpReload', panel).addEventListener('click', function (e) { e.stopPropagation(); refresh(true) })
    return panel
  }

  function toast(msg, ok) {
    var el = $q('#bpToast', panel)
    if (!el) return
    el.textContent = msg
    el.style.color = ok ? '#2e9e5b' : '#c0392b'
    window.clearTimeout(el.__t)
    el.__t = window.setTimeout(function () { el.textContent = '' }, 2600)
  }

  function saveSettings(patch, doneMsg) {
    return fetch('/api/companion/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      toast(doneMsg || '已保存，桌宠热应用中', true)
    }).catch(function (e) { toast('保存失败：' + (e.message || e), false) })
  }

  // ---------- 渲染 ----------

  function renderStyles() {
    var cards = STYLE_DEFS.map(function (s) {
      var cur = s.id === styleId
      return '<button type="button" data-style="' + s.id + '" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:9px 4px;border:1px solid ' +
        (cur ? ACCENT : 'var(--line,#d9e2e6)') + ';border-radius:10px;background:' + (cur ? ACCENT + '10' : 'var(--surface,#fff)') +
        ';cursor:pointer;box-shadow:' + (cur ? '0 0 0 2px ' + ACCENT + '2e' : 'none') + ';">' +
        '<span style="width:26px;height:26px;border-radius:50%;background:' + s.swatch + ';border:1px solid #94a7ad;"></span>' +
        '<span style="font-size:11px;color:var(--ink,#20303a);">' + s.name + '</span></button>'
    }).join('')
    return card('气泡皮肤',
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">' + cards + '</div>' +
      '<div style="margin-top:9px;font-size:10px;color:var(--muted,#687984);">插件身份色（如 DSH 蓝）优先于皮肤——气泡颜色跟"谁在说话"走。</div>')
  }

  function renderClickTalk() {
    return card('点击互动',
      '<div style="display:flex;align-items:center;gap:9px;padding:7px 9px;border:1px solid var(--line,#d9e2e6);border-radius:9px;background:var(--surface,#fff);">' +
        '<input type="checkbox" id="bpClickTalk"' + (clickTalk ? ' checked' : '') + ' style="flex:none;" />' +
        '<label for="bpClickTalk" style="flex:1;display:flex;flex-direction:column;cursor:pointer;">' +
          '<strong style="font-size:12px;">点击桌宠时随机互动</strong>' +
          '<small style="font-size:10px;color:var(--muted,#687984);">点一下桌宠：素材库有图时约 45% 概率出随机图片，否则说一句随机语句——都显示在说话气泡框里</small></label>' +
      '</div>')
  }

  function renderImages() {
    var items = images.map(function (im) {
      return '<div style="position:relative;width:96px;">' +
        '<img src="' + im.url + '?v=' + im.mtime + '" style="width:96px;height:64px;object-fit:cover;border-radius:7px;border:1px solid var(--line,#d9e2e6);" />' +
        '<button type="button" data-del="' + encodeURIComponent(im.name) + '" title="删除" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border:none;border-radius:50%;background:#c0392b;color:#fff;font-size:10px;cursor:pointer;">✕</button>' +
        '<div style="font-size:9px;color:var(--muted,#687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">' + im.name + '</div></div>'
    }).join('')
    var empty = images.length ? '' : '<div style="font-size:11px;color:var(--muted,#687984);padding:8px 2px;">素材库为空——上传图片后，「随机图片」模块与空闲时的图片泡泡就会启用。</div>'
    return card('图片素材库（' + images.length + ' 张）',
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">' +
        '<button type="button" id="bpUploadBtn" style="border:1px solid ' + ACCENT + '55;background:' + ACCENT + '12;color:' + ACCENT + ';border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer;">上传图片</button>' +
        '<input type="file" id="bpUploadFile" accept=".png,.jpg,.jpeg,.gif,.webp" multiple style="display:none;" />' +
        '<span id="bpToast" style="font-size:11px;"></span>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;">' + items + empty + '</div>' +
      '<div style="margin-top:9px;font-size:10px;color:var(--muted,#687984);">单张 ≤5MB，支持 PNG/JPG/GIF/WebP；也可以直接把图片放进 Live2D桌宠/bubble-imgs 目录。</div>')
  }

  function renderAll(settings) {
    var body = $q('#bpBody', panel)
    if (!body) return
    body.innerHTML = renderStyles() + renderClickTalk() + renderImages()
    bindAll()
  }

  // ---------- 交互绑定 ----------

  function bindAll() {
    var body = $q('#bpBody', panel)
    if (!body) return

    body.querySelectorAll('[data-style]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        styleId = btn.getAttribute('data-style')
        saveSettings({ live2d_bubble_style: styleId }, '皮肤已切换').then(refresh)
      })
    })

    var clickCb = $q('#bpClickTalk', body)
    if (clickCb) {
      clickCb.addEventListener('change', function () {
        clickTalk = clickCb.checked
        saveSettings({ pet_click_talk_enabled: clickTalk }, clickTalk ? '点击互动已开启' : '点击互动已关闭')
      })
    }

    var upBtn = $q('#bpUploadBtn', body)
    var upFile = $q('#bpUploadFile', body)
    if (upBtn && upFile) {
      upBtn.addEventListener('click', function (e) { e.stopPropagation(); upFile.click() })
      upFile.addEventListener('change', function () {
        var files = Array.prototype.slice.call(upFile.files || [])
        if (!files.length) return
        var chain = Promise.resolve()
        files.forEach(function (f) {
          chain = chain.then(function () {
            if (f.size > 5 * 1024 * 1024) { toast(f.name + ' 超过 5MB', false); return }
            return new Promise(function (resolve) {
              var reader = new FileReader()
              reader.onload = function () {
                fetch('/api/companion/bubble-images/upload', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: f.name, data_url: reader.result }),
                }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
                  .then(function (res) {
                    toast(res.ok ? '已上传 ' + f.name : (res.j && res.j.detail) || '上传失败', res.ok)
                  })
                  .catch(function () { toast('上传失败：网络错误', false) })
                  .then(resolve)
              }
              reader.onerror = function () { toast(f.name + ' 读取失败', false); resolve() }
              reader.readAsDataURL(f)
            })
          })
        })
        chain.then(function () { refreshImages() })
        upFile.value = ''
      })
    }
    body.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        fetch('/api/companion/bubble-images/' + btn.getAttribute('data-del'), { method: 'DELETE' })
          .then(function () { toast('已删除', true); refreshImages() })
          .catch(function () { toast('删除失败', false) })
      })
    })
  }

  function refreshImages() {
    return fetch('/api/companion/bubble-images', { headers: { 'Cache-Control': 'no-cache' } })
      .then(function (r) { return r.json() })
      .then(function (j) {
        images = (j && j.images) || []
        if (panel && panel.style.display !== 'none') renderAll()
      })
      .catch(function () {})
  }

  function refresh(showBusy) {
    if (showBusy) { var sub = $q('#bpSub', panel); if (sub) sub.textContent = '刷新中…' }
    return Promise.all([
      fetch('/api/companion/status', { headers: { 'Cache-Control': 'no-cache' } }).then(function (r) { return r.json() }).catch(function () { return null }),
      fetch('/api/companion/bubble-images', { headers: { 'Cache-Control': 'no-cache' } }).then(function (r) { return r.json() }).catch(function () { return null }),
    ]).then(function (res) {
      if (!panel || panel.style.display === 'none') return
      var st = (res[0] && res[0].pet && res[0].pet.settings) || {}
      styleId = String(st.live2d_bubble_style || 'default')
      clickTalk = st.pet_click_talk_enabled !== false
      images = (res[1] && res[1].images) || []
      renderAll(st)
      var sub = $q('#bpSub', panel)
      if (sub) sub.textContent = '桌宠气泡皮肤 · 模块化泡泡 · 图片素材库（' + images.length + ' 张素材）'
    })
  }

  function startPoll() {
    if (pollTimer) return
    pollTimer = window.setInterval(function () {
      if (panel && panel.style.display !== 'none') refresh()
    }, POLL_MS)
  }

  function setNavActive(on) { if (navBtn) navBtn.classList.toggle('active', !!on) }

  function showPanel() {
    ensurePanel()
    var host = findContentArea()
    if (host && panel.parentElement !== host) host.appendChild(panel)
    panel.style.display = 'flex'
    setNavActive(true)
    refresh(true)
    startPoll()
  }

  function hidePanel() {
    if (panel) panel.style.display = 'none'
    setNavActive(false)
  }

  function togglePanel() {
    if (panel && panel.style.display !== 'none') hidePanel()
    else showPanel()
  }

  function ensureNav() {
    if (navBtn && navBtn.isConnected) return
    var nav = $q('nav')
    if (!nav) return
    navBtn = document.createElement('button')
    navBtn.type = 'button'
    navBtn.className = 'nav-item bubble-nav'
    navBtn.title = '泡泡工坊'
    navBtn.innerHTML = NAV_SVG + '<span>泡泡</span>'
    navBtn.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      togglePanel()
    })
    nav.appendChild(navBtn)
  }

  function boot() {
    if (!$q('nav')) { window.setTimeout(boot, 400); return }
    ensureNav()
    hidePanel()
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot()
  else document.addEventListener('DOMContentLoaded', boot)
  window.addEventListener('load', function () { if (!navBtn || !navBtn.isConnected) boot() })

  window.__mioBubblePanel = { show: showPanel, hide: hidePanel, refresh: refresh }
})()
