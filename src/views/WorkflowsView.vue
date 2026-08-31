<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDialog, useMessage, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  AlertCircleOutline,
  CheckmarkCircle,
  CubeOutline,
  EllipsisHorizontalOutline,
  GitNetworkOutline,
  MusicalNotesOutline,
  OpenOutline,
  PlayOutline,
  SearchOutline,
} from '@vicons/ionicons5'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { storeToRefs } from 'pinia'
import WorkflowCreateChooser from '@/components/workflow/WorkflowCreateChooser.vue'
import WorkflowRevisionConflictModal from '@/components/workflow/WorkflowRevisionConflictModal.vue'
import WorkflowSimpleCreator from '@/components/workflow/WorkflowSimpleCreator.vue'
import { useModelStore } from '@/stores/model'
import {
  useWorkflowStore,
  WorkflowRevisionConflictError,
  type WorkflowEntry,
} from '@/stores/workflow'
import {
  analyzeSimpleWorkflow,
  resolveWorkflowOpenMode,
  type SimpleWorkflowReasonCode,
  type SimpleWorkflowSavePayload,
} from '@/utils/workflowSimple'
import {
  isWorkflowEditorSurfaceLocked,
  isWorkflowLockedByNodeEditor,
} from '@/utils/workflowEditorState'
import { convertSimpleWorkflowToGraph } from '@/workflows/simpleToGraph'
import { isGraphWorkflowDefinition, isSimpleWorkflowDefinition } from '@/workflows/formats'
import {
  countWorkflowSaveOutputs,
  getWorkflowDefinitionIssue,
} from '@/workflows/runtimeDefinition'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const workflow = useWorkflowStore()
const model = useModelStore()
const { workflows, selectedWorkflowId, selectedWorkflow, nodeEditorOpenWorkflowId } = storeToRefs(workflow)
const { downloadedModels, models } = storeToRefs(model)
const editingId = ref('')
const name = ref('')
const description = ref('')
const query = ref('')
const importFileInputRef = ref<HTMLInputElement | null>(null)
const createChooserOpen = ref(false)
const simpleEditorOpen = ref(false)
const simpleEditorWorkflow = ref<WorkflowEntry | null>(null)
type WorkflowCreateType = 'simple' | 'advanced'
type SimpleSaveContinuation = 'stay' | 'run'
const pendingSimpleSave = ref<{
  payload: SimpleWorkflowSavePayload
  continuation: SimpleSaveContinuation
} | null>(null)
const showRevisionConflict = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuVisible = ref(false)
const contextWorkflow = ref<WorkflowEntry | null>(null)
let unlistenNodeEditorClosed: UnlistenFn | undefined

const deviceOptions = [
  { label: 'Auto', value: 'auto' },
  { label: 'CPU', value: 'cpu' },
  { label: 'CUDA', value: 'cuda' },
  { label: 'MPS', value: 'mps' },
  { label: 'MLX', value: 'mlx' },
]
const formatOptions = [
  { label: 'WAV', value: 'wav' },
  { label: 'FLAC', value: 'flac' },
  { label: 'MP3', value: 'mp3' },
  { label: 'M4A', value: 'm4a' },
]

const filteredWorkflows = computed(() => {
  const value = query.value.trim().toLowerCase()
  if (!value) return workflows.value
  return workflows.value.filter(item =>
    item.name.toLowerCase().includes(value)
    || item.description.toLowerCase().includes(value),
  )
})

const isNodeEditorOpen = computed(() => isWorkflowEditorSurfaceLocked(
  nodeEditorOpenWorkflowId.value,
  selectedWorkflowId.value,
  nodeEditorOpenWorkflowId.value === '__new__',
))

function workflowDefinitionError(definition: Record<string, unknown>): string {
  const issue = getWorkflowDefinitionIssue(definition)
  if (issue === 'steps-required') return t('workflows.stepsRequired')
  if (issue === 'no-save-outputs') return t('workflows.workflowNoSaveOutputs')
  if (issue === 'invalid-definition') return t('workflows.workflowFormatInvalid')
  if (issue === 'invalid-format') return t('workflows.workflowFormatInvalid')
  return ''
}
function workflowRunBlocked(definition: Record<string, unknown>) {
  return Boolean(workflowDefinitionError(definition))
}

// ---- Per-item lightweight status (memoized) ----
const workflowStatusMap = computed(() => Object.fromEntries(
  workflows.value.map(item => [item.id, workflowRunBlocked(item.definition)]),
))
function isWorkflowBlocked(item: WorkflowEntry) {
  return Boolean(workflowStatusMap.value[item.id])
}

const workflowMenuOptions = computed<DropdownOption[]>(() => {
  const current = contextWorkflow.value
  if (!current) return []
  const isSimpleDefinition = isSimpleWorkflowDefinition(current.definition)
  const canEditSimple = isSimpleDefinition && analyzeSimpleWorkflow(current.definition).editable
  const definitionError = workflowDefinitionError(current.definition)
  const options: DropdownOption[] = [
    {
      key: 'edit',
      label: canEditSimple
        ? t('workflows.simpleMode')
        : isSimpleDefinition
            ? t('workflows.convertToAdvancedCopy')
            : t('workflows.openAdvancedEditor'),
      disabled: isSimpleDefinition && !canEditSimple && Boolean(definitionError),
    },
    {
      key: 'run',
      label: t('workflows.runWorkflowAction'),
      disabled: isWorkflowBlocked(current),
    },
  ]
  if (isSimpleDefinition && canEditSimple) {
    options.push({
      key: 'convert',
      label: t('workflows.convertToAdvancedCopy'),
      disabled: Boolean(definitionError),
    })
  }
  options.push(
    { type: 'divider', key: 'workflow-actions-divider' },
    { key: 'duplicate', label: t('workflows.duplicate') },
    { key: 'export', label: t('workflows.exportWorkflow') },
    { key: 'delete', label: t('workflows.deleteConfirm') },
  )
  return options
})

