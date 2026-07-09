import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'

export type EnvInfo = {
  pythonVersion?: string
  platform?: string
  workerVersion?: string
  pymssAvailable?: boolean
  pymssPath?: string | null
  pymssVersion?: string | null
  pymssError?: string
  torchAvailable?: boolean
  torchVersion?: string | null
  torchError?: string
  cudaAvailable?: boolean
  cudaDeviceCount?: number
  cudaDevices?: CudaDeviceInfo[]
  mpsAvailable?: boolean
  mlxAvailable?: boolean
  avAvailable?: boolean
  librosaAvailable?: boolean
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
          ? `CUDA (${env.cudaDeviceCount || 0})`
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

  const envIssueCount = computed(() => diagnostics.value.filter((item) => item.level !== 'ok').length)

  function pushWorkerEvent(event: any) {
    workerEvents.value.unshift(event)
    workerEvents.value = workerEvents.value.slice(0, 100)
    if (event?.type === 'env_info') {
      envInfo.value = event.payload
      envLoading.value = false
      envCheckedOnce.value = true
    }
    if (event?.type === 'error') lastError.value = event.payload?.message || 'Unknown error'
    if (event?.type === 'error' && event?.payload?.code === 'ENV_CHECK_FAILED') {
      envLoading.value = false
      envCheckedOnce.value = true
    }
  }

  async function checkEnv() {
    envLoading.value = true
    lastError.value = null
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

  return {
    envInfo,
    envLoading,
    envCheckedOnce,
    workerEvents,
    lastError,
    diagnostics,
    envReady,
    envIssueCount,
    pushWorkerEvent,
    checkEnv,
    checkEnvInBackground,
  }
})
