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
  const initialized = ref(false)

  const hasUpdate = computed(() => availableUpdate.value !== null)
  const isBusy = computed(() => ['checking', 'downloading', 'installing'].includes(status.value))
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

  async function checkForUpdates(manual = false) {
    const app = useAppStore()
    const variant = app.buildInfoVariant || ''
    if (!variant.includes('online')) {
      resetResult()
      status.value = 'idle'
      lastCheckResult.value = 'none'
      error.value = ''
      currentVersion.value = app.buildInfoVersion || ''
      return null
    }
    status.value = 'checking'
    error.value = ''
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
    try {
      await update.downloadAndInstall()
      status.value = 'installing'
      lastAcceptedVersion.value = update.version
      deferredVersion.value = ''
      deferredAt.value = ''
      await persistState()
      await relaunch()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      status.value = 'failed'
      throw err
    }
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
    initialize,
    checkForUpdates,
    downloadAndInstall,
    deferUntilNextLaunch,
    clearDeferredUpdate,
    dismiss,
  }
})
