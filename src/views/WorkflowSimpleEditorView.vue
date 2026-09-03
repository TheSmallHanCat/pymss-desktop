<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { storeToRefs } from 'pinia'
import WorkflowSimpleNodeEditor from '@/components/workflow/WorkflowSimpleNodeEditor.vue'
import WorkflowRevisionConflictModal from '@/components/workflow/WorkflowRevisionConflictModal.vue'
import { useModelStore } from '@/stores/model'
import { WorkflowRevisionConflictError, useWorkflowStore, type WorkflowEntry } from '@/stores/workflow'
import {
  buildSimpleWorkflowDefinition,
  configuredStemsFor,
  createDefaultSimpleEditorUi,
  createStepDraft,
  hydrateSimpleWorkflow,
  type SimpleDraft,
} from '@/utils/workflowSimple'
import { canConnectSimple, cleanupSimpleDraft, simpleStepInputTarget } from '@/utils/simpleWorkflowEditor'
import { isSimpleWorkflowDefinition } from '@/workflows/formats'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const workflow = useWorkflowStore()
const model = useModelStore()
const { workflows } = storeToRefs(workflow)
const { downloadedModels } = storeToRefs(model)

const currentWindow = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? getCurrentWindow() : null
const isMacOS = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const isStandaloneWindow = computed(() => Boolean(currentWindow && currentWindow.label !== 'main'))
const showCustomWindowChrome = computed(() => isStandaloneWindow.value && !isMacOS)
const isMaximized = ref(false)
const name = ref('')
const description = ref('')
const draft = ref<SimpleDraft>(hydrateSimpleWorkflow({ steps: [] }))
const editingId = ref('')
const expectedUpdatedAt = ref<number | undefined>()
const loaded = ref(false)
const editorRenderKey = ref(0)
const saving = ref(false)
const initialSnapshot = ref('')
const showClosePrompt = ref(false)
const showRevisionConflict = ref(false)
const pendingConflict = ref<{ definition: Record<string, unknown>; name: string; description: string } | null>(null)
let unlistenResize: (() => void) | undefined
let unlistenCloseRequested: (() => void) | undefined

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshot() {
  return JSON.stringify({ name: name.value, description: description.value, draft: draft.value })
}

const dirty = computed(() => loaded.value && snapshot() !== initialSnapshot.value)

const formError = computed(() => {
  if (!name.value.trim()) return t('workflows.nameRequired')
  if (!draft.value.steps.length) return t('workflows.stepsRequired')
  const downloaded = new Set(downloadedModels.value.map(item => item.name))
  for (const [index, step] of draft.value.steps.entries()) {
    const stepLabel = t('workflows.stepTitle', { index: index + 1 })
    if (!step.model.trim()) return t('workflows.stepModelRequired', { id: stepLabel })
    if (!downloaded.has(step.model.trim())) return t('workflows.stepModelNotDownloaded', { id: stepLabel })
    if (!step.input.trim()) return t('workflows.stepInputRequired', { id: stepLabel })
    if (!canConnectSimple(draft.value, step.input, simpleStepInputTarget(step.id)).ok) return t('workflows.invalidConnection')
    if (!step.stems.length) return t('workflows.stepStemsRequired', { id: stepLabel })
  }
  if (!draft.value.steps.some(step => Object.keys(step.save || {}).length)) return t('workflows.workflowNoSaveOutputs')
  return ''
})
const canSave = computed(() => !formError.value && !saving.value)

function createExampleDraft(): SimpleDraft {
  const example = hydrateSimpleWorkflow({ steps: [] })
  const step = createStepDraft(0)
  const modelEntry = downloadedModels.value[0]
  if (modelEntry) {
    step.model = modelEntry.name
    step.stems = configuredStemsFor(modelEntry)
    step.outputNames = Object.fromEntries(step.stems.map(stem => [stem, '%filename%_%stem%_%model%']))
    step.save = Object.fromEntries(step.stems.map(stem => [stem, 'Default']))
  }
  example.steps = [step]
  example.ui = createDefaultSimpleEditorUi(example.steps)
  return example
}

function loadEntry(entry?: WorkflowEntry | null) {
  editingId.value = entry?.id || ''
  name.value = entry?.name || '新建工作流'
  description.value = entry?.description || ''
  const hydrated = entry && isSimpleWorkflowDefinition(entry.definition)
    ? hydrateSimpleWorkflow(entry.definition)
    : hydrateSimpleWorkflow({ steps: [] })
  if (!entry) {
    const example = createExampleDraft()
    hydrated.defaultDevice = example.defaultDevice
    hydrated.defaultFormat = example.defaultFormat
    hydrated.defaultNormalize = example.defaultNormalize
    hydrated.steps = example.steps
    hydrated.ui = example.ui
  } else if (!hydrated.steps.length) {
    hydrated.steps = [createStepDraft(0)]
    hydrated.ui = createDefaultSimpleEditorUi(hydrated.steps)
  } else {
    hydrated.ui = hydrated.ui || createDefaultSimpleEditorUi(hydrated.steps)
  }
  cleanupSimpleDraft(hydrated)
  draft.value = clone(hydrated)
  expectedUpdatedAt.value = entry?.updatedAt
  initialSnapshot.value = snapshot()
  loaded.value = true
}

