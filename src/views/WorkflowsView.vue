<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  AddOutline,
  CopyOutline,
  GitNetworkOutline,
  PlayOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useModelStore } from '@/stores/model'
import { useWorkflowStore, type WorkflowEntry } from '@/stores/workflow'

type WorkflowStepDraft = {
  id: string
  model: string
  input: string
  stems: string[]
  overlapSize: number | null
}

const { t, locale } = useI18n()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const workflow = useWorkflowStore()
const model = useModelStore()
const { workflows, selectedWorkflowId, selectedWorkflow } = storeToRefs(workflow)
const { models, downloadedModels } = storeToRefs(model)
const editingId = ref('')
const name = ref('')
const description = ref('')
const query = ref('')
const defaultDevice = ref('auto')
const defaultFormat = ref('wav')
const defaultNormalize = ref(false)
const steps = ref<WorkflowStepDraft[]>([createStepDraft()])

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
const filteredWorkflows = computed(() => {
  const value = query.value.trim().toLowerCase()
  if (!value) return workflows.value
  return workflows.value.filter(item =>
    item.name.toLowerCase().includes(value)
    || item.description.toLowerCase().includes(value),
  )
})
const generatedDefinition = computed(() => buildDefinition())
const generatedJson = computed(() => JSON.stringify(generatedDefinition.value, null, 2))
const formError = computed(() => {
  if (!name.value.trim()) return t('workflows.nameRequired')
  if (!steps.value.length) return t('workflows.stepsRequired')
  const downloaded = new Set(downloadedModels.value.map(item => item.name))
  for (const [index, step] of steps.value.entries()) {
    const label = t('workflows.stepTitle', { index: index + 1 })
    if (!step.model.trim()) return t('workflows.stepModelRequired', { id: label })
    if (!downloaded.has(step.model.trim())) return t('workflows.stepModelNotDownloaded', { id: label })
    if (!step.input.trim()) return t('workflows.stepInputRequired', { id: label })
    if (!step.stems.length) return t('workflows.stepStemsRequired', { id: label })
  }
  return ''
})
const canSave = computed(() => !formError.value)

