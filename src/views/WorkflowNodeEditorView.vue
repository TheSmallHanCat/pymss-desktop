<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useMessage, type InputInst } from 'naive-ui'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { storeToRefs } from 'pinia'
import WorkflowNodeEditor from '@/components/workflow/WorkflowNodeEditor.vue'
import { useModelStore } from '@/stores/model'
import { useWorkflowStore, type WorkflowEntry } from '@/stores/workflow'
import {
  buildWorkflowDefinition,
  getWorkflowValidationSummary,
  hydrateWorkflowDefinition,
  workflowValidationErrorMessage,
  type WorkflowValidationSummary,
} from '@/utils/workflowDefinition'
import {
  readWorkflowGraphDefinition,
  serializeWorkflowGraphDefinition,
} from '@/utils/workflowGraph'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const workflow = useWorkflowStore()
const model = useModelStore()
const { workflows } = storeToRefs(workflow)
const { models, downloadedModels } = storeToRefs(model)

const editingId = ref('')
const name = ref('')
const description = ref('')
const defaultDevice = ref('auto')
const defaultFormat = ref('wav')
const defaultNormalize = ref(false)
const definition = ref<Record<string, unknown>>({})
const loaded = ref(false)
const editingName = ref(false)
const nameBeforeEdit = ref('')
const nameInputRef = ref<InputInst | null>(null)

const hasTauriWindow = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const currentWindow = hasTauriWindow ? getCurrentWindow() : null
const isStandaloneWindow = computed(() => Boolean(currentWindow && currentWindow.label !== 'main'))
const isMaximized = ref(false)

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

const modelOptions = computed(() => [...downloadedModels.value]
  .sort((a, b) => a.name.localeCompare(b.name, locale.value === 'zh-CN' ? 'zh-CN' : 'en'))
  .map(item => ({
    label: item.name,
    value: item.name,
  })))
const hydratedDraft = computed(() => hydrateWorkflowDefinition(definition.value))
const generatedDefinition = computed(() => buildWorkflowDefinition({
  defaultDevice: defaultDevice.value,
  defaultFormat: defaultFormat.value,
  defaultNormalize: defaultNormalize.value,
  steps: hydratedDraft.value.steps,
  utilityNodes: hydratedDraft.value.utilityNodes,
  saveTargets: hydratedDraft.value.saveTargets,
  ui: hydratedDraft.value.ui,
}))
const validationSummary = computed(() => getWorkflowValidationSummary(generatedDefinition.value))

