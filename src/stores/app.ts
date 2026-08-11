import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { createFreshRunner } from '@/utils/async'
import { isTauriRuntime } from '@/utils/appStore'

export type EnvInfo = {
  pythonVersion?: string
  platform?: string
  workerVersion?: string
  pymssAvailable?: boolean
  /** Whether the active runtime's pymss exposes the user-model registry (2.0.15+). */
  customModelsSupported?: boolean
  pymssPath?: string | null
  pymssVersion?: string | null
  pymssError?: string
  torchAvailable?: boolean
  torchVersion?: string | null
  torchError?: string
  torchBackend?: 'cpu' | 'cuda' | 'rocm' | string
  hipVersion?: string | null
  cudaAvailable?: boolean
  cudaDeviceCount?: number
  cudaDevices?: CudaDeviceInfo[]
  mpsAvailable?: boolean
  mlxAvailable?: boolean
  avAvailable?: boolean
  librosaAvailable?: boolean
}

export type RuntimeBackend = 'cpu' | 'cuda' | 'rocm' | 'mlx'
export type RuntimeInfo = {
  manifestVersion?: string
  pythonVersion?: string
  platform?: string
  machine?: string
  bootstrapPython?: string
  runtimeEnvsDir?: string
  activeRuntimeFile?: string
  bundledRuntimeEnvsDir?: string | null
  backend?: RuntimeBackend | null
  installedBackend?: RuntimeBackend | string | null
  installState?: {
    backend?: RuntimeBackend | string
    manifestVersion?: string
    installedAt?: string
    pythonVersion?: string
    torchVersion?: string | null
    torchBackend?: string | null
    pythonPath?: string
    logPath?: string
    source?: string
    packages?: Record<string, boolean>
  } | null
  installedEnvironments?: InstalledRuntime[]
  /** GPU vendors detected without torch ('nvidia' | 'amd' | 'intel'); empty when undetectable. */
  gpuVendors?: string[]
  statePath?: string
  logPath?: string
  torchVersion?: string | null
  torchBackend?: string
  acceleratorAvailable?: boolean
  packages?: Record<string, boolean>
  ready?: boolean
}

export type InstalledRuntime = {
  backend?: RuntimeBackend | string
  manifestVersion?: string
  installedAt?: string
  pythonVersion?: string
  torchVersion?: string | null
  torchBackend?: string | null
  acceleratorAvailable?: boolean
  pythonPath?: string
  logPath?: string
  packages?: Record<string, boolean>
  source?: 'managed' | 'bundled' | 'preinstalled'
}

export type CudaDeviceInfo = {
  id: number
  name: string
  totalMemoryBytes?: number
  major?: number
  minor?: number
}

export type DiagnosticLevel = 'ok' | 'warn' | 'error'
export type DiagnosticItem = {
  key: string
  level: DiagnosticLevel
  label: string
  value: string
  detail?: string
}

