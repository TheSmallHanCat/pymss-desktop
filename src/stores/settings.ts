import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import {
  applyTheme,
  DEFAULT_THEME_ACCENT,
  DEFAULT_THEME_MODE,
  normalizeThemeAccent,
  type ThemeAccent,
  type ThemeMode,
} from '@/utils/theme'
import {
  applyScaleFactor,
  DEFAULT_SCALE_FACTOR,
  normalizeScaleFactor,
  SCALE_FACTOR_MAX,
  SCALE_FACTOR_MIN,
  SCALE_FACTOR_STEP,
} from '@/utils/appZoom'
import { normalizeLocaleSetting, setLocale, type LocaleSetting } from '@/i18n'
import { loadAppStore, saveAppStore } from '@/utils/appStore'
import type { EnvInfo } from '@/stores/app'

type AppPathsPayload = {
  dataRoot: string
  portableDataRoot: string
  dataRootIsPortable: boolean
  canMigrateDataRootToPortable: boolean
  settingsDir: string
  modelsDir: string
  outputsDir: string
  editorProjectsDir: string
  logsDir: string
  tempDir: string
}

type DataRootMigrationPayload = {
  previousDataRoot: string
  targetDataRoot: string
  fileCount: number
  totalBytes: number
  cleanupFailedPaths: string[]
  paths: AppPathsPayload
}

export type ModelDirMigrationConflict = {
  sourcePath: string
  relativePath: string
  destinationPath: string
  existingSizeBytes: number
  incomingSizeBytes: number
}

export type PrepareModelDirChangePayload = {
  currentModelDir: string
  targetModelDir: string
  sameAsCurrent: boolean
  sourceDirExists: boolean
  targetDirExists: boolean
  targetDirEmpty: boolean
  fileCount: number
  totalBytes: number
  conflictCount: number
  diskAvailableBytes: number | null
  diskInsufficient: boolean
}

export type ModelDirMigrationResolution = 'overwrite' | 'skip' | 'abort'
export type ModelDirMigrationStatus = 'idle' | 'confirm' | 'running' | 'conflict' | 'ready_to_switch' | 'finalizing_cleanup' | 'success' | 'failed' | 'aborted'
export type ModelDirMigrationState = {
  status: ModelDirMigrationStatus
  taskId: string
  sourceModelDir: string
  targetModelDir: string
  previousModelDir: string
  totalFiles: number
  completedFiles: number
  totalBytes: number
  copiedBytes: number
  currentPath: string
  message: string
  skippedFiles: string[]
  overwrittenFiles: string[]
  cleanupFailedFiles: string[]
  conflict: ModelDirMigrationConflict | null
  error: string
  preparation: PrepareModelDirChangePayload | null
  resolvingConflict: boolean
}

type StoredSettings = {
  themeMode?: ThemeMode
  themeAccent?: ThemeAccent
  scaleFactor?: number
  locale?: LocaleSetting
  animationsEnabled?: boolean
  developerMode?: boolean
  modelDir?: string
  outputDir?: string
  defaultDevice?: string
  defaultFormat?: string
  downloadSource?: string
  maxConcurrentSeparations?: number
  wavBitDepth?: string
  flacBitDepth?: string
  mp3BitRate?: string
  m4aBitRate?: string
  m4aCodec?: string
  startupOnboardingSeen?: boolean
  startupOnboardingSeenVersion?: string
}

const DEFAULT_LOCALE: LocaleSetting = 'system'
const DEFAULT_DOWNLOAD_SOURCE = 'modelscope'
const DEFAULT_DEFAULT_DEVICE = 'auto'
const DEFAULT_DEFAULT_FORMAT = 'wav'
const DEFAULT_CONCURRENT_SEPARATIONS = 1
const MAX_CONCURRENT_SEPARATIONS = 16

function displayModelDirPath(path: unknown): string {
  const value = String(path || '').trim()
  if (!value) return ''
  return value
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/, '')
    .replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '')
}

