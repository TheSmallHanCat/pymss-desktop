<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  AddOutline,
  CopyOutline,
  DownloadOutline,
  GitNetworkOutline,
  OpenOutline,
  PlayOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { storeToRefs } from 'pinia'
import { useModelStore } from '@/stores/model'
import { useWorkflowStore, type WorkflowEntry } from '@/stores/workflow'
import {
  buildWorkflowDefinition,
  getWorkflowBatchInputConfigs,
  getWorkflowValidationSummary,
  hydrateWorkflowDefinition,
  type WorkflowBatchInputConfig,
  type WorkflowValidationSummary,
} from '@/utils/workflowDefinition'
import { exportComfyMssWorkflow, importComfyMssWorkflow } from '@/utils/comfyMssWorkflow'

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
const defaultDevice = ref('auto')
const defaultFormat = ref('wav')
const defaultNormalize = ref(false)
const definition = ref<Record<string, unknown>>({})
const isCreatingNew = ref(false)
const importFileInputRef = ref<HTMLInputElement | null>(null)
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
const hydratedDraft = computed(() => hydrateWorkflowDefinition(definition.value))
const generatedDefinition = computed(() => buildDefinition())
const generatedJson = computed(() => JSON.stringify(generatedDefinition.value, null, 2))
const validationSummary = computed(() => getWorkflowValidationSummary(generatedDefinition.value))

function workflowValidationError(summary: WorkflowValidationSummary) {
  if (summary.batchInputMultipleUnsupported) return t('workflows.batchInputMultipleUnsupported')
  if (summary.batchInputMissingFolderCount > 0) return t('workflows.batchInputFolderRequired')
  if (summary.utilityInputMissingCount > 0) return t('workflows.utilityInputsRequired', { count: summary.utilityInputMissingCount })
  if (summary.danglingConnectionCount > 0) return t('workflows.workflowDanglingConnections', { count: summary.danglingConnectionCount })
  if (summary.invalidConnectionCount > 0) return t('workflows.workflowInvalidConnections', { count: summary.invalidConnectionCount })
  if (summary.duplicateInputConnectionCount > 0) return t('workflows.workflowDuplicateInputConnections', { count: summary.duplicateInputConnectionCount })
  if (summary.graphCycleDetected) return t('workflows.workflowCycleDetected')
  return ''
}

function workflowRunBlocked(summary: WorkflowValidationSummary) {
  return Boolean(workflowValidationError(summary) || summary.noSaveOutputs)
}

const formError = computed(() => {
  if (!name.value.trim()) return t('workflows.nameRequired')
  if (!hydratedDraft.value.steps.length) return t('workflows.stepsRequired')
  const validationError = workflowValidationError(validationSummary.value)
  if (validationError) return validationError
  const downloaded = new Set(downloadedModels.value.map(item => item.name))
  for (const [index, step] of hydratedDraft.value.steps.entries()) {
    const label = t('workflows.stepTitle', { index: index + 1 })
    if (!step.model.trim()) return t('workflows.stepModelRequired', { id: label })
    if (!downloaded.has(step.model.trim())) return t('workflows.stepModelNotDownloaded', { id: label })
    if (!step.input.trim()) return t('workflows.stepInputRequired', { id: label })
    if (!step.stems.length) return t('workflows.stepStemsRequired', { id: label })
  }
  if (validationSummary.value.noSaveOutputs) return t('workflows.workflowNoSaveOutputs')
  return ''
})
const canSave = computed(() => !formError.value)
const isNodeEditorOpen = computed(() => Boolean(nodeEditorOpenWorkflowId.value))

type WorkflowCardMeta = {
  batchInputConfigs: WorkflowBatchInputConfig[]
  batchInputMissingCount: number
  batchInputUnsupported: boolean
  utilityInputMissingCount: number
  danglingConnectionCount: number
  invalidConnectionCount: number
  duplicateInputConnectionCount: number
  graphCycleDetected: boolean
  noSaveOutputs: boolean
  runBlocked: boolean
}

const workflowBatchTaskCounts = ref<Record<string, number | null>>({})
let workflowBatchTaskCountToken = 0