export const useAppStore = defineStore('app', () => {
  const envInfo = ref<EnvInfo | null>(null)
  const envLoading = ref(false)
  const envCheckedOnce = ref(false)
  const workerEvents = ref<any[]>([])
  const lastError = ref<string | null>(null)
  const runtimeInfo = ref<RuntimeInfo | null>(null)
  const runtimeInstallTaskId = ref<string | null>(null)
  const runtimeInstallStatus = ref<'idle' | 'installing' | 'success' | 'error' | 'cancelled'>('idle')
  const runtimeInstallBackend = ref<string | null>(null)
  const runtimeInstallMessage = ref('')
  const runtimeInstallLogs = ref<string[]>([])
  const runtimeEnvSizes = ref<Record<string, number>>({})
  const runtimeEnvSizesLoading = ref(false)
  // Backends whose venv exists but never finished installing — leftover disk usage the user
  // can reclaim.
  const runtimeIncompleteBackends = ref<string[]>([])
  const buildInfoVersion = ref('')
  const buildInfoVariant = ref('')
  const buildInfoUpdateSupported = ref(false)

  const diagnostics = computed<DiagnosticItem[]>(() => {
    const env = envInfo.value
    if (!env) return []
    return [
      {
        key: 'python',
        level: env.pythonVersion ? 'ok' : 'error',
        label: 'Python',
        value: env.pythonVersion || 'Not detected',
        detail: env.platform,
      },
      {
        key: 'pymss',
        level: env.pymssAvailable ? 'ok' : 'error',
        label: 'pymss',
        value: env.pymssAvailable ? 'Available' : 'Unavailable',
        detail: env.pymssPath || env.pymssError,
      },
      {
        key: 'torch',
        level: env.torchAvailable ? 'ok' : 'error',
        label: 'Torch',
        value: env.torchVersion || 'Unavailable',
        detail: env.torchError,
      },
      {
        key: 'accelerator',
        level: env.cudaAvailable || env.mpsAvailable || env.mlxAvailable ? 'ok' : 'warn',
        label: 'Accelerator',
        value: env.cudaAvailable
          ? `${env.torchBackend === 'rocm' ? 'ROCm' : 'CUDA'} (${env.cudaDeviceCount || 0})`
          : env.mlxAvailable
              ? 'MLX'
              : env.mpsAvailable
                ? 'MPS'
              : 'CPU only',
        detail: env.cudaAvailable || env.mpsAvailable || env.mlxAvailable
          ? undefined
          : 'No hardware accelerator detected. Separation still works, but can be slower.',
      },
      {
        key: 'av',
        level: env.avAvailable ? 'ok' : 'warn',
        label: 'PyAV',
        value: env.avAvailable ? 'Available' : 'Unavailable',
        detail: env.avAvailable ? undefined : 'Some audio formats may require extra codecs or PyAV.',
      },
    ]
  })

  const envReady = computed(() => {
    const env = envInfo.value
    return Boolean(env?.pythonVersion && env?.pymssAvailable && env?.torchAvailable)
  })

  const runtimeInstalledBackend = computed(() => {
    const info = runtimeInfo.value
    if (!info?.ready) return null
    const recorded = info.installedBackend || info.installState?.backend
    if (recorded === 'mlx' && info.packages?.mlx) return recorded
    if (recorded && recorded === info.torchBackend) return recorded
    if (info.packages?.mlx) return 'mlx'
    return info.torchBackend || null
  })

  const envIssueCount = computed(() => diagnostics.value.filter((item) => item.level !== 'ok').length)

  function runtimeReadyForBackend(backend: RuntimeBackend) {
    const info = runtimeInfo.value
    if (!info?.ready) return false
    if (backend === 'mlx') return Boolean(info.packages?.mlx)
    if (info.torchBackend !== backend) return false
    if (backend === 'cuda' || backend === 'rocm') return Boolean(info.acceleratorAvailable)
    return true
  }

  function recordWorkerEvent(event: any) {
    workerEvents.value.unshift(event)
    workerEvents.value = workerEvents.value.slice(0, 100)
  }

  function handleWorkerEvent(event: any) {
    if (event?.type === 'env_info') {
      envInfo.value = event.payload
      envLoading.value = false
      envCheckedOnce.value = true
    }
    if (event?.type === 'error') {
      lastError.value = event.payload?.message || 'Unknown error'
      if (event.payload?.logPath) {
        runtimeInfo.value = { ...(runtimeInfo.value || {}), logPath: event.payload.logPath }
      }
      if (event.payload?.backend && event.payload?.logPath && runtimeInstallBackend.value === event.payload.backend) {
        runtimeInstallMessage.value = event.payload.message || runtimeInstallMessage.value
      }
    }
    if (event?.type === 'error' && event?.payload?.code === 'ENV_CHECK_FAILED') {
      envLoading.value = false
      envCheckedOnce.value = true
    }
  }

  function clearWorkerEvents() {
    workerEvents.value = []
  }

  async function checkEnv() {
    envLoading.value = true
    lastError.value = null
    if (!isTauriRuntime()) {
      const result: EnvInfo = { platform: navigator.platform }
      envInfo.value = result
      envCheckedOnce.value = true
      envLoading.value = false
      return result
    }
    try {
      const result = await invoke<EnvInfo>('get_env_info')
      envInfo.value = result
      envCheckedOnce.value = true
      return result
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      envLoading.value = false
    }
  }

  async function checkEnvInBackground() {
    if (envLoading.value) return
    if (!isTauriRuntime()) {
      envCheckedOnce.value = true
      return
    }
    envLoading.value = true
    lastError.value = null
    try {
      await invoke('start_env_check')
    } catch (error) {
      envLoading.value = false
      lastError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  // Disk usage is a separate worker call: walking multi-GB venvs is too slow to fold into
  // runtime_info, which runs on startup and after every runtime operation.
  // Callers refresh right after an install or a delete, so a caller must never be handed the
  // result of a walk that started before the change it is refreshing for.
  const measureRuntimeEnvSizes = createFreshRunner(async () => {
    if (!isTauriRuntime()) {
      runtimeEnvSizes.value = {}
      runtimeIncompleteBackends.value = []
      return runtimeEnvSizes.value
    }
    const result = await invoke<{
      sizes?: Record<string, number>
      incompleteBackends?: string[]
    }>('runtime_env_sizes')
    runtimeEnvSizes.value = result?.sizes || {}
    runtimeIncompleteBackends.value = result?.incompleteBackends || []
    return runtimeEnvSizes.value
  })

  let runtimeEnvSizesWaiting = 0

  async function loadRuntimeEnvSizes() {
    runtimeEnvSizesWaiting += 1
    runtimeEnvSizesLoading.value = true
    try {
      return await measureRuntimeEnvSizes()
    } catch {
      // Sizes are supplementary — a failure must not break the settings page.
      return runtimeEnvSizes.value
    } finally {
      runtimeEnvSizesWaiting -= 1
      // Only the last caller clears the flag; queued callers are still measuring.
      if (runtimeEnvSizesWaiting === 0) runtimeEnvSizesLoading.value = false
    }
  }

  async function checkRuntimeInfo(backend?: RuntimeBackend) {
    if (!isTauriRuntime()) {
      runtimeInfo.value = { ready: false, backend: backend || null, platform: navigator.platform }
      return runtimeInfo.value
    }
    runtimeInfo.value = await invoke<RuntimeInfo>('runtime_info', { payload: backend ? { backend } : {} })
    return runtimeInfo.value
  }

  async function installRuntime(backend: RuntimeBackend, mirror = 'auto', locale = '') {
    const taskId = `runtime_install_${crypto.randomUUID()}`
    runtimeInstallTaskId.value = taskId
    runtimeInstallStatus.value = 'installing'
    runtimeInstallBackend.value = backend
    runtimeInstallMessage.value = ''
    runtimeInstallLogs.value = []
    try {
      await invoke('start_runtime_install', { payload: { taskId, backend, mirror, locale } })
    } catch (error) {
      runtimeInstallStatus.value = 'error'
      runtimeInstallMessage.value = error instanceof Error ? error.message : String(error)
      throw error
    }
    return taskId
  }

  async function activateRuntime(backend: RuntimeBackend) {
    await invoke('activate_runtime', { payload: { backend } })
    await Promise.all([checkRuntimeInfo(), checkEnv()])
  }

  async function cancelRuntimeInstall() {
    if (!runtimeInstallTaskId.value) return false
    return invoke<boolean>('cancel_runtime_install', { taskId: runtimeInstallTaskId.value })
  }

  async function waitForRuntimeInstall(timeoutMs = 30 * 60 * 1000) {
    const startedAt = Date.now()
    while (runtimeInstallStatus.value === 'installing') {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Runtime installation timed out')
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250))
    }
    if (runtimeInstallStatus.value !== 'success') {
      throw new Error(runtimeInstallMessage.value || 'Runtime installation failed')
    }
  }

  async function deleteRuntime(backend: RuntimeBackend) {
    await invoke('delete_runtime', { payload: { backend } })
    await checkRuntimeInfo()
  }

  function handleRuntimeEvent(event: any) {
    const taskId = event?.taskId
    if (!runtimeInstallTaskId.value || taskId !== runtimeInstallTaskId.value) return
    if (event?.type === 'runtime_install_finished') {
      runtimeInstallStatus.value = 'success'
      runtimeInstallMessage.value = ''
      if (event.payload?.state || event.payload?.logPath) {
        runtimeInfo.value = {
          ...(runtimeInfo.value || {}),
          installedBackend: event.payload?.state?.backend,
          installState: event.payload?.state,
          logPath: event.payload?.logPath,
        }
      }
      void checkEnv()
      void checkRuntimeInfo()
      void import('@/stores/model').then(({ useModelStore }) => useModelStore().loadModels())
    } else if (event?.type === 'runtime_install_started') {
      runtimeInstallStatus.value = 'installing'
      if (event.payload?.backend) runtimeInstallBackend.value = event.payload.backend
      runtimeInstallMessage.value = event.payload?.backend || ''
      if (event.payload?.logPath) runtimeInfo.value = { ...(runtimeInfo.value || {}), logPath: event.payload.logPath }
    } else if (event?.type === 'runtime_install_stage' || event?.type === 'runtime_install_log') {
      runtimeInstallMessage.value = event.payload?.message || event.payload?.stage || ''
      const line = event.payload?.message || event.payload?.stage
      if (line) runtimeInstallLogs.value = [...runtimeInstallLogs.value, String(line)].slice(-300)
    } else if (event?.type === 'runtime_install_failed' || event?.type === 'error') {
      runtimeInstallStatus.value = 'error'
      runtimeInstallMessage.value = event.payload?.message || 'Runtime installation failed'
    } else if (event?.type === 'task_cancelled') {
      runtimeInstallStatus.value = 'cancelled'
    }
  }

  return {
    envInfo,
    envLoading,
    envCheckedOnce,
    workerEvents,
    lastError,
    diagnostics,
    envReady,
    envIssueCount,
    runtimeInstalledBackend,
    runtimeReadyForBackend,
    recordWorkerEvent,
    handleWorkerEvent,
    clearWorkerEvents,
    checkEnv,
    checkEnvInBackground,
    runtimeInfo,
    runtimeInstallTaskId,
    runtimeInstallStatus,
    runtimeInstallBackend,
    runtimeInstallMessage,
    runtimeInstallLogs,
    runtimeEnvSizes,
    runtimeEnvSizesLoading,
    runtimeIncompleteBackends,
    buildInfoVersion,
    buildInfoVariant,
    buildInfoUpdateSupported,
    loadRuntimeEnvSizes,
    checkRuntimeInfo,
    installRuntime,
    activateRuntime,
    cancelRuntimeInstall,
    waitForRuntimeInstall,
    deleteRuntime,
    handleRuntimeEvent,
  }
})