async function persist(force = false) {
  if (!canSave.value && !force) return null
  saving.value = true
  try {
    cleanupSimpleDraft(draft.value)
    const entry = await workflow.saveWorkflow({
      id: editingId.value || undefined,
      name: name.value.trim(),
      description: description.value.trim(),
      definition: buildSimpleWorkflowDefinition(draft.value) as unknown as Record<string, unknown>,
      expectedUpdatedAt: force ? undefined : expectedUpdatedAt.value,
      force,
    })
    editingId.value = entry.id
    expectedUpdatedAt.value = entry.updatedAt
    initialSnapshot.value = snapshot()
    message.success(t('workflows.saved'))
    return entry
  } catch (error) {
    if (error instanceof WorkflowRevisionConflictError) {
      pendingConflict.value = {
        definition: buildSimpleWorkflowDefinition(draft.value) as unknown as Record<string, unknown>,
        name: name.value.trim(),
        description: description.value.trim(),
      }
      showRevisionConflict.value = true
      return null
    }
    message.error(error instanceof Error ? error.message : String(error))
    return null
  } finally {
    saving.value = false
  }
}

async function closeEditor() {
  if (dirty.value) {
    showClosePrompt.value = true
    return
  }
  await destroyWindow()
}

async function destroyWindow() {
  if (isStandaloneWindow.value && currentWindow) {
    try { await invoke('close_current_window'); return } catch { await currentWindow.close().catch(() => undefined); return }
  }
  await router.push('/workflows')
}

async function refreshMaximized() {
  if (!isStandaloneWindow.value || !currentWindow) {
    isMaximized.value = false
    return
  }
  try {
    isMaximized.value = await invoke<boolean>('is_current_window_maximized')
  } catch {
    try { isMaximized.value = await currentWindow.isMaximized() } catch { isMaximized.value = false }
  }
}

function startWindowDrag(event?: MouseEvent) {
  if (event?.detail && event.detail > 1) {
    void toggleMaximizeWindow()
    return
  }
  if (!currentWindow) return
  invoke('start_drag_current_window').catch(() => currentWindow.startDragging().catch(() => undefined))
}

async function minimizeWindow() {
  if (!currentWindow) return
  try { await invoke('minimize_current_window') } catch { await currentWindow.minimize().catch(() => undefined) }
}

async function toggleMaximizeWindow() {
  if (!currentWindow) return
  try {
    isMaximized.value = await invoke<boolean>('toggle_maximize_current_window')
  } catch {
    await currentWindow.toggleMaximize().then(refreshMaximized).catch(() => undefined)
  }
}

async function saveAndClose() {
  // The save button in the close prompt must follow the same validation as
  // the editor toolbar.  Previously `persist()` returned null silently when
  // the draft was invalid, while the prompt was already dismissed, which
  // made the action appear to do nothing.
  if (saving.value) return
  if (formError.value) {
    message.warning(formError.value)
    return
  }
  showClosePrompt.value = false
  const entry = await persist()
  if (entry) await destroyWindow()
}

async function runWorkflow() {
  const entry = await persist()
  if (!entry) return
  if (isStandaloneWindow.value && currentWindow) {
    await currentWindow.emit('pymss://workflow-simple-editor-action', { action: 'run', workflowId: entry.id })
    await destroyWindow()
    return
  }
  await router.push({ path: '/', query: { mode: 'workflow' } })
}

async function reloadConflict() {
  if (!editingId.value) return
  await workflow.reload()
  const latest = workflows.value.find(item => item.id === editingId.value)
  if (latest) loadEntry(latest)
  pendingConflict.value = null
  showRevisionConflict.value = false
}

function saveConflictCopy() {
  const pending = pendingConflict.value
  if (!pending) return
  pendingConflict.value = null
  showRevisionConflict.value = false
  editingId.value = ''
  expectedUpdatedAt.value = undefined
  name.value = `${pending.name} Copy`
  void persist()
}

function overwriteConflict() {
  pendingConflict.value = null
  showRevisionConflict.value = false
  void persist(true)
}

onMounted(async () => {
  await Promise.allSettled([workflow.initialize(), model.initialize()])
  // The standalone window has its own Pinia instance.  Use the persisted
  // model cache immediately, then refresh it in the background when the
  // backend is available so newly downloaded models become selectable without
  // delaying the editor window.
  if (!model.modelsLoaded) {
    void model.loadModels().catch((error) => {
      console.warn('Failed to refresh models for simple workflow editor', error)
    })
  }
  const id = String(route.query.workflowId || '').trim()
  loadEntry(id ? workflows.value.find(item => item.id === id) : null)
  await refreshMaximized()
  if (!currentWindow || currentWindow.label === 'main') return
  try { unlistenResize = await currentWindow.onResized(refreshMaximized) } catch {}
  try {
    unlistenCloseRequested = await currentWindow.onCloseRequested((event) => {
      event.preventDefault()
      void closeEditor()
    })
  } catch {}
})

