<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  AddOutline,
  AlertCircleOutline,
  CheckmarkCircle,
  CopyOutline,
  CubeOutline,
  DownloadOutline,
  GitNetworkOutline,
  OpenOutline,
  PlayOutline,
  SearchOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { storeToRefs } from 'pinia'
import WorkflowRevisionConflictModal from '@/components/workflow/WorkflowRevisionConflictModal.vue'
import WorkflowSimpleCreator from '@/components/workflow/WorkflowSimpleCreator.vue'
import { useModelStore } from '@/stores/model'
import {
  useWorkflowStore,
  WorkflowRevisionConflictError,
  type WorkflowEntry,
} from '@/stores/workflow'
import {
  getWorkflowBatchInputConfigs,
  getWorkflowValidationSummary,
  hydrateWorkflowDefinition,
  workflowValidationErrorMessage,
  type WorkflowValidationSummary,
} from '@/utils/workflowDefinition'
import { exportComfyMssWorkflow, importComfyMssWorkflow } from '@/utils/comfyMssWorkflow'
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
const simpleEditorOpen = ref(false)
const simpleEditorWorkflow = ref<WorkflowEntry | null>(null)
type SimpleSaveContinuation = 'stay' | 'advanced' | 'run'
const pendingSimpleSave = ref<{
  payload: SimpleWorkflowSavePayload
  continuation: SimpleSaveContinuation
} | null>(null)
const showRevisionConflict = ref(false)
const newSimpleAdvancedBaselineIds = ref<string[] | null>(null)
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
  simpleEditorOpen.value && !simpleEditorWorkflow.value,
))

function workflowValidationError(summary: WorkflowValidationSummary) {
  return workflowValidationErrorMessage(summary, t)
}

function workflowRunBlocked(summary: WorkflowValidationSummary) {
  return Boolean(workflowValidationError(summary) || summary.noSaveOutputs)
}

// ---- Per-item lightweight status (memoized) ----
const workflowStatusMap = computed(() => Object.fromEntries(
  workflows.value.map(item => [item.id, workflowRunBlocked(getWorkflowValidationSummary(item.definition))]),
))
function isWorkflowBlocked(item: WorkflowEntry) {
  return Boolean(workflowStatusMap.value[item.id])
}

// ---- Batch task estimate ----
const workflowBatchTaskCounts = ref<Record<string, number | null>>({})
let workflowBatchTaskCountToken = 0

function refreshWorkflowBatchTaskCounts() {
  const entries = workflows.value.map(item => ({
    item,
    configs: getWorkflowBatchInputConfigs(item.definition),
    summary: getWorkflowValidationSummary(item.definition),
  }))
  const next: Record<string, number | null> = {}
  entries.forEach(({ item }) => {
    next[item.id] = null
  })
  workflowBatchTaskCounts.value = next
  const token = ++workflowBatchTaskCountToken
  entries.forEach(({ item, configs, summary }) => {
    if (configs.length !== 1 || summary.batchInputMissingFolderCount || summary.batchInputMultipleUnsupported) return
    const config = configs[0]
    void invoke<{ files: string[] }>('scan_audio_paths_with_options', {
      paths: [config.folder],
      recursive: config.recursive,
      sortFiles: config.sortFiles,
    }).then((result) => {
      if (token !== workflowBatchTaskCountToken) return
      workflowBatchTaskCounts.value = {
        ...workflowBatchTaskCounts.value,
        [item.id]: Array.isArray(result.files) ? result.files.length : 0,
      }
    }).catch(() => {
      if (token !== workflowBatchTaskCountToken) return
      workflowBatchTaskCounts.value = {
        ...workflowBatchTaskCounts.value,
        [item.id]: null,
      }
    })
  })
}

// ---- Selected workflow overview data ----
const selectedDraft = computed(() =>
  selectedWorkflow.value ? hydrateWorkflowDefinition(selectedWorkflow.value.definition) : null)
const selectedSummary = computed(() =>
  selectedWorkflow.value ? getWorkflowValidationSummary(selectedWorkflow.value.definition) : null)
const selectedStemCount = computed(() =>
  selectedDraft.value ? selectedDraft.value.steps.reduce((total, step) => total + step.stems.length, 0) : 0)