function workflowValidationError(summary: WorkflowValidationSummary) {
  return workflowValidationErrorMessage(summary, t)
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

function loadWorkflow(item?: WorkflowEntry | null) {
  if (!item) {
    editingId.value = ''
    name.value = t('workflows.newWorkflow')
    description.value = ''
    defaultDevice.value = 'auto'
    defaultFormat.value = 'wav'
    defaultNormalize.value = false
    definition.value = createFreshDefinition()
    return
  }
  editingId.value = item.id
  name.value = item.name
  description.value = item.description
  definition.value = item.definition
  const draft = hydrateWorkflowDefinition(item.definition)
  defaultDevice.value = draft.defaultDevice
  defaultFormat.value = draft.defaultFormat
  defaultNormalize.value = draft.defaultNormalize
  workflow.selectWorkflow(item.id)
}

async function save(currentDefinition?: Record<string, unknown>) {
  if (!canSave.value) return
  try {
    const definitionSource = currentDefinition && typeof currentDefinition === 'object'
      ? currentDefinition
      : generatedDefinition.value
    const graphDefinition = readWorkflowGraphDefinition(definitionSource)
    const definitionToSave = serializeWorkflowGraphDefinition({
      ...graphDefinition,
      defaults: {
        ...graphDefinition.defaults,
        device: defaultDevice.value || 'auto',
        output_format: defaultFormat.value || 'wav',
        inference_params: {
          ...(graphDefinition.defaults.inference_params || {}),
          normalize: Boolean(defaultNormalize.value),
        },
      },
    })
    const entry = await workflow.saveWorkflow({
      id: editingId.value || undefined,
      name: name.value,
      description: description.value,
      definition: definitionToSave,
    })
    loadWorkflow(entry)
    message.success(t('workflows.saved'))
  } catch (error) {
    console.error('[workflow-node-editor-view] save failed', error)
    message.error(error instanceof Error ? error.message : 'Save failed')
  }
}

async function closeEditor() {
  if (currentWindow && currentWindow.label !== 'main') {
    try {
      await invoke('close_current_window')
    } catch {
      await currentWindow.destroy().catch(() => currentWindow.close())
    }
    return
  }
  await router.push('/workflows')
}

function beginNameEdit() {
  nameBeforeEdit.value = name.value
  editingName.value = true
  void nextTick(() => nameInputRef.value?.focus())
}

function finishNameEdit() {
  if (!editingName.value) return
  const trimmed = name.value.trim()
  name.value = trimmed || nameBeforeEdit.value.trim() || t('workflows.newWorkflow')
  editingName.value = false
}

function cancelNameEdit() {
  name.value = nameBeforeEdit.value || t('workflows.newWorkflow')
  editingName.value = false
}
async function refreshMaximized() {
  if (!currentWindow) {
    isMaximized.value = false
    return
  }
  try {
    isMaximized.value = await invoke<boolean>('is_current_window_maximized')
  } catch (error) {
    console.warn('[workflow-node-editor] is_current_window_maximized failed', error)
    try {
      isMaximized.value = await currentWindow.isMaximized()
    } catch {
      isMaximized.value = false
    }
  }
}

function startWindowDrag(event?: MouseEvent) {
  if (event?.detail && event.detail > 1) {
    void toggleMaximizeWindow()
    return
  }
  if (!currentWindow) return
  invoke('start_drag_current_window').catch((error) => {
    console.warn('[workflow-node-editor] start_drag_current_window failed', error)
    currentWindow.startDragging().catch(innerError => console.warn('[workflow-node-editor] currentWindow.startDragging failed', innerError))
  })
}

async function minimizeWindow() {
  if (!currentWindow) return
  try {
    await invoke('minimize_current_window')
  } catch (error) {
    console.warn('[workflow-node-editor] minimize_current_window failed', error)
    currentWindow.minimize().catch(innerError => console.warn('[workflow-node-editor] currentWindow.minimize failed', innerError))
  }
}

async function toggleMaximizeWindow() {
  if (!currentWindow) return
  try {
    isMaximized.value = await invoke<boolean>('toggle_maximize_current_window')
  } catch (error) {
    console.warn('[workflow-node-editor] toggle_maximize_current_window failed', error)
    currentWindow.toggleMaximize().then(refreshMaximized).catch(innerError => console.warn('[workflow-node-editor] currentWindow.toggleMaximize failed', innerError))
  }
}

let unlistenResize: (() => void) | undefined
let unlistenCloseRequested: (() => void) | undefined

onMounted(async () => {
  const workflowId = String(route.query.workflowId || '')
  const isNewWorkflow = route.query.new === '1'
  const target = workflowId ? workflows.value.find(item => item.id === workflowId) : null
  loadWorkflow(isNewWorkflow ? null : target || workflows.value.find(item => item.id === workflow.selectedWorkflowId) || workflows.value[0] || null)
  loaded.value = true
  await refreshMaximized()
  if (!currentWindow || currentWindow.label === 'main') return
  try {
    unlistenResize = await currentWindow.onResized(refreshMaximized)
  } catch {}
  try {
    unlistenCloseRequested = await currentWindow.onCloseRequested((event) => {
      event.preventDefault()
      void closeEditor()
    })
  } catch {}
})

onBeforeUnmount(() => {
  unlistenResize?.()
  unlistenCloseRequested?.()
})

watch([defaultDevice, defaultFormat, defaultNormalize], () => {
  if (!loaded.value) return
  definition.value = generatedDefinition.value
})
</script>

<template>
  <div class="workflow-node-editor-page">
    <header v-if="isStandaloneWindow" class="workflow-window-chrome">
      <div class="workflow-window-chrome__drag" data-tauri-drag-region @mousedown.left="startWindowDrag">
        <div class="workflow-window-chrome__copy">
          <strong>{{ t('app.name') }}</strong>
          <span>{{ t('workflows.nodeEditor') }}</span>
        </div>
      </div>
      <div class="workflow-window-chrome__actions">
        <button type="button" :aria-label="t('common.minimize')" @click="minimizeWindow">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <button type="button" :aria-label="t('common.maximize')" @click="toggleMaximizeWindow">
          <svg v-if="isMaximized" width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 3.5V2a.5.5 0 01.5-.5h6a.5.5 0 01.5.5v6a.5.5 0 01-.5.5h-1.5" stroke="currentColor" stroke-width="1.2"/></svg>
          <svg v-else width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
        <button type="button" class="danger" :aria-label="t('common.close')" @click="closeEditor">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
    </header>

    <section class="workflow-node-editor-topbar">
      <div class="workflow-node-editor-title">
        <div class="eyebrow">{{ t('workflows.nodeEditor') }}</div>
        <button v-if="!editingName" type="button" class="workflow-name-trigger" @click="beginNameEdit">
          {{ name || t('workflows.untitled') }}
        </button>
        <n-input
          v-else
          ref="nameInputRef"
          v-model:value="name"
          class="workflow-name-input"
          size="small"
          :placeholder="t('workflows.namePlaceholder')"
          @blur="finishNameEdit"
          @keydown.enter.prevent="finishNameEdit"
          @keydown.esc.prevent="cancelNameEdit"
        />
      </div>

      <div class="config-grid">
        <label class="config-field">
          <span>{{ t('workflows.defaultDevice') }}</span>
          <n-select v-model:value="defaultDevice" size="small" :options="deviceOptions" />
        </label>
        <label class="config-field">
          <span>{{ t('workflows.defaultFormat') }}</span>
          <n-select v-model:value="defaultFormat" size="small" :options="formatOptions" />
        </label>
        <label class="config-field config-field--switch">
          <span>{{ t('workflows.normalize') }}</span>
          <n-switch v-model:value="defaultNormalize" size="small" />
        </label>
      </div>

      <details class="description-drawer">
        <summary>{{ t('workflows.description') }}</summary>
        <n-input v-model:value="description" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" :placeholder="t('workflows.descriptionPlaceholder')" />
      </details>
    </section>

    <WorkflowNodeEditor
      v-if="loaded"
      v-model:definition="definition"
      :model-options="modelOptions"
      :models="models"
      :form-error="formError"
      :can-save="canSave"
      @save="save"
      @close="closeEditor"
    />
  </div>
</template>

<style scoped>
.workflow-node-editor-page {
  height: 100%;
  min-height: 0;
  padding: 0 12px 12px;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 10px;
  -webkit-app-region: no-drag;
}

.workflow-node-editor-page *,
.workflow-node-editor-page :deep(*) {
  -webkit-app-region: no-drag;
}

.workflow-window-chrome {
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 54%, transparent);
  background: color-mix(in srgb, var(--surface) 84%, transparent);
  backdrop-filter: blur(18px) saturate(1.15);
  user-select: none;
}