watch(() => draft.value.steps.length, () => {
  if (!draft.value.ui) draft.value.ui = createDefaultSimpleEditorUi(draft.value.steps)
})

watch(downloadedModels, () => {
  // A new editor can mount before the model cache finishes loading. Fill the
  // starter step once the first downloaded model becomes available, without
  // replacing edits the user has already made in the blank draft.
  if (editingId.value || !loaded.value || dirty.value || draft.value.steps.some(step => step.model.trim())) return
  const example = createExampleDraft()
  draft.value.steps = example.steps
  draft.value.ui = example.ui
  initialSnapshot.value = snapshot()
  // Recreate the child once so its undo baseline includes the asynchronously
  // loaded starter template rather than the initial blank draft.
  editorRenderKey.value += 1
})

onBeforeUnmount(() => {
  unlistenResize?.()
  unlistenCloseRequested?.()
})

</script>

<template>
  <div class="simple-editor-page" :class="{ 'simple-editor-page--custom-chrome': showCustomWindowChrome }">
    <header v-if="showCustomWindowChrome" class="simple-editor-chrome">
      <div class="simple-editor-chrome__drag" data-tauri-drag-region @mousedown.left="startWindowDrag">
        <strong>{{ t('app.name') }}</strong><span>·</span><span>{{ t('workflows.simpleCreator') }}</span>
      </div>
      <div class="simple-editor-chrome__actions">
        <button type="button" :aria-label="t('common.minimize')" @click="minimizeWindow">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
        <button type="button" :aria-label="t('common.maximize')" @click="toggleMaximizeWindow">
          <svg v-if="isMaximized" width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2" /><path d="M3.5 3.5V2a.5.5 0 01.5-.5h6a.5.5 0 01.5.5v6a.5.5 0 01-.5.5h-1.5" stroke="currentColor" stroke-width="1.2" /></svg>
          <svg v-else width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" /></svg>
        </button>
        <button type="button" class="danger" :aria-label="t('common.close')" @click="closeEditor">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
      </div>
    </header>
    <WorkflowSimpleNodeEditor
      v-if="loaded"
      :key="editorRenderKey"
      v-model:draft="draft"
      v-model:name="name"
      v-model:description="description"
      :models="downloadedModels"
      :saving="saving"
      :form-error="formError"
      :can-save="canSave"
      @save="persist"
      @close="closeEditor"
      @run="runWorkflow"
    />
    <n-modal v-model:show="showClosePrompt" preset="card" :title="t('workflows.simpleUnsavedTitle')" style="width: min(440px, calc(100vw - 32px))">
      <p>{{ t('workflows.simpleUnsavedHint') }}</p>
      <template #footer><div class="simple-editor-page__prompt-actions"><n-button secondary @click="showClosePrompt = false; void destroyWindow()">{{ t('workflows.simpleDiscardChanges') }}</n-button><n-button type="primary" :loading="saving" :disabled="saving" @click="void saveAndClose()">{{ t('workflows.simpleSaveAndClose') }}</n-button></div></template>
    </n-modal>
    <WorkflowRevisionConflictModal
      v-model:show="showRevisionConflict"
      :workflow-name="name"
      @reload="reloadConflict"
      @save-copy="saveConflictCopy"
      @overwrite="overwriteConflict"
    />
  </div>
</template>

<style scoped>
.simple-editor-page { height: 100%; min-height: 0; background: var(--surface); color: var(--on-surface); -webkit-app-region: no-drag; }
.simple-editor-page * { -webkit-app-region: no-drag; }
.simple-editor-chrome { height: 40px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--outline) 54%, transparent); background: color-mix(in srgb, var(--surface) 84%, transparent); backdrop-filter: blur(18px) saturate(1.15); user-select: none; }
.simple-editor-chrome__drag { display: flex; align-items: center; gap: 6px; height: 100%; padding-left: 12px; flex: 1; -webkit-app-region: drag; font-size: 12px; }
.simple-editor-chrome__drag span { color: var(--on-surface-muted); }
.simple-editor-chrome__actions { display: flex; height: 100%; }
.simple-editor-chrome__actions button { width: 46px; height: 100%; display: grid; place-items: center; border: 0; background: transparent; color: var(--on-surface-muted); cursor: pointer; transition: background 140ms ease, color 140ms ease; }
.simple-editor-chrome__actions button:hover { background: var(--surface-2); color: var(--on-surface); }
.simple-editor-chrome__actions button.danger:hover { background: var(--danger); color: #fff; }
.simple-editor-page__prompt-actions { display: flex; justify-content: flex-end; gap: 8px; }
.simple-editor-page > :deep(.simple-node-editor) { height: 100%; }
.simple-editor-page--custom-chrome > :deep(.simple-node-editor) { height: calc(100% - 40px); }
</style>
