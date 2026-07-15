<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CopyOutline,
  DownloadOutline,
  PlayOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import type { ModelEntry } from '@/stores/model'
import type { WorkflowEntry } from '@/stores/workflow'
import {
  createStepDraft,
  getWorkflowValidationSummary,
  hydrateWorkflowDefinition,
  parseModelStems,
  workflowValidationErrorMessage,
  type WorkflowNodeEditorUi,
  type WorkflowStepDraft,
} from '@/utils/workflowDefinition'
import {
  buildSimpleWorkflowDefinition,
  hydrateSimpleWorkflow,
  type SimpleWorkflowSavePayload,
} from '@/utils/workflowSimple'

const props = defineProps<{
  workflow?: WorkflowEntry | null
  models: ModelEntry[]
  saving?: boolean
}>()

const emit = defineEmits<{
  save: [payload: SimpleWorkflowSavePayload]
  'open-advanced': [payload: SimpleWorkflowSavePayload, persistDraft: boolean]
  run: [payload: SimpleWorkflowSavePayload]
  duplicate: [payload: SimpleWorkflowSavePayload]
  export: [payload: SimpleWorkflowSavePayload]
  delete: []
  cancel: []
}>()

const { t, locale } = useI18n()
const name = ref('')
const description = ref('')
const defaultDevice = ref('auto')
const defaultFormat = ref('wav')
const defaultNormalize = ref(false)
const steps = ref<WorkflowStepDraft[]>([])
const preservedUi = ref<WorkflowNodeEditorUi>({
  viewport: { x: 0, y: 0, k: 1 },
  nodes: {},
  notes: [],
  collapsedStepIds: [],
})
const expectedUpdatedAt = ref<number | undefined>()
const sourceDefinition = ref<Record<string, unknown> | undefined>()

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

const modelOptions = computed(() => [...props.models]
  .sort((left, right) => left.name.localeCompare(right.name, locale.value === 'zh-CN' ? 'zh-CN' : 'en'))
  .map(item => ({ label: item.name, value: item.name })))
const downloadedModelNames = computed(() => new Set(props.models.map(item => item.name)))

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function loadWorkflow(item?: WorkflowEntry | null) {
  const draft = item ? hydrateSimpleWorkflow(item.definition) : hydrateWorkflowDefinition({})
  name.value = item?.name || ''
  description.value = item?.description || ''
  defaultDevice.value = draft.defaultDevice
  defaultFormat.value = draft.defaultFormat
  defaultNormalize.value = draft.defaultNormalize
  steps.value = clone(draft.steps.length ? draft.steps : [createStepDraft(0)])
  preservedUi.value = clone(draft.ui)
  expectedUpdatedAt.value = item?.updatedAt
  sourceDefinition.value = item ? clone(item.definition) : undefined
}

watch(() => props.workflow, item => loadWorkflow(item), { immediate: true })

function configuredStems(modelName: string) {
  const item = props.models.find(modelItem => modelItem.name === modelName)
  return parseModelStems(item?.configInstruments || item?.configTargetInstrument || item?.targetStem)
}

function inputOptions(index: number) {
  return [
    { label: t('workflows.originalInput'), value: 'input' },
    ...steps.value.slice(0, index).flatMap((step, sourceIndex) => step.stems.map(stem => ({
      label: `${t('workflows.stepTitle', { index: sourceIndex + 1 })} · ${stem}`,
      value: `${step.id}.${stem}`,
    }))),
  ]
}

function clearInvalidInputs() {
  steps.value.forEach((step, index) => {
    const allowed = new Set(inputOptions(index).map(option => option.value))
    if (!allowed.has(step.input)) step.input = index === 0 ? 'input' : ''
  })
}

function updateStepModel(step: WorkflowStepDraft, modelName: string) {
  step.model = modelName
  step.stems = configuredStems(modelName)
  step.save = Object.fromEntries(step.stems.map(stem => [stem, stem]))
  clearInvalidInputs()
}

function addStep() {
  steps.value.push(createStepDraft(steps.value.length))
}

function removeStep(index: number) {
  if (steps.value.length <= 1) return
  steps.value.splice(index, 1)
  clearInvalidInputs()
}

