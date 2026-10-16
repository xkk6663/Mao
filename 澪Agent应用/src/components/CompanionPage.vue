<script setup>
import { computed, inject, onMounted, ref } from 'vue'
import {
  Boxes, Gamepad2, ImagePlus, Monitor, RefreshCw, Stethoscope, Zap,
} from '@lucide/vue'
import PetAppearancePanel from './PetAppearancePanel.vue'

const context = inject('mio-companion-page')
if (!context) throw new Error('桌宠页上下文未初始化')

// ---------------------------------------------------------------- 通用请求
async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url} -> ${response.status}`)
  return response.json()
}
async function request(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try { message = (await response.json()).detail || message } catch { /* 忽略解析失败 */ }
    throw new Error(message)
  }
  return response.json()
}

// ---------------------------------------------------------------- 模型管理
const models = ref([])
const currentModelId = ref('')
const schedule = ref({ enabled: false, time: '09:00', mode: 'random', last_switched: '' })
const modelMessage = ref('')
// 内置模型按 featured 降序（项目内置的 whale-deepseek / da-feiyu 排前面）
const sortedBuiltInModels = computed(() => [...models.value.filter((item) => !item.imported)]
  .sort((a, b) => Number(b.featured) - Number(a.featured)))
const importedModels = computed(() => models.value.filter((item) => item.imported))

// 面板「实时刷新」上抛的状态：合并进 provide 的 companionStatus（浅合并 + pet 深一层），
// 让桌宠管理页在面板自己拉完 /api/companion/status 后立刻拿到新数据。
function applyRefreshedStatus(data) {
  if (!data) return
  const current = context.companionStatus || {}
  context.companionStatus = {
    ...current,
    ...data,
    pet: { ...(current.pet || {}), ...(data.pet || {}) },
  }
}

async function refreshModels() {
  try {
    const [modelData, scheduleData] = await Promise.all([
      getJson('/api/companion/live2d/models'),
      getJson('/api/companion/live2d/schedule'),
    ])
    models.value = (modelData.models || []).map((model) => ({
      id: model.id,
      name: model.display_name || model.name || model.id,
      imported: Boolean(model.imported),
      featured: model.id === 'whale-deepseek' || model.id === 'da-feiyu',
    }))
    schedule.value = scheduleData || schedule.value
    try {
      const status = await getJson('/api/companion/status')
      currentModelId.value = ((status.live2d && status.live2d.runtime) || {}).model_id || ''
    } catch { /* 状态读取失败不影响模型列表 */ }
  } catch (error) {
    modelMessage.value = `读取模型失败：${error.message}`
  }
}

// 切换模型：PATCH 之后同步写回 provide 的 companionStatus，
// 否则桌宠管理页的「当前」标记会停在旧模型上（此前是手工注入 dist 的补丁）。
async function switchModel(id) {
  modelMessage.value = '正在切换…'
  try {
    await request('/api/companion/settings', 'PATCH', { live2d_model_id: id })
    try {
      const settings = context.companionStatus && context.companionStatus.pet && context.companionStatus.pet.settings
      if (settings) settings.live2d_model_id = id
    } catch { /* provide 不可写时忽略 */ }
    modelMessage.value = '✓ 已切换，桌宠正在换装'
    setTimeout(refreshModels, 2500)
  } catch (error) {
    modelMessage.value = `✗ 切换失败：${error.message}`
  }
}

async function saveSchedule() {
  try {
    await request('/api/companion/live2d/schedule', 'PATCH', {
      enabled: schedule.value.enabled,
      time: schedule.value.time || '09:00',
      mode: schedule.value.mode,
    })
    modelMessage.value = schedule.value.enabled
      ? `✓ 已保存（每天 ${schedule.value.time} 自动换）`
      : '✓ 已关闭自动更换'
    setTimeout(refreshModels, 1200)
  } catch (error) {
    modelMessage.value = `✗ 保存失败：${error.message}`
  }
}

function importModel() {
  if (!context.importLive2DModel) return
  context.importLive2DModel().then(refreshModels).catch((error) => {
    modelMessage.value = `导入失败：${error.message}`
  })
}
function replaceModelCover(id, event) {
  if (!context.replaceLive2DPreview) return
  context.replaceLive2DPreview(id, event).then(refreshModels).catch((error) => {
    modelMessage.value = `封面更换失败：${error.message}`
  })
}
function deleteModel(id) {
  if (!context.deleteLive2DModel) return
  context.deleteLive2DModel(id).then(refreshModels).catch((error) => {
    modelMessage.value = `删除失败：${error.message}`
  })
}

// ---------------------------------------------------------------- 屏幕观察
// 三个预设必须与 saveObserve 的映射表一致；回读时**只按 min 匹配**（min 是预设的区分因子）。
// 旧实现要求 (min,max) 精确等于某一个配对，服务端存成 (1800,2000) 之类就三个分支全不命中，
// observe.range 静默保持默认 '5-15' —— 看起来就是「改完设置重开变回默认」。
const OBSERVE_RANGES = [
  { id: '5-15', min: 300, max: 900 },
  { id: '10-30', min: 600, max: 1800 },
  { id: '30-60', min: 1800, max: 3600 },
]
function matchObserveRange(min) {
  const exact = OBSERVE_RANGES.find((item) => item.min === min)
  if (exact) return exact.id
  return OBSERVE_RANGES.reduce((best, item) =>
    Math.abs(item.min - min) < Math.abs(best.min - min) ? item : best, OBSERVE_RANGES[0]).id
}
const observe = ref({ enabled: false, range: '5-15' })
const observeMessage = ref('')
const xiaozhiStatus = ref({ connected: false, session_id: '', vision: false, observe_enabled: false })

async function loadXiaozhiStatus() {
  try {
    const [status, vision, observeStatus] = await Promise.all([
      getJson('/api/xiaozhi/status').catch(() => null),
      getJson('/api/xiaozhi/vision-info').catch(() => null),
      getJson('/api/xiaozhi/observe/status').catch(() => null),
    ])
    xiaozhiStatus.value = {
      connected: Boolean(status && status.connected),
      session_id: (status && status.session_id) || '',
      vision: Boolean(vision && vision.ok),
      // 读不到观察状态时保留上一次的值，不要回落成「未启动」——
      // 旧实现用 .catch(() => ({ enabled: false })) 会把开关刷成默认，同样是「设置被重置」的假象。
      observe_enabled: observeStatus
        ? Boolean(observeStatus.enabled)
        : Boolean(xiaozhiStatus.value.observe_enabled),
    }
    if (observeStatus) {
      observe.value.enabled = Boolean(observeStatus.enabled)
      const min = Number(observeStatus.min_seconds) || 300
      const max = Number(observeStatus.max_seconds) || 900
      observe.value.range = matchObserveRange(min)
    }
    observeMessage.value = ''
  } catch (error) {
    observeMessage.value = `读取失败：${error.message}`
  }
}

async function saveObserve() {
  try {
    const preset = OBSERVE_RANGES.find((item) => item.id === observe.value.range) || OBSERVE_RANGES[0]
    const [min, max] = [preset.min, preset.max]
    const result = await request(observe.value.enabled ? '/api/xiaozhi/observe/start' : '/api/xiaozhi/observe/stop', 'POST', {
      enabled: observe.value.enabled, min_seconds: min, max_seconds: max, quiet_start: '23:00', quiet_end: '08:00',
    })
    // 用服务端回执回填，保证「界面上看到的 = 服务端存的」
    if (result && typeof result.enabled !== 'undefined') {
      observe.value.enabled = Boolean(result.enabled)
      observe.value.range = matchObserveRange(Number(result.min_seconds) || min)
    }
    observeMessage.value = observe.value.enabled
      ? `✓ 自动观察已开启（${preset.id.replace('-', '–')} 分钟随机）`
      : '✓ 自动观察已关闭'
  } catch (error) {
    observeMessage.value = `✗ 保存失败：${error.message}`
  }
}

async function observeOnce() {
  observeMessage.value = '截屏分析中…'
  try {
    const shot = await request('/api/companion/screen-shot', 'POST', {})
    if (!shot.ok) throw new Error('截图失败')
    const result = await request('/api/xiaozhi/vision-bubble', 'POST', {
      image_base64: shot.image_base64, kind: 'observe', question: '',
    })
    if (!result.ok) throw new Error(result.detail || '小智视觉失败')
    observeMessage.value = `✓ 已让小智评价：${String(result.text || '').slice(0, 60)}…`
  } catch (error) {
    observeMessage.value = `✗ ${error.message}`
  }
}

function openScreenCrop() {
  if (window.mioDesktop && typeof window.mioDesktop.openScreenCrop === 'function') {
    window.mioDesktop.openScreenCrop()
  } else if (window.pywebview && window.pywebview.api && window.pywebview.api.open_screen_crop) {
    window.pywebview.api.open_screen_crop()
  } else {
    observeMessage.value = '快捷键可用：任意软件按 Ctrl+Shift+S 框选区域'
  }
}

// ---------------------------------------------------------------- 体检
// 体检面板的正式 UI 由 core-inject/health-panel-inject.js 接管渲染（Agents/本体自检增强版），
// 它会整体替换 .health-simple-panel 的 innerHTML。这里**只渲染空壳 + 加载占位**：
// ① 旧版在这里渲染完整体检 UI，注入层接管前会闪现旧界面（"进体检先闪一下旧 UI"）；
// ② 旧模板的动态绑定会让 Vue 在注入层替换 innerHTML 之后仍试图 patch 已不存在的节点。
onMounted(() => {
  refreshModels()
  loadXiaozhiStatus()
})
</script>

<template>
  <section class="companion-hub">
    <div class="companion-main">
      <nav class="companion-tab-bar compact-companion-tabs" aria-label="桌宠功能">
        <button type="button" :class="{ active: context.activeCompanionSection === 'pet-panel' }" @click="context.activeCompanionSection = 'pet-panel'"><Gamepad2 :size="16" />桌宠</button>
        <button type="button" :class="{ active: context.activeCompanionSection === 'screen-panel' }" @click="context.activeCompanionSection = 'screen-panel'"><Monitor :size="16" />观察</button>
        <button type="button" :class="{ active: context.activeCompanionSection === 'model-panel' }" @click="context.activeCompanionSection = 'model-panel'"><Boxes :size="16" />模型</button>
        <button type="button" :class="{ active: context.activeCompanionSection === 'health-panel' }" @click="context.activeCompanionSection = 'health-panel'"><Stethoscope :size="16" />体检</button>
      </nav>

      <PetAppearancePanel
        v-if="context.activeCompanionSection === 'pet-panel'"
        :status="context.companionStatus"
        :avatar-url="context.companionAvatarUrl"
        :display-name="context.mioDisplayName"
        :busy="Boolean(context.companionBusy)"
        management-mode
        :feedback="context.settingsFeedback"
        @control="context.controlCompanion"
        @import-live2d="context.importLive2DModel"
        @delete-live2d="context.deleteLive2DModel"
        @replace-live2d-preview="context.replaceLive2DPreview"
        @preview-motion="context.previewLive2DMotion"
        @preview-expression="context.previewLive2DExpression"
        @select-live2d="switchModel"
        @save="context.saveCompanionSettings('pet')"
        @save-size="context.saveCompanionSize"
        @manage="context.openSettingsSection('pet')"
        @refresh-status="applyRefreshedStatus"
      />

      <section v-else-if="context.activeCompanionSection === 'screen-panel'" class="companion-simple-panel observer-simple-panel">
        <header><div><Monitor :size="19" /><span><h2>屏幕自动观察（冷不丁评价）</h2><p>随机截屏让小智评价你的屏幕</p></span></div><span :class="['connection-label', { online: xiaozhiStatus.observe_enabled }]">{{ xiaozhiStatus.observe_enabled ? '观察中' : '未启动' }}</span></header>
        <div class="observe-auto-block">
          <div class="voice-quick-grid">
            <label><span><strong>自动观察</strong><small>随机截屏让小智评价你的屏幕</small></span><span class="switch-control"><input v-model="observe.enabled" type="checkbox" @change="saveObserve" /><i /></span></label>
            <label><span><strong>快捷键</strong><small>全局 Ctrl+Shift+S 框选区域投喂</small></span><b class="shortcut-chip">Ctrl+Shift+S</b></label>
          </div>
          <div class="voice-quick-settings">
            <label><span>间隔(分)</span><select v-model="observe.range" @change="saveObserve"><option value="5-15">5–15 分钟随机</option><option value="10-30">10–30 分钟随机</option><option value="30-60">30–60 分钟随机</option></select></label>
            <label><span>免打扰</span><span class="dim-text">23:00 – 08:00</span></label>
          </div>
          <div class="voice-runtime-summary"><strong>上次更换：{{ schedule.last_switched || '尚未更换' }}</strong></div>
          <footer class="companion-action-bar">
            <button type="button" @click="observeOnce"><Zap :size="15" />立即观察一次</button>
            <button type="button" @click="openScreenCrop"><Monitor :size="15" />框选屏幕区域</button>
          </footer>
          <p class="companion-panel-msg">{{ observeMessage }}</p>
        </div>
      </section>

      <section v-else-if="context.activeCompanionSection === 'model-panel'" class="companion-simple-panel model-simple-panel">
        <header><div><Boxes :size="19" /><span><h2>Live2D 模型管理</h2><p>切换模型、导入与每天定时自动更换</p></span></div><button type="button" title="刷新" @click="refreshModels"><RefreshCw :size="15" /></button></header>
        <div class="model-actions" style="display:flex;gap:8px;margin-bottom:10px;">
          <button type="button" class="primary-button" style="flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 12px;border:none;border-radius:8px;background:#3370ff;color:#fff;font-size:13px;cursor:pointer;" @click="importModel"><ImagePlus :size="15" /><span>导入 Live2D 模型</span></button>
        </div>
        <div class="model-list">
          <div class="model-section" style="margin-bottom:10px;">
            <h4 style="margin:6px 0 6px;font-size:13px;color:#5f6670;">内置模型（随项目分发）</h4>
            <div v-for="item in sortedBuiltInModels" :key="item.id" class="model-item" :class="{ gold: item.featured }">
              <span class="model-name">{{ item.name }}</span><span class="model-id">{{ item.id }}</span>
              <span v-if="String(item.id) === String(currentModelId)" class="model-cur">当前</span>
              <button v-else type="button" class="model-switch" @click="switchModel(item.id)">切换</button>
            </div>
            <div v-if="!sortedBuiltInModels.length" class="model-empty">暂无内置模型</div>
          </div>
          <div class="model-section">
            <h4 style="margin:6px 0 6px;font-size:13px;color:#5f6670;">外部导入（仅本机）</h4>
            <div v-for="item in importedModels" :key="item.id" class="model-item">
              <span class="model-name">{{ item.name }}</span><span class="model-id">{{ item.id }}</span>
              <span v-if="String(item.id) === String(currentModelId)" class="model-cur">当前</span>
              <button v-else type="button" class="model-switch" @click="switchModel(item.id)">切换</button>
              <label class="model-cover" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#3370ff;cursor:pointer;margin-left:8px;"><input type="file" accept="image/*" style="display:none;" @change="replaceModelCover(item.id, $event)" /><span>封面</span></label>
              <button type="button" class="model-del" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#c0392b;cursor:pointer;margin-left:8px;border:none;background:transparent;" @click="deleteModel(item.id)">删除</button>
            </div>
            <div v-if="!importedModels.length" class="model-empty">暂无导入模型</div>
          </div>
        </div>
        <div class="voice-quick-settings">
          <label><span>自动更换</span><span class="switch-control"><input v-model="schedule.enabled" type="checkbox" @change="saveSchedule" /><i /></span></label>
          <label><span>时间</span><input v-model="schedule.time" type="time" @change="saveSchedule" /></label>
          <label><span>模式</span><select v-model="schedule.mode" @change="saveSchedule"><option value="random">随机</option><option value="sequential">顺序</option></select></label>
        </div>
        <div class="voice-runtime-summary"><strong>上次更换：{{ schedule.last_switched || '尚未更换' }}</strong></div>
        <p class="companion-panel-msg">{{ modelMessage }}</p>
      </section>

      <!-- 体检：只渲染空壳占位，正式 UI 由 core-inject/health-panel-inject.js 接管填充
           （避免旧版体检 UI 在接管前闪现；见 script 内注释） -->
      <section v-else class="companion-simple-panel health-simple-panel" aria-busy="true">
        <p class="companion-panel-msg">体检加载中…</p>
      </section>
    </div>
  </section>
</template>