// ---- Selected workflow overview data (simple-mode details; comfy graphs
// show a read-only overview since their structure is free-form) ----
import { hydrateSimpleWorkflow, analyzeComfyOverview } from '@/utils/workflowSimple'
const selectedComfyOverview = computed(() => analyzeComfyOverview(selectedWorkflow.value?.definition))
const isComfyWorkflow = computed(() => isGraphWorkflowDefinition(selectedWorkflow.value?.definition))
const isSimpleWorkflow = computed(() => isSimpleWorkflowDefinition(selectedWorkflow.value?.definition))
const selectedDraft = computed(() =>
  isSimpleWorkflowDefinition(selectedWorkflow.value?.definition)
    ? hydrateSimpleWorkflow(selectedWorkflow.value?.definition)
    : null)
const selectedSummary = computed((): { error: string } | null =>
  selectedWorkflow.value ? { error: workflowDefinitionError(selectedWorkflow.value.definition) } : null)
const selectedStemCount = computed(() =>
  selectedDraft.value && selectedDraft.value.steps.length
    ? selectedDraft.value.steps.reduce((total, step) => total + step.stems.length, 0)
    : 0)
const selectedModels = computed(() => {
  if (isComfyWorkflow.value) {
    const downloaded = new Set(downloadedModels.value.map(item => item.name))
    return (selectedComfyOverview.value?.models || []).map(name => ({ name, downloaded: downloaded.has(name) }))
  }
  const draft = selectedDraft.value
  if (!draft || !draft.steps.length) return [] as { name: string; downloaded: boolean }[]
  const downloaded = new Set(downloadedModels.value.map(item => item.name))
  const seen = new Set<string>()
  const list: { name: string; downloaded: boolean }[] = []
  for (const step of draft.steps) {
    const modelName = step.model.trim()
    if (!modelName || seen.has(modelName)) continue
    seen.add(modelName)
    list.push({ name: modelName, downloaded: downloaded.has(modelName) })
  }
  return list
})
const selectedError = computed(() => selectedSummary.value?.error || '')
const selectedSaveOutputCount = computed(() => {
  const def = selectedWorkflow.value?.definition
  return def ? countWorkflowSaveOutputs(def) : 0
})
const selectedReady = computed(() => Boolean(selectedWorkflow.value) && !selectedError.value)
const selectedSimpleAnalysis = computed(() => selectedWorkflow.value
  ? analyzeSimpleWorkflow(selectedWorkflow.value.definition)
  : null)
const selectedSimpleReasons = computed(() => selectedSimpleAnalysis.value?.reasonCodes || [])

const simpleReasonKeys: Record<SimpleWorkflowReasonCode, string> = {
  graph_workflow: 'workflows.simpleReasonGraphWorkflow',
  advanced_parameters: 'workflows.simpleReasonAdvancedParameters',
  invalid_definition: 'workflows.simpleReasonInvalidDefinition',
}

function simpleReasonLabel(reason: SimpleWorkflowReasonCode) {
  return t(simpleReasonKeys[reason])
}