const generatedDefinition = computed(() => buildSimpleWorkflowDefinition({
  defaultDevice: defaultDevice.value,
  defaultFormat: defaultFormat.value,
  defaultNormalize: defaultNormalize.value,
  steps: steps.value,
  utilityNodes: [],
  saveTargets: [],
  ui: preservedUi.value,
}, sourceDefinition.value))
const validationSummary = computed(() => getWorkflowValidationSummary(generatedDefinition.value))

const formError = computed(() => {
  if (!name.value.trim()) return t('workflows.nameRequired')
  if (!steps.value.length) return t('workflows.stepsRequired')
  for (const [index, step] of steps.value.entries()) {
    const label = t('workflows.stepTitle', { index: index + 1 })
    if (!step.model.trim()) return t('workflows.stepModelRequired', { id: label })
    if (!downloadedModelNames.value.has(step.model.trim())) return t('workflows.stepModelNotDownloaded', { id: label })
    if (!step.input.trim() || !inputOptions(index).some(option => option.value === step.input)) {
      return t('workflows.stepInputRequired', { id: label })
    }
    if (!step.stems.length) return t('workflows.stepStemsRequired', { id: label })
  }
  return workflowValidationErrorMessage(validationSummary.value, t)
})

const canSubmit = computed(() => !formError.value && !props.saving)

function payload(): SimpleWorkflowSavePayload {
  return {
    id: props.workflow?.id,
    name: name.value.trim(),
    description: description.value.trim(),
    definition: generatedDefinition.value,
    expectedUpdatedAt: expectedUpdatedAt.value,
  }
}

</script>

<template>
  <section class="simple-creator">
    <header class="simple-creator__head">
      <div>
        <span>{{ workflow ? t('workflows.editing') : t('workflows.creating') }}</span>
        <h2>{{ t('workflows.simpleCreator') }}</h2>
      </div>
      <div class="simple-creator__actions">
        <n-button secondary @click="emit('cancel')">{{ t('common.cancel') }}</n-button>
        <n-button secondary :disabled="saving" @click="emit('open-advanced', payload(), !formError)">
          {{ t('workflows.openAdvancedEditor') }}
        </n-button>
        <n-button type="primary" :loading="saving" :disabled="!canSubmit" @click="emit('save', payload())">
          {{ t('common.save') }}
        </n-button>
      </div>
    </header>

    <div class="simple-creator__defaults">
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
      <label class="simple-creator__normalize">
        <span>{{ t('workflows.normalize') }}</span>
        <n-switch v-model:value="defaultNormalize" />
      </label>
      <label class="simple-creator__description">
        <span>{{ t('workflows.description') }}</span>
        <n-input
          v-model:value="description"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 2 }"
          :placeholder="t('workflows.descriptionPlaceholder')"
        />
      </label>
    </div>

    <div class="simple-creator__steps-head">
      <div>
        <strong>{{ t('workflows.steps') }}</strong>
        <span>{{ t('workflows.stepsHint') }}</span>
      </div>
      <n-button secondary @click="addStep">{{ t('workflows.addStep') }}</n-button>
    </div>

    <div class="simple-step-list">
      <article v-for="(step, index) in steps" :key="step.id" class="simple-step">
        <header>
          <strong>{{ t('workflows.stepTitle', { index: index + 1 }) }}</strong>
          <n-button text type="error" :disabled="steps.length <= 1" @click="removeStep(index)">
            {{ t('workflows.removeStep') }}
          </n-button>
        </header>
        <div class="simple-step__grid">
          <label>
            <span>{{ t('workflows.stepModel') }}</span>
            <n-select
              :value="step.model"
              :options="modelOptions"
              filterable
              :placeholder="t('workflows.stepModelPlaceholder')"
              @update:value="updateStepModel(step, $event)"
            />
          </label>
          <label>
            <span>{{ t('workflows.stepInput') }}</span>
            <n-select
              v-model:value="step.input"
              :options="inputOptions(index)"
              :placeholder="t('workflows.stepInputPlaceholder')"
            />
          </label>
          <label>
            <span>{{ t('workflows.stepOverlap') }}</span>
            <n-input-number v-model:value="step.overlapSize" :min="0" :step="1" clearable />
          </label>
          <label class="simple-step__stems">
            <span>{{ t('workflows.stepStems') }}</span>
            <n-select
              v-model:value="step.stems"
              multiple
              filterable
              :options="configuredStems(step.model).map(stem => ({ label: stem, value: stem }))"
              :placeholder="t('workflows.stepStemsPlaceholder')"
              @update:value="clearInvalidInputs"
            />
          </label>
        </div>
      </article>
    </div>

    <p v-if="formError" class="simple-creator__error">{{ formError }}</p>
    <p v-else class="simple-creator__valid">{{ t('workflows.formValid') }}</p>

    <footer v-if="workflow" class="simple-creator__footer">
      <n-button type="primary" :disabled="!canSubmit" @click="emit('run', payload())">
        <template #icon><n-icon :component="PlayOutline" /></template>
        {{ t('workflows.runWorkflowAction') }}
      </n-button>
      <n-button secondary :disabled="!canSubmit" @click="emit('duplicate', payload())">
        <template #icon><n-icon :component="CopyOutline" /></template>
        {{ t('workflows.duplicate') }}
      </n-button>
      <n-button secondary :disabled="!canSubmit" @click="emit('export', payload())">
        <template #icon><n-icon :component="DownloadOutline" /></template>
        {{ t('workflows.exportComfyMss') }}
      </n-button>
      <n-button secondary type="error" :disabled="saving" @click="emit('delete')">
        <template #icon><n-icon :component="TrashOutline" /></template>
        {{ t('workflows.deleteConfirm') }}
      </n-button>
    </footer>
  </section>
