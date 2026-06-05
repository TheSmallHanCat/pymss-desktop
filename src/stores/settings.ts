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
import { setLocale, type SupportedLocale } from '@/i18n'
import { loadAppStore, saveAppStore } from '@/utils/appStore'
import type { EnvInfo } from '@/stores/app'

type AppPathsPayload = {
  dataRoot: string
  settingsDir: string
  modelsDir: string
  outputsDir: string
  editorProjectsDir: string
  logsDir: string
  tempDir: string
}

type StoredSettings = {
  themeMode?: ThemeMode
  themeAccent?: ThemeAccent
  locale?: SupportedLocale
  modelDir?: string
  outputDir?: string
  separateTaskOutputDir?: boolean
  defaultDevice?: string
  defaultFormat?: string
  downloadSource?: string
  maxConcurrentSeparations?: number
  wavBitDepth?: string
  flacBitDepth?: string
  mp3BitRate?: string
  m4aBitRate?: string
  m4aCodec?: string
}

const DEFAULT_LOCALE: SupportedLocale = 'zh-CN'
const DEFAULT_DOWNLOAD_SOURCE = 'modelscope'
const DEFAULT_DEFAULT_DEVICE = 'auto'
const DEFAULT_DEFAULT_FORMAT = 'wav'
const DEFAULT_CONCURRENT_SEPARATIONS = 1
const MAX_CONCURRENT_SEPARATIONS = 16
const DEFAULT_WAV_BIT_DEPTH = 'FLOAT'
const DEFAULT_FLAC_BIT_DEPTH = 'PCM_24'
const DEFAULT_MP3_BIT_RATE = '320k'
const DEFAULT_M4A_BIT_RATE = '192k'
const DEFAULT_M4A_CODEC = 'aac_at'

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
  const locale = ref<SupportedLocale>(DEFAULT_LOCALE)
  const modelDir = ref('')
  const outputDir = ref('')
  const separateTaskOutputDir = ref(true)
  const defaultDevice = ref(DEFAULT_DEFAULT_DEVICE)
  const defaultFormat = ref(DEFAULT_DEFAULT_FORMAT)
  const downloadSource = ref(DEFAULT_DOWNLOAD_SOURCE)
  const maxConcurrentSeparations = ref(DEFAULT_CONCURRENT_SEPARATIONS)
  const wavBitDepth = ref(DEFAULT_WAV_BIT_DEPTH)
  const flacBitDepth = ref(DEFAULT_FLAC_BIT_DEPTH)
  const mp3BitRate = ref(DEFAULT_MP3_BIT_RATE)
  const m4aBitRate = ref(DEFAULT_M4A_BIT_RATE)
  const m4aCodec = ref(DEFAULT_M4A_CODEC)

  const dataRoot = computed(() => appPaths.value?.dataRoot || '')
  const settingsDir = computed(() => appPaths.value?.settingsDir || '')
  const editorProjectsDir = computed(() => appPaths.value?.editorProjectsDir || '')
  const logsDir = computed(() => appPaths.value?.logsDir || '')
  const tempDir = computed(() => appPaths.value?.tempDir || '')

  const persistable = computed<StoredSettings>(() => ({
    themeMode: themeMode.value,
    themeAccent: themeAccent.value,
    locale: locale.value,
    modelDir: modelDir.value,
    outputDir: outputDir.value,
    separateTaskOutputDir: separateTaskOutputDir.value,
    defaultDevice: defaultDevice.value,
    defaultFormat: defaultFormat.value,
    downloadSource: downloadSource.value,
    maxConcurrentSeparations: maxConcurrentSeparations.value,
    wavBitDepth: wavBitDepth.value,
    flacBitDepth: flacBitDepth.value,
    mp3BitRate: mp3BitRate.value,
    m4aBitRate: m4aBitRate.value,
    m4aCodec: m4aCodec.value,
  }))

  let saveTimer: ReturnType<typeof setTimeout> | null = null

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
    locale.value = stored?.locale || DEFAULT_LOCALE
    modelDir.value = (stored?.modelDir || paths.modelsDir).trim() || paths.modelsDir
    outputDir.value = (stored?.outputDir || paths.outputsDir).trim() || paths.outputsDir
    separateTaskOutputDir.value = stored?.separateTaskOutputDir ?? true
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
    m4aCodec.value = stored?.m4aCodec || DEFAULT_M4A_CODEC

    applyTheme(themeMode.value, themeAccent.value)
    setLocale(locale.value)
    initialized.value = true
  }

  watch(themeMode, (value) => {
    applyTheme(value, themeAccent.value)
    queuePersist()
  })
  watch(themeAccent, (value) => {
    applyTheme(themeMode.value, value)
    queuePersist()
  })
  watch(locale, (value) => {
    setLocale(value)
    queuePersist()
  })
  watch(
    [
      modelDir,
      outputDir,
      separateTaskOutputDir,
      defaultDevice,
      defaultFormat,
      downloadSource,
      maxConcurrentSeparations,
      wavBitDepth,
      flacBitDepth,
      mp3BitRate,
      m4aBitRate,
      m4aCodec,
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
    if (env?.mpsAvailable) options.push({ label: 'Apple MPS', value: 'mps', type: 'mps', deviceIds: [0] })
    if (env?.mlxAvailable || env?.mpsAvailable) options.push({ label: 'Apple MLX', value: 'mlx', type: 'mlx', deviceIds: [0] })
    return options
  }

  function getRuntimeDeviceConfig(): RuntimeDeviceConfig {
    const selected = defaultDevice.value
    if (selected.startsWith('cuda:')) {
      const id = parseInt(selected.slice('cuda:'.length), 10)
      return { device: 'cuda', deviceIds: Number.isFinite(id) ? [id] : [0] }
    }
    if (selected === 'cuda') return { device: 'cuda', deviceIds: [0] }
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
    const folder = await invoke<string | null>('pick_output_folder')
    if (folder) modelDir.value = folder
  }

  async function pickOutputDir() {
    const folder = await invoke<string | null>('pick_output_folder')
    if (folder) outputDir.value = folder
  }

  return {
    initialized,
    appPaths,
    dataRoot,
    settingsDir,
    editorProjectsDir,
    logsDir,
    tempDir,
    themeMode,
    themeAccent,
    locale,
    modelDir,
    outputDir,
    separateTaskOutputDir,
    defaultDevice,
    defaultFormat,
    downloadSource,
    maxConcurrentSeparations,
    MAX_CONCURRENT_SEPARATIONS,
    wavBitDepth,
    flacBitDepth,
    mp3BitRate,
    m4aBitRate,
    m4aCodec,
    initialize,
    pickModelDir,
    pickOutputDir,
    deviceOptions,
    getRuntimeDeviceConfig,
    getAudioParams,
  }
})