const workflowCardMetaMap = computed(() => Object.fromEntries(workflows.value.map((item) => {
  const summary = getWorkflowValidationSummary(item.definition)
  const meta: WorkflowCardMeta = {
    batchInputConfigs: getWorkflowBatchInputConfigs(item.definition),
    batchInputMissingCount: summary.batchInputMissingFolderCount,
    batchInputUnsupported: summary.batchInputMultipleUnsupported,
    utilityInputMissingCount: summary.utilityInputMissingCount,
    danglingConnectionCount: summary.danglingConnectionCount,
    invalidConnectionCount: summary.invalidConnectionCount,
    duplicateInputConnectionCount: summary.duplicateInputConnectionCount,
    graphCycleDetected: summary.graphCycleDetected,
    noSaveOutputs: summary.noSaveOutputs,
    runBlocked: workflowRunBlocked(summary),
  }
  return [item.id, meta]
})))

function workflowCardMeta(item: WorkflowEntry): WorkflowCardMeta {
  return workflowCardMetaMap.value[item.id] || {
    batchInputConfigs: [],
    batchInputMissingCount: 0,
    batchInputUnsupported: false,
    utilityInputMissingCount: 0,
    danglingConnectionCount: 0,
    invalidConnectionCount: 0,
    duplicateInputConnectionCount: 0,
    graphCycleDetected: false,
    noSaveOutputs: false,
    runBlocked: false,
  }
}

function workflowBatchTaskCount(item: WorkflowEntry) {
  const value = workflowBatchTaskCounts.value[item.id]
  return typeof value === 'number' ? value : null
}

function workflowBatchTooltipLines(item: WorkflowEntry) {
  const meta = workflowCardMeta(item)
  const lines: string[] = []
  meta.batchInputConfigs.forEach((config, index) => {
    lines.push(`${t('workflows.batchInputFolderLabel')} ${index + 1}: ${config.folder}`)
    lines.push(`- ${t(config.recursive ? 'workflows.batchInputRecursiveOn' : 'workflows.batchInputRecursiveOff')}`)
    lines.push(`- ${t(config.sortFiles ? 'workflows.batchInputSortOn' : 'workflows.batchInputSortOff')}`)
  })
  if (meta.batchInputMissingCount) {
    lines.push(t('workflows.batchInputFolderMissing', { count: meta.batchInputMissingCount }))
  }
  if (meta.batchInputUnsupported) {
    lines.push(t('workflows.batchInputMultipleUnsupported'))
  }
  if (meta.utilityInputMissingCount) {
    lines.push(t('workflows.utilityInputsRequired', { count: meta.utilityInputMissingCount }))
  }
  if (meta.danglingConnectionCount) {
    lines.push(t('workflows.workflowDanglingConnections', { count: meta.danglingConnectionCount }))
  }
  if (meta.invalidConnectionCount) {
    lines.push(t('workflows.workflowInvalidConnections', { count: meta.invalidConnectionCount }))
  }
  if (meta.duplicateInputConnectionCount) {
    lines.push(t('workflows.workflowDuplicateInputConnections', { count: meta.duplicateInputConnectionCount }))
  }
  if (meta.graphCycleDetected) {
    lines.push(t('workflows.workflowCycleDetected'))
  }
  if (meta.noSaveOutputs) {
    lines.push(t('workflows.workflowNoSaveOutputs'))
  }
  return lines
}