function normalizePathForCompare(path: string): string {
  return displayModelDirPath(path).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

function isPathUnderRoot(path: string, root: string): boolean {
  const normalizedPath = normalizePathForCompare(path)
  const normalizedRoot = normalizePathForCompare(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`)
}

function normalizePrepareModelDirChangePayload(payload: PrepareModelDirChangePayload): PrepareModelDirChangePayload {
  return {
    ...payload,
    currentModelDir: displayModelDirPath(payload.currentModelDir),
    targetModelDir: displayModelDirPath(payload.targetModelDir),
  }
}

const DEFAULT_WAV_BIT_DEPTH = 'FLOAT'
const DEFAULT_FLAC_BIT_DEPTH = 'PCM_24'
const DEFAULT_MP3_BIT_RATE = '320k'
const DEFAULT_M4A_BIT_RATE = '512k'
const DEFAULT_M4A_CODEC = 'aac'

function normalizeM4aCodec(value: unknown): string {
  return String(value || '').trim().toLowerCase() === 'aac' ? 'aac' : DEFAULT_M4A_CODEC
}

function createEmptyModelDirMigrationState(): ModelDirMigrationState {
  return {
    status: 'idle',
    taskId: '',
    sourceModelDir: '',
    targetModelDir: '',
    previousModelDir: '',
    totalFiles: 0,
    completedFiles: 0,
    totalBytes: 0,
    copiedBytes: 0,
    currentPath: '',
    message: '',
    skippedFiles: [],
    overwrittenFiles: [],
    cleanupFailedFiles: [],
    conflict: null,
    error: '',
    preparation: null,
    resolvingConflict: false,
  }
}

export type AudioParams = {
  wavBitDepth: string
  flacBitDepth: string
  mp3BitRate: string
  m4aBitRate: string
  m4aCodec: string
}

export type RuntimeDeviceConfig = {
  device: 'auto' | 'cpu' | 'cuda' | 'mps' | 'mlx'
  deviceIds: number[]
}

export type DeviceOption = {
  label: string
  value: string
  type: RuntimeDeviceConfig['device']
  deviceIds?: number[]
}

export const useSettingsStore = defineStore('settings', () => {
  const initialized = ref(false)
  const appPaths = ref<AppPathsPayload | null>(null)
  const themeMode = ref<ThemeMode>(DEFAULT_THEME_MODE)
  const themeAccent = ref<ThemeAccent>(DEFAULT_THEME_ACCENT)
  const scaleFactor = ref(DEFAULT_SCALE_FACTOR)
  const locale = ref<LocaleSetting>(DEFAULT_LOCALE)
  const animationsEnabled = ref(true)
  const developerMode = ref(false)
  const modelDir = ref('')
  const outputDir = ref('')
  const defaultDevice = ref(DEFAULT_DEFAULT_DEVICE)
  const defaultFormat = ref(DEFAULT_DEFAULT_FORMAT)
  const downloadSource = ref(DEFAULT_DOWNLOAD_SOURCE)
  const maxConcurrentSeparations = ref(DEFAULT_CONCURRENT_SEPARATIONS)
  const wavBitDepth = ref(DEFAULT_WAV_BIT_DEPTH)
  const flacBitDepth = ref(DEFAULT_FLAC_BIT_DEPTH)
  const mp3BitRate = ref(DEFAULT_MP3_BIT_RATE)
  const m4aBitRate = ref(DEFAULT_M4A_BIT_RATE)
  const m4aCodec = ref(DEFAULT_M4A_CODEC)
  const startupOnboardingSeen = ref(false)
  const modelDirMigrationState = ref<ModelDirMigrationState>(createEmptyModelDirMigrationState())

  const dataRoot = computed(() => appPaths.value?.dataRoot || '')
  const settingsDir = computed(() => appPaths.value?.settingsDir || '')
  const editorProjectsDir = computed(() => appPaths.value?.editorProjectsDir || '')
  const logsDir = computed(() => appPaths.value?.logsDir || '')
  const tempDir = computed(() => appPaths.value?.tempDir || '')
  const isModelDirMigrating = computed(() => ['running', 'conflict', 'ready_to_switch', 'finalizing_cleanup'].includes(modelDirMigrationState.value.status))
  const shouldShowStartupOnboarding = computed(() => initialized.value && !startupOnboardingSeen.value)

  const persistable = computed<StoredSettings>(() => ({
    themeMode: themeMode.value,
    themeAccent: themeAccent.value,
    scaleFactor: scaleFactor.value,
    locale: locale.value,
    animationsEnabled: animationsEnabled.value,
    developerMode: developerMode.value,
    modelDir: modelDir.value,
    outputDir: outputDir.value,
    defaultDevice: defaultDevice.value,
    defaultFormat: defaultFormat.value,
    downloadSource: downloadSource.value,
    maxConcurrentSeparations: maxConcurrentSeparations.value,
    wavBitDepth: wavBitDepth.value,
    flacBitDepth: flacBitDepth.value,
    mp3BitRate: mp3BitRate.value,
    m4aBitRate: m4aBitRate.value,
    m4aCodec: m4aCodec.value,
    startupOnboardingSeen: startupOnboardingSeen.value,
  }))

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let scaleApplyTimer: ReturnType<typeof setTimeout> | null = null

  // 防抖应用缩放：滑块位于它自身控制的 WebView 内，立即 setZoom 会在交互过程中
  // 改变滑块几何，导致指针位置重新映射、数值连跳两格。延迟到交互稳定后再缩放即可避免。
  function queueApplyScaleFactor(value: number) {
    if (scaleApplyTimer) clearTimeout(scaleApplyTimer)
    scaleApplyTimer = setTimeout(() => {
      scaleApplyTimer = null
      void applyScaleFactor(value).catch((error) => console.warn('Failed to apply scale factor', error))
    }, 140)
  }

  function queuePersist() {
    if (!initialized.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveAppStore('app-settings', persistable.value)
    }, 80)
  }

  async function initialize() {
    if (initialized.value) return
    const [paths, stored] = await Promise.all([
      invoke<AppPathsPayload>('get_app_paths'),
      loadAppStore<StoredSettings>('app-settings'),
    ])

    appPaths.value = paths
    themeMode.value = stored?.themeMode || DEFAULT_THEME_MODE
    themeAccent.value = normalizeThemeAccent(stored?.themeAccent, DEFAULT_THEME_ACCENT)
    scaleFactor.value = normalizeScaleFactor(stored?.scaleFactor)
    locale.value = normalizeLocaleSetting(stored?.locale, DEFAULT_LOCALE)
    animationsEnabled.value = stored?.animationsEnabled ?? true
    developerMode.value = stored?.developerMode === true
    modelDir.value = (stored?.modelDir || paths.modelsDir).trim() || paths.modelsDir
    outputDir.value = (stored?.outputDir || paths.outputsDir).trim() || paths.outputsDir
    defaultDevice.value = stored?.defaultDevice || DEFAULT_DEFAULT_DEVICE
    defaultFormat.value = stored?.defaultFormat || DEFAULT_DEFAULT_FORMAT
    downloadSource.value = stored?.downloadSource || DEFAULT_DOWNLOAD_SOURCE
    maxConcurrentSeparations.value = Number.isFinite(Number(stored?.maxConcurrentSeparations))
      ? Math.min(MAX_CONCURRENT_SEPARATIONS, Math.max(1, Math.trunc(Number(stored?.maxConcurrentSeparations))))
      : DEFAULT_CONCURRENT_SEPARATIONS
    wavBitDepth.value = stored?.wavBitDepth || DEFAULT_WAV_BIT_DEPTH
    flacBitDepth.value = stored?.flacBitDepth || DEFAULT_FLAC_BIT_DEPTH
    mp3BitRate.value = stored?.mp3BitRate || DEFAULT_MP3_BIT_RATE
    m4aBitRate.value = stored?.m4aBitRate || DEFAULT_M4A_BIT_RATE
    m4aCodec.value = normalizeM4aCodec(stored?.m4aCodec)
    startupOnboardingSeen.value = stored?.startupOnboardingSeen === true
      || String(stored?.startupOnboardingSeenVersion || '').trim().length > 0
    const shouldPersistNormalizedOnboarding =
      !stored
      || typeof stored.startupOnboardingSeen !== 'boolean'
      || String(stored.startupOnboardingSeenVersion || '').trim().length > 0

    applyTheme(themeMode.value, themeAccent.value)
    await applyScaleFactor(scaleFactor.value).catch((error) => console.warn('Failed to apply scale factor', error))
    setLocale(locale.value)
    initialized.value = true
    if (shouldPersistNormalizedOnboarding) queuePersist()
  }

  watch(themeMode, (value) => {
    applyTheme(value, themeAccent.value)
    queuePersist()
  })
  watch(themeAccent, (value) => {
    applyTheme(themeMode.value, value)
    queuePersist()
  })
  watch(scaleFactor, (value) => {
    const normalized = normalizeScaleFactor(value)
    if (normalized !== value) scaleFactor.value = normalized
    queueApplyScaleFactor(normalized)
    queuePersist()
  })
  watch(locale, (value) => {
    setLocale(value)
    queuePersist()
  })
  watch(animationsEnabled, () => {
    queuePersist()
  })
  watch(
    [
      modelDir,
      outputDir,
      defaultDevice,
      defaultFormat,
      downloadSource,
      maxConcurrentSeparations,
      wavBitDepth,
      flacBitDepth,
      mp3BitRate,
      m4aBitRate,
      m4aCodec,
      developerMode,
    ],
    () => queuePersist(),
    { deep: true },
  )

  function deviceOptions(env?: EnvInfo | null): DeviceOption[] {
    const options: DeviceOption[] = [
      { label: 'Auto (优先使用可用显卡)', value: 'auto', type: 'auto' },
      { label: 'CPU', value: 'cpu', type: 'cpu', deviceIds: [0] },
    ]
    for (const gpu of env?.cudaDevices || []) {
      const memory = gpu.totalMemoryBytes
        ? ` · ${(gpu.totalMemoryBytes / 1024 / 1024 / 1024).toFixed(1)} GB`
        : ''
      options.push({
        label: `CUDA ${gpu.id}: ${gpu.name}${memory}`,
        value: `cuda:${gpu.id}`,
        type: 'cuda',
        deviceIds: [gpu.id],
      })
    }
    if (env?.cudaAvailable && !(env.cudaDevices || []).length) {
      const count = Math.max(1, env.cudaDeviceCount || 1)
      for (let id = 0; id < count; id += 1) {
        options.push({ label: `CUDA ${id}`, value: `cuda:${id}`, type: 'cuda', deviceIds: [id] })
      }
    }
    if (env?.mlxAvailable || env?.mpsAvailable) options.push({ label: 'Apple MLX', value: 'mlx', type: 'mlx', deviceIds: [0] })
    if (env?.mpsAvailable) options.push({ label: 'Apple MPS', value: 'mps', type: 'mps', deviceIds: [0] })
    return options
  }

  function getRuntimeDeviceConfig(env?: EnvInfo | null): RuntimeDeviceConfig {
    const selected = defaultDevice.value
    if (selected.startsWith('cuda:')) {
      const id = parseInt(selected.slice('cuda:'.length), 10)
      return { device: 'cuda', deviceIds: Number.isFinite(id) ? [id] : [0] }
    }
    if (selected === 'cuda') return { device: 'cuda', deviceIds: [0] }
    if (selected === 'auto' && env?.mlxAvailable) {
      return { device: 'mlx', deviceIds: [0] }
    }
    if (selected === 'cpu' || selected === 'mps' || selected === 'mlx' || selected === 'auto') {
      return { device: selected, deviceIds: [0] }
    }
    return { device: 'auto', deviceIds: [0] }
  }

  function getAudioParams(): Record<string, string | number> {
    return {
      wav_bit_depth: wavBitDepth.value,
      flac_bit_depth: flacBitDepth.value,
      mp3_bit_rate: mp3BitRate.value,
      m4a_bit_rate: m4aBitRate.value,
      m4a_codec: m4aCodec.value,
    }
  }

  async function pickModelDir() {
    return invoke<string | null>('pick_output_folder')
  }

  async function pickOutputDir() {
    const folder = await invoke<string | null>('pick_output_folder')
    if (folder) outputDir.value = folder
  }

  function refreshPathsAfterDataRootMigration(payload: DataRootMigrationPayload) {
    const previousRoot = displayModelDirPath(payload.previousDataRoot)
    const nextPaths = payload.paths
    const shouldMoveModelDir = Boolean(modelDir.value) && isPathUnderRoot(modelDir.value, previousRoot)
    const shouldMoveOutputDir = Boolean(outputDir.value) && isPathUnderRoot(outputDir.value, previousRoot)
    appPaths.value = nextPaths
    if (shouldMoveModelDir) modelDir.value = nextPaths.modelsDir
    if (shouldMoveOutputDir) outputDir.value = nextPaths.outputsDir
  }

  async function migrateDataRootToPortable() {
    const payload = await invoke<DataRootMigrationPayload>('migrate_data_root_to_portable')
    if (!payload.cleanupFailedPaths?.length) {
      refreshPathsAfterDataRootMigration(payload)
      await refreshModelDataAfterDirChange().catch(() => {})
      queuePersist()
    }
    return payload
  }

  async function pickFolder() {
    return invoke<string | null>('pick_output_folder')
  }

  async function refreshModelDataAfterDirChange() {
    const { useModelStore } = await import('@/stores/model')
    const modelStore = useModelStore()
    await modelStore.loadModels()
    await modelStore.loadModelStorageSummary({ force: true })
    const selectedModelName = modelStore.selectedModel
    if (selectedModelName) {
      const nextSelected = modelStore.models.find((item) => item.name === selectedModelName) || null
      modelStore.selectedInfo = nextSelected
      if (nextSelected) {
        await modelStore.selectModel(selectedModelName).catch(() => {})
      }
    } else {
      modelStore.selectedInfo = null
    }
  }

  async function applyModelDirWithoutMigration(targetModelDir: string) {
    const previousModelDir = modelDir.value
    modelDir.value = displayModelDirPath(targetModelDir)
    try {
      await refreshModelDataAfterDirChange()
      return { targetModelDir }
    } catch (error) {
      modelDir.value = previousModelDir
      await refreshModelDataAfterDirChange().catch(() => {})
      throw error
    }
  }

  async function prepareModelDirChange(targetDir: string) {
    const payload = normalizePrepareModelDirChangePayload(await invoke<PrepareModelDirChangePayload>('prepare_model_dir_change', {
      payload: {
        currentModelDir: modelDir.value,
        targetModelDir: targetDir,
      },
    }))

    if (payload.sameAsCurrent) {
      return { outcome: 'noop' as const, payload }
    }

    if (payload.fileCount <= 0) {
      await applyModelDirWithoutMigration(payload.targetModelDir)
      return { outcome: 'switched' as const, payload }
    }

    modelDirMigrationState.value = {
      ...createEmptyModelDirMigrationState(),
      status: 'confirm',
      sourceModelDir: payload.currentModelDir,
      targetModelDir: payload.targetModelDir,
      previousModelDir: modelDir.value,
      totalFiles: payload.fileCount,
      totalBytes: payload.totalBytes,
      preparation: payload,
      message: '',
    }
    return { outcome: 'confirm' as const, payload }
  }

  function cancelModelDirChangeConfirmation() {
    modelDirMigrationState.value = createEmptyModelDirMigrationState()
  }

  async function confirmModelDirMigration() {
    const preparation = modelDirMigrationState.value.preparation
    if (!preparation) {
      throw new Error('No model directory migration is pending confirmation')
    }
    const taskId = `model_dir_migration_${Date.now()}`
    modelDirMigrationState.value = {
      ...modelDirMigrationState.value,
      status: 'running',
      taskId,
      sourceModelDir: preparation.currentModelDir,
      targetModelDir: preparation.targetModelDir,
      previousModelDir: modelDir.value,
      totalFiles: preparation.fileCount,
      totalBytes: preparation.totalBytes,
      conflict: null,
      error: '',
      message: '正在复制模型目录',
      resolvingConflict: false,
    }
    try {
      await invoke('start_model_dir_migration', {
        payload: {
          taskId,
          currentModelDir: preparation.currentModelDir,
          targetModelDir: preparation.targetModelDir,
        },
      })
    } catch (error) {
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'confirm',
        taskId: '',
        message: '',
      }
      throw error
    }
  }

  async function resolveModelDirConflict(resolution: ModelDirMigrationResolution) {
    const taskId = modelDirMigrationState.value.taskId
    if (!taskId) {
      throw new Error('No model directory migration is waiting for conflict resolution')
    }
    modelDirMigrationState.value = {
      ...modelDirMigrationState.value,
      resolvingConflict: true,
    }
    try {
      await invoke('respond_model_dir_migration_conflict', {
        payload: {
          taskId,
          resolution,
        },
      })
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'running',
        conflict: null,
        resolvingConflict: false,
        message: resolution === 'overwrite'
          ? '已选择覆盖同名文件，正在继续复制'
          : resolution === 'skip'
            ? '已选择跳过同名文件，正在继续复制'
            : '正在终止模型目录迁移',
      }
    } catch (error) {
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        resolvingConflict: false,
      }
      throw error
    }
  }

  async function finalizeModelDirSwitch(taskId: string, payload: any) {
    const previousModelDir = modelDirMigrationState.value.previousModelDir || modelDir.value
    const targetModelDir = displayModelDirPath(payload.targetModelDir || modelDirMigrationState.value.targetModelDir || '')
    modelDirMigrationState.value = {
      ...modelDirMigrationState.value,
      status: 'finalizing_cleanup',
      message: payload.message || '',
      currentPath: '',
      conflict: null,
      resolvingConflict: false,
      error: '',
    }
    modelDir.value = targetModelDir
    try {
      await refreshModelDataAfterDirChange()
      await invoke('confirm_model_dir_migration_switch', {
        payload: { taskId },
      })
    } catch (error) {
      await invoke('cancel_model_dir_migration', {
        payload: { taskId },
      }).catch(() => {})
      modelDir.value = previousModelDir
      await refreshModelDataAfterDirChange().catch(() => {})
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
        currentPath: '',
        resolvingConflict: false,
        conflict: null,
      }
    }
  }

  async function handleWorkerEvent(event: any) {
    const type = event?.type as string | undefined
    if (!type?.startsWith('model_dir_migration_')) return
    const payload = event?.payload || {}
    const taskId = String(event?.taskId || '')
    if (modelDirMigrationState.value.taskId && taskId && modelDirMigrationState.value.taskId !== taskId) return

    if (type === 'model_dir_migration_started') {
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'running',
        taskId,
        sourceModelDir: displayModelDirPath(payload.sourceModelDir || modelDirMigrationState.value.sourceModelDir),
        targetModelDir: displayModelDirPath(payload.targetModelDir || modelDirMigrationState.value.targetModelDir),
        totalFiles: Number(payload.totalFiles || modelDirMigrationState.value.totalFiles || 0),
        completedFiles: Number(payload.completedFiles || 0),
        totalBytes: Number(payload.totalBytes || modelDirMigrationState.value.totalBytes || 0),
        copiedBytes: Number(payload.copiedBytes || 0),
        currentPath: displayModelDirPath(payload.currentPath || ''),
        message: payload.message || '',
        conflict: null,
        error: '',
        resolvingConflict: false,
      }
      return
    }

    if (type === 'model_dir_migration_progress') {
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'running',
        taskId,
        completedFiles: Number(payload.completedFiles || 0),
        totalFiles: Number(payload.totalFiles || modelDirMigrationState.value.totalFiles || 0),
        totalBytes: Number(payload.totalBytes || modelDirMigrationState.value.totalBytes || 0),
        copiedBytes: Number(payload.copiedBytes || 0),
        currentPath: displayModelDirPath(payload.currentPath || ''),
        message: payload.message || '',
        skippedFiles: Array.isArray(payload.skippedFiles) ? payload.skippedFiles : modelDirMigrationState.value.skippedFiles,
        overwrittenFiles: Array.isArray(payload.overwrittenFiles) ? payload.overwrittenFiles : modelDirMigrationState.value.overwrittenFiles,
        conflict: null,
        resolvingConflict: false,
      }
      return
    }

    if (type === 'model_dir_migration_conflict') {
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'conflict',
        taskId,
        completedFiles: Number(payload.completedFiles || modelDirMigrationState.value.completedFiles || 0),
        totalFiles: Number(payload.totalFiles || modelDirMigrationState.value.totalFiles || 0),
        totalBytes: Number(payload.totalBytes || modelDirMigrationState.value.totalBytes || 0),
        copiedBytes: Number(payload.copiedBytes || modelDirMigrationState.value.copiedBytes || 0),
        currentPath: displayModelDirPath(payload.currentPath || ''),
        message: payload.message || '',
        conflict: payload.conflict ? { ...payload.conflict, sourcePath: displayModelDirPath(payload.conflict.sourcePath), destinationPath: displayModelDirPath(payload.conflict.destinationPath) } : null,
        resolvingConflict: false,
      }
      return
    }

    if (type === 'model_dir_migration_ready_to_switch') {
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'ready_to_switch',
        taskId,
        completedFiles: Number(payload.completedFiles || modelDirMigrationState.value.totalFiles || 0),
        totalFiles: Number(payload.totalFiles || modelDirMigrationState.value.totalFiles || 0),
        totalBytes: Number(payload.totalBytes || modelDirMigrationState.value.totalBytes || 0),
        copiedBytes: Number(payload.copiedBytes || modelDirMigrationState.value.totalBytes || 0),
        currentPath: '',
        message: payload.message || '',
        skippedFiles: Array.isArray(payload.skippedFiles) ? payload.skippedFiles : modelDirMigrationState.value.skippedFiles,
        overwrittenFiles: Array.isArray(payload.overwrittenFiles) ? payload.overwrittenFiles : modelDirMigrationState.value.overwrittenFiles,
        conflict: null,
        resolvingConflict: false,
      }
      await finalizeModelDirSwitch(taskId, payload)
      return
    }

    if (type === 'model_dir_migration_done') {
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'success',
        taskId,
        sourceModelDir: displayModelDirPath(payload.sourceModelDir || modelDirMigrationState.value.sourceModelDir),
        targetModelDir: displayModelDirPath(payload.targetModelDir || modelDirMigrationState.value.targetModelDir),
        completedFiles: Number(payload.completedFiles || modelDirMigrationState.value.completedFiles || 0),
        totalFiles: Number(payload.totalFiles || modelDirMigrationState.value.totalFiles || 0),
        totalBytes: Number(payload.totalBytes || modelDirMigrationState.value.totalBytes || 0),
        copiedBytes: Number(payload.copiedBytes || modelDirMigrationState.value.copiedBytes || 0),
        currentPath: '',
        message: payload.message || '',
        skippedFiles: Array.isArray(payload.skippedFiles) ? payload.skippedFiles : [],
        overwrittenFiles: Array.isArray(payload.overwrittenFiles) ? payload.overwrittenFiles : [],
        cleanupFailedFiles: Array.isArray(payload.cleanupFailedFiles) ? payload.cleanupFailedFiles : [],
        conflict: null,
        error: '',
        resolvingConflict: false,
      }
      modelDir.value = displayModelDirPath(payload.targetModelDir || modelDirMigrationState.value.targetModelDir)
      return
    }

    if (type === 'model_dir_migration_failed') {
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'failed',
        taskId,
        currentPath: '',
        message: payload.message || '',
        error: payload.message || '',
        conflict: null,
        resolvingConflict: false,
      }
      return
    }

    if (type === 'model_dir_migration_aborted') {
      modelDirMigrationState.value = {
        ...modelDirMigrationState.value,
        status: 'aborted',
        taskId,
        currentPath: '',
        message: payload.message || '',
        error: '',
        conflict: null,
        resolvingConflict: false,
      }
    }
  }

  function clearModelDirMigrationState() {
    modelDirMigrationState.value = createEmptyModelDirMigrationState()
  }

  async function markStartupOnboardingCompleted() {
    startupOnboardingSeen.value = true
    await saveAppStore('app-settings', persistable.value)
  }

  return {
    initialized,
    appPaths,
    dataRoot,
    settingsDir,
    editorProjectsDir,
    logsDir,
    tempDir,
    isModelDirMigrating,
    shouldShowStartupOnboarding,
    themeMode,
    themeAccent,
    scaleFactor,
    locale,
    animationsEnabled,
    developerMode,
    modelDir,
    outputDir,
    defaultDevice,
    defaultFormat,
    downloadSource,
    maxConcurrentSeparations,
    MAX_CONCURRENT_SEPARATIONS,
    SCALE_FACTOR_MIN,
    SCALE_FACTOR_MAX,
    SCALE_FACTOR_STEP,
    wavBitDepth,
    flacBitDepth,
    mp3BitRate,
    m4aBitRate,
    m4aCodec,
    startupOnboardingSeen,
    modelDirMigrationState,
    initialize,
    markStartupOnboardingCompleted,
    pickModelDir,
    pickOutputDir,
    migrateDataRootToPortable,
    pickFolder,
    prepareModelDirChange,
    cancelModelDirChangeConfirmation,
    confirmModelDirMigration,
    resolveModelDirConflict,
    clearModelDirMigrationState,
    handleWorkerEvent,
    deviceOptions,
    getRuntimeDeviceConfig,
    getAudioParams,
  }
})
