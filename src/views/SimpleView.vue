<script setup lang="ts">
/**
 * SimpleView — a screen-reader-first separation page.
 *
 * The main SeparateView is a rich, visual, drag-and-drop workspace. This view
 * strips it down to a single linear flow that works end-to-end with keyboard
 * and screen reader alone:
 *
 *   1. Choose a model (or workflow)
 *   2. Add audio files
 *   3. Start separation
 *   4. Preview results with native <audio controls>
 *   5. Export / open output folder
 *
 * It reuses the same stores (task, model, workflow, settings) so no business
 * logic is duplicated. Every action is announced via useLiveAnnouncer.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  ArrowBackOutline,
  AddCircleOutline,
  CloseCircleOutline,
  PlayCircleOutline,
  DownloadOutline,
  FolderOpenOutline,
  CubeOutline,
  GitNetworkOutline,
  SettingsOutline,
} from '@vicons/ionicons5'
import { useTaskStore, type SeparationTask } from '@/stores/task'
import { useModelStore } from '@/stores/model'
import { useWorkflowStore } from '@/stores/workflow'
import { useSettingsStore } from '@/stores/settings'
import { useLiveAnnouncer } from '@/composables/useLiveAnnouncer'
import SrText from '@/components/SrText.vue'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const task = useTaskStore()
const model = useModelStore()
const workflow = useWorkflowStore()
const settings = useSettingsStore()
const announcer = useLiveAnnouncer()

const { inputFiles, separateRunMode: runMode } = storeToRefs(task)
const { selectedModel, downloadedModels, models: modelEntries } = storeToRefs(model)
const { workflows, selectedWorkflow, selectedWorkflowId } = storeToRefs(workflow)

type Mode = 'model' | 'workflow'
const mode = ref<Mode>('model')

// ---- Model options ----
const modelOptions = computed(() => {
  return downloadedModels.value.map((m) => ({
    label: m.name,
    value: m.name,
  }))
})

// ---- Workflow options ----
const workflowOptions = computed(() => {
  return workflows.value.map((w) => ({
    label: w.name,
    value: w.id,
  }))
})

// ---- File list ----
const fileList = computed(() => inputFiles.value)

function fileName(path: string) {
  return path.split(/[/\\]/).pop() || path
}

async function addFiles() {
  const before = inputFiles.value.length
  await task.pickFiles()
  const added = inputFiles.value.length - before
  if (added > 0) {
    message.success(t('simple.filesAdded', { count: added }))
    announcer.announcePolite(t('simple.filesAdded', { count: added }))
  }
}

function removeFile(index: number) {
  const file = inputFiles.value[index]
  if (!file) return
  task.removeInputFile(file)
  announcer.announcePolite(t('simple.fileRemoved', { name: fileName(file) }))
}

// ---- Mode switching ----
function switchMode(newMode: Mode) {
  mode.value = newMode
  runMode.value = newMode
  announcer.announcePolite(newMode === 'workflow' ? t('simple.modeWorkflow') : t('simple.modeModel'))
}

// ---- Start separation ----
const isStarting = ref(false)

async function startSeparation() {
  if (mode.value === 'model' && !selectedModel.value) {
    message.warning(t('simple.noModelSelected'))
    announcer.announceAssertive(t('simple.noModelSelected'))
    return
  }
  if (mode.value === 'workflow' && !selectedWorkflow.value) {
    message.warning(t('simple.noWorkflowSelected'))
    announcer.announceAssertive(t('simple.noWorkflowSelected'))
    return
  }
  if (!inputFiles.value.length) {
    message.warning(t('simple.noFiles'))
    announcer.announceAssertive(t('simple.noFiles'))
    return
  }
  isStarting.value = true
  announcer.announcePolite(t('simple.starting'))
  try {
    const result = mode.value === 'workflow' && selectedWorkflow.value
      ? await task.startWorkflowInference(selectedWorkflow.value, { outputLayout: 'flat' })
      : await task.startSeparation({ outputLayout: 'flat' })
    if (result && result.failed > 0) {
      message.warning(t('simple.partialSuccess', { succeeded: result.succeeded, failed: result.failed }))
      announcer.announcePolite(t('simple.partialSuccess', { succeeded: result.succeeded, failed: result.failed }))
    } else {
      message.success(t('simple.started', { count: result?.succeeded ?? 1 }))
      announcer.announcePolite(t('simple.started', { count: result?.succeeded ?? 1 }))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    message.error(msg)
    announcer.announceAssertive(msg)
  } finally {
    isStarting.value = false
  }
}

// ---- Active tasks (progress) ----
const activeTasks = computed(() => task.runningTasks)
const recentDoneTasks = computed(() =>
  task.completedTasks.slice(0, 10),
)

function taskProgressText(taskItem: SeparationTask): string {
  if (taskItem.status === 'done') return t('simple.taskDone')
  if (taskItem.status === 'failed') return t('simple.taskFailed')
  if (taskItem.status === 'cancelled') return t('simple.taskCancelled')
  return t('simple.taskProgress', { percent: taskItem.progress, stage: taskItem.stageLabel })
}

// Announce progress milestones
let lastAnnouncedProgress: Record<string, number> = {}
watch(activeTasks, (tasks) => {
  tasks.forEach((taskItem) => {
    const last = lastAnnouncedProgress[taskItem.id] || 0
    const current = taskItem.progress
    // Announce at every 25% milestone
    const milestone = Math.floor(current / 25) * 25
    if (milestone > last && milestone > 0) {
      announcer.announcePolite(taskProgressText(taskItem), { progress: true })
      lastAnnouncedProgress[taskItem.id] = milestone
    }
  })
}, { deep: true })

// Announce task completion/failure
watch(() => task.runningTasks.length, (newCount, oldCount) => {
  if (newCount < oldCount) {
    // A task finished — check recent completions
    const finished = task.completedTasks[0]
    if (finished) {
      if (finished.status === 'done') {
        announcer.announcePolite(t('simple.taskDoneAnnounce', { name: fileName(finished.input) }))
      } else if (finished.status === 'failed') {
        announcer.announceAssertive(t('simple.taskFailedAnnounce', { name: fileName(finished.input) }))
      }
    }
  }
})

// ---- Results preview ----
function outputUrl(path: string): string {
  try {
    return convertFileSrc(path)
  } catch {
    return ''
  }
}

async function openOutputDir(taskItem: SeparationTask) {
  try {
    await task.revealPath(taskItem.output)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// ---- Navigation ----
function goBack() {
  router.push('/')
}

function goSettings() {
  router.push('/settings')
}

onMounted(() => {
  // Ensure models are loaded
  if (!modelEntries.value.length) {
    void model.loadModels().catch(() => {})
  }
  // Set initial mode
  runMode.value = mode.value
})
</script>

<template>
  <div class="simple-view page">
    <!-- Top bar -->
    <header class="simple-topbar">
      <n-button quaternary size="small" @click="goBack">
        <template #icon><n-icon :component="ArrowBackOutline" /></template>
        {{ t('simple.backToMain') }}
      </n-button>
      <h1 class="simple-title">{{ t('simple.pageTitle') }}</h1>
      <n-button quaternary size="small" @click="goSettings">
        <template #icon><n-icon :component="SettingsOutline" /></template>
        {{ t('nav.settings') }}
      </n-button>
    </header>

    <p class="simple-intro">{{ t('simple.intro') }}</p>

    <!-- Mode selector -->
    <section class="simple-section" aria-labelledby="simple-mode-heading">
      <h2 id="simple-mode-heading" class="simple-section__title">{{ t('simple.modeTitle') }}</h2>
      <div class="simple-mode-buttons" role="radiogroup" :aria-label="t('simple.modeTitle')">
        <button
          type="button"
          class="simple-mode-btn"
          role="radio"
          :aria-checked="mode === 'model'"
          @click="switchMode('model')"
        >
          <n-icon :component="CubeOutline" :size="20" aria-hidden="true" />
          <span>{{ t('simple.modeModel') }}</span>
        </button>
        <button
          type="button"
          class="simple-mode-btn"
          role="radio"
          :aria-checked="mode === 'workflow'"
          @click="switchMode('workflow')"
        >
          <n-icon :component="GitNetworkOutline" :size="20" aria-hidden="true" />
          <span>{{ t('simple.modeWorkflow') }}</span>
        </button>
      </div>
    </section>

    <!-- Model / Workflow selection -->
    <section v-if="mode === 'model'" class="simple-section" aria-labelledby="simple-model-heading">
      <h2 id="simple-model-heading" class="simple-section__title">{{ t('simple.modelTitle') }}</h2>
      <label class="simple-label" for="simple-model-select">{{ t('simple.modelLabel') }}</label>
      <select
        id="simple-model-select"
        class="simple-select"
        :value="selectedModel"
        @change="model.selectModel(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="opt in modelOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <p v-if="!modelOptions.length" class="simple-hint">{{ t('simple.noModelsHint') }}</p>
    </section>

    <section v-else class="simple-section" aria-labelledby="simple-workflow-heading">
      <h2 id="simple-workflow-heading" class="simple-section__title">{{ t('simple.workflowTitle') }}</h2>
      <label class="simple-label" for="simple-workflow-select">{{ t('simple.workflowLabel') }}</label>
      <select
        id="simple-workflow-select"
        class="simple-select"
        :value="selectedWorkflowId"
        @change="workflow.selectWorkflow(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="opt in workflowOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <p v-if="!workflowOptions.length" class="simple-hint">{{ t('simple.noWorkflowsHint') }}</p>
    </section>

    <!-- File list -->
    <section class="simple-section" aria-labelledby="simple-files-heading">
      <h2 id="simple-files-heading" class="simple-section__title">{{ t('simple.filesTitle') }}</h2>
      <button type="button" class="simple-action-btn" @click="addFiles">
        <n-icon :component="AddCircleOutline" :size="20" aria-hidden="true" />
        <span>{{ t('simple.addFiles') }}</span>
      </button>

      <ul v-if="fileList.length" class="simple-file-list" :aria-label="t('simple.filesTitle')">
        <li v-for="(file, index) in fileList" :key="index" class="simple-file-item">
          <span class="simple-file-name">{{ fileName(file) }}</span>
          <button
            type="button"
            class="simple-remove-btn"
            :aria-label="t('simple.removeFile', { name: fileName(file) })"
            @click="removeFile(index)"
          >
            <n-icon :component="CloseCircleOutline" :size="18" aria-hidden="true" />
            <SrText>{{ t('simple.removeFile', { name: fileName(file) }) }}</SrText>
          </button>
        </li>
      </ul>
      <p v-else class="simple-hint">{{ t('simple.noFilesHint') }}</p>
    </section>

    <!-- Start button -->
    <section class="simple-section" aria-labelledby="simple-start-heading">
      <h2 id="simple-start-heading" class="simple-section__title">{{ t('simple.startTitle') }}</h2>
      <button
        type="button"
        class="simple-start-btn"
        :disabled="isStarting || !fileList.length"
        @click="startSeparation"
      >
        <n-icon :component="PlayCircleOutline" :size="22" aria-hidden="true" />
        <span>{{ isStarting ? t('simple.starting') : t('simple.startSeparation') }}</span>
      </button>
    </section>

    <!-- Active tasks / progress -->
    <section v-if="activeTasks.length" class="simple-section" aria-labelledby="simple-progress-heading">
      <h2 id="simple-progress-heading" class="simple-section__title">{{ t('simple.progressTitle') }}</h2>
      <ul class="simple-task-list">
        <li v-for="taskItem in activeTasks" :key="taskItem.id" class="simple-task-item">
          <div class="simple-task-info">
            <strong>{{ fileName(taskItem.input) }}</strong>
            <span class="simple-task-stage">{{ taskItem.stageLabel }}</span>
          </div>
          <div class="simple-task-progress">
            <progress :value="taskItem.progress" max="100" :aria-label="taskProgressText(taskItem)">{{ taskItem.progress }}%</progress>
            <span class="simple-task-percent">{{ taskItem.progress }}%</span>
          </div>
        </li>
      </ul>
    </section>

    <!-- Results -->
    <section v-if="recentDoneTasks.length" class="simple-section" aria-labelledby="simple-results-heading">
      <h2 id="simple-results-heading" class="simple-section__title">{{ t('simple.resultsTitle') }}</h2>
      <ul class="simple-result-list">
        <li v-for="taskItem in recentDoneTasks" :key="taskItem.id" class="simple-result-item">
          <div class="simple-result-head">
            <strong>{{ fileName(taskItem.input) }}</strong>
            <button
              type="button"
              class="simple-open-btn"
              :aria-label="t('simple.openOutput', { name: fileName(taskItem.input) })"
              @click="openOutputDir(taskItem)"
            >
              <n-icon :component="FolderOpenOutline" :size="18" aria-hidden="true" />
              <span>{{ t('simple.openOutputDir') }}</span>
            </button>
          </div>
          <ul v-if="taskItem.outputs.length" class="simple-stem-list">
            <li v-for="output in taskItem.outputs" :key="output.path" class="simple-stem-item">
              <span class="simple-stem-name">{{ output.stem }}</span>
              <audio controls :src="outputUrl(output.path)" :aria-label="t('simple.previewStem', { stem: output.stem })">
                <SrText>{{ t('simple.audioNotSupported') }}</SrText>
              </audio>
            </li>
          </ul>
          <p v-else class="simple-hint">{{ t('simple.noOutputs') }}</p>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.simple-view {
  max-width: 720px;
  margin: 0 auto;
  display: grid;
  gap: 24px;
}

.simple-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.simple-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  text-align: center;
  flex: 1;
}

.simple-intro {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 14px;
  line-height: 1.7;
}

.simple-section {
  display: grid;
  gap: 10px;
}

.simple-section__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}

.simple-label {
  font-size: 13px;
  color: var(--on-surface-muted);
}

.simple-select {
  width: 100%;
  padding: 10px 14px;
  border-radius: 11px;
  border: 1px solid var(--outline);
  background: var(--surface-1);
  color: var(--on-surface);
  font-size: 14px;
  cursor: pointer;
}

.simple-select:focus-visible {
  outline: 2px solid var(--primary-strong);
  outline-offset: 2px;
}

.simple-hint {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 13px;
}

.simple-mode-buttons {
  display: flex;
  gap: 10px;
}

.simple-mode-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 12px;
  border: 1px solid var(--outline);
  background: var(--surface-1);
  color: var(--on-surface-muted);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: 160ms ease;
}

.simple-mode-btn:hover {
  border-color: var(--primary-border);
  color: var(--on-surface);
}

.simple-mode-btn[aria-checked="true"] {
  border-color: var(--primary-border);
  background: var(--primary-soft);
  color: var(--primary-strong);
}

.simple-action-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-radius: 11px;
  border: 1px solid var(--primary-border);
  background: var(--primary-soft);
  color: var(--primary-strong);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: 160ms ease;
}

.simple-action-btn:hover {
  background: color-mix(in srgb, var(--primary-soft) 60%, var(--surface-1));
}

.simple-file-list,
.simple-task-list,
.simple-result-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.simple-file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--surface-2);
}

.simple-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.simple-remove-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: transparent;
  color: var(--on-surface-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 8px;
  transition: color 140ms ease, background 140ms ease;
}

.simple-remove-btn:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.simple-start-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 14px 24px;
  border-radius: 14px;
  border: 0;
  background: var(--primary);
  color: #fff;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  transition: 160ms ease;
}

.simple-start-btn:not(:disabled):hover {
  background: color-mix(in srgb, var(--primary) 88%, white);
  transform: translateY(-1px);
}

.simple-start-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.simple-task-item {
  display: grid;
  gap: 6px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--surface-2);
}

.simple-task-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.simple-task-info strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.simple-task-stage {
  color: var(--on-surface-muted);
  font-size: 12px;
  flex-shrink: 0;
}

.simple-task-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.simple-task-progress progress {
  flex: 1;
  height: 8px;
}

.simple-task-percent {
  font-size: 12px;
  color: var(--on-surface-muted);
  min-width: 36px;
  text-align: right;
}

.simple-result-item {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--surface-2);
}

.simple-result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.simple-result-head strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.simple-open-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--outline);
  background: var(--surface-1);
  color: var(--on-surface-muted);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 9px;
  cursor: pointer;
  transition: 140ms ease;
}

.simple-open-btn:hover {
  color: var(--on-surface);
  border-color: var(--primary-border);
}

.simple-stem-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.simple-stem-item {
  display: grid;
  grid-template-columns: minmax(80px, 120px) 1fr;
  align-items: center;
  gap: 10px;
}

.simple-stem-name {
  font-size: 12px;
  color: var(--on-surface-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.simple-stem-item audio {
  width: 100%;
  height: 36px;
}
</style>