function refreshWorkflowBatchTaskCounts() {
  const entries = workflows.value.map(item => ({ item, meta: workflowCardMeta(item) }))
  const next: Record<string, number | null> = {}
  entries.forEach(({ item }) => {
    next[item.id] = null
  })
  workflowBatchTaskCounts.value = next
  const token = ++workflowBatchTaskCountToken
  entries.forEach(({ item, meta }) => {
    if (meta.batchInputConfigs.length !== 1 || meta.batchInputMissingCount || meta.batchInputUnsupported) return
    const config = meta.batchInputConfigs[0]
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

async function openNodeEditor() {
  const openId = nodeEditorOpenWorkflowId.value
  const workflowId = openId && openId !== '__new__' ? openId : editingId.value || selectedWorkflowId.value || ''
  const isNewWorkflow = openId === '__new__' || !workflowId
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      await invoke('open_workflow_node_editor_window', { payload: { workflowId, newWorkflow: isNewWorkflow } })
      workflow.markNodeEditorOpen(workflowId || '__new__')
      return
    } catch (error) {
      console.warn('Failed to open workflow node editor window, falling back to route navigation', error)
    }
  }
  await router.push({ path: '/workflow-node-editor', query: workflowId ? { workflowId } : { new: '1' } })
}
async function refreshAfterNodeEditorClosed() {
  workflow.markNodeEditorClosed()
  await workflow.reload()
  const next = editingId.value
    ? workflows.value.find(item => item.id === editingId.value)
    : workflow.selectedWorkflow
  if (next) {
    editWorkflow(next)
  } else if (workflow.selectedWorkflow) {
    editWorkflow(workflow.selectedWorkflow)
  }
}
function buildDefinition(): Record<string, unknown> {
  return buildWorkflowDefinition({
    defaultDevice: defaultDevice.value,
    defaultFormat: defaultFormat.value,
    defaultNormalize: defaultNormalize.value,
    steps: hydratedDraft.value.steps,
    utilityNodes: hydratedDraft.value.utilityNodes,
    saveTargets: hydratedDraft.value.saveTargets,
    ui: hydratedDraft.value.ui,
  })
}
function createFreshDefinition() {
  const fresh = hydrateWorkflowDefinition({})
  return buildWorkflowDefinition({
    defaultDevice: defaultDevice.value,
    defaultFormat: defaultFormat.value,
    defaultNormalize: defaultNormalize.value,
    steps: fresh.steps,
    utilityNodes: fresh.utilityNodes,
    saveTargets: fresh.saveTargets,
    ui: fresh.ui,
  })
}
function hydrateFromDefinition(definition: Record<string, unknown>) {
  const draft = hydrateWorkflowDefinition(definition)
  defaultDevice.value = draft.defaultDevice
  defaultFormat.value = draft.defaultFormat
  defaultNormalize.value = draft.defaultNormalize
}
function resetEditor() {
  isCreatingNew.value = true
  editingId.value = ''
  name.value = ''
  description.value = ''
  defaultDevice.value = 'auto'
  defaultFormat.value = 'wav'
  defaultNormalize.value = false
  definition.value = createFreshDefinition()
  workflow.selectWorkflow('')
}
function editWorkflow(item: WorkflowEntry) {
  isCreatingNew.value = false
  editingId.value = item.id
  name.value = item.name
  description.value = item.description
  definition.value = item.definition
  hydrateFromDefinition(item.definition)
  workflow.selectWorkflow(item.id)
}
async function save() {
  if (!canSave.value) return
  const entry = await workflow.saveWorkflow({
    id: editingId.value || undefined,
    name: name.value,
    description: description.value,
    definition: generatedDefinition.value,
  })
  editWorkflow(entry)
  message.success(t('workflows.saved'))
}
async function duplicate(item: WorkflowEntry) {
  const entry = await workflow.duplicateWorkflow(item.id)
  if (entry) {
    editWorkflow(entry)
    message.success(t('workflows.duplicated'))
  }
}
function duplicateSelected() {
  if (selectedWorkflow.value) void duplicate(selectedWorkflow.value)
}
function confirmDelete(item: WorkflowEntry) {
  dialog.warning({
    title: t('workflows.deleteTitle'),
    content: t('workflows.deleteHint', { name: item.name }),
    positiveText: t('workflows.deleteConfirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await workflow.deleteWorkflow(item.id)
      if (editingId.value === item.id) resetEditor()
      message.success(t('workflows.deleted'))
    },
  })
}
function deleteSelected() {
  if (selectedWorkflow.value) confirmDelete(selectedWorkflow.value)
}
function runWorkflow(item: WorkflowEntry) {
  const meta = workflowCardMeta(item)
  if (meta.runBlocked) {
    message.warning(workflowBatchTooltipLines(item).find(Boolean) || t('workflows.workflowRunBlocked'))
    return
  }
  workflow.selectWorkflow(item.id)
  router.push({ path: '/', query: { mode: 'workflow' } })
}

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
    definition.value = result.definition
    hydrateFromDefinition(result.definition)
    if (!name.value.trim() || isCreatingNew.value) {
      name.value = workflowFileBasename(file.name) || t('workflows.newWorkflow')
    }
    isCreatingNew.value = !editingId.value
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

function exportSelectedComfyMss() {
  try {
    const payload = exportComfyMssWorkflow(generatedDefinition.value, { models: models.value })
    downloadJsonFile(`${workflowSlug(name.value || t('workflows.untitled'))}.comfy-mss.json`, payload)
    message.success(t('workflows.comfyExportSuccess'))
  } catch (error) {
    message.error(`${t('workflows.comfyExportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
  }
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
  if (!editingId.value && !isCreatingNew.value && items.length) editWorkflow(items[0])
}, { immediate: true, deep: true })

watch([defaultDevice, defaultFormat, defaultNormalize], () => {
  definition.value = generatedDefinition.value
})
</script>

<template>
  <div class="page workflows-page">
    <div class="page-header-compact workflows-header">
      <div>
        <div class="eyebrow">{{ t('workflows.eyebrow') }}</div>
        <h1>{{ t('workflows.title') }}</h1>
        <p>{{ t('workflows.subtitle') }}</p>
      </div>
      <n-button type="primary" @click="resetEditor">
        <template #icon><n-icon :component="AddOutline" /></template>
        {{ t('workflows.newWorkflow') }}
      </n-button>
    </div>

    <div class="workflows-layout">
      <section class="workflow-list-panel">
        <n-input v-model:value="query" clearable :placeholder="t('workflows.searchPlaceholder')" />
        <div v-if="filteredWorkflows.length" class="workflow-list">
          <article
            v-for="item in filteredWorkflows"
            :key="item.id"
            class="workflow-card"
            :class="{ 'workflow-card--active': item.id === selectedWorkflowId }"
            @click="editWorkflow(item)"
          >
            <div class="workflow-card__icon"><n-icon :component="GitNetworkOutline" /></div>
            <div class="workflow-card__main">
              <strong>{{ item.name }}</strong>
              <span>{{ item.description || t('workflows.noDescription') }}</span>
              <div v-if="workflowCardMeta(item).batchInputConfigs.length || workflowCardMeta(item).batchInputMissingCount || workflowCardMeta(item).batchInputUnsupported || workflowCardMeta(item).utilityInputMissingCount || workflowCardMeta(item).danglingConnectionCount || workflowCardMeta(item).invalidConnectionCount || workflowCardMeta(item).duplicateInputConnectionCount || workflowCardMeta(item).graphCycleDetected || workflowCardMeta(item).noSaveOutputs" class="workflow-card__meta">
                <n-tooltip v-if="workflowCardMeta(item).batchInputConfigs.length" trigger="hover">
                  <template #trigger>
                    <n-tag size="small" round :bordered="false">
                      {{ t('workflows.batchInputTag') }}
                    </n-tag>
                  </template>
                  <div class="workflow-card__tooltip">{{ workflowBatchTooltipLines(item).join('\n') }}</div>
                </n-tooltip>
                <n-tooltip v-if="workflowBatchTaskCount(item) !== null" trigger="hover">
                  <template #trigger>
                    <n-tag size="small" round :bordered="false" type="info">
                      {{ t('workflows.batchInputEstimatedTasks', { count: workflowBatchTaskCount(item) }) }}
                    </n-tag>
                  </template>
                  <div class="workflow-card__tooltip">{{ workflowBatchTooltipLines(item).join('\n') }}</div>
                </n-tooltip>
                <n-tag v-if="workflowCardMeta(item).batchInputMissingCount" size="small" round :bordered="false" type="warning">
                  {{ t('workflows.batchInputFolderMissing', { count: workflowCardMeta(item).batchInputMissingCount }) }}
                </n-tag>
                <n-tag v-if="workflowCardMeta(item).batchInputUnsupported" size="small" round :bordered="false" type="warning">
                  {{ t('workflows.batchInputMultipleUnsupportedShort') }}
                </n-tag>
                <n-tag v-if="workflowCardMeta(item).utilityInputMissingCount" size="small" round :bordered="false" type="warning">
                  {{ t('workflows.utilityInputsRequired', { count: workflowCardMeta(item).utilityInputMissingCount }) }}
                </n-tag>
                <n-tag v-if="workflowCardMeta(item).danglingConnectionCount" size="small" round :bordered="false" type="warning">
                  {{ t('workflows.workflowDanglingConnections', { count: workflowCardMeta(item).danglingConnectionCount }) }}
                </n-tag>
                <n-tag v-if="workflowCardMeta(item).invalidConnectionCount" size="small" round :bordered="false" type="warning">
                  {{ t('workflows.workflowInvalidConnections', { count: workflowCardMeta(item).invalidConnectionCount }) }}
                </n-tag>
                <n-tag v-if="workflowCardMeta(item).duplicateInputConnectionCount" size="small" round :bordered="false" type="warning">
                  {{ t('workflows.workflowDuplicateInputConnections', { count: workflowCardMeta(item).duplicateInputConnectionCount }) }}
                </n-tag>
                <n-tag v-if="workflowCardMeta(item).graphCycleDetected" size="small" round :bordered="false" type="warning">
                  {{ t('workflows.workflowCycleDetected') }}
                </n-tag>
                <n-tag v-if="workflowCardMeta(item).noSaveOutputs" size="small" round :bordered="false" type="warning">
                  {{ t('workflows.workflowNoSaveOutputs') }}
                </n-tag>
              </div>
            </div>
            <n-tooltip trigger="hover" :disabled="!workflowCardMeta(item).runBlocked">
              <template #trigger>
                <span class="workflow-card__run-trigger" @click.stop>
                  <n-button quaternary circle size="small" :disabled="workflowCardMeta(item).runBlocked" @click="runWorkflow(item)">
                    <template #icon><n-icon :component="PlayOutline" /></template>
                  </n-button>
                </span>
              </template>
              <div class="workflow-card__tooltip">{{ workflowBatchTooltipLines(item).join('\n') || t('workflows.workflowRunBlocked') }}</div>
            </n-tooltip>
          </article>
        </div>
        <div v-else class="empty-state">
          <n-icon :component="GitNetworkOutline" />
          <strong>{{ t('workflows.emptyTitle') }}</strong>
          <span>{{ t('workflows.emptyDesc') }}</span>
        </div>
      </section>

      <section class="workflow-editor-panel">
        <input
          ref="importFileInputRef"
          class="workflow-hidden-file-input"
          type="file"
          accept=".json,application/json"
          @change="handleImportComfyMss"
        >
        <div class="editor-head">
          <div>
            <div class="eyebrow">{{ editingId ? t('workflows.editing') : t('workflows.creating') }}</div>
            <h2>{{ editingId ? name || t('workflows.untitled') : t('workflows.newWorkflow') }}</h2>
          </div>
          <div class="editor-actions">
            <n-button secondary @click="triggerImportComfyMss">
              <template #icon><n-icon :component="OpenOutline" /></template>
              {{ t('workflows.importComfyMss') }}
            </n-button>
            <n-button secondary :disabled="!canSave" @click="exportSelectedComfyMss">
              <template #icon><n-icon :component="DownloadOutline" /></template>
              {{ t('workflows.exportComfyMss') }}
            </n-button>
            <n-button v-if="editingId" secondary @click="duplicateSelected">
              <template #icon><n-icon :component="CopyOutline" /></template>
              {{ t('workflows.duplicate') }}
            </n-button>
            <n-button v-if="editingId" secondary type="error" @click="deleteSelected">
              <template #icon><n-icon :component="TrashOutline" /></template>
              {{ t('workflows.deleteConfirm') }}
            </n-button>
            <n-button secondary @click="openNodeEditor">
              <template #icon><n-icon :component="GitNetworkOutline" /></template>
              {{ t('workflows.nodeEditor') }}
            </n-button>
            <n-button type="primary" :disabled="!canSave" @click="save">
              {{ t('common.save') }}
            </n-button>
          </div>
        </div>

        <div class="editor-form">
          <div class="form-grid">
            <label>
              <span>{{ t('workflows.name') }}</span>
              <n-input v-model:value="name" :placeholder="t('workflows.namePlaceholder')" />
            </label>
            <label>
              <span>{{ t('workflows.defaultDevice') }}</span>
              <n-select v-model:value="defaultDevice" :options="deviceOptions" />
            </label>
            <label>
              <span>{{ t('workflows.defaultFormat') }}</span>
              <n-select v-model:value="defaultFormat" :options="formatOptions" />
            </label>
            <label>
              <span>{{ t('workflows.normalize') }}</span>
              <n-switch v-model:value="defaultNormalize" />
            </label>
          </div>
          <label>
            <span>{{ t('workflows.description') }}</span>
            <n-input v-model:value="description" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" :placeholder="t('workflows.descriptionPlaceholder')" />
          </label>

          <p v-if="formError" class="json-error">{{ formError }}</p>
          <p v-else class="json-ok">{{ t('workflows.formValid') }}</p>

          <n-collapse>
            <n-collapse-item :title="t('workflows.generatedJson')" name="json">
              <n-input
                :value="generatedJson"
                type="textarea"
                class="definition-input"
                readonly
                :autosize="{ minRows: 12, maxRows: 20 }"
              />
            </n-collapse-item>
          </n-collapse>
        </div>
        <div v-if="isNodeEditorOpen" class="workflow-editor-lock">
          <div class="workflow-editor-lock__card">
            <n-icon :component="GitNetworkOutline" />
            <strong>{{ t('workflows.nodeEditorOpenedTitle') }}</strong>
            <span>{{ t('workflows.nodeEditorOpenedHint') }}</span>
            <n-button secondary @click="openNodeEditor">{{ t('workflows.backToNodeEditor') }}</n-button>
          </div>
        </div>
      </section>
    </div>

  </div>
</template>

<style scoped>
.workflows-page {
  display: grid;
  gap: 18px;
  max-width: 1240px;
}
.workflows-header {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-start;
}
.eyebrow {
  color: color-mix(in srgb, var(--primary-strong) 82%, var(--on-surface-muted));
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.workflows-header h1,
.editor-head h2 {
  margin: 4px 0 0;
}
.workflows-header p {
  margin: 8px 0 0;
  color: var(--on-surface-muted);
}
.workflows-layout {
  display: grid;
  grid-template-columns: minmax(270px, 340px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.workflow-list-panel,
.workflow-editor-panel {
  border: 1px solid color-mix(in srgb, var(--outline) 58%, transparent);
  border-radius: 20px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.026), transparent 48%),
    color-mix(in srgb, var(--surface-1) 72%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.04),
    0 18px 46px rgba(0, 0, 0, 0.075);
}
.workflow-list-panel {
  display: grid;
  align-content: start;
  gap: 10px;
  padding: 14px;
  position: sticky;
  top: 0;
}
.workflow-list {
  display: grid;
  gap: 7px;
}
.workflow-card {
  display: grid;
  grid-template-columns: 30px 1fr auto;
  gap: 9px;
  align-items: center;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 14px;
  cursor: pointer;
  background: color-mix(in srgb, var(--surface-2) 42%, transparent);
  transition: background 140ms ease, border-color 140ms ease;
}
.workflow-card:hover {
  background: color-mix(in srgb, var(--surface-2) 62%, transparent);
}
.workflow-card--active {
  border-color: color-mix(in srgb, var(--primary) 38%, var(--outline));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 28%, transparent), transparent 72%),
    color-mix(in srgb, var(--surface-2) 64%, transparent);
}
.workflow-card__icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  color: color-mix(in srgb, var(--primary-strong) 76%, var(--on-surface-muted));
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
}
.workflow-card__main {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.workflow-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.workflow-card__tooltip {
  max-width: 360px;
  white-space: pre-line;
  font-size: 12px;
  line-height: 1.55;
}
.workflow-card__run-trigger {
  display: inline-grid;
  place-items: center;
}
.workflow-card__main strong,
.workflow-card__main span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workflow-card__main span,
.empty-state span {
  color: var(--on-surface-muted);
  font-size: 12px;
}
.empty-state {
  min-height: 260px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  text-align: center;
  color: var(--on-surface-muted);
}
.empty-state .n-icon {
  font-size: 42px;
  color: var(--primary-strong);
}
.workflow-editor-panel {
  position: relative;
  padding: 18px;
  overflow: hidden;
}
.workflow-hidden-file-input {
  display: none;
}
.editor-head {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-start;
}
.editor-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.editor-form {
  margin-top: 16px;
  display: grid;
  gap: 14px;
}
.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(140px, 1fr));
  gap: 12px;
  align-items: end;
}
.editor-form label {
  display: grid;
  gap: 8px;
}
.editor-form label > span {
  color: var(--on-surface-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.definition-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}
.json-error,
.json-ok {
  margin: 0;
  font-size: 12px;
}
.json-error {
  color: var(--danger);
}
.json-ok {
  color: var(--success);
}


.workflow-editor-lock {
  position: absolute;
  inset: 74px 14px 14px;
  z-index: 8;
  display: grid;
  place-items: center;
  padding: 24px;
  border-radius: 18px;
  background:
    radial-gradient(circle at 50% 22%, color-mix(in srgb, var(--primary-soft) 44%, transparent), transparent 42%),
    color-mix(in srgb, var(--surface-1) 78%, transparent);
  backdrop-filter: blur(10px) saturate(1.08);
  border: 1px solid color-mix(in srgb, var(--outline) 50%, transparent);
}
.workflow-editor-lock__card {
  width: min(360px, 100%);
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-2) 82%, transparent);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.12);
}
.workflow-editor-lock__card .n-icon {
  font-size: 34px;
  color: var(--primary-strong);
}
.workflow-editor-lock__card span {
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.6;
}

@media (max-width: 1120px) {
  .form-grid {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 960px) {
  .workflows-layout,
  .workflows-header {
    grid-template-columns: 1fr;
    display: grid;
  }
}
</style>