const selectedModels = computed(() => {
  const draft = selectedDraft.value
  if (!draft) return [] as { name: string; downloaded: boolean }[]
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
const selectedBatchConfigs = computed(() =>
  selectedWorkflow.value ? getWorkflowBatchInputConfigs(selectedWorkflow.value.definition) : [])
const selectedBatchTaskCount = computed(() => {
  const id = selectedWorkflow.value?.id
  if (!id) return null
  const value = workflowBatchTaskCounts.value[id]
  return typeof value === 'number' ? value : null
})
const selectedError = computed(() => {
  const summary = selectedSummary.value
  if (!summary) return ''
  return workflowValidationError(summary) || (summary.noSaveOutputs ? t('workflows.workflowNoSaveOutputs') : '')
})
const selectedReady = computed(() => Boolean(selectedWorkflow.value) && !selectedError.value)
const selectedSimpleAnalysis = computed(() => selectedWorkflow.value
  ? analyzeSimpleWorkflow(selectedWorkflow.value.definition)
  : null)
const selectedSimpleReasons = computed(() => selectedSimpleAnalysis.value?.reasonCodes || [])

const simpleReasonKeys: Record<SimpleWorkflowReasonCode, string> = {
  utility_nodes: 'workflows.simpleReasonUtilityNodes',
  unsupported_nodes: 'workflows.simpleReasonUnsupportedNodes',
  custom_model_type: 'workflows.simpleReasonCustomModel',
  comfy_metadata: 'workflows.simpleReasonComfyMetadata',
  invalid_graph: 'workflows.simpleReasonInvalidGraph',
  custom_save_behavior: 'workflows.simpleReasonCustomSave',
}

function simpleReasonLabel(reason: SimpleWorkflowReasonCode) {
  return t(simpleReasonKeys[reason])
}

function deviceLabel(value: string) {
  return deviceOptions.find(option => option.value === value)?.label || value
}
function formatLabel(value: string) {
  return formatOptions.find(option => option.value === value)?.label || String(value || '').toUpperCase()
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

function cancelSimpleWorkflow() {
  closeSimpleWorkflow()
  editingId.value = ''
  name.value = ''
  description.value = ''
  workflow.selectWorkflow('')
}

async function openAdvancedFromSimple(payload: SimpleWorkflowSavePayload, persistDraft: boolean) {
  if (persistDraft) {
    await saveSimpleWorkflow(payload, { continuation: 'advanced' })
    return
  }
  const workflowId = simpleEditorWorkflow.value?.id
  newSimpleAdvancedBaselineIds.value = workflowId
    ? null
    : workflows.value.map(item => item.id)
  await openNodeEditor(workflowId ? { workflowId } : { forceNew: true })
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
    if (continuation === 'advanced') {
      simpleEditorWorkflow.value = cloneWorkflowEntry(entry)
      simpleEditorOpen.value = true
      newSimpleAdvancedBaselineIds.value = null
      await openNodeEditor({ workflowId: entry.id })
    } else if (continuation === 'run') {
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

// ---- Node editor bridge ----
async function openNodeEditor(options: { forceNew?: boolean; workflowId?: string } = {}) {
  const forceNew = options.forceNew === true
  const workflowId = forceNew ? '' : (options.workflowId || editingId.value || selectedWorkflowId.value || '')
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
  const baselineIds = newSimpleAdvancedBaselineIds.value
  const restoreNewSimpleDraft = Boolean(
    baselineIds
    && simpleEditorOpen.value
    && !simpleEditorWorkflow.value,
  )
  workflow.markNodeEditorClosed()
  await workflow.reload()
  if (restoreNewSimpleDraft && baselineIds) {
    const baseline = new Set(baselineIds)
    const created = workflows.value.find(item =>
      item.id === selectedWorkflowId.value && !baseline.has(item.id))
      || workflows.value.find(item => !baseline.has(item.id))
    newSimpleAdvancedBaselineIds.value = null
    if (created) {
      openWorkflowFromList(created)
    } else {
      editingId.value = ''
      workflow.selectWorkflow('')
    }
    return
  }
  newSimpleAdvancedBaselineIds.value = null
  const target = workflows.value.find(item => item.id === editingId.value)
    || workflow.selectedWorkflow
    || workflows.value[0]
  if (target) openWorkflowFromList(target)
}

// ---- Actions ----
async function duplicateSelected() {
  const current = selectedWorkflow.value
  if (!current) return
  const entry = await workflow.duplicateWorkflow(current.id)
  if (entry) {
    editWorkflow(entry)
    message.success(t('workflows.duplicated'))
  }
}

function deleteSelected() {
  const current = selectedWorkflow.value
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
function triggerImportComfyMss() {
  importFileInputRef.value?.click()
}

function workflowFileBasename(fileName: string) {
  return fileName.replace(/\.[^.]+$/u, '').trim()
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

function importWarningSummary(warnings: string[]) {
  if (!warnings.length) return ''
  if (warnings.length === 1) return warnings[0]
  return `${warnings[0]}（另外还有 ${warnings.length - 1} 条提示）`
}

async function handleImportComfyMss(event: Event) {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as Record<string, unknown>
    const result = importComfyMssWorkflow(parsed, { models: models.value })
    const entry = await workflow.saveWorkflow({
      name: workflowFileBasename(file.name) || t('workflows.newWorkflow'),
      description: '',
      definition: result.definition,
    })
    editWorkflow(entry)
    message.success(t('workflows.comfyImportSuccess'))
    if (result.warnings.length) {
      message.warning(importWarningSummary(result.warnings))
    }
  } catch (error) {
    message.error(`${t('workflows.comfyImportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (input) input.value = ''
  }
}

async function exportWorkflowComfyMss(
  workflowName: string,
  definition: Record<string, unknown>,
) {
  try {
    const payload = exportComfyMssWorkflow(definition, { models: models.value })
    const fileName = `${workflowSlug(workflowName || t('workflows.untitled'))}.comfy-mss.json`
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
    message.success(t('workflows.comfyExportSuccess'))
  } catch (error) {
    message.error(`${t('workflows.comfyExportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function exportSelectedComfyMss() {
  const current = selectedWorkflow.value
  if (!current) return
  await exportWorkflowComfyMss(current.name, current.definition)
}

function exportSimpleWorkflow(payload: SimpleWorkflowSavePayload) {
  void exportWorkflowComfyMss(payload.name, payload.definition)
}

onMounted(async () => {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  unlistenNodeEditorClosed = await listen('pymss://workflow-node-editor-closed', () => {
    void refreshAfterNodeEditorClosed()
  })
})

onUnmounted(() => {
  unlistenNodeEditorClosed?.()
})

watch(workflows, (items) => {
  refreshWorkflowBatchTaskCounts()
  if (
    newSimpleAdvancedBaselineIds.value
    && simpleEditorOpen.value
    && !simpleEditorWorkflow.value
  ) return
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
      @change="handleImportComfyMss"
    >

    <header class="page-header-compact">
      <div>
        <h1>{{ t('workflows.title') }}</h1>
        <p>{{ t('workflows.subtitle') }}</p>
      </div>
      <div class="workflows-page__header-actions">
        <n-button secondary @click="triggerImportComfyMss">
          <template #icon><n-icon :component="OpenOutline" /></template>
          {{ t('workflows.importComfyMss') }}
        </n-button>
        <n-button type="primary" @click="createSimpleWorkflow">
          <template #icon><n-icon :component="AddOutline" /></template>
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
            <n-button type="primary" size="small" @click="createSimpleWorkflow">
              <template #icon><n-icon :component="AddOutline" /></template>
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
          <n-button type="primary" @click="createSimpleWorkflow">
            <template #icon><n-icon :component="AddOutline" /></template>
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

            <div v-if="selectedDraft && selectedSummary" class="wf-metrics">
              <div class="wf-metric">
                <strong>{{ selectedDraft.steps.length }}</strong>
                <span>{{ t('workflows.graphSummarySteps') }}</span>
              </div>
              <div class="wf-metric">
                <strong>{{ selectedDraft.utilityNodes.length }}</strong>
                <span>{{ t('workflows.metricTools') }}</span>
              </div>
              <div class="wf-metric">
                <strong>{{ selectedSummary.saveOutputCount }}</strong>
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

            <section v-if="selectedDraft" class="wf-section">
              <h3>{{ t('workflows.runParams') }}</h3>
              <div class="wf-param-grid">
                <div class="wf-param">
                  <span>{{ t('workflows.defaultDevice') }}</span>
                  <strong>{{ deviceLabel(selectedDraft.defaultDevice) }}</strong>
                </div>
                <div class="wf-param">
                  <span>{{ t('workflows.defaultFormat') }}</span>
                  <strong>{{ formatLabel(selectedDraft.defaultFormat) }}</strong>
                </div>
                <div class="wf-param">
                  <span>{{ t('workflows.normalize') }}</span>
                  <strong>{{ selectedDraft.defaultNormalize ? t('workflows.paramOn') : t('workflows.paramOff') }}</strong>
                </div>
              </div>
            </section>

            <section v-if="selectedBatchConfigs.length" class="wf-section">
              <h3>{{ t('workflows.batchInputTag') }}</h3>
              <div class="wf-batch-list">
                <div v-for="(config, index) in selectedBatchConfigs" :key="index" class="wf-batch">
                  <strong>{{ config.folder || t('workflows.batchInputFolderPlaceholder') }}</strong>
                  <span>
                    {{ t(config.recursive ? 'workflows.batchInputRecursiveOn' : 'workflows.batchInputRecursiveOff') }}
                    ·
                    {{ t(config.sortFiles ? 'workflows.batchInputSortOn' : 'workflows.batchInputSortOff') }}
                  </span>
                </div>
              </div>
              <span v-if="selectedBatchTaskCount !== null" class="wf-batch-count">
                {{ t('workflows.batchInputEstimatedTasks', { count: selectedBatchTaskCount }) }}
              </span>
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
              <n-button secondary size="large" @click="openNodeEditor()">
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
              <n-button quaternary @click="duplicateSelected">
                <template #icon><n-icon :component="CopyOutline" /></template>
                {{ t('workflows.duplicate') }}
              </n-button>
              <n-button quaternary @click="exportSelectedComfyMss">
                <template #icon><n-icon :component="DownloadOutline" /></template>
                {{ t('workflows.exportComfyMss') }}
              </n-button>
              <n-button quaternary type="error" @click="deleteSelected">
                <template #icon><n-icon :component="TrashOutline" /></template>
                {{ t('workflows.deleteConfirm') }}
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
  max-width: 1140px;
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
