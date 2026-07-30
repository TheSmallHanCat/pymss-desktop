<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import {
  AlertCircleOutline,
  CheckmarkCircleOutline,
  CloudDownloadOutline,
  FolderOpenOutline,
  InformationCircleOutline,
  LockClosedOutline,
  PulseOutline,
  RefreshOutline,
  TerminalOutline,
  TimeOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { useAppStore, type DiagnosticLevel } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import { useTaskStore } from '@/stores/task'
import { useModelStore } from '@/stores/model'
import { formatBytes } from '@/utils/format'

const { t } = useI18n()
const message = useMessage()
const app = useAppStore()
const settings = useSettingsStore()
const task = useTaskStore()
const modelStore = useModelStore()

const { developerMode, dataRoot, modelDir, outputDir, settingsDir, editorProjectsDir, logsDir, tempDir, defaultDevice, downloadSource, maxConcurrentSeparations } = storeToRefs(settings)
const { activeWorkerTasks, runningTasks } = storeToRefs(task)
const { downloadTasks } = storeToRefs(modelStore)

type DebugTab = 'overview' | 'runtime' | 'models' | 'events' | 'logs' | 'paths'
type CatalogEditMode = 'simple' | 'advanced'
type DebugCatalogInfo = {
  baseCatalogPath: string
  debugCatalogPath: string
  debugDir: string
  baseCatalog: Record<string, unknown>
  debugCatalog: Record<string, unknown>
  effectiveCatalog: Record<string, unknown>
  status: Record<string, any>
}
type DebugModelConfig = {
  model: string
  source: string
  readOnly: boolean
  baseConfigPath: string | null
  effectiveConfigPath: string | null
  baseContent: string
  effectiveContent: string
  downloadedConfigExists: boolean
}
type DebugRuntimeFileInfo = {
  kind: string
  source: string
  path: string
  exists: boolean
  editable: boolean
  content?: string | null
  backupPath: string
  backupExists: boolean
}
type DebugRuntimePointers = {
  runtimeEnvsDir: string
  activeRuntimeFile: string
  bundledRuntimeEnvsDir?: string | null
  files: DebugRuntimeFileInfo[]
}
type RuntimeTreeChild = {
  name: string
  role: string
  path: string
}
type RuntimeTreeNode = RuntimeTreeChild & {
  source: string
  children: RuntimeTreeChild[]
}
type RuntimeDebugEnvironmentRow = {
  backend: string
  source: string
  pythonPath: string
  editablePath: string
  editableFile: DebugRuntimeFileInfo | null
}
type DebugWorkerEvent = {
  type?: string
  taskId?: string
  timestamp?: string
  payload?: unknown
}
type DebugWorkerEventGroup = {
  key: string
  taskId: string | null
  latestType: string
  firstTimestamp?: string
  lastTimestamp?: string
  eventCount: number
  latestPayload?: unknown
  typeCounts: Record<string, number>
  events: DebugWorkerEvent[]
}
type DebugLogInfo = {
  path: string
  logsDir: string
  exists: boolean
  sizeBytes: number
  persistentPath: string
  persistentExists: boolean
  persistentSizeBytes: number
  debugBuild: boolean
  maxBytes: number
  persistentMaxBytes: number
  reportPath: string
  reportExists: boolean
  reportSizeBytes: number
}
type DebugLogContent = {
  path: string
  content: string
  sizeBytes: number
  truncated: boolean
}
type DebugLogReport = {
  path: string
  exists: boolean
  sizeBytes: number
}

const activeTab = ref<DebugTab>('overview')
const debugCatalogLoading = ref(false)
const debugCatalogSaving = ref(false)
const debugCatalogInfo = ref<DebugCatalogInfo | null>(null)
const debugCatalogText = ref('')
const debugCatalogObject = ref<Record<string, any>>({ schema_version: 1, models: [] })
const debugCatalogModels = ref<Record<string, any>[]>([])
const catalogEditMode = ref<CatalogEditMode>('simple')
const catalogSearch = ref('')
const selectedCatalogModelName = ref('')
const catalogModelDraft = ref<Record<string, any>>({})
const catalogModelDialogVisible = ref(false)
const selectedDebugModel = ref('')
const debugConfigLoading = ref(false)
const debugConfigSaving = ref(false)
const debugModelConfig = ref<DebugModelConfig | null>(null)
const debugConfigText = ref('')
const workerEventDialogVisible = ref(false)
const selectedWorkerEvent = ref<any | null>(null)
const runtimeDebugLoading = ref(false)
const runtimeDebugSaving = ref('')
const runtimeDebugInfo = ref<DebugRuntimePointers | null>(null)
const runtimeDebugEditorVisible = ref(false)
const runtimeDebugEditingPath = ref('')
const runtimeDebugEditingContent = ref('')
const runtimeOverrideBackend = ref('cuda')
const runtimeOverridePythonPath = ref('')
const debugLogLoading = ref(false)
const debugLogClearing = ref(false)
const debugLogReportLoading = ref(false)
const debugLogInfo = ref<DebugLogInfo | null>(null)
const debugLogContent = ref<DebugLogContent | null>(null)

const diagnostics = computed(() => app.diagnostics)
const env = computed(() => app.envInfo)
const recentWorkerEventGroups = computed(() => groupWorkerEvents(app.workerEvents as DebugWorkerEvent[]).slice(0, 40))
const debugTabs = computed(() => [
  { key: 'overview', label: t('debug.tabOverview') },
  { key: 'runtime', label: t('debug.tabRuntime') },
  { key: 'models', label: t('debug.tabModels') },
  { key: 'events', label: t('debug.tabEvents') },
  { key: 'logs', label: t('debug.tabLogs') },
  { key: 'paths', label: t('debug.tabPaths') },
] as Array<{ key: DebugTab; label: string }>)
const debugModelOptions = computed(() => modelStore.models
  .filter((model) => model.downloaded || model.source === 'user')
  .map((model) => ({
    label: `${model.name}${model.source === 'user' ? ` · ${t('debug.userModelReadonly')}` : ''}`,
    value: model.name,
  })))

function catalogForEditor(result: DebugCatalogInfo) {
  return result.effectiveCatalog || result.baseCatalog || { schema_version: 1, models: [], removed: [] }
}
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function safeCatalogRelpath(modelName: string, field: string, value: unknown, required = false) {
  if (value == null) value = ''
  if (typeof value !== 'string') throw new Error(t('debug.catalogFieldMustBeString', { model: modelName, field }))
  const relpath = value.trim().replace(/\\/g, '/')
  if (required && !relpath) throw new Error(t('debug.catalogFieldRequired', { model: modelName, field }))
  const parts = relpath.split('/').filter(Boolean)
  if (relpath && (relpath.startsWith('/') || /^[a-zA-Z]:\//.test(relpath) || parts.includes('..'))) {
    throw new Error(t('debug.catalogFieldUnsafePath', { model: modelName, field }))
  }
  return relpath
}

function validateDebugCatalog(catalog: unknown) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error(t('debug.catalogPayloadMustBeObject'))
  const source = catalog as Record<string, any>
  if (!Array.isArray(source.models)) throw new Error(t('debug.catalogModelsMustBeArray'))
  if (source.removed != null && !Array.isArray(source.removed)) throw new Error(t('debug.catalogRemovedMustBeArray'))
  const seen = new Set<string>()
  const models = source.models.map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(t('debug.catalogModelMustBeObject', { index }))
    const model = item as Record<string, any>
    const name = String(model.name || '').trim()
    if (!name) throw new Error(t('debug.catalogModelNameRequiredAt', { index }))
    if (seen.has(name)) throw new Error(t('debug.catalogModelDuplicate', { model: name }))
    seen.add(name)
    const auxiliaryRelpaths = model.auxiliary_relpaths ?? []
    if (!Array.isArray(auxiliaryRelpaths)) throw new Error(t('debug.catalogAuxiliaryMustBeArray', { model: name }))
    return {
      ...model,
      name,
      relpath: safeCatalogRelpath(name, 'relpath', model.relpath, true),
      config_relpath: safeCatalogRelpath(name, 'config_relpath', model.config_relpath),
      auxiliary_relpaths: auxiliaryRelpaths.map((relpath: unknown, auxiliaryIndex: number) => (
        safeCatalogRelpath(name, `auxiliary_relpaths[${auxiliaryIndex}]`, relpath, true)
      )),
    }
  })
  return { ...source, models }
}