function createStepDraft(index = 0): WorkflowStepDraft {
  return {
    id: `step_${index + 1}`,
    model: '',
    input: index ? '' : 'input',
    stems: [],
    overlapSize: null,
  }
}
function parseModelStems(value?: unknown) {
  const seen = new Set<string>()
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，;；/|\n]+/)
  return rawItems
    .map(item => String(item || '').trim().replace(/^[\s"'[\](){}]+|[\s"'[\](){}]+$/g, ''))
    .filter((item) => {
      if (!item) return false
      const key = item.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
function modelStemOptions(modelName: string) {
  const entry = models.value.find(item => item.name === modelName)
  return parseModelStems(entry?.configInstruments || entry?.configTargetInstrument || entry?.targetStem)
    .map(stem => ({ label: stem, value: stem }))
}
function inputOptions(index: number) {
  const options = [{ label: t('workflows.originalInput'), value: 'input' }]
  steps.value.slice(0, index).forEach((step) => {
    step.stems.forEach((stem) => {
      options.push({ label: `${step.id}.${stem}`, value: `${step.id}.${stem}` })
    })
  })
  return options
}
function reindexSteps() {
  steps.value.forEach((step, index) => {
    step.id = `step_${index + 1}`
  })
}
function safeStemDir(stem: string) {
  return stem.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_') || stem
}
function buildDefinition(): Record<string, unknown> {
  return {
    version: 1,
    defaults: {
      device: defaultDevice.value,
      output_format: defaultFormat.value,
      model_dir: null,
      inference_params: {
        normalize: defaultNormalize.value,
      },
    },
    steps: steps.value.map((step, index) => ({
      id: `step_${index + 1}`,
      model: step.model.trim(),
      input: step.input.trim(),
      stems: [...step.stems],
      ...(step.overlapSize ? { inference_params: { overlap_size: step.overlapSize } } : {}),
      save: Object.fromEntries(step.stems.map(stem => [stem, safeStemDir(stem)])),
    })),
  }
}
function hydrateFromDefinition(definition: Record<string, unknown>) {
  const defaults = definition.defaults && typeof definition.defaults === 'object'
    ? definition.defaults as Record<string, unknown>
    : {}
  defaultDevice.value = String(defaults.device || 'auto')
  defaultFormat.value = String(defaults.output_format || 'wav')
  const inferenceDefaults = defaults.inference_params && typeof defaults.inference_params === 'object'
    ? defaults.inference_params as Record<string, unknown>
    : {}
  defaultNormalize.value = Boolean(inferenceDefaults.normalize)
  const rawSteps = Array.isArray(definition.steps) ? definition.steps : []
  const idMap = new Map<string, string>()
  rawSteps.forEach((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (item.id) idMap.set(String(item.id), `step_${index + 1}`)
  })
  steps.value = rawSteps.map((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const inference = item.inference_params && typeof item.inference_params === 'object'
      ? item.inference_params as Record<string, unknown>
      : {}
    const save = item.save && typeof item.save === 'object' ? item.save as Record<string, unknown> : {}
    const stems = Array.isArray(item.stems)
      ? item.stems.map(stem => String(stem))
      : Object.keys(save)
    const rawInput = String(item.input || (index ? '' : 'input'))
    const mappedInput = rawInput.includes('.')
      ? (() => {
          const [sourceId, stem] = rawInput.split('.', 2)
          return idMap.has(sourceId) && stem ? `${idMap.get(sourceId)}.${stem}` : rawInput
        })()
      : rawInput
    return {
      id: `step_${index + 1}`,
      model: String(item.model || ''),
      input: mappedInput,
      stems,
      overlapSize: typeof inference.overlap_size === 'number' ? inference.overlap_size : null,
    }
  })
  if (!steps.value.length) steps.value = [createStepDraft()]
  reindexSteps()
}
function resetEditor() {
  editingId.value = ''
  name.value = ''
  description.value = ''
  defaultDevice.value = 'auto'
  defaultFormat.value = 'wav'
  defaultNormalize.value = false
  steps.value = [createStepDraft()]
}
function editWorkflow(item: WorkflowEntry) {
  editingId.value = item.id
  name.value = item.name
  description.value = item.description
  hydrateFromDefinition(item.definition)
  workflow.selectWorkflow(item.id)
}
function addStep() {
  const draft = createStepDraft(steps.value.length)
  draft.input = inputOptions(steps.value.length)[0]?.value || 'input'
  steps.value.push(draft)
  reindexSteps()
}
function removeStep(index: number) {
  if (steps.value.length <= 1) return
  steps.value.splice(index, 1)
  reindexSteps()
}
function handleModelChange(step: WorkflowStepDraft) {
  const options = modelStemOptions(step.model).map(item => item.value)
  step.stems = step.stems.filter(stem => options.includes(stem))
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
  workflow.selectWorkflow(item.id)
  router.push({ path: '/', query: { mode: 'workflow' } })
}
watch(workflows, (items) => {
  if (!editingId.value && items.length) editWorkflow(items[0])
}, { immediate: true })
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
            </div>
            <n-button quaternary circle size="small" @click.stop="runWorkflow(item)">
              <template #icon><n-icon :component="PlayOutline" /></template>
            </n-button>
          </article>
        </div>
        <div v-else class="empty-state">
          <n-icon :component="GitNetworkOutline" />
          <strong>{{ t('workflows.emptyTitle') }}</strong>
          <span>{{ t('workflows.emptyDesc') }}</span>
        </div>
      </section>

      <section class="workflow-editor-panel">
        <div class="editor-head">
          <div>
            <div class="eyebrow">{{ editingId ? t('workflows.editing') : t('workflows.creating') }}</div>
            <h2>{{ editingId ? name || t('workflows.untitled') : t('workflows.newWorkflow') }}</h2>
          </div>
          <div class="editor-actions">
            <n-button v-if="editingId" secondary @click="duplicateSelected">
              <template #icon><n-icon :component="CopyOutline" /></template>
              {{ t('workflows.duplicate') }}
            </n-button>
            <n-button v-if="editingId" secondary type="error" @click="deleteSelected">
              <template #icon><n-icon :component="TrashOutline" /></template>
              {{ t('workflows.deleteConfirm') }}
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

          <div class="steps-head">
            <div>
              <strong>{{ t('workflows.steps') }}</strong>
              <span>{{ t('workflows.stepsHint') }}</span>
            </div>
            <n-button secondary @click="addStep">
              <template #icon><n-icon :component="AddOutline" /></template>
              {{ t('workflows.addStep') }}
            </n-button>
          </div>

          <div class="workflow-chain">
            <article v-for="(step, index) in steps" :key="index" class="step-card">
              <div class="step-card__head">
                <div class="step-card__title">
                  <span class="step-card__index">{{ index + 1 }}</span>
                  <strong>{{ t('workflows.stepTitle', { index: index + 1 }) }}</strong>
                </div>
                <n-button quaternary circle size="small" :disabled="steps.length <= 1" @click="removeStep(index)">
                  <template #icon><n-icon :component="TrashOutline" /></template>
                </n-button>
              </div>
              <div class="form-grid form-grid--step">
                <label>
                  <span>{{ t('workflows.stepModel') }}</span>
                  <n-select
                    v-model:value="step.model"
                    filterable
                    :options="modelOptions"
                    :placeholder="t('workflows.stepModelPlaceholder')"
                    @update:value="handleModelChange(step)"
                  />
                </label>
                <label>
                  <span>{{ t('workflows.stepInput') }}</span>
                  <n-select
                    v-model:value="step.input"
                    filterable
                    tag
                    :options="inputOptions(index)"
                    :placeholder="t('workflows.stepInputPlaceholder')"
                  />
                </label>
                <label>
                  <span>{{ t('workflows.stepOverlap') }}</span>
                  <n-input-number v-model:value="step.overlapSize" clearable :min="0" :step="1024" style="width: 100%" />
                </label>
              </div>
              <label>
                <span>{{ t('workflows.stepStems') }}</span>
                <n-select
                  v-model:value="step.stems"
                  multiple
                  filterable
                  tag
                  :options="modelStemOptions(step.model)"
                  :placeholder="t('workflows.stepStemsPlaceholder')"
                />
              </label>
            </article>
          </div>

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
.workflows-header p,
.steps-head span {
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
  padding: 18px;
}
.editor-head,
.steps-head,
.step-card__head {
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
.form-grid--step {
  grid-template-columns: minmax(220px, 1.4fr) minmax(180px, 1fr) minmax(140px, .8fr);
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
.workflow-chain {
  position: relative;
  display: grid;
  gap: 12px;
  padding-left: 20px;
}
.workflow-chain::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 10px;
  bottom: 10px;
  width: 1px;
  background: linear-gradient(180deg, var(--primary), color-mix(in srgb, var(--outline) 58%, transparent));
  opacity: 0.42;
}
.step-card {
  position: relative;
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--outline) 54%, transparent);
  border-radius: 16px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.024), transparent 48%),
    color-mix(in srgb, var(--surface-2) 50%, transparent);
}
.step-card::before {
  content: '';
  position: absolute;
  left: -18px;
  top: 22px;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--primary);
  box-shadow:
    0 0 0 4px color-mix(in srgb, var(--primary-soft) 52%, var(--surface-1)),
    0 0 18px color-mix(in srgb, var(--primary-glow) 55%, transparent);
}
.step-card__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.step-card__index {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  color: color-mix(in srgb, var(--primary-strong) 82%, var(--on-surface));
  background: color-mix(in srgb, var(--primary-soft) 32%, var(--surface-2));
  font-size: 12px;
  font-weight: 700;
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
@media (max-width: 1120px) {
  .form-grid,
  .form-grid--step {
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