.workflow-window-chrome__drag {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  padding-left: 12px;
  -webkit-app-region: drag;
}

.workflow-window-chrome__copy {
  display: grid;
  gap: 2px;
}

.workflow-window-chrome__copy strong {
  font-size: 12px;
  line-height: 1.1;
}

.workflow-window-chrome__copy span {
  color: var(--on-surface-muted);
  font-size: 10px;
  line-height: 1.1;
}

.workflow-window-chrome__actions {
  display: flex;
  height: 100%;
}

.workflow-window-chrome__actions button {
  width: 46px;
  border: 0;
  background: transparent;
  color: var(--on-surface-muted);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.workflow-window-chrome__actions button:hover {
  background: color-mix(in srgb, var(--surface-2) 88%, transparent);
  color: var(--on-surface);
}

.workflow-window-chrome__actions button.danger:hover {
  background: var(--danger);
  color: #fff;
}

.workflow-node-editor-topbar {
  min-height: 58px;
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto auto;
  align-items: end;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 16px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.04), transparent 70%),
    color-mix(in srgb, var(--surface-1) 80%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 74%, transparent),
    0 14px 34px rgba(0, 0, 0, 0.08);
}

.workflow-node-editor-title {
  min-width: 0;
  display: grid;
  gap: 6px;
}

.eyebrow {
  color: color-mix(in srgb, var(--primary-strong) 82%, var(--on-surface-muted));
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.workflow-name-trigger {
  min-width: 0;
  width: fit-content;
  max-width: min(360px, 100%);
  padding: 0;
  border: 0;
  color: var(--on-surface);
  background: transparent;
  cursor: text;
  font: inherit;
  font-size: 18px;
  font-weight: 800;
  line-height: 1.12;
  text-align: left;
}

.workflow-name-trigger:hover {
  color: var(--primary-strong);
}

.workflow-name-trigger,
.workflow-name-input {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-name-input {
  max-width: 320px;
}

.config-grid {
  display: grid;
  grid-template-columns: minmax(132px, 156px) minmax(132px, 156px) minmax(92px, auto);
  gap: 8px;
  align-items: end;
}

.config-field {
  display: grid;
  gap: 5px;
}

.config-field > span {
  color: var(--on-surface-muted);
  font-size: 11px;
  font-weight: 700;
}

.config-field--switch {
  justify-items: start;
}

.description-drawer {
  min-width: 132px;
  align-self: end;
  position: relative;
}

.description-drawer summary {
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 45%, transparent);
  border-radius: 10px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-2) 62%, transparent);
  cursor: pointer;
  font-size: 12px;
  list-style: none;
}

.description-drawer summary::-webkit-details-marker {
  display: none;
}

.description-drawer[open] {
  position: relative;
}

.description-drawer[open] :deep(.n-input) {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 20;
  width: min(420px, 70vw);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.16);
}

@media (max-width: 1100px) {
  .workflow-node-editor-topbar {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .config-grid {
    grid-template-columns: 1fr 1fr;
  }

  .description-drawer[open] :deep(.n-input) {
    position: static;
    width: 100%;
    margin-top: 8px;
  }
}
</style>
