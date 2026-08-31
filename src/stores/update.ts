import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { exit } from '@tauri-apps/plugin-process'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import { isTauriRuntime, loadAppStore, saveAppStore } from '@/utils/appStore'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'failed'

type UpdateStorePayload = {
  deferredVersion?: string
  deferredAt?: string
  lastAcceptedVersion?: string
}

type ManagedUpdate = {
  currentVersion: string
  version: string
  date?: string
  body?: string
  prerelease: boolean
  distribution: 'inno' | 'portable'
  autoUpdateSupported: boolean
  requiresManualInstall: boolean
  updateMessage?: string
  manualInstallUrl?: string
}

type UpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number | null } }
  | { event: 'Progress'; data: { chunkLength?: number } }
  | { event: 'Finished'; data?: null }

function isPrereleaseVersion(version: string) {
  return /^\d+\.\d+\.\d+-/.test(version.trim())
}

export const useUpdateStore = defineStore('update', () => {
  const status = ref<UpdateStatus>('idle')
  const currentVersion = ref('')
  const latestVersion = ref('')
  const releaseNotes = ref('')
  const releaseDate = ref('')
  const updateMessage = ref('')
  const manualInstallUrl = ref('')
  const error = ref('')
  const lastCheckedAt = ref('')
  const availableUpdate = ref<ManagedUpdate | null>(null)
  const lastCheckResult = ref<'idle' | 'checking' | 'available' | 'none' | 'failed'>('idle')
  const deferredVersion = ref('')
  const deferredAt = ref('')
  const lastAcceptedVersion = ref('')
  const downloadDownloadedBytes = ref(0)
  const downloadTotalBytes = ref(0)
  const installErrorVisible = ref(false)
  const installFailed = ref(false)
  const initialized = ref(false)
  const autoCheckCompleted = ref(false)
  let updateCheckInFlight: Promise<ManagedUpdate | null> | null = null
  let initializeInFlight: Promise<void> | null = null
  let unlistenProgress: UnlistenFn | undefined

  const hasUpdate = computed(() => availableUpdate.value !== null)
  const isBusy = computed(() => ['checking', 'downloading', 'installing'].includes(status.value))
  const isInstallingUpdate = computed(() => ['downloading', 'installing'].includes(status.value))
  const isInstallOverlayVisible = computed(() => isInstallingUpdate.value || installErrorVisible.value)
  const downloadProgressPercent = computed(() => {
    if (downloadTotalBytes.value <= 0) return 0
    return Math.min(100, Math.round((downloadDownloadedBytes.value / downloadTotalBytes.value) * 100))
  })
  const hasDeferredUpdate = computed(() => Boolean(deferredVersion.value))
  const updateIsPrerelease = computed(() => {
    return availableUpdate.value?.prerelease === true || isPrereleaseVersion(availableUpdate.value?.version || latestVersion.value)
  })
  const requiresManualInstall = computed(() => Boolean(
    availableUpdate.value
    && (availableUpdate.value.autoUpdateSupported === false || availableUpdate.value.requiresManualInstall === true),
  ))
  const shouldShowDeferred = computed(() => Boolean(
    availableUpdate.value
    && deferredVersion.value
    && deferredVersion.value === availableUpdate.value.version
    && deferredVersion.value !== lastAcceptedVersion.value,
  ))

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
    if (!initializeInFlight) {
      initializeInFlight = (async () => {
        autoCheckCompleted.value = false
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
        if (isTauriRuntime()) {
          const nextUnlisten = await listen<UpdateDownloadEvent>('pymss://managed-update-event', (event) => {
            if (event.payload.event === 'Started') {
              const total = Number(event.payload.data.contentLength || 0)
              downloadTotalBytes.value = Number.isFinite(total) && total > 0 ? total : 0
              downloadDownloadedBytes.value = 0
              return
            }
            if (event.payload.event === 'Progress') {
              const chunk = Number(event.payload.data.chunkLength || 0)
              if (Number.isFinite(chunk) && chunk > 0) downloadDownloadedBytes.value += chunk
              return
            }
            if (event.payload.event === 'Finished') {
              if (downloadTotalBytes.value > 0) downloadDownloadedBytes.value = downloadTotalBytes.value
              status.value = 'installing'
            }
          })
          unlistenProgress?.()
          unlistenProgress = nextUnlisten
        }
        initialized.value = true
      })().finally(() => {
        initializeInFlight = null
      })
    }
    return initializeInFlight
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
    updateMessage.value = ''
    manualInstallUrl.value = ''
  }

  function resetDownloadProgress() {
    downloadDownloadedBytes.value = 0
    downloadTotalBytes.value = 0
  }

  async function checkForUpdates(manual = false) {
    const app = useAppStore()
    const settings = useSettingsStore()
    if (!manual && autoCheckCompleted.value) return availableUpdate.value
    if (!updateCheckInFlight) {
      updateCheckInFlight = (async () => {
        try {
          if (!app.buildInfoUpdateSupported) {
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
          const endpointOverride = settings.developerMode ? settings.updateEndpointOverride.trim() : ''
          const update = await invoke<ManagedUpdate | null>('check_managed_update', {
            channel: settings.updateChannel,
            endpointOverride: endpointOverride || null,
          })
          currentVersion.value = update?.currentVersion || app.buildInfoVersion || ''
          lastCheckedAt.value = new Date().toISOString()
          if (!update) {
            resetResult()
            status.value = 'idle'
            lastCheckResult.value = 'none'
            return null
          }
          availableUpdate.value = update
          latestVersion.value = update.version
          releaseNotes.value = update.body || ''
          releaseDate.value = update.date || ''
          updateMessage.value = update.updateMessage || ''
          manualInstallUrl.value = update.manualInstallUrl || ''
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
          status.value = 'failed'
          lastCheckResult.value = 'failed'
          throw err
        } finally {
          updateCheckInFlight = null
        }
      })()
    }
    if (manual) return updateCheckInFlight
    return updateCheckInFlight.catch(() => null).finally(() => {
      autoCheckCompleted.value = true
    })
  }

  async function downloadAndInstall() {
    const update = availableUpdate.value
    if (!update) throw new Error('Update package is not available. Check for updates again.')
    if (!update.autoUpdateSupported || update.requiresManualInstall) {
      throw new Error(update.updateMessage || 'This update requires manual installation from GitHub.')
    }
    status.value = 'downloading'
    resetDownloadProgress()
    error.value = ''
    installErrorVisible.value = false
    installFailed.value = false
    try {
      const settings = useSettingsStore()
      const endpointOverride = settings.developerMode ? settings.updateEndpointOverride.trim() : ''
      await invoke('start_managed_update', {
        channel: settings.updateChannel,
        endpointOverride: endpointOverride || null,
        expectedVersion: update.version,
      })
      status.value = 'installing'
      lastAcceptedVersion.value = update.version
      deferredVersion.value = ''
      deferredAt.value = ''
      installErrorVisible.value = false
      installFailed.value = false
      await persistState()
      await exit(0)
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
    updateMessage,
    manualInstallUrl,
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
    updateIsPrerelease,
    requiresManualInstall,
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