</template>

<style scoped>
.simple-creator {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 16px;
  overflow: hidden;
  border: 1px solid var(--outline);
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-1) 92%, transparent);
}

.simple-creator__head,
.simple-creator__steps-head,
.simple-step > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.simple-creator__head,
.simple-creator__defaults,
.simple-creator__steps-head,
.simple-creator__error,
.simple-creator__valid,
.simple-creator__footer {
  flex: 0 0 auto;
}

.simple-creator__head span,
.simple-creator__steps-head span,
.simple-creator label > span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.simple-creator__head > div > span {
  color: var(--primary-strong);
}

.simple-creator__head h2 { margin: 2px 0 0; font-size: 18px; font-weight: 600; }

.simple-creator__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.simple-creator__defaults {
  display: grid;
  grid-template-columns: minmax(220px, 1.4fr) minmax(150px, 0.8fr) minmax(150px, 0.8fr) auto;
  gap: 10px 12px;
}

.simple-creator label { min-width: 0; display: grid; gap: 5px; }
.simple-creator__normalize { align-content: end; padding-bottom: 6px; }
.simple-creator__description { grid-column: 1 / -1; }
.simple-creator__steps-head > div { display: grid; gap: 4px; }

.simple-step-list {
  flex: 1 1 280px;
  min-height: 0;
  display: grid;
  align-content: start;
  grid-auto-rows: max-content;
  gap: 12px;
  overflow-y: auto;
}

.simple-step {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--outline);
  border-radius: 15px;
  background: color-mix(in srgb, var(--surface-2) 46%, transparent);
}

.simple-step__grid {
  display: grid;
  grid-template-columns: minmax(220px, 1.2fr) minmax(190px, 1fr) minmax(120px, 0.55fr);
  gap: 10px 12px;
}

.simple-step__stems { grid-column: 1 / -1; }
.simple-creator__error,
.simple-creator__valid { margin: 0; font-size: 12px; }
.simple-creator__error { color: var(--danger); }
.simple-creator__valid { color: var(--success); }

.simple-creator__footer {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--outline);
}

@media (max-width: 900px) {
  .simple-creator__head { flex-direction: column; }
  .simple-creator__actions { justify-content: flex-start; }
  .simple-creator__defaults,
  .simple-step__grid { grid-template-columns: minmax(0, 1fr); }
  .simple-creator__description,
  .simple-step__stems { grid-column: auto; }
}
</style>