async function updateSelectedWorkflowDefaults(patch: {
  defaultDevice?: string
  defaultFormat?: string
}) {
  const current = selectedWorkflow.value
  const draft = selectedDraft.value
  if (!current || !draft || !selectedSimpleAnalysis.value?.editable || isNodeEditorOpen.value) return
  const definition = JSON.parse(JSON.stringify(current.definition)) as Record<string, unknown>
  const device = patch.defaultDevice ?? draft.defaultDevice
  const fmt = patch.defaultFormat ?? draft.defaultFormat
  const defaults = definition.defaults && typeof definition.defaults === 'object' && !Array.isArray(definition.defaults)
    ? definition.defaults as Record<string, unknown>
    : {}
  defaults.device = device
  defaults.output_format = fmt
  const inference = (defaults.inference_params as Record<string, unknown>) || {}
  inference.normalize = draft.defaultNormalize
  defaults.inference_params = inference
  definition.defaults = defaults
  try {
    const entry = await workflow.saveWorkflow({
      id: current.id,
      name: current.name,
      description: current.description,
      definition,
      expectedUpdatedAt: current.updatedAt,
    })
    // The selected workflow may change while persistence is in flight. Do
    // not overwrite the newly selected editor fields with the old entry.
    if (selectedWorkflowId.value !== current.id) return
    editWorkflow(entry)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

function updateSelectedDefaultDevice(value: string | number | null) {
  void updateSelectedWorkflowDefaults({ defaultDevice: String(value || 'auto') })
}

function updateSelectedDefaultFormat(value: string | number | null) {
  void updateSelectedWorkflowDefaults({ defaultFormat: String(value || 'wav') })
}


// ---- Selection + quick meta edit ----
function editWorkflow(item: WorkflowEntry) {
  editingId.value = item.id
  name.value = item.name
  description.value = item.description
  workflow.selectWorkflow(item.id)
}

async function saveMeta() {
  const current = selectedWorkflow.value
  if (!current || isNodeEditorOpen.value) return
  const targetId = current.id
  const trimmedName = name.value.trim()
  if (!trimmedName) {
    name.value = current.name
    return
  }
  if (trimmedName === current.name && description.value.trim() === current.description) return
  const entry = await workflow.saveWorkflow({
    id: targetId,
    name: trimmedName,
    description: description.value,
    definition: current.definition,
  })
  // Guard against a race: if the user switched workflows while saveWorkflow was
  // awaiting, do not clobber the newly selected workflow's displayed fields.
  if (selectedWorkflowId.value !== targetId) return
  editingId.value = entry.id
  name.value = entry.name
  description.value = entry.description
}

function cloneWorkflowEntry(item: WorkflowEntry) {
  return JSON.parse(JSON.stringify(item)) as WorkflowEntry
}

function createSimpleWorkflow() {
  editingId.value = ''
  name.value = ''
  description.value = ''
  workflow.selectWorkflow('')
  simpleEditorWorkflow.value = null
  simpleEditorOpen.value = true
}

function openWorkflowCreateChooser() {
  if (nodeEditorOpenWorkflowId.value) return
  createChooserOpen.value = true
}

async function createAdvancedWorkflow() {
  closeSimpleWorkflow()
  editingId.value = ''
  name.value = ''
  description.value = ''
  await openNodeEditor({ forceNew: true, skipWarning: true })
}

function selectWorkflowCreateType(type: WorkflowCreateType) {
  if (type === 'simple') {
    createSimpleWorkflow()
    return
  }
  void createAdvancedWorkflow()
}

function editSimpleWorkflow(item: WorkflowEntry) {
  if (!analyzeSimpleWorkflow(item.definition).editable) return
  simpleEditorWorkflow.value = cloneWorkflowEntry(item)
  simpleEditorOpen.value = true
}

function openWorkflowFromList(item: WorkflowEntry) {
  editWorkflow(item)
  const openMode = resolveWorkflowOpenMode(item.definition)
  if (isWorkflowLockedByNodeEditor(nodeEditorOpenWorkflowId.value, item.id)) {
    if (openMode === 'simple') {
      if (!simpleEditorOpen.value || simpleEditorWorkflow.value?.id !== item.id) {
        editSimpleWorkflow(item)
      }
    } else {
      closeSimpleWorkflow()
    }
    return
  }
  if (openMode === 'simple') {
    editSimpleWorkflow(item)
    return
  }
  closeSimpleWorkflow()
}

function closeSimpleWorkflow() {
  simpleEditorOpen.value = false
  simpleEditorWorkflow.value = null
}

function openWorkflowContextMenu(event: MouseEvent, item: WorkflowEntry) {
  contextWorkflow.value = item
  contextMenuVisible.value = false
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  window.requestAnimationFrame(() => {
    contextMenuVisible.value = true
  })
}

function closeWorkflowContextMenu() {
  contextMenuVisible.value = false
  contextWorkflow.value = null
}

function openSelectedContextMenu(event: MouseEvent) {
  const current = selectedWorkflow.value
  if (!current) return
  openWorkflowContextMenu(event, current)
}

function openWorkflowEditor(item: WorkflowEntry) {
  editWorkflow(item)
  if (isSimpleWorkflowDefinition(item.definition)) {
    if (!analyzeSimpleWorkflow(item.definition).editable) {
      convertSelectedSimpleToAdvanced()
      return
    }
    editSimpleWorkflow(item)
    return
  }
  closeSimpleWorkflow()
  void openNodeEditor({ workflowId: item.id })
}

function handleWorkflowContextMenuSelect(key: string | number) {
  const current = contextWorkflow.value
  closeWorkflowContextMenu()
  if (!current) return

  if (key === 'edit') {
    openWorkflowEditor(current)
    return
  }
  if (key === 'run') {
    editWorkflow(current)
    router.push({ path: '/', query: { mode: 'workflow' } })
    return
  }
  if (key === 'convert') {
    editWorkflow(current)
    convertSelectedSimpleToAdvanced()
    return
  }
  if (key === 'duplicate') {
    void duplicateWorkflow(current)
    return
  }
  if (key === 'export') {
    void exportWorkflowEntry(current)
    return
  }
  if (key === 'delete') {
    deleteWorkflow(current)
  }
}

function cancelSimpleWorkflow() {
  closeSimpleWorkflow()
  editingId.value = ''
  name.value = ''
  description.value = ''
  workflow.selectWorkflow('')
}

async function openAdvancedFromSimple(payload: SimpleWorkflowSavePayload) {
  const confirmed = await confirmSimpleToAdvancedConversion()
  if (!confirmed) return
  try {
    let sourceId = payload.id
    let sourceDefinition = payload.definition
    if (!sourceId) {
      const source = await workflow.saveWorkflow({ ...payload, format: 'simple' })
      sourceId = source.id
      sourceDefinition = source.definition
      editWorkflow(source)
      simpleEditorWorkflow.value = cloneWorkflowEntry(source)
    }
    const definition = convertSimpleWorkflowToGraph(sourceDefinition, {
      models: models.value,
      sourceWorkflowId: sourceId,
    })
    const entry = await workflow.saveWorkflow({
      name: t('workflows.advancedCopyName', { name: payload.name }),
      description: payload.description,
      definition,
      format: 'graph',
      convertedFrom: sourceId,
    })
    closeSimpleWorkflow()
    editWorkflow(entry)
    message.success(t('workflows.advancedCopyCreated'))
    await openNodeEditor({ workflowId: entry.id, skipWarning: true })
  } catch (error) {
    message.error(`${t('workflows.advancedConversionFailed')}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function convertSelectedSimpleToAdvanced() {
  const current = selectedWorkflow.value
  if (!current || !isSimpleWorkflowDefinition(current.definition) || selectedError.value) return
  void openAdvancedFromSimple({
    id: current.id,
    name: current.name,
    description: current.description,
    definition: current.definition,
    expectedUpdatedAt: current.updatedAt,
  })
}

async function saveSimpleWorkflow(
  payload: SimpleWorkflowSavePayload,
  options: {
    continuation?: SimpleSaveContinuation
    force?: boolean
    saveCopy?: boolean
  } = {},
) {
  const continuation = options.continuation || 'stay'
  try {
    const entry = await workflow.saveWorkflow({
      ...payload,
      id: options.saveCopy ? undefined : payload.id,
      name: options.saveCopy ? `${payload.name} Copy` : payload.name,
      expectedUpdatedAt: options.saveCopy ? undefined : payload.expectedUpdatedAt,
      force: options.force,
    })
    pendingSimpleSave.value = null
    showRevisionConflict.value = false
    editWorkflow(entry)
    if (continuation === 'run') {
      closeSimpleWorkflow()
      workflow.selectWorkflow(entry.id)
      await router.push({ path: '/', query: { mode: 'workflow' } })
    } else {
      simpleEditorWorkflow.value = cloneWorkflowEntry(entry)
      message.success(t('workflows.saved'))
    }
  } catch (error) {
    if (error instanceof WorkflowRevisionConflictError) {
      pendingSimpleSave.value = { payload, continuation }
      showRevisionConflict.value = true
      return
    }
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function reloadSimpleConflict() {
  const pending = pendingSimpleSave.value
  if (!pending?.payload.id) return
  await workflow.reload()
  const latest = workflows.value.find(item => item.id === pending.payload.id)
  if (latest) {
    editWorkflow(latest)
    simpleEditorWorkflow.value = cloneWorkflowEntry(latest)
  }
  pendingSimpleSave.value = null
}

function saveSimpleConflictCopy() {
  const pending = pendingSimpleSave.value
  if (!pending) return
  void saveSimpleWorkflow(pending.payload, { continuation: pending.continuation, saveCopy: true })
}

function overwriteSimpleConflict() {
  const pending = pendingSimpleSave.value
  if (!pending) return
  void saveSimpleWorkflow(pending.payload, { continuation: pending.continuation, force: true })
}

function runSimpleWorkflow(payload: SimpleWorkflowSavePayload) {
  void saveSimpleWorkflow(payload, { continuation: 'run' })
}

function duplicateSimpleWorkflow(payload: SimpleWorkflowSavePayload) {
  void saveSimpleWorkflow(payload, { saveCopy: true })
}

function confirmAdvancedWorkflowWarning() {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    dialog.warning({
      title: t('workflows.advancedWarningTitle'),
      content: t('workflows.advancedWarningContent'),
      positiveText: t('workflows.advancedWarningContinue'),
      negativeText: t('workflows.advancedWarningCancel'),
      positiveButtonProps: { type: 'warning' },
      negativeButtonProps: { secondary: true },
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    })
  })
}

function confirmSimpleToAdvancedConversion() {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    dialog.warning({
      title: t('workflows.convertAdvancedTitle'),
      content: t('workflows.convertAdvancedContent'),
      positiveText: t('workflows.convertAdvancedConfirm'),
      negativeText: t('common.cancel'),
      positiveButtonProps: { type: 'warning' },
      negativeButtonProps: { secondary: true },
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    })
  })
}

// ---- Node editor bridge ----
async function openNodeEditor(options: { forceNew?: boolean; workflowId?: string; skipWarning?: boolean } = {}) {
  if (!options.skipWarning) {
    const confirmed = await confirmAdvancedWorkflowWarning()
    if (!confirmed) return
  }

  const forceNew = options.forceNew === true
  // The overview's selected entry is the authoritative target. `editingId`
  // can briefly lag while the store reloads after a standalone editor closes;
  // preferring it here could reopen a different (or legacy) graph as blank.
  const workflowId = forceNew
    ? ''
    : (options.workflowId || selectedWorkflow.value?.id || selectedWorkflowId.value || editingId.value || '')
  const isNewWorkflow = forceNew || !workflowId
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      await invoke('open_workflow_node_editor_window', { payload: { workflowId, newWorkflow: isNewWorkflow } })
      workflow.markNodeEditorOpen(isNewWorkflow ? '__new__' : workflowId)
      return
    } catch (error) {
      console.warn('Failed to open workflow node editor window, falling back to route navigation', error)
    }
  }
  await router.push({ path: '/workflow-node-editor', query: isNewWorkflow ? { new: '1' } : { workflowId } })
}

async function refreshAfterNodeEditorClosed() {
  workflow.markNodeEditorClosed()
  await workflow.reload()
  const target = workflows.value.find(item => item.id === editingId.value)
    || workflow.selectedWorkflow
    || workflows.value[0]
  if (target) openWorkflowFromList(target)
}

// ---- Actions ----
async function duplicateWorkflow(item: WorkflowEntry) {
  const current = item
  if (!current) return
  const entry = await workflow.duplicateWorkflow(current.id)
  if (entry) {
    editWorkflow(entry)
    message.success(t('workflows.duplicated'))
  }
}

function deleteWorkflow(item: WorkflowEntry) {
  const current = item
  if (!current) return
  dialog.warning({
    title: t('workflows.deleteTitle'),
    content: t('workflows.deleteHint', { name: current.name }),
    positiveText: t('workflows.deleteConfirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const deletedId = current.id
      await workflow.deleteWorkflow(current.id)
      if (simpleEditorWorkflow.value?.id === deletedId) closeSimpleWorkflow()
      message.success(t('workflows.deleted'))
    },
  })
}

function deleteSelected() {
  const current = selectedWorkflow.value
  if (!current) return
  deleteWorkflow(current)
}

function runSelected() {
  const current = selectedWorkflow.value
  if (!current) return
  if (selectedError.value) {
    message.warning(selectedError.value)
    return
  }
  workflow.selectWorkflow(current.id)
  router.push({ path: '/', query: { mode: 'workflow' } })
}

// ---- comfy-mss import / export ----
function triggerImportWorkflow() {
  importFileInputRef.value?.click()
}

function workflowFileBasename(fileName: string) {
  return fileName
    .replace(/\.(?:comfy-mss|pymss-workflow)\.json$/iu, '')
    .replace(/\.[^.]+$/u, '')
    .trim()
}

function downloadJsonFile(fileName: string, payload: Record<string, unknown>) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

function workflowSlug(value: string) {
  const normalized = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
  return normalized || 'workflow'
}

async function handleImportWorkflow(event: Event) {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (!isGraphWorkflowDefinition(parsed) && !isSimpleWorkflowDefinition(parsed)) {
      throw new Error(t('workflows.workflowImportInvalid'))
    }
    const entry = await workflow.saveWorkflow({
      name: workflowFileBasename(file.name) || t('workflows.newWorkflow'),
      description: '',
      definition: parsed,
    })
    editWorkflow(entry)
    message.success(t('workflows.workflowImportSuccess'))
  } catch (error) {
    message.error(`${t('workflows.workflowImportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (input) input.value = ''
  }
}

async function exportWorkflowDefinition(
  workflowName: string,
  definition: Record<string, unknown>,
) {
  try {
    const payload = definition
    const suffix = isGraphWorkflowDefinition(definition)
      ? 'comfy-mss.json'
      : 'pymss-workflow.json'
    const fileName = `${workflowSlug(workflowName || t('workflows.untitled'))}.${suffix}`
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    if (isTauri) {
      const content = `${JSON.stringify(payload, null, 2)}\n`
      const savedPath = await invoke<string | null>('save_text_file_dialog', {
        defaultName: fileName,
        content,
      })
      if (!savedPath) return
    } else {
      downloadJsonFile(fileName, payload)
    }
    message.success(t('workflows.workflowExportSuccess'))
  } catch (error) {
    message.error(`${t('workflows.workflowExportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function exportWorkflowEntry(current: WorkflowEntry) {
  if (!current) return
  await exportWorkflowDefinition(current.name, current.definition)
}

function exportSimpleWorkflow(payload: SimpleWorkflowSavePayload) {
  void exportWorkflowDefinition(payload.name, payload.definition)
}

onMounted(async () => {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  unlistenNodeEditorClosed = await listen('pymss://workflow-node-editor-closed', () => {
    void refreshAfterNodeEditorClosed()
  })
})

onUnmounted(() => {
  closeWorkflowContextMenu()
  unlistenNodeEditorClosed?.()
})

watch(workflows, (items) => {
  const current = items.find(item => item.id === editingId.value)
  if (current) {
    // keep local meta in sync with store (e.g. after node editor save / reload)
    name.value = current.name
    description.value = current.description
  } else if (items.length) {
    const preferred = items.find(item => item.id === selectedWorkflowId.value) || items[0]
    openWorkflowFromList(preferred)
  } else {
    editingId.value = ''
    name.value = ''
    description.value = ''
  }
}, { immediate: true, deep: true })
</script>

<template>
  <div class="page workflows-page">
    <input
      ref="importFileInputRef"
      class="wf-hidden-file-input"
      type="file"
      accept=".json,application/json"
      @change="handleImportWorkflow"
    >

    <header class="page-header-compact">
      <div>
        <h1>{{ t('workflows.title') }}</h1>
        <p>{{ t('workflows.subtitle') }}</p>
      </div>
      <div class="workflows-page__header-actions">
        <n-button secondary @click="triggerImportWorkflow">
          <template #icon><n-icon :component="OpenOutline" /></template>
          {{ t('workflows.importWorkflow') }}
        </n-button>
        <n-button
          class="workflow-create-button"
          type="primary"
          :disabled="Boolean(nodeEditorOpenWorkflowId)"
          @click="openWorkflowCreateChooser"
        >
          <span class="workflow-create-button__mark" aria-hidden="true" />
          {{ t('workflows.newWorkflow') }}
        </n-button>
      </div>
    </header>

    <div class="console">
      <aside class="console__rail">
        <div class="wf-list-head">
          <n-input v-model:value="query" clearable :placeholder="t('workflows.searchPlaceholder')">
            <template #prefix><n-icon :component="SearchOutline" /></template>
          </n-input>
        </div>
        <div class="wf-list-scroll">
          <div v-if="filteredWorkflows.length" class="wf-list">
            <button
              v-for="item in filteredWorkflows"
              :key="item.id"
              type="button"
              class="wf-row"
              :class="{ 'wf-row--active': item.id === selectedWorkflowId }"
              @click="openWorkflowFromList(item)"
              @contextmenu.stop.prevent="openWorkflowContextMenu($event, item)"
            >
              <span class="wf-row__icon"><n-icon :component="GitNetworkOutline" /></span>
              <span class="wf-row__main">
                <strong>{{ item.name }}</strong>
                <small>{{ item.description || t('workflows.noDescription') }}</small>
              </span>
              <span
                class="wf-row__dot"
                :class="isWorkflowBlocked(item) ? 'wf-row__dot--warn' : 'wf-row__dot--ok'"
                :title="isWorkflowBlocked(item) ? t('workflows.workflowValidationTitle') : t('workflows.statusReady')"
              />
            </button>
          </div>
          <div v-else class="wf-empty">
            <n-icon :component="GitNetworkOutline" />
            <strong>{{ t('workflows.emptyTitle') }}</strong>
            <span>{{ t('workflows.emptyDesc') }}</span>
            <n-button class="workflow-create-button" type="primary" size="small" @click="openWorkflowCreateChooser">
              <span class="workflow-create-button__mark" aria-hidden="true" />
              {{ t('workflows.newWorkflow') }}
            </n-button>
          </div>
        </div>
      </aside>

      <main class="console__stage">
        <WorkflowSimpleCreator
          v-if="simpleEditorOpen"
          :key="simpleEditorWorkflow ? `${simpleEditorWorkflow.id}:${simpleEditorWorkflow.updatedAt}` : 'new'"
          :workflow="simpleEditorWorkflow"
          :models="downloadedModels"
          :saving="workflow.isSaving"
          @save="saveSimpleWorkflow"
          @open-advanced="openAdvancedFromSimple"
          @run="runSimpleWorkflow"
          @duplicate="duplicateSimpleWorkflow"
          @export="exportSimpleWorkflow"
          @delete="deleteSelected"
          @cancel="cancelSimpleWorkflow"
        />

        <div v-else-if="!selectedWorkflow || selectedSimpleAnalysis?.editable" class="wf-overview-empty">
          <n-icon :component="GitNetworkOutline" />
          <strong>{{ t('workflows.overviewEmptyTitle') }}</strong>
          <span>{{ t('workflows.overviewEmptyDesc') }}</span>
          <n-button class="workflow-create-button" type="primary" @click="openWorkflowCreateChooser">
            <span class="workflow-create-button__mark" aria-hidden="true" />
            {{ t('workflows.newWorkflow') }}
          </n-button>
        </div>

        <template v-else>
          <div class="wf-overview">
            <div class="wf-overview__top">
              <div class="wf-overview__heading">
                <span class="wf-overview__icon"><n-icon :component="GitNetworkOutline" /></span>
                <n-input
                  v-model:value="name"
                  class="wf-name-input"
                  :disabled="isNodeEditorOpen"
                  :placeholder="t('workflows.untitled')"
                  @blur="saveMeta"
                  @keydown.enter="(event: KeyboardEvent) => (event.target as HTMLElement)?.blur()"
                />
                <span
                  class="wf-status"
                  :class="selectedReady ? 'wf-status--ok' : 'wf-status--warn'"
                >
                  <n-icon :component="selectedReady ? CheckmarkCircle : AlertCircleOutline" />
                  {{ selectedReady ? t('workflows.statusReady') : t('workflows.workflowValidationTitle') }}
                </span>
              </div>
              <n-input
                v-model:value="description"
                class="wf-desc-input"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 3 }"
                :disabled="isNodeEditorOpen"
                :placeholder="t('workflows.descriptionPlaceholder')"
                @blur="saveMeta"
              />
            </div>

            <div v-if="isComfyWorkflow && selectedComfyOverview" class="wf-metrics">
              <div class="wf-metric">
                <strong>{{ selectedComfyOverview.separateCount }}</strong>
                <span>{{ t('workflows.graphSummarySteps') }}</span>
              </div>
              <div class="wf-metric">
                <strong>{{ selectedComfyOverview.nodeCount }}</strong>
                <span>{{ t('workflows.metricNodes') }}</span>
              </div>
              <div class="wf-metric">
                <strong>{{ selectedComfyOverview.outputCount }}</strong>
                <span>{{ t('workflows.graphSummaryOutputs') }}</span>
              </div>
              <div class="wf-metric">
                <strong>{{ selectedComfyOverview.linkCount }}</strong>
                <span>{{ t('workflows.metricLinks') }}</span>
              </div>
            </div>
            <div v-else-if="selectedDraft && selectedSummary" class="wf-metrics">
              <div class="wf-metric">
                <strong>{{ selectedDraft.steps.length }}</strong>
                <span>{{ t('workflows.graphSummarySteps') }}</span>
              </div>
              <div class="wf-metric">
                <strong>0</strong>
                <span>{{ t('workflows.metricTools') }}</span>
              </div>
              <div class="wf-metric">
                <strong>{{ selectedSaveOutputCount }}</strong>
                <span>{{ t('workflows.graphSummaryOutputs') }}</span>
              </div>
              <div class="wf-metric">
                <strong>{{ selectedStemCount }}</strong>
                <span>{{ t('workflows.metricStems') }}</span>
              </div>
            </div>

            <section class="wf-section">
              <h3>{{ t('workflows.modelsUsed') }}</h3>
              <div v-if="selectedModels.length" class="wf-chips">
                <span
                  v-for="item in selectedModels"
                  :key="item.name"
                  class="wf-chip"
                  :class="{ 'wf-chip--warn': !item.downloaded }"
                  :title="item.name"
                >
                  <n-icon :component="CubeOutline" />
                  <span class="wf-chip__name">{{ item.name }}</span>
                  <small v-if="!item.downloaded">{{ t('workflows.modelNotDownloadedShort') }}</small>
                </span>
              </div>
              <p v-else class="wf-muted">{{ t('workflows.noModelsConfigured') }}</p>
            </section>

            <section v-if="selectedDraft && selectedSimpleAnalysis?.editable" class="wf-section">
              <h3>{{ t('workflows.runParams') }}</h3>
              <div class="wf-param-grid">
                <div class="wf-param">
                  <span>{{ t('workflows.defaultDevice') }}</span>
                  <n-select
                    :value="selectedDraft.defaultDevice"
                    size="small"
                    :options="deviceOptions"
                    :disabled="isNodeEditorOpen"
                    @update:value="updateSelectedDefaultDevice"
                  />
                </div>
                <div class="wf-param">
                  <span>{{ t('workflows.defaultFormat') }}</span>
                  <n-select
                    :value="selectedDraft.defaultFormat"
                    size="small"
                    :options="formatOptions"
                    :disabled="isNodeEditorOpen"
                    @update:value="updateSelectedDefaultFormat"
                  />
                </div>
              </div>
            </section>

            <section v-if="isComfyWorkflow && selectedComfyOverview?.inputSlots?.length" class="wf-section">
              <h3>{{ t('workflows.inputSlots') }}</h3>
              <div class="wf-chips">
                <span v-for="slot in selectedComfyOverview.inputSlots" :key="slot" class="wf-chip" :title="slot">
                  <n-icon :component="MusicalNotesOutline" />
                  <span class="wf-chip__name">{{ slot }}</span>
                </span>
              </div>
            </section>

            <section v-if="isComfyWorkflow" class="wf-section">
              <p class="wf-muted">{{ t('workflows.comfyReadOnlyHint') }}</p>
            </section>

            <div v-if="selectedError" class="wf-validation">
              <n-icon :component="AlertCircleOutline" />
              <span>{{ selectedError }}</span>
            </div>

            <section v-if="selectedSimpleAnalysis && !selectedSimpleAnalysis.editable" class="wf-simple-blockers">
              <strong>{{ t('workflows.advancedModeRequired') }}</strong>
              <ul>
                <li v-for="reason in selectedSimpleReasons" :key="reason">{{ simpleReasonLabel(reason) }}</li>
              </ul>
            </section>
          </div>

          <footer class="wf-actionbar">
            <div class="wf-actionbar__primary">
              <n-button
                v-if="selectedSimpleAnalysis?.editable"
                type="primary"
                size="large"
                @click="editSimpleWorkflow(selectedWorkflow)"
              >
                <template #icon><n-icon :component="GitNetworkOutline" /></template>
                {{ t('workflows.simpleMode') }}
              </n-button>
              <n-button
                v-if="isSimpleWorkflow"
                secondary
                size="large"
                :disabled="Boolean(selectedError)"
                @click="convertSelectedSimpleToAdvanced"
              >
                <template #icon><n-icon :component="GitNetworkOutline" /></template>
                {{ t('workflows.convertToAdvancedCopy') }}
              </n-button>
              <n-button
                v-else-if="isComfyWorkflow"
                secondary
                size="large"
                @click="openNodeEditor({ workflowId: selectedWorkflow?.id })"
              >
                <template #icon><n-icon :component="GitNetworkOutline" /></template>
                {{ t('workflows.openAdvancedEditor') }}
              </n-button>
              <n-button
                secondary
                size="large"
                :disabled="Boolean(selectedError)"
                @click="runSelected"
              >
                <template #icon><n-icon :component="PlayOutline" /></template>
                {{ t('workflows.runWorkflowAction') }}
              </n-button>
            </div>
            <div class="wf-actionbar__more">
              <n-button quaternary @click="openSelectedContextMenu">
                <template #icon><n-icon :component="EllipsisHorizontalOutline" /></template>
                {{ t('workflows.moreActions') }}
              </n-button>
            </div>
          </footer>

        </template>

        <div v-if="isNodeEditorOpen" class="wf-lock">
          <div class="wf-lock__card">
            <n-icon :component="GitNetworkOutline" />
            <strong>{{ t('workflows.nodeEditorOpenedTitle') }}</strong>
            <span>{{ t('workflows.nodeEditorOpenedHint') }}</span>
            <n-button secondary @click="openNodeEditor()">{{ t('workflows.backToNodeEditor') }}</n-button>
          </div>
        </div>
      </main>
    </div>

    <n-dropdown
      placement="bottom-start"
      trigger="manual"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="workflowMenuOptions"
      :show="contextMenuVisible"
      @clickoutside="closeWorkflowContextMenu"
      @select="handleWorkflowContextMenuSelect"
    />

    <WorkflowCreateChooser
      v-model:show="createChooserOpen"
      @select="selectWorkflowCreateType"
    />

    <WorkflowRevisionConflictModal
      v-model:show="showRevisionConflict"
      :workflow-name="pendingSimpleSave?.payload.name || simpleEditorWorkflow?.name || ''"
      @reload="reloadSimpleConflict"
      @save-copy="saveSimpleConflictCopy"
      @overwrite="overwriteSimpleConflict"
    />
  </div>
</template>

<style scoped>
.workflows-page {
  max-width: var(--page-max-width);
  margin: 0 auto;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.wf-hidden-file-input {
  display: none;
}

.workflows-page__header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}

.workflow-create-button {
  --n-border-radius: 9px;
  font-weight: 650;
  letter-spacing: 0.01em;
  box-shadow: 0 5px 14px color-mix(in srgb, var(--primary) 22%, transparent);
  transition: transform 160ms ease, box-shadow 160ms ease, filter 160ms ease;
}

.workflow-create-button:hover {
  transform: translateY(-1px);
  filter: saturate(1.06);
  box-shadow: 0 8px 18px color-mix(in srgb, var(--primary) 28%, transparent);
}

.workflow-create-button:active {
  transform: translateY(1px) scale(0.985);
  box-shadow: 0 3px 9px color-mix(in srgb, var(--primary) 18%, transparent);
}

.workflow-create-button__mark {
  position: relative;
  display: inline-block;
  flex: 0 0 14px;
  width: 16px;
  height: 14px;
  margin-right: 1px;
  color: currentColor;
}

.workflow-create-button__mark::before,
.workflow-create-button__mark::after {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 11px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
  content: '';
  transform: translate(-50%, -50%);
}

.workflow-create-button__mark::after {
  transform: translate(-50%, -50%) rotate(90deg);
}

/* ============ Console grid ============ */
.console {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  gap: 16px;
}

/* ============ Rail (list) ============ */
.console__rail {
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  padding: 15px 14px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-1) 78%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 80%, transparent),
    0 18px 46px rgba(0, 0, 0, 0.06);
}

.wf-list-scroll {
  min-height: 0;
  overflow: auto;
  margin: 0 -4px;
  padding: 0 4px;
}

.wf-list {
  display: grid;
  gap: 6px;
}

.wf-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 13px;
  background: color-mix(in srgb, var(--surface-2) 38%, transparent);
  color: var(--on-surface);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: background 140ms ease, border-color 140ms ease;
}

.wf-row:hover {
  background: color-mix(in srgb, var(--surface-2) 60%, transparent);
}

.wf-row--active {
  border-color: color-mix(in srgb, var(--primary) 40%, var(--outline));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 26%, transparent), transparent 74%),
    color-mix(in srgb, var(--surface-2) 62%, transparent);
}

.wf-row__icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  color: color-mix(in srgb, var(--primary-strong) 76%, var(--on-surface-muted));
  background: color-mix(in srgb, var(--primary-soft) 32%, var(--surface-2));
}

.wf-row__main {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.wf-row__main strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.wf-row__main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.wf-row__dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: 0 0 auto;
}

.wf-row__dot--ok {
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 18%, transparent);
}

.wf-row__dot--warn {
  background: var(--warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 18%, transparent);
}

.wf-empty {
  min-height: 240px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  text-align: center;
  color: var(--on-surface-muted);
}

.wf-empty .n-icon {
  font-size: 40px;
  color: var(--primary-strong);
}

.wf-empty strong {
  color: var(--on-surface);
  font-size: 14px;
}

.wf-empty span {
  font-size: 12px;
  max-width: 220px;
  line-height: 1.5;
}

/* ============ Stage (overview) ============ */
.console__stage {
  position: relative;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-1) 78%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 80%, transparent),
    0 18px 46px rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

.wf-overview-empty {
  flex: 1;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  padding: 32px;
  text-align: center;
  color: var(--on-surface-muted);
}

.wf-overview-empty .n-icon {
  font-size: 52px;
  color: var(--primary-strong);
}

.wf-overview-empty strong {
  color: var(--on-surface);
  font-size: 17px;
}

.wf-overview-empty span {
  font-size: 13px;
  max-width: 340px;
  line-height: 1.55;
}

.wf-overview {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: grid;
  align-content: start;
  gap: 18px;
  padding: 20px 22px;
}

/* --- heading + meta edit --- */
.wf-overview__top {
  display: grid;
  gap: 10px;
}

.wf-overview__heading {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.wf-overview__icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 12px;
  font-size: 20px;
  color: color-mix(in srgb, var(--primary-strong) 82%, var(--on-surface));
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
}

.wf-name-input {
  flex: 1 1 auto;
  min-width: 0;
}

.wf-name-input :deep(.n-input__border),
.wf-name-input :deep(.n-input__state-border),
.wf-desc-input :deep(.n-input__border),
.wf-desc-input :deep(.n-input__state-border) {
  display: none;
}

.wf-name-input :deep(.n-input) {
  --n-color: transparent;
  --n-color-focus: color-mix(in srgb, var(--surface-2) 60%, transparent);
  background: transparent;
  border-radius: 10px;
}

.wf-name-input :deep(.n-input:hover) {
  background: color-mix(in srgb, var(--surface-2) 44%, transparent);
}

.wf-name-input :deep(.n-input__input-el) {
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--on-surface);
}

.wf-desc-input :deep(.n-input) {
  --n-color: transparent;
  --n-color-focus: color-mix(in srgb, var(--surface-2) 50%, transparent);
  background: transparent;
}

.wf-desc-input :deep(.n-input:hover) {
  background: color-mix(in srgb, var(--surface-2) 38%, transparent);
}

.wf-desc-input :deep(.n-input__textarea-el) {
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.55;
}

.wf-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.wf-status .n-icon {
  font-size: 15px;
}

.wf-status--ok {
  color: color-mix(in srgb, var(--success) 82%, white 6%);
  background: color-mix(in srgb, var(--success) 15%, transparent);
}

.wf-status--warn {
  color: color-mix(in srgb, var(--warning) 84%, white 6%);
  background: color-mix(in srgb, var(--warning) 15%, transparent);
}

/* --- metrics --- */
.wf-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.wf-metric {
  display: grid;
  gap: 3px;
  padding: 14px 12px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-2) 46%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 66%, transparent);
}

.wf-metric strong {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.wf-metric span {
  color: var(--on-surface-muted);
  font-size: 11px;
  font-weight: 600;
}

/* --- sections --- */
.wf-section {
  display: grid;
  gap: 10px;
}

.wf-section h3 {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.wf-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.wf-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 6px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-2) 56%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 64%, transparent);
  font-size: 12px;
}

.wf-chip .n-icon {
  flex: 0 0 auto;
  font-size: 14px;
  color: color-mix(in srgb, var(--primary-strong) 78%, var(--on-surface-muted));
}

.wf-chip__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-chip small {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  color: color-mix(in srgb, var(--warning) 86%, white 6%);
  background: color-mix(in srgb, var(--warning) 18%, transparent);
  font-size: 10px;
  font-weight: 700;
}

.wf-chip--warn {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 40%, var(--outline));
}

.wf-chip--warn .n-icon {
  color: color-mix(in srgb, var(--warning) 78%, var(--on-surface-muted));
}

.wf-muted {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.wf-param-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.wf-param {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 42%, transparent);
}

.wf-param span {
  color: var(--on-surface-muted);
  font-size: 11px;
  font-weight: 600;
}

.wf-param strong {
  font-size: 14px;
  font-weight: 600;
}

.wf-batch-list {
  display: grid;
  gap: 8px;
}

.wf-batch {
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 42%, transparent);
}

.wf-batch strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.wf-batch span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.wf-batch-count {
  color: color-mix(in srgb, var(--primary-strong) 84%, var(--on-surface));
  font-size: 12px;
  font-weight: 600;
}

.wf-validation {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--warning) 48%, var(--outline));
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: color-mix(in srgb, var(--warning) 84%, white 8%);
  font-size: 12px;
  line-height: 1.5;
}

.wf-validation .n-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  font-size: 16px;
}

.wf-simple-blockers {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--outline) 88%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 42%, transparent);
}

.wf-simple-blockers strong {
  font-size: 12px;
}

.wf-simple-blockers ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.45;
}

/* --- action bar --- */
.wf-actionbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 22px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 60%, transparent);
  background: color-mix(in srgb, var(--surface-2) 40%, transparent);
}

.wf-actionbar__primary,
.wf-actionbar__more {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* --- node editor lock --- */
.wf-lock {
  position: absolute;
  inset: 0;
  z-index: 8;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--surface-1) 74%, transparent);
  backdrop-filter: blur(10px) saturate(1.08);
}

.wf-lock__card {
  width: min(360px, 100%);
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 26px;
  text-align: center;
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-2) 84%, transparent);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.14);
}

.wf-lock__card .n-icon {
  font-size: 34px;
  color: var(--primary-strong);
}

.wf-lock__card strong {
  font-size: 15px;
}

.wf-lock__card span {
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.6;
}

/* ============ Responsive ============ */
@media (max-width: 960px) {
  .console {
    grid-template-columns: 1fr;
  }

  .wf-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .wf-param-grid {
    grid-template-columns: 1fr;
  }
}
</style>