function parseDebugCatalogText() {
  try {
    return validateDebugCatalog(JSON.parse(debugCatalogText.value || '{}'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(t('debug.catalogJsonSyntaxInvalid'))
    throw error
  }
}

function setCatalogEditor(catalog: Record<string, unknown>) {
  const cloned = cloneJson(catalog || { schema_version: 1, models: [] }) as Record<string, any>
  const models = Array.isArray(cloned.models) ? cloned.models.filter((item: unknown) => item && typeof item === 'object') : []
  debugCatalogObject.value = { ...cloned, models }
  debugCatalogModels.value = models
  debugCatalogText.value = JSON.stringify(debugCatalogObject.value, null, 2)
  if (!selectedCatalogModelName.value || !models.some((item: Record<string, any>) => item.name === selectedCatalogModelName.value)) {
    selectedCatalogModelName.value = String(models[0]?.name || '')
  }
  loadCatalogDraft(selectedCatalogModelName.value)
}

const visibleCatalogModels = computed(() => {
  const query = catalogSearch.value.trim().toLowerCase()
  if (!query) return debugCatalogModels.value
  return debugCatalogModels.value.filter((model) => [
    model.name,
    model.model_type,
    model.architecture,
    model.primary_category,
    model.primary_category_cn,
    model.secondary_category,
    model.secondary_category_cn,
  ].some((value) => String(value || '').toLowerCase().includes(query)))
})
const baseCatalogModelsByName = computed(() => {
  const models = debugCatalogInfo.value?.baseCatalog?.models
  const list = Array.isArray(models) ? models : []
  return new Map(list
    .filter((item: unknown): item is Record<string, any> => Boolean(item && typeof item === 'object' && (item as Record<string, any>).name))
    .map((item) => [String(item.name), item]))
})

function catalogModelStatus(model: Record<string, any>) {
  const base = baseCatalogModelsByName.value.get(String(model.name || ''))
  if (!base) return 'added'
  return stableJson(model) === stableJson(base) ? 'normal' : 'modified'
}

function syncCatalogTextFromSimple() {
  debugCatalogObject.value = { ...debugCatalogObject.value, models: debugCatalogModels.value }
  debugCatalogText.value = JSON.stringify(debugCatalogObject.value, null, 2)
}

function loadCatalogDraft(name: string) {
  const model = debugCatalogModels.value.find((item) => item.name === name)
  catalogModelDraft.value = model
    ? { ...cloneJson(model), aliasesText: Array.isArray(model.aliases) ? model.aliases.join(', ') : '' }
    : {}
}

function selectCatalogModel(name: string) {
  selectedCatalogModelName.value = name
  loadCatalogDraft(name)
  catalogModelDialogVisible.value = true
}

function addCatalogModel() {
  const nextName = `debug_model_${debugCatalogModels.value.length + 1}.ckpt`
  catalogModelDraft.value = {
    name: nextName,
    aliasesText: nextName.replace(/\.[^.]+$/, ''),
    model_type: '',
    architecture: '',
    supported: true,
    unsupported_reason: '',
    relpath: '',
    config_relpath: '',
    auxiliary_relpaths: [],
    size_bytes: 0,
    sha256: '',
    primary_category: 'custom',
    primary_category_cn: '自定义',
    secondary_category: '',
    secondary_category_cn: '',
    target_stem: '',
    config_instruments: '',
    config_target_instrument: '',
    classification_confidence: 'manual',
    classification_basis: 'debug catalog',
  }
  selectedCatalogModelName.value = ''
  catalogModelDialogVisible.value = true
}

function saveCatalogDraft() {
  const draft = cloneJson(catalogModelDraft.value) as Record<string, any>
  const name = String(draft.name || '').trim()
  if (!name) {
    message.error(t('debug.catalogModelNameRequired'))
    return
  }
  const aliases = String(draft.aliasesText || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  delete draft.aliasesText
  draft.name = name
  draft.aliases = aliases
  draft.supported = Boolean(draft.supported)
  draft.size_bytes = Number.parseInt(String(draft.size_bytes || 0), 10) || 0
  const existingIndex = debugCatalogModels.value.findIndex((item) => item.name === selectedCatalogModelName.value || item.name === name)
  if (existingIndex >= 0) debugCatalogModels.value.splice(existingIndex, 1, draft)
  else debugCatalogModels.value.unshift(draft)
  selectedCatalogModelName.value = name
  catalogModelDraft.value = { ...cloneJson(draft), aliasesText: aliases.join(', ') }
  syncCatalogTextFromSimple()
  catalogModelDialogVisible.value = false
}

function removeCatalogModel(name: string) {
  if (!name) return
  debugCatalogModels.value = debugCatalogModels.value.filter((item) => item.name !== name)
  selectedCatalogModelName.value = debugCatalogModels.value[0]?.name || ''
  loadCatalogDraft(selectedCatalogModelName.value)
  syncCatalogTextFromSimple()
}

function switchCatalogEditMode(mode: CatalogEditMode) {
  if (mode === catalogEditMode.value) return
  if (mode === 'simple') {
    try {
      setCatalogEditor(parseDebugCatalogText())
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
      return
    }
  } else {
    syncCatalogTextFromSimple()
  }
  catalogEditMode.value = mode
}

function quoteCatalogRelpath(path: string) {
  return String(path || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function currentCatalogDownloadUrl(relpath: unknown) {
  const path = String(relpath || '').trim().replace(/\\/g, '/')
  if (!path) return ''
  const repositories = (debugCatalogInfo.value?.effectiveCatalog?.source_repository
    || debugCatalogInfo.value?.baseCatalog?.source_repository
    || {}) as Record<string, unknown>
  const quotedPath = quoteCatalogRelpath(path)
  if (downloadSource.value === 'huggingface') {
    const base = String(repositories.huggingface || '').replace(/\/$/, '')
    return base ? `${base}/resolve/main/${quotedPath}` : ''
  }
  if (downloadSource.value === 'hf-mirror') {
    const hfBase = String(repositories.huggingface || '')
    const match = hfBase.match(/huggingface\.co\/(.+)$/)
    return match?.[1] ? `https://hf-mirror.com/${match[1].replace(/\/$/, '')}/resolve/main/${quotedPath}` : ''
  }
  const base = String(repositories.modelscope || '').replace(/\/$/, '')
  return base ? `${base}/resolve/master/${quotedPath}` : ''
}
const runningDownloadTasks = computed(() => Object.values(downloadTasks.value).filter((item) => item.status === 'downloading'))
const runtimeDevice = computed(() => settings.getRuntimeDeviceConfig(app.envInfo))
const cudaDevices = computed(() => env.value?.cudaDevices || [])
const runtimeRows = computed(() => [
  { label: t('debug.defaultDevice'), value: defaultDevice.value },
  { label: t('debug.resolvedDevice'), value: `${runtimeDevice.value.device} [${runtimeDevice.value.deviceIds.join(', ')}]` },
  { label: t('debug.downloadSource'), value: downloadSource.value },
  { label: t('debug.maxConcurrent'), value: String(maxConcurrentSeparations.value) },
])
const pathRows = computed(() => [
  { label: t('debug.dataRoot'), value: dataRoot.value },
  { label: t('debug.modelDir'), value: modelDir.value },
  { label: t('debug.outputDir'), value: outputDir.value },
  { label: t('debug.settingsDir'), value: settingsDir.value },
  { label: t('debug.editorProjectsDir'), value: editorProjectsDir.value },
  { label: t('debug.logsDir'), value: logsDir.value },
  { label: t('debug.tempDir'), value: tempDir.value },
  { label: t('debug.debugDir'), value: debugCatalogInfo.value?.debugDir || '' },
])
const runtimeTree = computed<RuntimeTreeNode[]>(() => {
  const info = app.runtimeInfo
  const environments = info?.installedEnvironments || []
  return [
    {
      name: 'bootstrap',
      role: t('debug.runtimeTreeBootstrapRole'),
      path: info?.bootstrapPython || '-',
      source: t('debug.runtimeTreeAppSource'),
      children: [],
    },
    {
      name: 'runtime-envs',
      role: t('debug.runtimeTreeManagedRootRole'),
      path: info?.runtimeEnvsDir || '-',
      source: t('debug.runtimeTreeUserSource'),
      children: environments.map((entry) => ({
        name: String(entry.backend || '-'),
        role: entry.source === 'preinstalled'
          ? t('debug.runtimeTreePreinstalledRole')
          : t('debug.runtimeTreeManagedRole'),
        path: entry.pythonPath || '-',
        source: entry.source || '-',
        children: [
          { name: 'python', role: t('debug.runtimeTreePythonRole'), path: entry.pythonPath || '-' },
          { name: 'install.log', role: t('debug.runtimeTreeLogRole'), path: entry.logPath || '-' },
        ],
      })),
    },
    {
      name: 'active-runtime.json',
      role: t('debug.runtimeTreeActiveRole'),
      path: info?.activeRuntimeFile || '-',
      source: t('debug.runtimeTreeUserSource'),
      children: [],
    },
    ...(info?.bundledRuntimeEnvsDir ? [{
      name: 'bundled-runtime-envs',
      role: t('debug.runtimeTreeBundleRootRole'),
      path: info.bundledRuntimeEnvsDir,
      source: t('debug.runtimeTreeAppSource'),
      children: [],
    }] : []),
  ]
})
const runtimeDebugRows = computed(() => [
  { label: t('debug.runtimeDebugUserRoot'), value: runtimeDebugInfo.value?.runtimeEnvsDir || app.runtimeInfo?.runtimeEnvsDir || '' },
  { label: t('debug.runtimeDebugUserActive'), value: runtimeDebugInfo.value?.activeRuntimeFile || app.runtimeInfo?.activeRuntimeFile || '' },
  { label: t('debug.runtimeDebugBundledRoot'), value: runtimeDebugInfo.value?.bundledRuntimeEnvsDir || app.runtimeInfo?.bundledRuntimeEnvsDir || '' },
  { label: t('debug.runtimeDebugInstallState'), value: app.runtimeInfo?.installState?.pythonPath || app.runtimeInfo?.installedBackend || '' },
])
const runtimeDebugFiles = computed(() => runtimeDebugInfo.value?.files || [])
const runtimeDebugActiveFile = computed(() => runtimeDebugFiles.value.find((file) => file.kind === 'active-runtime') || null)
const runtimeDebugFileLookup = computed(() => new Map(runtimeDebugFiles.value.map((file) => [file.path, file])))
const runtimeDebugEnvironments = computed<RuntimeDebugEnvironmentRow[]>(() => (app.runtimeInfo?.installedEnvironments || []).map((entry) => {
  const pythonPath = String(entry.pythonPath || '')
  const separator = pythonPath.includes('\\') ? '\\' : '/'
  const editablePath = pythonPath
    .replace(/[\\/]Scripts[\\/]python(?:\.exe)?$/i, `${separator}pyvenv.cfg`)
    .replace(/[\\/]bin[\\/]python(?:\d+(?:\.\d+)?)?$/i, `${separator}pyvenv.cfg`)
  const editableFile = editablePath !== pythonPath ? runtimeDebugFileLookup.value.get(editablePath) || null : null
  return {
    backend: String(entry.backend || '-'),
    source: String(entry.source || '-'),
    pythonPath,
    editablePath: editableFile?.path || editablePath,
    editableFile,
  }
}))
const runtimeBackendOptions = [
  { label: 'CPU', value: 'cpu' },
  { label: 'CUDA', value: 'cuda' },
  { label: 'ROCm', value: 'rocm' },
  { label: 'MLX', value: 'mlx' },
]
const debugLogRows = computed(() => [
  { label: t('debug.currentLogPath'), value: debugLogInfo.value?.path || '' },
  { label: t('debug.currentLogSize'), value: `${formatBytes(debugLogInfo.value?.sizeBytes || 0)} / ${formatBytes(debugLogInfo.value?.maxBytes || 0)}` },
  { label: t('debug.persistentLogPath'), value: debugLogInfo.value?.persistentPath || debugLogContent.value?.path || '' },
  { label: t('debug.persistentLogSize'), value: `${formatBytes(debugLogInfo.value?.persistentSizeBytes || debugLogContent.value?.sizeBytes || 0)} / ${formatBytes(debugLogInfo.value?.persistentMaxBytes || 0)}` },
  { label: t('debug.reportPath'), value: debugLogInfo.value?.reportPath || '' },
  { label: t('debug.reportSize'), value: debugLogInfo.value?.reportExists ? formatBytes(debugLogInfo.value?.reportSizeBytes || 0) : '-' },
  { label: t('debug.logMode'), value: debugLogInfo.value?.debugBuild ? t('debug.logModeVerbose') : t('debug.logModeRelease') },
])
const statusCards = computed(() => [
  { label: t('debug.envStatus'), value: app.envReady ? t('debug.ready') : t('debug.needsAttention'), tone: app.envReady ? 'ok' : 'warn' },
  { label: t('debug.activeWorkerTasks'), value: String(activeWorkerTasks.value.length), tone: activeWorkerTasks.value.length ? 'warn' : 'ok' },
  { label: t('debug.runningTasks'), value: String(runningTasks.value.length), tone: runningTasks.value.length ? 'warn' : 'ok' },
  { label: t('debug.downloadingModels'), value: String(runningDownloadTasks.value.length), tone: runningDownloadTasks.value.length ? 'warn' : 'ok' },
])

function diagnosticIcon(level: DiagnosticLevel) {
  if (level === 'ok') return CheckmarkCircleOutline
  if (level === 'warn') return WarningOutline
  return AlertCircleOutline
}

function eventTime(value: unknown) {
  const time = Date.parse(String(value || ''))
  if (!Number.isFinite(time)) return '-'
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time)
}

function shortTaskId(value: unknown) {
  const text = String(value || '').trim()
  if (!text) return '-'
  return text.length > 28 ? `${text.slice(0, 14)}…${text.slice(-10)}` : text
}

function groupWorkerEvents(events: DebugWorkerEvent[]): DebugWorkerEventGroup[] {
  const groups: DebugWorkerEventGroup[] = []
  const taskGroups = new Map<string, DebugWorkerEventGroup>()

  for (const event of events) {
    const type = String(event?.type || 'unknown')
    const taskId = String(event?.taskId || '').trim()
    const timestamp = event?.timestamp
    if (!taskId) {
      groups.push({
        key: `event:${groups.length}:${timestamp || ''}:${type}`,
        taskId: null,
        latestType: type,
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
        eventCount: 1,
        latestPayload: event?.payload,
        typeCounts: { [type]: 1 },
        events: [event],
      })
      continue
    }

    let group = taskGroups.get(taskId)
    if (!group) {
      group = {
        key: `task:${taskId}`,
        taskId,
        latestType: type,
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
        eventCount: 0,
        latestPayload: event?.payload,
        typeCounts: {},
        events: [],
      }
      taskGroups.set(taskId, group)
      groups.push(group)
    }

    group.eventCount += 1
    group.typeCounts[type] = (group.typeCounts[type] || 0) + 1
    group.events.push(event)
    if (group.events.length === 1 || isNewerTimestamp(timestamp, group.lastTimestamp)) {
      group.latestType = type
      group.lastTimestamp = timestamp
      group.latestPayload = event?.payload
    }
    if (!group.firstTimestamp || isNewerTimestamp(group.firstTimestamp, timestamp)) {
      group.firstTimestamp = timestamp
    }
  }

  return groups
}

function isNewerTimestamp(left: unknown, right: unknown) {
  const leftTime = Date.parse(String(left || ''))
  const rightTime = Date.parse(String(right || ''))
  if (!Number.isFinite(leftTime)) return false
  if (!Number.isFinite(rightTime)) return true
  return leftTime > rightTime
}

function workerEventGroupTitle(group: DebugWorkerEventGroup | null) {
  if (!group) return t('debug.workerEvents')
  return group.taskId ? t('debug.workerEventTaskGroup') : group.latestType
}

function workerEventGroupSummary(group: DebugWorkerEventGroup | null) {
  if (!group) return ''
  return Object.entries(group.typeCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([type, count]) => `${type}: ${count}`)
    .join(' · ')
}

function workerEventGroupPayload(group: DebugWorkerEventGroup | null) {
  if (!group) return ''
  if (!group.taskId) return formatPayload(group.latestPayload)
  return formatPayload({
    taskId: group.taskId,
    eventCount: group.eventCount,
    firstEventAt: group.firstTimestamp,
    latestEventAt: group.lastTimestamp,
    latestType: group.latestType,
    typeCounts: group.typeCounts,
    latestPayload: group.latestPayload,
  })
}

function formatPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return ''
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

async function checkEnv() {
  if (!developerMode.value) return
  try {
    await app.checkEnv()
    message.success(t('debug.envCheckDone'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

function openWorkerEvent(group: DebugWorkerEventGroup) {
  selectedWorkerEvent.value = group
  workerEventDialogVisible.value = true
}

async function loadDebugCatalog() {
  debugCatalogLoading.value = true
  try {
    const result = await invoke<DebugCatalogInfo>('debug_catalog_info')
    debugCatalogInfo.value = result
    setCatalogEditor(catalogForEditor(result))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    debugCatalogLoading.value = false
  }
}

async function saveDebugCatalog() {
  debugCatalogSaving.value = true
  try {
    if (catalogEditMode.value === 'simple') syncCatalogTextFromSimple()
    const catalog = parseDebugCatalogText()
    const result = await invoke<DebugCatalogInfo>('debug_catalog_save', { payload: { catalog, fullCatalog: true } })
    debugCatalogInfo.value = result
    setCatalogEditor(catalogForEditor(result))
    await modelStore.loadModels()
    message.success(t('debug.debugCatalogSaved'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    debugCatalogSaving.value = false
  }
}

async function resetDebugCatalog() {
  debugCatalogSaving.value = true
  try {
    const result = await invoke<DebugCatalogInfo>('debug_catalog_reset')
    debugCatalogInfo.value = result
    setCatalogEditor(catalogForEditor(result))
    await modelStore.loadModels()
    message.success(t('debug.debugCatalogReset'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    debugCatalogSaving.value = false
  }
}

async function loadDebugModelConfig() {
  if (!selectedDebugModel.value) return false
  debugConfigLoading.value = true
  try {
    const result = await invoke<DebugModelConfig>('debug_model_config', {
      payload: { action: 'read', model: selectedDebugModel.value, modelDir: settings.modelDir || null },
    })
    debugModelConfig.value = result
    debugConfigText.value = result.effectiveContent || ''
    return true
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
    return false
  } finally {
    debugConfigLoading.value = false
  }
}

async function saveDebugModelConfig() {
  if (!selectedDebugModel.value || debugModelConfig.value?.readOnly) return
  debugConfigSaving.value = true
  try {
    const result = await invoke<DebugModelConfig>('debug_model_config', {
      payload: {
        action: 'save',
        model: selectedDebugModel.value,
        modelDir: settings.modelDir || null,
        content: debugConfigText.value,
      },
    })
    debugModelConfig.value = result
    debugConfigText.value = result.effectiveContent || ''
    await modelStore.loadModels()
    message.success(t('debug.downloadedConfigSaved'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    debugConfigSaving.value = false
  }
}

async function resetDebugModelConfig() {
  if (!selectedDebugModel.value || debugModelConfig.value?.readOnly) return
  if (await loadDebugModelConfig()) message.success(t('debug.modelConfigReset'))
}

async function revealPath(path: string) {
  if (!path) return
  try {
    await task.revealPath(path)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function loadDebugLog() {
  if (!developerMode.value) return
  debugLogLoading.value = true
  try {
    const [info, content] = await Promise.all([
      invoke<DebugLogInfo>('debug_log_info'),
      invoke<DebugLogContent>('debug_log_read'),
    ])
    debugLogInfo.value = info
    debugLogContent.value = content
  } catch (error) {
    debugLogInfo.value = null
    debugLogContent.value = null
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    debugLogLoading.value = false
  }
}

async function clearDebugLog() {
  if (!developerMode.value) return
  debugLogClearing.value = true
  try {
    debugLogInfo.value = await invoke<DebugLogInfo>('debug_log_clear')
    debugLogContent.value = await invoke<DebugLogContent>('debug_log_read')
    message.success(t('debug.logCleared'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    debugLogClearing.value = false
  }
}

async function copyDebugLog() {
  const content = debugLogContent.value?.content || ''
  if (!content) return
  try {
    await navigator.clipboard.writeText(content)
    message.success(t('debug.logCopied'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function createDebugLogReport() {
  if (!developerMode.value) return
  debugLogReportLoading.value = true
  try {
    const report = await invoke<DebugLogReport>('debug_log_create_report')
    message.success(t('debug.reportCreated'))
    await loadDebugLog()
    await revealPath(report.path)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    debugLogReportLoading.value = false
  }
}

function setRuntimeDebugInfo(info: DebugRuntimePointers) {
  runtimeDebugInfo.value = info
  if (runtimeDebugEditingPath.value && !info.files.some((file) => file.path === runtimeDebugEditingPath.value)) {
    runtimeDebugEditorVisible.value = false
    runtimeDebugEditingPath.value = ''
    runtimeDebugEditingContent.value = ''
  }
}

async function loadRuntimeDebugPointers() {
  if (!developerMode.value) {
    runtimeDebugInfo.value = null
    return
  }
  runtimeDebugLoading.value = true
  try {
    const info = await invoke<DebugRuntimePointers>('debug_runtime_pointers')
    setRuntimeDebugInfo(info)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    runtimeDebugLoading.value = false
  }
}

function openRuntimeDebugEditor(file: DebugRuntimeFileInfo) {
  if (!developerMode.value || !file.editable) return
  runtimeDebugEditingPath.value = file.path
  runtimeDebugEditingContent.value = file.content || ''
  runtimeDebugEditorVisible.value = true
}

async function saveRuntimeDebugEditor() {
  const path = runtimeDebugEditingPath.value
  if (!path) return
  runtimeDebugSaving.value = path
  try {
    const info = await invoke<DebugRuntimePointers>('debug_runtime_write_file', {
      payload: { path, content: runtimeDebugEditingContent.value || '', backup: true },
    })
    setRuntimeDebugInfo(info)
    runtimeDebugEditorVisible.value = false
    runtimeDebugEditingPath.value = ''
    runtimeDebugEditingContent.value = ''
    await app.checkRuntimeInfo().catch(() => {})
    message.success(t('debug.runtimeDebugSaved'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    runtimeDebugSaving.value = ''
  }
}

async function restoreRuntimeDebugFile(file: DebugRuntimeFileInfo) {
  if (!developerMode.value || !file.backupExists) return
  runtimeDebugSaving.value = file.path
  try {
    const info = await invoke<DebugRuntimePointers>('debug_runtime_restore_file', { payload: { path: file.path } })
    setRuntimeDebugInfo(info)
    await app.checkRuntimeInfo().catch(() => {})
    message.success(t('debug.runtimeDebugRestored'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    runtimeDebugSaving.value = ''
  }
}

async function overrideActiveRuntimePointer() {
  if (!developerMode.value || !runtimeOverrideBackend.value || !runtimeOverridePythonPath.value.trim()) return
  runtimeDebugSaving.value = 'active-runtime'
  try {
    const info = await invoke<DebugRuntimePointers>('debug_runtime_override_active', {
      payload: { backend: runtimeOverrideBackend.value, pythonPath: runtimeOverridePythonPath.value.trim(), source: 'debug' },
    })
    setRuntimeDebugInfo(info)
    await app.checkRuntimeInfo().catch(() => {})
    message.success(t('debug.runtimeDebugOverrideSaved'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    runtimeDebugSaving.value = ''
  }
}

function loadDebugPageData() {
  if (!developerMode.value) return
  if (!app.envLoading && !app.envInfo) app.checkEnvInBackground().catch(() => {})
  app.checkRuntimeInfo().catch(() => {})
  loadRuntimeDebugPointers().catch(() => {})
  loadDebugLog().catch(() => {})
  if (!modelStore.models.length) modelStore.loadModels().catch(() => {})
  loadDebugCatalog().catch(() => {})
}

onMounted(() => {
  loadDebugPageData()
})

watch(selectedDebugModel, () => {
  if (!developerMode.value) return
  loadDebugModelConfig().catch(() => {})
})

watch(debugModelOptions, (options) => {
  if (selectedDebugModel.value && !options.some((item) => item.value === selectedDebugModel.value)) {
    selectedDebugModel.value = ''
    debugModelConfig.value = null
    debugConfigText.value = ''
  }
})

watch(developerMode, (enabled) => {
  if (enabled) {
    loadDebugPageData()
  }
  else {
    app.clearWorkerEvents()
    workerEventDialogVisible.value = false
    selectedWorkerEvent.value = null
    runtimeDebugEditorVisible.value = false
    catalogModelDialogVisible.value = false
    runtimeDebugInfo.value = null
    debugLogInfo.value = null
    debugLogContent.value = null
  }
})
</script>

<template>
  <div class="page debug-page" :class="{ 'debug-page--locked': !developerMode }">
    <div class="page-header-compact debug-page__header">
      <div>
        <h1>{{ t('debug.title') }}</h1>
        <p>{{ t('debug.subtitle') }}</p>
      </div>
      <n-button type="primary" secondary :loading="app.envLoading" @click="checkEnv">
        <template #icon><n-icon :component="RefreshOutline" /></template>
        {{ app.envLoading ? t('settings.checkingEnv') : t('settings.checkEnv') }}
      </n-button>
    </div>

    <div v-if="!developerMode" class="debug-page__lock" aria-live="polite">
      <section class="debug-lock-card" aria-labelledby="debug-lock-title">
        <div class="debug-lock-card__icon">
          <n-icon :component="LockClosedOutline" />
        </div>
        <div class="debug-lock-card__copy">
          <strong id="debug-lock-title">{{ t('debug.disabledTitle') }}</strong>
          <p>{{ t('debug.disabledHint') }}</p>
        </div>
      </section>
    </div>

    <div class="debug-page__content" :class="{ 'debug-page__content--locked': !developerMode }" :inert="!developerMode || undefined">
    <nav class="debug-tabs" aria-label="Debug sections">
      <button
        v-for="tab in debugTabs"
        :key="tab.key"
        type="button"
        class="debug-tab"
        :class="{ 'debug-tab--active': activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>

    <section v-if="activeTab === 'overview'" class="debug-status-grid">
      <article v-for="item in statusCards" :key="item.label" class="debug-status-card" :class="`debug-status-card--${item.tone}`">
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </article>
    </section>

    <section v-if="activeTab === 'overview'" class="debug-grid debug-grid--top">
      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="PulseOutline" />
            <span>{{ t('debug.environment') }}</span>
          </div>
        </template>
        <div class="diagnostic-list">
          <div v-for="item in diagnostics" :key="item.key" class="diagnostic-row" :class="`diagnostic-row--${item.level}`">
            <n-icon :component="diagnosticIcon(item.level)" />
            <div class="diagnostic-row__main">
              <strong>{{ item.label }}</strong>
              <span>{{ item.value }}</span>
              <code v-if="item.detail">{{ item.detail }}</code>
            </div>
          </div>
          <n-empty v-if="!diagnostics.length" :description="t('debug.envNotChecked')" />
        </div>
      </n-card>

      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="InformationCircleOutline" />
            <span>{{ t('debug.runtimeParams') }}</span>
          </div>
        </template>
        <div class="kv-list">
          <div v-for="row in runtimeRows" :key="row.label" class="kv-row">
            <span>{{ row.label }}</span>
            <code>{{ row.value || '-' }}</code>
          </div>
        </div>
        <div v-if="cudaDevices.length" class="cuda-list">
          <h3>{{ t('debug.cudaDevices') }}</h3>
          <div v-for="gpu in cudaDevices" :key="gpu.id" class="cuda-row">
            <span>CUDA {{ gpu.id }}</span>
            <strong>{{ gpu.name }}</strong>
            <code v-if="gpu.totalMemoryBytes">{{ formatBytes(gpu.totalMemoryBytes) }}</code>
          </div>
        </div>
      </n-card>
    </section>

    <n-card v-if="activeTab === 'paths'" class="debug-card" :bordered="true" size="small">
      <template #header>
        <div class="debug-section-title">
          <n-icon :component="FolderOpenOutline" />
          <span>{{ t('debug.paths') }}</span>
        </div>
      </template>
      <div class="path-debug-grid">
        <div v-for="row in pathRows" :key="row.label" class="path-debug-row">
          <span>{{ row.label }}</span>
          <code :title="row.value || '-'">{{ row.value || '-' }}</code>
          <n-button size="tiny" secondary :disabled="!row.value" @click="revealPath(row.value)">
            {{ t('common.open') }}
          </n-button>
        </div>
      </div>
    </n-card>

    <n-card v-if="activeTab === 'runtime'" class="debug-card" :bordered="true" size="small">
      <template #header>
        <div class="debug-section-title">
          <n-icon :component="FolderOpenOutline" />
          <span>{{ t('debug.runtimeTreeTitle') }}</span>
        </div>
      </template>
      <section class="runtime-debug-panel">
        <div class="runtime-debug-toolbar">
          <strong>{{ t('debug.runtimeDebugPointerTitle') }}</strong>
          <n-button size="tiny" secondary :loading="runtimeDebugLoading" @click="loadRuntimeDebugPointers">
            {{ t('common.refresh') }}
          </n-button>
        </div>
        <div class="kv-list">
          <div v-for="row in runtimeDebugRows" :key="row.label" class="kv-row">
            <span>{{ row.label }}</span>
            <code :title="row.value || '-'">{{ row.value || '-' }}</code>
          </div>
        </div>
        <div class="runtime-override-form">
          <n-select v-model:value="runtimeOverrideBackend" size="small" :options="runtimeBackendOptions" />
          <n-input v-model:value="runtimeOverridePythonPath" size="small" :placeholder="t('debug.runtimeDebugPythonPathPlaceholder')" />
          <n-button size="small" type="primary" secondary :loading="runtimeDebugSaving === 'active-runtime'" :disabled="!developerMode || !runtimeOverridePythonPath.trim()" @click="overrideActiveRuntimePointer">
            {{ t('debug.runtimeDebugOverrideActive') }}
          </n-button>
        </div>
      </section>
      <section class="runtime-file-editor-list">
        <article v-if="runtimeDebugActiveFile" class="runtime-file-editor">
          <div class="runtime-file-editor__head">
            <div class="runtime-file-editor__title">
              <strong>active-runtime</strong>
              <span>{{ runtimeDebugActiveFile.source }} · {{ runtimeDebugActiveFile.exists ? t('debug.runtimeDebugFileExists') : t('debug.runtimeDebugFileMissing') }}</span>
            </div>
            <div class="runtime-file-editor__actions">
              <n-button size="tiny" secondary :disabled="!runtimeDebugActiveFile.path" @click="revealPath(runtimeDebugActiveFile.path)">{{ t('common.open') }}</n-button>
              <n-button size="tiny" secondary :disabled="!developerMode || !runtimeDebugActiveFile.editable" @click="openRuntimeDebugEditor(runtimeDebugActiveFile)">{{ t('debug.runtimeDebugEdit') }}</n-button>
              <n-button size="tiny" secondary :disabled="!developerMode || !runtimeDebugActiveFile.backupExists" :loading="runtimeDebugSaving === runtimeDebugActiveFile.path" @click="restoreRuntimeDebugFile(runtimeDebugActiveFile)">{{ t('debug.runtimeDebugRestore') }}</n-button>
            </div>
          </div>
          <button type="button" class="runtime-file-editor__path-button" :disabled="!developerMode || !runtimeDebugActiveFile.editable" :title="t('debug.runtimeDebugEdit')" @click="openRuntimeDebugEditor(runtimeDebugActiveFile)">
            <code class="runtime-file-editor__path">{{ runtimeDebugActiveFile.path }}</code>
          </button>
        </article>
        <article v-for="envItem in runtimeDebugEnvironments" :key="`${envItem.backend}-${envItem.pythonPath}`" class="runtime-file-editor">
          <div class="runtime-file-editor__head">
            <div class="runtime-file-editor__title">
              <strong>{{ envItem.backend }}</strong>
              <span>{{ envItem.source }} · {{ envItem.editableFile ? t('debug.runtimeDebugConfigFile') : t('debug.runtimeDebugNoConfigFile') }}</span>
            </div>
            <div class="runtime-file-editor__actions">
              <n-button size="tiny" secondary :disabled="!envItem.pythonPath" @click="revealPath(envItem.pythonPath)">{{ t('common.open') }}</n-button>
              <n-button size="tiny" secondary :disabled="!developerMode || !envItem.editableFile?.editable" @click="envItem.editableFile && openRuntimeDebugEditor(envItem.editableFile)">{{ t('debug.runtimeDebugEdit') }}</n-button>
              <n-button size="tiny" secondary :disabled="!developerMode || !envItem.editableFile?.backupExists" :loading="runtimeDebugSaving === envItem.editablePath" @click="envItem.editableFile && restoreRuntimeDebugFile(envItem.editableFile)">{{ t('debug.runtimeDebugRestore') }}</n-button>
            </div>
          </div>
          <button v-if="envItem.editableFile" type="button" class="runtime-file-editor__path-button" :disabled="!developerMode || !envItem.editableFile.editable" :title="t('debug.runtimeDebugEdit')" @click="openRuntimeDebugEditor(envItem.editableFile)">
            <code class="runtime-file-editor__path runtime-file-editor__path--config">{{ envItem.editablePath }}</code>
          </button>
        </article>
        <n-empty v-if="!runtimeDebugActiveFile && !runtimeDebugEnvironments.length" :description="t('debug.runtimeDebugNoFiles')" />
      </section>
      <div class="runtime-tree">
        <div v-for="node in runtimeTree" :key="node.name" class="runtime-tree__node">
          <div class="runtime-tree__head">
            <span class="runtime-tree__chevron" aria-hidden="true">›</span>
            <strong>{{ node.name }}</strong>
            <span class="runtime-tree__role">{{ node.role }}</span>
            <em>{{ node.source }}</em>
          </div>
          <code class="runtime-tree__path" :title="node.path">{{ node.path }}</code>
          <div v-if="node.children.length" class="runtime-tree__children">
            <div v-for="child in node.children" :key="`${node.name}-${child.name}`" class="runtime-tree__child">
              <span class="runtime-tree__branch" aria-hidden="true">└</span>
              <div class="runtime-tree__child-main">
                <div class="runtime-tree__child-head">
                  <strong>{{ child.name }}</strong>
                  <span>{{ child.role }}</span>
                </div>
                <code :title="child.path">{{ child.path }}</code>
              </div>
            </div>
          </div>
        </div>
        <n-empty v-if="!app.runtimeInfo" :description="t('debug.envNotChecked')" />
      </div>
    </n-card>

    <n-modal v-model:show="runtimeDebugEditorVisible" preset="card" style="width: min(760px, 92vw)" :mask-closable="true" @after-leave="runtimeDebugEditingPath = ''; runtimeDebugEditingContent = ''">
      <template #header>
        <div class="debug-section-title">
          <n-icon :component="TerminalOutline" />
          <span>{{ t('debug.runtimeDebugEditorTitle') }}</span>
        </div>
      </template>
      <div class="runtime-debug-editor-modal">
        <div class="kv-list">
          <div class="kv-row">
            <span>{{ t('debug.runtimeDebugEditPath') }}</span>
            <code :title="runtimeDebugEditingPath">{{ runtimeDebugEditingPath || '-' }}</code>
          </div>
        </div>
        <n-input
          v-model:value="runtimeDebugEditingContent"
          type="textarea"
          size="small"
          :autosize="{ minRows: 12, maxRows: 24 }"
          :placeholder="t('debug.runtimeDebugEmptyFile')"
        />
      </div>
      <template #footer>
        <div class="runtime-debug-editor-modal__footer">
          <n-button secondary @click="runtimeDebugEditorVisible = false">{{ t('common.close') }}</n-button>
          <n-button type="primary" secondary :loading="runtimeDebugSaving === runtimeDebugEditingPath" @click="saveRuntimeDebugEditor">
            {{ t('common.save') }}
          </n-button>
        </div>
      </template>
    </n-modal>

    <section v-if="activeTab === 'models'" class="debug-model-workbench">
      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="TerminalOutline" />
            <span>{{ t('debug.debugCatalogTitle') }}</span>
          </div>
        </template>
        <div class="debug-editor-meta">
          <div class="kv-row">
            <span>{{ t('debug.debugCatalogPath') }}</span>
            <code>{{ debugCatalogInfo?.debugCatalogPath || '-' }}</code>
          </div>
          <n-alert type="info" :show-icon="true">
            {{ t('debug.debugCatalogHint') }}
          </n-alert>
        </div>
        <div class="catalog-mode-switch">
          <n-button-group size="small">
            <n-button :type="catalogEditMode === 'simple' ? 'primary' : 'default'" secondary @click="switchCatalogEditMode('simple')">
              {{ t('debug.catalogSimpleMode') }}
            </n-button>
            <n-button :type="catalogEditMode === 'advanced' ? 'primary' : 'default'" secondary @click="switchCatalogEditMode('advanced')">
              {{ t('debug.catalogAdvancedMode') }}
            </n-button>
          </n-button-group>
          <n-button size="small" secondary @click="addCatalogModel">
            {{ t('debug.addCatalogModel') }}
          </n-button>
        </div>
        <div v-if="catalogEditMode === 'simple'" class="catalog-simple-list">
          <n-input v-model:value="catalogSearch" size="small" clearable :placeholder="t('debug.catalogSearch')" />
          <button
            v-for="model in visibleCatalogModels"
            :key="model.name"
            type="button"
            class="catalog-model-row"
            @click="selectCatalogModel(model.name)"
          >
            <div class="catalog-model-row__main">
              <strong>{{ model.name }}</strong>
              <span>{{ model.model_type || model.architecture || '-' }} · {{ model.primary_category || '-' }}</span>
            </div>
            <n-tag v-if="catalogModelStatus(model) === 'modified'" size="small" type="error" :bordered="false">
              {{ t('debug.catalogStatusModified') }}
            </n-tag>
            <n-tag v-else-if="catalogModelStatus(model) === 'added'" size="small" type="error" :bordered="false">
              {{ t('debug.catalogStatusAdded') }}
            </n-tag>
          </button>
          <n-empty v-if="!visibleCatalogModels.length" :description="t('debug.catalogNoModels')" />
        </div>
        <n-input
          v-else
          v-model:value="debugCatalogText"
          type="textarea"
          class="debug-code-editor"
          :autosize="{ minRows: 14, maxRows: 24 }"
          spellcheck="false"
        />
        <n-modal
          v-model:show="catalogModelDialogVisible"
          preset="card"
          :title="t('debug.catalogModelDialogTitle')"
          :style="{ width: 'min(820px, calc(100vw - 48px))' }"
        >
          <div class="catalog-model-form">
            <div class="catalog-form-grid">
              <label>
                <span>{{ t('debug.catalogFieldName') }}</span>
                <n-input v-model:value="catalogModelDraft.name" size="small" />
              </label>
              <label>
                <span>{{ t('debug.catalogFieldAliases') }}</span>
                <n-input v-model:value="catalogModelDraft.aliasesText" size="small" />
              </label>
              <label>
                <span>{{ t('debug.catalogFieldModelType') }}</span>
                <n-input v-model:value="catalogModelDraft.model_type" size="small" />
              </label>
              <label>
                <span>{{ t('debug.catalogFieldArchitecture') }}</span>
                <n-input v-model:value="catalogModelDraft.architecture" size="small" />
              </label>
              <label class="catalog-form-grid__wide">
                <span>{{ t('debug.catalogFieldRelpath') }}</span>
                <n-input v-model:value="catalogModelDraft.relpath" size="small" />
              </label>
              <label class="catalog-form-grid__wide">
                <span>{{ t('debug.catalogFieldDownloadUrl') }}</span>
                <n-input :value="currentCatalogDownloadUrl(catalogModelDraft.relpath) || '-'" size="small" readonly />
              </label>
              <label class="catalog-form-grid__wide">
                <span>{{ t('debug.catalogFieldConfigRelpath') }}</span>
                <n-input v-model:value="catalogModelDraft.config_relpath" size="small" />
              </label>
              <label>
                <span>{{ t('debug.catalogFieldPrimaryCategory') }}</span>
                <n-input v-model:value="catalogModelDraft.primary_category" size="small" />
              </label>
              <label>
                <span>{{ t('debug.catalogFieldPrimaryCategoryCn') }}</span>
                <n-input v-model:value="catalogModelDraft.primary_category_cn" size="small" />
              </label>
              <label>
                <span>{{ t('debug.catalogFieldSecondaryCategory') }}</span>
                <n-input v-model:value="catalogModelDraft.secondary_category" size="small" />
              </label>
              <label>
                <span>{{ t('debug.catalogFieldTargetStem') }}</span>
                <n-input v-model:value="catalogModelDraft.target_stem" size="small" />
              </label>
              <label>
                <span>{{ t('debug.catalogFieldSize') }}</span>
                <n-input-number v-model:value="catalogModelDraft.size_bytes" size="small" :min="0" class="catalog-number" />
              </label>
              <label class="catalog-checkbox-row">
                <n-checkbox v-model:checked="catalogModelDraft.supported">
                  {{ t('debug.catalogFieldSupported') }}
                </n-checkbox>
              </label>
            </div>
          </div>
          <template #footer>
            <div class="debug-editor-actions">
              <n-button secondary :disabled="!selectedCatalogModelName" @click="removeCatalogModel(selectedCatalogModelName); catalogModelDialogVisible = false">
                {{ t('debug.removeCatalogModel') }}
              </n-button>
              <n-button secondary @click="catalogModelDialogVisible = false">
                {{ t('common.cancel') }}
              </n-button>
              <n-button type="primary" @click="saveCatalogDraft">
                {{ t('debug.applyCatalogModel') }}
              </n-button>
            </div>
          </template>
        </n-modal>
        <div class="debug-editor-actions">
          <n-button secondary :loading="debugCatalogLoading" @click="loadDebugCatalog">
            {{ t('common.refresh') }}
          </n-button>
          <n-button secondary type="warning" :loading="debugCatalogSaving" @click="resetDebugCatalog">
            {{ t('debug.restorePymssCatalog') }}
          </n-button>
          <n-button type="primary" :loading="debugCatalogSaving" @click="saveDebugCatalog">
            {{ t('debug.saveDebugCatalog') }}
          </n-button>
        </div>
      </n-card>

      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="FolderOpenOutline" />
            <span>{{ t('debug.modelConfigTitle') }}</span>
          </div>
        </template>
        <div class="debug-config-controls">
          <n-select
            v-model:value="selectedDebugModel"
            :options="debugModelOptions"
            filterable
            clearable
            :placeholder="t('debug.pickModel')"
          />
          <n-button secondary :disabled="!selectedDebugModel" :loading="debugConfigLoading" @click="loadDebugModelConfig">
            {{ t('common.refresh') }}
          </n-button>
        </div>
        <div v-if="debugModelConfig" class="debug-editor-meta">
          <n-alert v-if="debugModelConfig.readOnly" type="warning" :show-icon="true">
            {{ t('debug.userConfigReadonlyHint') }}
          </n-alert>
          <div class="kv-row">
            <span>{{ t('debug.effectiveConfigPath') }}</span>
            <code>{{ debugModelConfig.effectiveConfigPath || '-' }}</code>
          </div>
          <div class="kv-row">
            <span>{{ t('debug.baseConfigPath') }}</span>
            <code>{{ debugModelConfig.baseConfigPath || '-' }}</code>
          </div>
        </div>
        <n-input
          v-model:value="debugConfigText"
          type="textarea"
          class="debug-code-editor"
          :autosize="{ minRows: 14, maxRows: 24 }"
          spellcheck="false"
          :disabled="debugModelConfig?.readOnly"
        />
        <div class="debug-editor-actions">
          <n-button secondary :disabled="!debugModelConfig || debugModelConfig.readOnly" :loading="debugConfigLoading" @click="resetDebugModelConfig">
            {{ t('debug.restoreModelConfig') }}
          </n-button>
          <n-button type="primary" :disabled="!debugModelConfig || debugModelConfig.readOnly || !debugModelConfig.baseConfigPath" :loading="debugConfigSaving" @click="saveDebugModelConfig">
            {{ t('debug.saveDebugConfig') }}
          </n-button>
        </div>
      </n-card>
    </section>

    <section v-if="activeTab === 'overview'" class="debug-grid">
      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="TimeOutline" />
            <span>{{ t('debug.activeTasks') }}</span>
          </div>
        </template>
        <div class="task-debug-list">
          <div v-for="item in runningTasks" :key="item.id" class="task-debug-row">
            <strong>{{ shortTaskId(item.id) }}</strong>
            <span>{{ item.status }}</span>
            <code :title="item.input">{{ item.model }}</code>
          </div>
          <n-empty v-if="!runningTasks.length" :description="t('debug.noActiveTasks')" />
        </div>
      </n-card>

      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="CloudDownloadOutline" />
            <span>{{ t('debug.downloadTasks') }}</span>
          </div>
        </template>
        <div class="task-debug-list">
          <div v-for="item in Object.values(downloadTasks)" :key="item.taskId" class="task-debug-row">
            <strong>{{ item.model }}</strong>
            <span>{{ item.status }} · {{ item.progress }}%</span>
            <code>{{ item.completedFiles }} / {{ item.totalFiles }}</code>
          </div>
          <n-empty v-if="!Object.values(downloadTasks).length" :description="t('debug.noDownloadTasks')" />
        </div>
      </n-card>
    </section>

    <n-card v-if="activeTab === 'events'" class="debug-card debug-card--events" :bordered="true" size="small">
      <template #header>
        <div class="debug-section-title">
          <n-icon :component="TerminalOutline" />
          <span>{{ t('debug.workerEvents') }}</span>
        </div>
      </template>
      <div class="worker-event-list">
        <button
          v-for="group in recentWorkerEventGroups"
          :key="group.key"
          type="button"
          class="worker-event-row"
          @click="openWorkerEvent(group)"
        >
          <code>{{ group.taskId ? t('debug.workerEventTaskGroup') : group.latestType }}</code>
          <span>{{ shortTaskId(group.taskId) }}</span>
          <span>{{ workerEventGroupSummary(group) }}</span>
          <time>{{ eventTime(group.lastTimestamp) }}</time>
          <strong>{{ group.eventCount }}</strong>
        </button>
        <n-empty v-if="!recentWorkerEventGroups.length" :description="t('settings.developerNoWorkerEvents')" />
      </div>
      <n-modal
        v-model:show="workerEventDialogVisible"
        preset="card"
        :title="workerEventGroupTitle(selectedWorkerEvent)"
        :style="{ width: 'min(920px, calc(100vw - 48px))' }"
      >
        <div class="worker-event-modal-meta">
          <span>{{ shortTaskId(selectedWorkerEvent?.taskId) }}</span>
          <span>{{ t('debug.workerEventCount', { count: selectedWorkerEvent?.eventCount || 0 }) }}</span>
          <span>{{ workerEventGroupSummary(selectedWorkerEvent) }}</span>
          <time>{{ eventTime(selectedWorkerEvent?.lastTimestamp) }}</time>
        </div>
        <pre class="worker-event-modal-payload">{{ workerEventGroupPayload(selectedWorkerEvent) }}</pre>
      </n-modal>
    </n-card>

    <n-card v-if="activeTab === 'logs'" class="debug-card debug-card--logs" :bordered="true" size="small">
      <template #header>
        <div class="debug-section-title">
          <n-icon :component="TerminalOutline" />
          <span>{{ t('debug.sessionLog') }}</span>
        </div>
      </template>
      <div class="debug-log-toolbar">
        <n-button size="small" secondary :loading="debugLogLoading" @click="loadDebugLog">
          {{ t('common.refresh') }}
        </n-button>
        <n-button size="small" secondary :disabled="!debugLogInfo?.logsDir" @click="revealPath(debugLogInfo?.logsDir || logsDir)">
          {{ t('debug.openLogsDir') }}
        </n-button>
        <n-button size="small" secondary :disabled="!debugLogContent?.content" @click="copyDebugLog">
          {{ t('debug.copyLog') }}
        </n-button>
        <n-button size="small" secondary :loading="debugLogReportLoading" @click="createDebugLogReport">
          {{ t('debug.createReport') }}
        </n-button>
        <n-button size="small" secondary :disabled="!debugLogInfo?.reportExists" @click="revealPath(debugLogInfo?.reportPath || '')">
          {{ t('debug.openReport') }}
        </n-button>
        <n-button size="small" secondary type="warning" :loading="debugLogClearing" @click="clearDebugLog">
          {{ t('debug.clearLog') }}
        </n-button>
      </div>
      <div class="kv-list debug-log-meta">
        <div v-for="row in debugLogRows" :key="row.label" class="kv-row">
          <span>{{ row.label }}</span>
          <code :title="row.value || '-'">{{ row.value || '-' }}</code>
        </div>
      </div>
      <n-alert v-if="debugLogContent?.truncated" type="warning" :show-icon="true">
        {{ t('debug.logTailHint') }}
      </n-alert>
      <pre v-if="debugLogContent?.content" class="debug-log-content">{{ debugLogContent.content }}</pre>
      <n-empty v-else :description="t('debug.logEmpty')" />
    </n-card>
    </div>
  </div>
</template>

<style scoped>
.debug-page {
  position: relative;
  display: grid;
  gap: 14px;
  max-width: var(--page-max-width);
}

.debug-page--locked::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 3;
  border-radius: 16px;
  background:
    radial-gradient(circle at 18% 8%, color-mix(in srgb, var(--primary) 10%, transparent), transparent 34%),
    linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 64%, transparent), color-mix(in srgb, var(--surface-1) 88%, transparent));
  backdrop-filter: blur(6px) saturate(0.85);
  pointer-events: auto;
}

.debug-page__lock {
  position: absolute;
  z-index: 4;
  top: min(24vh, 180px);
  left: 50%;
  width: min(520px, calc(100% - 48px));
  transform: translateX(-50%);
  pointer-events: none;
}

.debug-lock-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 16px;
  padding: 20px;
  border: 1px solid color-mix(in srgb, var(--outline) 62%, transparent);
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-1) 92%, transparent);
  box-shadow: 0 18px 52px color-mix(in srgb, #27324a 14%, transparent);
  pointer-events: auto;
}

.debug-lock-card__icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
  font-size: 22px;
}

.debug-lock-card__copy {
  display: grid;
  gap: 5px;
}

.debug-lock-card__copy strong {
  color: var(--on-surface);
  font-size: 16px;
}

.debug-lock-card__copy p {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.65;
}

.debug-page__content {
  display: grid;
  gap: 14px;
}

.debug-page__content--locked {
  user-select: none;
}

.debug-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.debug-tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--outline) 50%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-1) 70%, transparent);
}

.debug-tab {
  flex: 0 0 auto;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--on-surface-muted);
  cursor: pointer;
  font-size: 13px;
}

.debug-tab--active {
  background: color-mix(in srgb, var(--primary) 18%, transparent);
  color: var(--on-surface);
}

.debug-model-workbench {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.debug-editor-meta {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
}

.debug-config-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  margin-bottom: 12px;
}

.debug-code-editor :deep(textarea) {
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.55;
}

.debug-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.catalog-mode-switch {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.catalog-simple-editor {
  display: grid;
  grid-template-columns: minmax(180px, 0.44fr) minmax(0, 1fr);
  gap: 12px;
  min-height: 420px;
}

.catalog-simple-list {
  display: grid;
  gap: 8px;
  max-height: 620px;
  overflow: auto;
  padding-right: 4px;
}

.catalog-model-list {
  display: grid;
  align-content: start;
  gap: 8px;
  max-height: 560px;
  overflow: auto;
  padding-right: 4px;
}

.catalog-model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 32%, transparent);
  color: var(--on-surface);
  text-align: left;
  cursor: pointer;
}

.catalog-model-row__main {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.catalog-model-row--active {
  border-color: color-mix(in srgb, var(--primary) 58%, var(--outline));
  background: color-mix(in srgb, var(--primary) 10%, var(--surface-2));
}

.catalog-model-row strong,
.catalog-model-row span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalog-model-row span {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.catalog-model-form {
  min-width: 0;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 28%, transparent);
}

.catalog-model-modal {
  width: min(760px, calc(100vw - 32px));
}

.catalog-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.catalog-form-grid label {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.catalog-form-grid label span {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.catalog-form-grid__wide {
  grid-column: 1 / -1;
}

.catalog-number {
  width: 100%;
}

.catalog-checkbox-row {
  align-content: end;
}

.debug-status-grid,
.debug-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.debug-status-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.debug-status-card {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--outline) 52%, transparent);
  background: color-mix(in srgb, var(--surface-1) 72%, transparent);
}

.debug-status-card span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.debug-status-card strong {
  color: var(--on-surface);
  font-size: 24px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.debug-status-card--ok {
  border-color: color-mix(in srgb, var(--success) 26%, var(--outline));
}

.debug-status-card--warn {
  border-color: color-mix(in srgb, var(--warning) 42%, var(--outline));
}

.debug-card {
  border-color: color-mix(in srgb, var(--outline) 58%, transparent) !important;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.025), transparent 42%),
    color-mix(in srgb, var(--surface-1) 72%, transparent) !important;
}

.debug-card :deep(.n-card__header) {
  padding: 16px 18px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
}

.debug-card :deep(.n-card__content) {
  padding: 14px 18px 18px;
}

.runtime-tree {
  display: grid;
  gap: 10px;
  font-size: 12px;
}

.runtime-debug-panel,
.runtime-file-editor-list {
  display: grid;
  gap: 10px;
  margin-bottom: 14px;
}

.runtime-file-editor-list {
  gap: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 30%, transparent);
}

.runtime-debug-toolbar,
.runtime-file-editor__head,
.runtime-file-editor__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.runtime-debug-toolbar,
.runtime-file-editor__head {
  justify-content: space-between;
}

.runtime-override-form {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.runtime-file-editor {
  display: grid;
  gap: 8px;
  padding: 13px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 34%, transparent);
  background: transparent;
}

.runtime-file-editor:last-of-type {
  border-bottom: 0;
}

.runtime-file-editor__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.runtime-file-editor__title strong {
  min-width: 86px;
  color: var(--on-surface);
  font-size: 13px;
  line-height: 1.35;
}

.runtime-file-editor__actions {
  flex: 0 0 auto;
  justify-content: flex-end;
}

.runtime-file-editor__head span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.runtime-file-editor__path {
  display: block;
  overflow: hidden;
  color: var(--on-surface-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-file-editor__path--config {
  color: color-mix(in srgb, var(--on-surface-muted) 88%, var(--primary));
}

.runtime-file-editor__path-button {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.runtime-file-editor__path-button .runtime-file-editor__path {
  display: block;
  width: 100%;
}

.runtime-file-editor__path-button:disabled {
  cursor: default;
}

.runtime-file-editor__path-button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
  border-radius: 6px;
}

.runtime-debug-editor-modal {
  display: grid;
  gap: 10px;
}

.runtime-debug-editor-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.debug-log-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.debug-log-meta {
  margin-bottom: 12px;
}

.debug-log-content {
  overflow: auto;
  max-height: min(58vh, 620px);
  margin: 12px 0 0;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, #0c111d 92%, var(--surface-1));
  color: #d9e2f1;
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.runtime-tree__node {
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 42%, transparent);
}

.runtime-tree__head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.runtime-tree__chevron {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  color: var(--primary);
  font-size: 20px;
  line-height: 1;
  transform: translateY(-1px);
}

.runtime-tree__role,
.runtime-tree__head em,
.runtime-tree__child-head span {
  color: var(--on-surface-muted);
  font-style: normal;
}

.runtime-tree__head em {
  margin-left: auto;
  color: var(--primary);
  font-size: 11px;
  white-space: nowrap;
}

.runtime-tree__path {
  display: block;
  margin: 8px 0 0 26px;
  min-width: 0;
  overflow: hidden;
  color: var(--on-surface);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-tree__children {
  display: grid;
  gap: 8px;
  margin: 12px 0 0 26px;
  padding-left: 14px;
  border-left: 1px solid color-mix(in srgb, var(--outline) 64%, transparent);
}

.runtime-tree__child {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  color: var(--on-surface-muted);
}

.runtime-tree__branch {
  color: var(--outline);
  font-size: 16px;
  line-height: 18px;
}

.runtime-tree__child-main {
  min-width: 0;
}

.runtime-tree__child-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.runtime-tree__child-main code {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.debug-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
}

.diagnostic-list,
.kv-list,
.task-debug-list,
.worker-event-list {
  display: grid;
  gap: 8px;
}

.diagnostic-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 10px;
  padding: 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 42%, transparent);
}

.diagnostic-row--ok { color: var(--success); }
.diagnostic-row--warn { color: var(--warning); }
.diagnostic-row--error { color: var(--danger); }

.diagnostic-row__main {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--on-surface);
}

.diagnostic-row__main span,
.kv-row span,
.path-debug-row span,
.task-debug-row span,
.cuda-row span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.diagnostic-row__main code,
.kv-row code,
.path-debug-row code,
.task-debug-row code,
.cuda-row code,
.worker-event-row code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
  font-size: 12px;
}

.kv-row,
.path-debug-row,
.task-debug-row,
.cuda-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 36%, transparent);
}

.path-debug-grid {
  display: grid;
  gap: 8px;
}

.path-debug-row {
  grid-template-columns: 150px minmax(0, 1fr) auto;
}

.cuda-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
}

.cuda-list h3 {
  margin: 0;
  font-size: 13px;
}

.cuda-row {
  grid-template-columns: 80px minmax(0, 1fr) auto;
}

.task-debug-row {
  grid-template-columns: minmax(0, 1fr) auto minmax(120px, 0.5fr);
}

.task-debug-row strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.worker-event-row {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(100px, 0.7fr) minmax(180px, 1.4fr) auto auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 36%, transparent);
  color: var(--on-surface);
  text-align: left;
  cursor: pointer;
}

.worker-event-row span,
.worker-event-row time {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.worker-event-row strong {
  justify-self: end;
  min-width: 28px;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
  font-size: 12px;
  text-align: center;
}

.worker-event-modal-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.worker-event-modal-payload {
  max-height: min(620px, 70vh);
  margin: 0;
  overflow: auto;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 40%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 40%, transparent);
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 980px) {
  .debug-status-grid,
  .debug-grid,
  .debug-model-workbench {
    grid-template-columns: 1fr;
  }

  .catalog-simple-editor,
  .catalog-form-grid {
    grid-template-columns: 1fr;
  }

  .path-debug-row,
  .task-debug-row,
  .debug-config-controls,
  .runtime-override-form,
  .worker-event-row {
    grid-template-columns: 1fr;
  }

  .runtime-file-editor__head {
    align-items: flex-start;
    flex-direction: column;
  }

  .runtime-file-editor__actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .runtime-tree__head {
    flex-wrap: wrap;
    gap: 6px 9px;
  }

  .runtime-tree__head em {
    width: 100%;
    margin-left: 26px;
  }

  .debug-page__lock {
    top: 96px;
    width: calc(100% - 28px);
  }

  .debug-lock-card {
    grid-template-columns: 1fr;
    justify-items: center;
    text-align: center;
  }
}
</style>
