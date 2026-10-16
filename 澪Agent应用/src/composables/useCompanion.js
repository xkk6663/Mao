/** Companion operations. Reactive values and cross-domain callbacks are explicitly injected.
 * This module owns behavior, not application-global mutable state.
 * Dependencies are accessors so async callbacks see the latest state.
 */
import * as observationApi from '../services/observationApi.js'

export function useCompanion(deps) {
  /**
   * 整体替换 companionStatus 的地方一律走这里。
   *
   * 为什么必须包一层：PetAppearancePanel 是**直接 v-model 到 store 的 pet.settings 对象**上的
   * （动作/表情槽位、三个开关、桌宠大小都写在同一个对象里），所以任何
   * `deps.companionStatus.value = <服务端刚返回的新对象>` 都会把**用户尚未点保存的编辑一起冲掉**。
   * 真实症状：调完表情 → 顺手拖一下「桌宠大小」（它 @change 立即 PATCH /size 并整体替换 store）
   * → 再点保存 → 表情白填，服务端存到的还是旧值，看起来就是"保存了但重开还是空的"。
   *
   * @param {object}  next                      服务端返回的新 status
   * @param {boolean} [opts.preserveSettings]   是否保留本地草稿（默认 true）
   * @param {object}  [opts.editing]            显式指定要保留的草稿对象（默认取当前 store 的 settings）
   * @param {string[]}[opts.serverKeys]         若给出：只有这些键以**服务端回执**为准，其余键保留草稿。
   *                                            用于「保存某个分组」的场景——本次提交的键服务端有权威
   *                                            （含它自动维护的 live2d_model_id、白名单过滤结果），
   *                                            但没提交的其它分组里用户未保存的编辑不能被清掉。
   */
  function assignStatus(next, { preserveSettings = true, editing = null, serverKeys = null } = {}) {
    if (preserveSettings && deps.companionStatusReady.value && next?.pet) {
      const draft = editing || deps.companionStatus.value.pet?.settings
      if (draft) {
        if (!serverKeys) {
          next.pet.settings = draft
        } else {
          // 只覆盖「服务端确实回传了」的那部分键；服务端没回的键保留草稿，
          // 避免因后端裁剪/省略某个键而把它从 UI 上误删。
          const serverSettings = next.pet.settings || {}
          const merged = { ...draft }
          for (const key of serverKeys) {
            if (key in serverSettings) merged[key] = serverSettings[key]
          }
          next.pet.settings = merged
        }
      }
    }
    deps.companionStatus.value = next
    return next
  }

  /**
   * 上传参考音频 / 导入音色包这类操作会同时改到 voice 与 pet 两个分组里的键
   * （音色档案、默认音色、gpt_sovits 路径等）。这些键必须以服务端回执为准，
   * 否则界面上看不到刚上传的参考音频；其余分组的未保存草稿则保留。
   */
  const voiceSyncKeys = () => [
    ...(deps.companionSettingKeys.voice || []),
    ...(deps.companionSettingKeys.pet || []),
  ]

  async function loadCompanionStatus({ quiet = false, preserveSettings = false } = {}) {
    if (deps.companionStatusLoading) return
    deps.companionStatusLoading = true
    try {
      const editingSettings = deps.companionStatus.value.pet?.settings
      const previousSpriteVersion = deps.companionStatus.value.pet?.sprite_version || ''
      const nextStatus = await observationApi.loadCompanionStatus()
      // ★ preserveSettings 只在「已经成功水合过一次」之后才成立。
      // 否则 App.vue 里那份**硬编码的初始 settings**（pet_size_percent:150 等）会被当成
      // 「用户正在编辑的草稿」整体盖到服务端真实配置上 —— 表现为：打开桌宠页永远是默认值，
      // 而页面上唯一的加载器（activeView === 'companion' 的 3s 轮询）恰好带 preserveSettings，
      // 于是错误值被永久固化，改了保存也像是没生效。
      const canPreserve = preserveSettings && deps.companionStatusReady.value && editingSettings
      if (canPreserve && nextStatus.pet) {
        nextStatus.pet.settings = editingSettings
      } else if (nextStatus.pet?.settings && nextStatus.voice_runtime?.active_weights) {
        nextStatus.pet.settings.gpt_sovits_gpt_weights ||= nextStatus.voice_runtime.active_weights.gpt || ''
        nextStatus.pet.settings.gpt_sovits_sovits_weights ||= nextStatus.voice_runtime.active_weights.sovits || ''
      }
      nextStatus.screen = nextStatus.screen || nextStatus.window || nextStatus.game || {}
       deps.companionStatus.value = nextStatus
      deps.companionStatusReady.value = true
      if (!preserveSettings) {
        for (const section of Object.keys(deps.companionSettingKeys)) {
          deps.savedCompanionSettings.value[section] = deps.companionSettingsSnapshot(section, nextStatus.pet?.settings || {})
        }
        if (deps.companionStatus.value.screen?.screen_scope) deps.screenScope.value = deps.companionStatus.value.screen.screen_scope
        if (deps.companionStatus.value.screen?.interval_ms) deps.observationInterval.value = deps.companionStatus.value.screen.interval_ms
        deps.observationMode.value = deps.companionStatus.value.screen?.mode === 'window' ? 'game' : 'screen'
        if (deps.companionStatus.value.screen?.hwnd) deps.selectedGameHwnd.value = String(deps.companionStatus.value.screen.hwnd)
      }
      if (String(nextStatus.pet?.sprite_version || '') !== String(previousSpriteVersion)) {
        deps.companionAvatarNonce.value = Date.now()
      }
    } catch (error) {
      if (!quiet) deps.errorMessage.value = error.message
    } finally {
      deps.companionStatusLoading = false
    }
  }
  async function openScreenPreviewWindow() {
    deps.errorMessage.value = ''
    try {
      if (window.pywebview?.api?.open_screen_preview) {
        const result = await window.pywebview.api.open_screen_preview()
        if (result?.ok === false) throw new Error(result.error || '独立预览窗口启动失败')
        return
      }
      window.open(`/api/companion/screen/preview?t=${Date.now()}`, '_blank', 'noopener,noreferrer')
    } catch (error) {
      deps.errorMessage.value = `打开独立预览失败：${error.message}`
    }
  }
  async function saveCompanionSize() {
    if (deps.companionBusy.value === 'size') return
    deps.companionBusy.value = 'size'
    deps.errorMessage.value = ''
    try {
      // ★ 必须在**请求发出前**捕获草稿对象：此刻 pet.settings 上还挂着用户尚未点保存的
      // 表情/开关改动；PATCH /size 的响应会带回服务端的旧副本，直接替换 store 就会冲掉这些编辑。
      const editing = deps.companionStatus.value.pet?.settings
      const next = await deps.request('/api/companion/size', {
        method: 'PATCH',
        body: JSON.stringify({ percent: Number(deps.companionStatus.value.pet.settings.pet_size_percent) }),
      })
      // 注意：这里必须用**请求前捕获的草稿对象**，不能用响应里的 settings，
      // 否则刚被拖动的表情/开关编辑会被服务端返回值覆盖掉。
      assignStatus(next, { editing: editing });
    } catch (error) {
      deps.errorMessage.value = `桌宠大小调整失败：${error.message}`
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function controlCompanion(action) {
    if (deps.companionBusy.value) return
    deps.companionBusy.value = action
    deps.errorMessage.value = ''
    try {
      // 启动/停止/重启只改运行态、不动 settings，但响应里同样带着 settings 副本；
      // 统一走 assignStatus，避免冲掉用户正在编辑的草稿。
      assignStatus(await deps.request(`/api/companion/${action}`, { method: 'POST', body: '{}' }))
    } catch (error) {
      deps.errorMessage.value = error.message
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function previewLive2DMotion(group) {
    if (!group || deps.companionBusy.value) return
    deps.companionBusy.value = 'motion-preview'
    deps.errorMessage.value = ''
    try {
      await deps.request('/api/companion/live2d/motion/preview', {
        method: 'POST',
        body: JSON.stringify({ group }),
      })
    } catch (error) {
      deps.errorMessage.value = `动作预览失败：${error.message}`
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function previewLive2DExpression(expression) {
    if (!expression || deps.companionBusy.value) return
    deps.companionBusy.value = 'expression-preview'
    deps.errorMessage.value = ''
    try {
      await deps.request('/api/companion/live2d/expression/preview', {
        method: 'POST',
        body: JSON.stringify({ expression }),
      })
    } catch (error) {
      deps.errorMessage.value = `表情预览失败：${error.message}`
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function saveCompanionSettings(section = '') {
    if (typeof section !== 'string') section = ''
    if (deps.companionBusy.value) return
    if (!deps.companionStatusReady.value) {
      // 原来这里是**静默 return**：点保存毫无反应、也没有任何提示，
      // 极易被误判成「保存了但不生效」。改成显式反馈。
      if (section) deps.showSettingsFeedback(section, 'error', '桌宠状态尚未加载完成，请稍后再保存')
      return
    }
    deps.companionBusy.value = 'settings'
    deps.errorMessage.value = ''
    if (section) deps.showSettingsFeedback(section, '', '保存中…')
    try {
      const settings = deps.companionStatus.value.pet.settings
      if (section === 'observation') {
        settings.screen_audio_enabled = Boolean(deps.companionStatus.value.screen?.running)
      }
      let previousPetSettings = {}
      if (section === 'pet' && deps.savedCompanionSettings.value.pet) {
        try { previousPetSettings = JSON.parse(deps.savedCompanionSettings.value.pet) || {} } catch (_) {}
      }
      const petWasRunning = section === 'pet' && Boolean(deps.companionStatus.value.pet.running)
      const payload = section && deps.companionSettingKeys[section]
        ? Object.fromEntries(deps.companionSettingKeys[section].map((key) => [key, settings[key]]))
        : settings
      // 预读一次服务端的 live2d_model_id（后端可能因自动换装/切换而先行改了它），
      // 保证「保存」不会把用户没改过的模型切回去。
      if (section === 'pet') {
        try {
          const fresh = await deps.request('/api/companion/status')
          const freshSettings = (fresh.pet || {}).settings || {}
          if (freshSettings.live2d_model_id) payload.live2d_model_id = freshSettings.live2d_model_id
        } catch (_) { /* 预读失败不阻断保存 */ }
      }
      // 保存：**本次提交的键以服务端回执为准**（这样才能反映后端的白名单过滤与它自动维护的
      // live2d_model_id），**未提交的键保留草稿**（避免"保存桌宠分组"顺手清掉"观察分组"里
      // 用户刚改但还没保存的选项）。
      assignStatus(await deps.request('/api/companion/settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }), { serverKeys: Object.keys(payload) })
      const rendererChanged = section === 'pet'
        && previousPetSettings.pet_renderer !== settings.pet_renderer
      const runtimeChanged = section === 'pet'
        && previousPetSettings.live2d_disable_gpu !== settings.live2d_disable_gpu
      if (petWasRunning && (rendererChanged || runtimeChanged)) {
        // 重启只改运行态，settings 不归它管 —— 走 assignStatus 保留草稿。
        assignStatus(await deps.request('/api/companion/restart', { method: 'POST', body: '{}' }))
      }
      const sections = section ? [section] : Object.keys(deps.companionSettingKeys)
      if (section === 'voice') sections.push('pet')
      if (section === 'pet') sections.push('voice')
      for (const item of sections) {
        deps.savedCompanionSettings.value[item] = deps.companionSettingsSnapshot(item)
      }
      if (section) {
        const message = section === 'pet' && (rendererChanged || runtimeChanged) ? '桌宠运行方式已更新' : `${deps.activeSettingsItem.value.label}设置已保存`
        deps.showSettingsFeedback(section, 'success', message)
      }
      return true
    } catch (error) {
      deps.errorMessage.value = error.message
      if (section) deps.showSettingsFeedback(section, 'error', `${deps.activeSettingsItem.value.label}设置保存失败`)
      return false
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function testCompanionVoice() {
    deps.companionBusy.value = 'voice'
    deps.errorMessage.value = ''
    try {
      await deps.request('/api/companion/voice/test', { method: 'POST', body: '{}' })
      await loadCompanionStatus({ quiet: true, preserveSettings: true })
    } catch (error) {
      deps.errorMessage.value = error.message
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function testCompanionVoiceProfile() {
    const saved = await saveCompanionSettings('voice')
    if (!saved) return
    await testCompanionVoice()
  }
  async function uploadVoiceReference(event, profileId) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 40 * 1024 * 1024) {
      deps.showSettingsFeedback('pet', 'error', '参考音频不能超过 40 MB')
      return
    }
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || ''
    const allowedExtensions = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac', '.wma'])
    if (!file.type.startsWith('audio/') && !allowedExtensions.has(extension)) {
      deps.showSettingsFeedback('pet', 'error', '请选择 WAV、MP3、FLAC 等音频文件')
      return
    }
    const saved = await saveCompanionSettings('voice')
    if (!saved) return
    deps.companionBusy.value = 'voice-reference'
    deps.errorMessage.value = ''
    try {
      assignStatus(await deps.request('/api/companion/voice/reference', {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          data_url: await deps.readFileAsDataUrl(file),
          profile_id: profileId,
        }),
      }), { serverKeys: voiceSyncKeys() })
      deps.savedCompanionSettings.value.voice = deps.companionSettingsSnapshot('voice')
      deps.savedCompanionSettings.value.pet = deps.companionSettingsSnapshot('pet')
      deps.showSettingsFeedback('pet', 'success', '参考音频已保存到当前音色')
    } catch (error) {
      deps.errorMessage.value = error.message
      deps.showSettingsFeedback('pet', 'error', `参考音频上传失败：${error.message}`)
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function exportVoicePackage(profileId) {
    if (!profileId) return
    deps.companionBusy.value = 'voice-export'
    deps.errorMessage.value = ''
    try {
      const response = await fetch('/api/companion/voice/profiles/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId }),
      })
      if (!response.ok) {
        let detail = '导出失败'
        try {
          detail = (await response.json()).detail || detail
        } catch {
          // Keep the fallback message.
        }
        throw new Error(detail)
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `音色包-${profileId}.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      deps.errorMessage.value = error.message
      deps.showSettingsFeedback('pet', 'error', `音色包导出失败：${error.message}`)
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function importVoicePackage(event) {
    const nativeImporter = window.pywebview?.api?.import_voice_package
    const file = event?.target?.files?.[0]
    if (event?.target) event.target.value = ''
    if (!nativeImporter && !file) return
    const saved = await saveCompanionSettings('voice')
    if (!saved) return
    deps.companionBusy.value = 'voice-import'
    deps.errorMessage.value = ''
    try {
      if (nativeImporter) {
        let result = await nativeImporter()
        if (result?.canceled) return
        if (result?.ok === false) throw new Error(result.error || '导入失败')
        if (result?.started) {
          const statusReader = window.pywebview?.api?.voice_package_import_status
          if (!statusReader) throw new Error('桌面导入状态接口不可用，请重启应用后重试')
          deps.showSettingsFeedback('pet', 'success', `正在后台导入「${result.filename || '音色包'}」，主应用可以继续保持打开`)
          while (true) {
            await new Promise((resolve) => window.setTimeout(resolve, 500))
            const status = await statusReader(result.job_id)
            if (status?.state === 'completed') {
              result = status
              break
            }
            const percent = Number.isFinite(Number(status?.percent)) ? ` ${Math.max(0, Math.min(99, Number(status.percent)))}%` : ''
            deps.showSettingsFeedback('pet', 'success', `${status?.message || '正在后台导入音色包'}${percent}；主应用不会因此关闭`)
          }
          if (result?.ok === false) throw new Error(result.error || '独立导入任务失败')
        }
        await loadCompanionStatus({ quiet: false })
        const imported = result?.imported || {}
        const engineLabel = imported.engine === 'so_vits_svc' ? 'So-VITS-SVC 第三方音色' : 'Mio 音色包'
        const readyMessage = imported.runtime === 'missing'
          ? `${engineLabel}「${imported.name || '未命名'}」已安全保存；本机缺少第三方音色运行环境，暂未设为默认`
          : `${engineLabel}「${imported.name || '未命名'}」已通过模型加载验证、设为默认，可直接试听`
        deps.showSettingsFeedback('pet', imported.runtime === 'missing' ? 'error' : 'success', readyMessage)
      } else {
        const response = await fetch('/api/companion/voice/profiles/import-package', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        })
        if (!response.ok) {
          let detail = '导入失败'
          try {
            detail = (await response.json()).detail || detail
          } catch {
            // Keep the fallback message.
          }
          throw new Error(detail)
        }
        assignStatus(await response.json(), { serverKeys: voiceSyncKeys() })
      }
      deps.savedCompanionSettings.value.voice = deps.companionSettingsSnapshot('voice')
      deps.savedCompanionSettings.value.pet = deps.companionSettingsSnapshot('pet')
      if (!nativeImporter) deps.showSettingsFeedback('pet', 'success', '音色包已导入并设为默认，可直接试听')
    } catch (error) {
      deps.errorMessage.value = error.message
      deps.showSettingsFeedback('pet', 'error', `音色包导入失败：${error.message}`)
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function controlVoiceRuntime(action) {
    if (deps.companionBusy.value) return
    deps.companionBusy.value = `voice-runtime-${action}`
    deps.errorMessage.value = ''
    try {
      deps.companionStatus.value.voice_runtime = await deps.request(`/api/companion/voice/runtime/${action}`, {
        method: 'POST',
        body: '{}',
      })
    } catch (error) {
      deps.errorMessage.value = error.message
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function controlLocalVision(action) {
    if (deps.companionBusy.value) return
    deps.companionBusy.value = `local-vision-${action}`
    deps.errorMessage.value = ''
    try {
      const localVision = await deps.request(`/api/companion/local-vision/runtime/${action}`, {
        method: 'POST',
        body: '{}',
      })
      deps.companionStatus.value.screen_analysis = {
        ...(deps.companionStatus.value.screen_analysis || {}),
        local_vision: localVision,
      }
      await loadCompanionStatus({ quiet: true, preserveSettings: true })
    } catch (error) {
      deps.errorMessage.value = error.message
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function pullLocalVisionModel() {
    if (deps.companionBusy.value) return
    deps.companionBusy.value = 'local-vision-pull'
    deps.errorMessage.value = ''
    try {
      const localVision = await deps.request('/api/companion/local-vision/model/pull', {
        method: 'POST',
        body: '{}',
      })
      deps.companionStatus.value.screen_analysis = {
        ...(deps.companionStatus.value.screen_analysis || {}),
        local_vision: localVision,
      }
    } catch (error) {
      deps.errorMessage.value = error.message
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function controlVoiceTraining(action) {
    if (deps.companionBusy.value) return
    deps.companionBusy.value = `voice-training-${action}`
    deps.errorMessage.value = ''
    try {
      deps.companionStatus.value.voice_training = await deps.request(`/api/companion/voice/training/${action}`, {
        method: 'POST',
        body: '{}',
      })
    } catch (error) {
      deps.errorMessage.value = error.message
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function importLive2DModel() {
    if (deps.companionBusy.value) return
    deps.companionBusy.value = 'live2d-import'
    deps.errorMessage.value = ''
    try {
      let result
      if (window.pywebview?.api?.import_live2d_model) {
        result = await window.pywebview.api.import_live2d_model()
        if (result?.canceled) return
        if (result?.ok === false) throw new Error(result.error || 'Live2D 模型导入失败')
      } else {
        const sourcePath = await deps.showAppPrompt({
          title: '导入 Live2D',
          message: '请输入包含 .model3.json 的模型目录完整路径',
          confirmText: '导入',
        })
        if (!sourcePath) return
        result = await deps.request('/api/companion/live2d/models/import', {
          method: 'POST',
          body: JSON.stringify({ source_path: sourcePath }),
        })
      }
      await loadCompanionStatus({ quiet: false })
      deps.showSettingsFeedback('pet', 'success', `已导入 ${result?.model?.name || 'Live2D 模型'}`)
    } catch (error) {
      deps.errorMessage.value = error.message
      deps.showSettingsFeedback('pet', 'error', `Live2D 模型导入失败：${error.message}`)
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function deleteLive2DModel(model) {
    if (deps.companionBusy.value || !model?.id) return
    const confirmed = await deps.showAppConfirm({
      title: `删除“${model.name || model.id}”？`,
      message: '模型文件会从本机形象目录移除。',
      confirmText: '删除形象',
      danger: true,
    })
    if (!confirmed) return
    deps.companionBusy.value = 'live2d-delete'
    deps.errorMessage.value = ''
    try {
      await deps.request(`/api/companion/live2d/models/${encodeURIComponent(model.id)}`, { method: 'DELETE' })
      await loadCompanionStatus({ quiet: false })
      deps.showSettingsFeedback('pet', 'success', '自定义 Live2D 模型已删除')
    } catch (error) {
      deps.errorMessage.value = error.message
      deps.showSettingsFeedback('pet', 'error', `Live2D 模型删除失败：${error.message}`)
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function replaceLive2DPreview(model, event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !model?.id) return
    if (!deps.isImageAttachment(file)) {
      deps.errorMessage.value = '请选择图片文件。'
      return
    }
    deps.companionBusy.value = 'live2d-preview'
    deps.errorMessage.value = ''
    try {
      const dataUrl = await deps.readFileAsDataUrl(file)
      await deps.request(`/api/companion/live2d/models/${encodeURIComponent(model.id)}/preview`, {
        method: 'POST',
        body: JSON.stringify({ data_url: dataUrl }),
      })
      deps.companionAvatarNonce.value = Date.now()
      await loadCompanionStatus({ quiet: false })
      deps.showSettingsFeedback('pet', 'success', `已更新 ${model.name || 'Live2D 模型'} 的封面`)
    } catch (error) {
      deps.errorMessage.value = error.message
      deps.showSettingsFeedback('pet', 'error', `封面更新失败：${error.message}`)
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function uploadCompanionSpriteSheet(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!deps.isImageAttachment(file)) {
      deps.errorMessage.value = '请选择图片文件。'
      return
    }
    deps.companionBusy.value = 'spritesheet'
    deps.errorMessage.value = ''
    try {
      const dataUrl = await deps.readFileAsDataUrl(file)
      // 换精灵图只改 pet.sprite_version（顶层字段），不动 settings —— 走 assignStatus 保留草稿。
      assignStatus(await deps.request('/api/companion/spritesheet', {
        method: 'POST',
        body: JSON.stringify({ data_url: dataUrl }),
      }))
      deps.companionAvatarNonce.value = Date.now()
    } catch (error) {
      deps.errorMessage.value = error.message
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function loadGameWindows({ quiet = false } = {}) {
    if (deps.gameWindowsLoading.value) return
    deps.gameWindowsLoading.value = true
    try {
      const windows = await observationApi.listWindows()
      deps.gameWindows.value = Array.isArray(windows) ? windows : []
      const currentHwnd = String(deps.companionStatus.value.screen?.hwnd || deps.selectedGameHwnd.value || '')
      if (currentHwnd && deps.gameWindows.value.some((item) => String(item.hwnd) === currentHwnd)) {
        deps.selectedGameHwnd.value = currentHwnd
      } else if (deps.gameWindows.value.length === 1) {
        deps.selectedGameHwnd.value = String(deps.gameWindows.value[0].hwnd)
      }
    } catch (error) {
      if (!quiet) deps.errorMessage.value = error.message
    } finally {
      deps.gameWindowsLoading.value = false
    }
  }
  async function controlObservation(action) {
    if (deps.companionBusy.value) return
    deps.companionBusy.value = `observation-${action}`
    deps.errorMessage.value = ''
    try {
      if (action === 'stop') {
        deps.companionStatus.value.screen = await deps.request('/api/companion/screen/stop', { method: 'POST', body: '{}' })
        deps.companionStatus.value.pet.settings.screen_audio_enabled = false
        return
      }

      if (deps.observationMode.value === 'game') {
        if (!deps.selectedGameHwnd.value) throw new Error('请选择要观察的游戏窗口。')
        deps.companionStatus.value.screen = await deps.request('/api/companion/game/select', {
          method: 'POST',
          body: JSON.stringify({ hwnd: Number(deps.selectedGameHwnd.value) }),
        })
        deps.companionStatus.value.screen = await deps.request('/api/companion/game/start', {
          method: 'POST',
          body: JSON.stringify({ interval_ms: deps.observationInterval.value }),
        })
      } else {
        deps.companionStatus.value.screen = await deps.request('/api/companion/screen/start', {
          method: 'POST',
          body: JSON.stringify({ interval_ms: deps.observationInterval.value, scope: deps.screenScope.value }),
        })
      }
      deps.companionStatus.value.pet.settings.screen_audio_enabled = true
      await loadCompanionStatus({ quiet: true, preserveSettings: true })
    } catch (error) {
      deps.errorMessage.value = error.message
    } finally {
      deps.companionBusy.value = ''
    }
  }
  async function letMioSeeObservation() {
    if (deps.companionBusy.value) return
    deps.companionBusy.value = 'observation-see'
    deps.errorMessage.value = ''
    try {
      let result
      if (deps.observationMode.value === 'game') {
        if (!deps.selectedGameHwnd.value) throw new Error('请选择要观察的游戏窗口。')
        if (
          deps.companionStatus.value.screen?.mode !== 'window'
          || String(deps.companionStatus.value.screen?.hwnd || '') !== String(deps.selectedGameHwnd.value)
        ) {
          deps.companionStatus.value.screen = await deps.request('/api/companion/game/select', {
            method: 'POST',
            body: JSON.stringify({ hwnd: Number(deps.selectedGameHwnd.value) }),
          })
        }
        result = await deps.request('/api/companion/game/analyze', { method: 'POST', body: '{}' })
      } else {
        result = await deps.request('/api/companion/screen/analyze', {
          method: 'POST',
          body: JSON.stringify({ interval_ms: deps.observationInterval.value, scope: deps.screenScope.value }),
        })
      }
      deps.companionStatus.value.screen_analysis = result.analysis
      await loadCompanionStatus({ quiet: true, preserveSettings: true })
    } catch (error) {
      deps.errorMessage.value = error.message
    } finally {
      deps.companionBusy.value = ''
    }
  }
  return { loadCompanionStatus, openScreenPreviewWindow, saveCompanionSize, controlCompanion, previewLive2DMotion, previewLive2DExpression, saveCompanionSettings, testCompanionVoice, testCompanionVoiceProfile, uploadVoiceReference, exportVoicePackage, importVoicePackage, controlVoiceRuntime, controlLocalVision, pullLocalVisionModel, controlVoiceTraining, importLive2DModel, deleteLive2DModel, replaceLive2DPreview, uploadCompanionSpriteSheet, loadGameWindows, controlObservation, letMioSeeObservation }
}
