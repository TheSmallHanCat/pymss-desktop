import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { useAppStore } from '@/stores/app'
import { isTauriRuntime, loadAppStore, saveAppStore } from '@/utils/appStore'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'failed'

type UpdateStorePayload = {
  deferredVersion?: string
  deferredAt?: string
  lastAcceptedVersion?: string
}

type UpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number | null } }
  | { event: 'Progress'; data: { chunkLength?: number } }
  | { event: 'Finished'; data?: null }

export const useUpdateStore = defineStore('update', () => {
  const status = ref<UpdateStatus>('idle')
  const currentVersion = ref('')
  const latestVersion = ref('')
  const releaseNotes = ref('')
  const releaseDate = ref('')
  const error = ref('')
  const lastCheckedAt = ref('')
  const availableUpdate = ref<Update | null>(null)
  const lastCheckResult = ref<'idle' | 'checking' | 'available' | 'none' | 'failed'>('idle')
  const deferredVersion = ref('')
  const deferredAt = ref('')
  const lastAcceptedVersion = ref('')
  const downloadDownloadedBytes = ref(0)
  const downloadTotalBytes = ref(0)
  const installErrorVisible = ref(false)
  const installFailed = ref(false)
  const initialized = ref(false)

  const hasUpdate = computed(() => availableUpdate.value !== null)
  const isBusy = computed(() => ['checking', 'downloading', 'installing'].includes(status.value))
  const isInstallingUpdate = computed(() => ['downloading', 'installing'].includes(status.value))
  const isInstallOverlayVisible = computed(() => isInstallingUpdate.value || installErrorVisible.value)
  const downloadProgressPercent = computed(() => {
    if (downloadTotalBytes.value <= 0) return 0
    return Math.min(100, Math.round((downloadDownloadedBytes.value / downloadTotalBytes.value) * 100))
  })
  const hasDeferredUpdate = computed(() => Boolean(deferredVersion.value))
  const shouldShowDeferred = computed(() => Boolean(deferredVersion.value && deferredVersion.value !== lastAcceptedVersion.value))

  async function persistState() {
    const payload: UpdateStorePayload = {
      deferredVersion: deferredVersion.value || undefined,
      deferredAt: deferredAt.value || undefined,
      lastAcceptedVersion: lastAcceptedVersion.value || undefined,
    }
    if (!isTauriRuntime()) {
      localStorage.setItem('pymss-studio:update-state', JSON.stringify(payload))
      return
    }
    await saveAppStore('update-state', payload)
  }

  async function initialize() {
    if (initialized.value) return
    initialized.value = true
    let payload: UpdateStorePayload | null = null
    if (!isTauriRuntime()) {
      try {
        const raw = localStorage.getItem('pymss-studio:update-state')
        payload = raw ? JSON.parse(raw) as UpdateStorePayload : null
      } catch {
        payload = null
      }
    } else {
      payload = await loadAppStore<UpdateStorePayload>('update-state')
    }
    deferredVersion.value = String(payload?.deferredVersion || '')
    deferredAt.value = String(payload?.deferredAt || '')
    lastAcceptedVersion.value = String(payload?.lastAcceptedVersion || '')
  }

  function hasPendingDeferredVersion(version: string) {
    return Boolean(version && deferredVersion.value === version && version !== lastAcceptedVersion.value)
  }

  async function resolveDeferredVersion(version: string) {
    if (!version) return false
    if (deferredVersion.value === version) {
      deferredVersion.value = ''
      deferredAt.value = ''
      lastAcceptedVersion.value = version
      await persistState()
      return true
    }
    return false
  }

  function resetResult() {
    availableUpdate.value = null
    latestVersion.value = ''
    releaseNotes.value = ''
    releaseDate.value = ''
  }

  function resetDownloadProgress() {
    downloadDownloadedBytes.value = 0
    downloadTotalBytes.value = 0
  }

  async function checkForUpdates(manual = false) {
    const app = useAppStore()
    if (!app.buildInfoUpdateSupported && !app.buildInfoVariant.includes('online')) {
      resetResult()
      status.value = 'idle'
      lastCheckResult.value = 'none'
      error.value = ''
      currentVersion.value = app.buildInfoVersion || ''
      return null
    }
    status.value = 'checking'
    error.value = ''
    installFailed.value = false
    try {
      const update = await check()
      currentVersion.value = update?.currentVersion || app.buildInfoVersion || ''
      lastCheckedAt.value = new Date().toISOString()
      if (!update) {
        resetResult()
        status.value = shouldShowDeferred.value ? 'ready' : 'idle'
        lastCheckResult.value = 'none'
        return null
      }
      availableUpdate.value = update
      latestVersion.value = update.version
      releaseNotes.value = update.body || ''
      releaseDate.value = update.date || ''
      if (deferredVersion.value === update.version) {
        status.value = 'ready'
        lastCheckResult.value = 'available'
      } else {
        status.value = 'available'
        lastCheckResult.value = 'available'
      }
      return update
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      status.value = shouldShowDeferred.value ? 'ready' : 'failed'
      lastCheckResult.value = 'failed'
      if (!manual) return null
      throw err
    }
  }

  async function downloadAndInstall() {
    const update = availableUpdate.value
    if (!update) return false
    status.value = 'downloading'
    resetDownloadProgress()
    error.value = ''
    installErrorVisible.value = false
    installFailed.value = false
    try {
      await update.downloadAndInstall((event: UpdateDownloadEvent) => {
        if (event.event === 'Started') {
          const total = Number(event.data.contentLength || 0)
          downloadTotalBytes.value = Number.isFinite(total) && total > 0 ? total : 0
          downloadDownloadedBytes.value = 0
          return
        }
        if (event.event === 'Progress') {
          const chunk = Number(event.data.chunkLength || 0)
          if (Number.isFinite(chunk) && chunk > 0) {
            downloadDownloadedBytes.value += chunk
            if (downloadTotalBytes.value > 0) {
              downloadDownloadedBytes.value = Math.min(downloadDownloadedBytes.value, downloadTotalBytes.value)
            }
          }
          return
        }
        if (event.event === 'Finished') {
          if (downloadTotalBytes.value > 0) downloadDownloadedBytes.value = downloadTotalBytes.value
          status.value = 'installing'
        }
      })
      status.value = 'installing'
      lastAcceptedVersion.value = update.version
      deferredVersion.value = ''
      deferredAt.value = ''
      installErrorVisible.value = false
      installFailed.value = false
      await persistState()
      await relaunch()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      status.value = 'failed'
      installErrorVisible.value = true
      installFailed.value = true
      throw err
    }
  }

  function dismissInstallError() {
    installErrorVisible.value = false
  }

  async function deferUntilNextLaunch() {
    const update = availableUpdate.value
    if (!update) return false
    deferredVersion.value = update.version
    deferredAt.value = new Date().toISOString()
    status.value = 'ready'
    await persistState()
    return true
  }

  async function clearDeferredUpdate() {
    deferredVersion.value = ''
    deferredAt.value = ''
    await persistState()
  }

  watch(currentVersion, (version) => {
    if (!version) return
    if (version === deferredVersion.value) {
      deferredVersion.value = ''
      deferredAt.value = ''
      lastAcceptedVersion.value = version
      void persistState()
      return
    }
    if (version === lastAcceptedVersion.value) return
    if (!lastAcceptedVersion.value) {
      lastAcceptedVersion.value = version
      void persistState()
    }
  })

  function dismiss() {
    resetResult()
    status.value = 'idle'
  }

  return {
    status,
    currentVersion,
    latestVersion,
    releaseNotes,
    releaseDate,
    error,
    lastCheckedAt,
    downloadDownloadedBytes,
    downloadTotalBytes,
    downloadProgressPercent,
    installErrorVisible,
    installFailed,
    availableUpdate,
    lastCheckResult,
    deferredVersion,
    deferredAt,
    lastAcceptedVersion,
    hasDeferredUpdate,
    shouldShowDeferred,
    hasPendingDeferredVersion,
    resolveDeferredVersion,
    hasUpdate,
    isBusy,
    isInstallingUpdate,
    isInstallOverlayVisible,
    initialize,
    checkForUpdates,
    downloadAndInstall,
    dismissInstallError,
    deferUntilNextLaunch,
    clearDeferredUpdate,
    dismiss,
  }
})
