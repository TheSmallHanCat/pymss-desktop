<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useDialog, useMessage } from 'naive-ui'
import {
  CheckmarkCircleOutline,
  AlertCircleOutline,
  CloseCircleOutline,
  HourglassOutline,
  RefreshOutline,
  TrashOutline,
  TerminalOutline,
  FolderOpenOutline,
  LayersOutline,
  ArchiveOutline,
} from '@vicons/ionicons5'
import { useTaskStore, type SeparationTask } from '@/stores/task'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const task = useTaskStore()

const terminalStatuses = ['done', 'failed', 'cancelled']
const showLogModal = ref(false)
const selectedLogTask = ref<SeparationTask | null>(null)
const historyExpanded = ref(true)

const runningTasks = computed(() => task.runningTasks)
const historyTasks = computed(() => task.tasks.filter((item) => terminalStatuses.includes(item.status)))

function formatTime(value: number) {
  const date = new Date(value)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`
}

function openLogs(item: SeparationTask) {
  selectedLogTask.value = item
  showLogModal.value = true
}

function logClass(line: string) {
  const value = line.toLowerCase()
  if (value.includes('error') || value.includes('failed') || value.includes('traceback')) return 'log-line--error'
  if (value.includes('warn')) return 'log-line--warn'
  if (value.includes('debug')) return 'log-line--debug'
  if (value.includes('done') || value.includes('success') || value.includes('completed')) return 'log-line--success'
  return 'log-line--info'
}

async function handleCancel(id: string) {
  const ok = await task.cancelTask(id)
  if (ok) message.success(t('tasks.cancelSuccess'))
}

async function handleRetry(id: string) {
  try {
    await task.retryTask(id)
    message.success(t('toast.taskRetried'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function handleClearHistory() {
  dialog.warning({
    title: t('tasks.clearHistoryTitle'),
    content: t('tasks.clearHistoryConfirm'),
    positiveText: t('tasks.clearHistoryPositive'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      task.clearHistory()
      message.success(t('tasks.clearHistorySuccess'))
    },
  })
}

function handleRemoveTask(item: SeparationTask) {
  dialog.warning({
    title: t('tasks.removeConfirmTitle'),
    content: t('tasks.removeConfirmContent'),
    positiveText: t('tasks.remove'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => task.removeTask(item.id),
  })
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: t('tasks.statusQueued'),
    preparing: t('tasks.statusPreparing'),
    validating_input: t('tasks.statusValidatingInput'),
    downloading_model: t('tasks.statusCheckingModel'),
    ensuring_model: t('tasks.statusCheckingModel'),
    loading_model: t('tasks.statusLoadingModel'),
    separating: t('tasks.statusSeparating'),
    writing_output: t('tasks.statusWritingOutput'),
    done: t('tasks.statusDone'),
    failed: t('tasks.statusFailed'),
    cancelled: t('tasks.statusCancelled'),
  }
  return labels[status] || status
}

function normalizeProgressMessage(message?: string) {
  const value = (message || '').trim().toLowerCase()
  if (!value) return ''
  const mapped: Record<string, string> = {
    'task started': t('tasks.progressPreparingTask'),
    'validating input': t('tasks.progressValidatingInput'),
    'checking model files': t('tasks.progressCheckingModel'),
    'loading model': t('tasks.progressLoadingModel'),
    'separating audio': t('tasks.progressSeparatingHint'),
    'processing audio chunks': t('tasks.progressProcessingChunks'),
    'processing vr batches': t('tasks.progressProcessingVrBatches'),
    'collecting outputs': t('tasks.progressCollectingOutputs'),
  }
  return mapped[value] || message || ''
}

function progressStatus(status: string) {
  switch (status) {
    case 'done': return 'success' as const
    case 'failed': return 'error' as const
    case 'cancelled': return 'warning' as const
    default: return 'info' as const
  }
}

function isRunning(status: string) {
  return !terminalStatuses.includes(status)
}

function taskDuration(item: SeparationTask) {
  const seconds = Math.max(0, Math.round((item.updatedAt - item.createdAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest}s`
}

function progressDetail(item: SeparationTask) {
  if (
    item.status === 'separating'
    && typeof item.progressCurrent === 'number'
    && typeof item.progressTotal === 'number'
    && item.progressTotal > 0
  ) {
    return `${Math.round(item.progressCurrent)} / ${Math.round(item.progressTotal)}`
  }
  return ''
}

function progressTitle(item: SeparationTask) {
  if (item.status === 'separating') return t('tasks.progressTitleSeparating')
  return statusLabel(item.status)
}

function taskSubMessage(item: SeparationTask) {
  if (item.error) return item.error
  return normalizeProgressMessage(item.progressDetail || item.message)
}

function statusIcon(status: string) {
  switch (status) {
    case 'done': return CheckmarkCircleOutline
    case 'failed': return AlertCircleOutline
    case 'cancelled': return CloseCircleOutline
    default: return HourglassOutline
  }
}

function statusType(status: string) {
  switch (status) {
    case 'done': return 'success' as const
    case 'failed': return 'error' as const
    case 'cancelled': return 'default' as const
    default: return 'info' as const
  }
}

function jumpToResult(item: SeparationTask) {
  task.focusResultTask(item.id)
  router.push('/results')
}

function taskCardId(item: Pick<SeparationTask, 'id'>) {
  return `task-card-${item.id}`
}

function scrollToFocusedTask(id: string | null) {
  if (!id) return
  nextTick(() => {
    const target = document.getElementById(taskCardId({ id }))
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

watch(() => task.focusedTaskId, (value) => {
  if (value) {
    scrollToFocusedTask(value)
    task.focusTask(null)
  }
})

onMounted(() => {
  if (task.focusedTaskId) {
    scrollToFocusedTask(task.focusedTaskId)
    task.focusTask(null)
  }
})
</script>

<template>
  <div class="page tasks-workbench">
    <div class="page-header-compact tasks-workbench__header">
      <div>
        <h1>{{ t('tasks.title') }}</h1>
        <p>{{ t('tasks.subtitle') }}</p>
      </div>
      <n-button v-if="historyTasks.length" secondary @click="handleClearHistory()">
        <template #icon><n-icon :component="TrashOutline" /></template>
        {{ t('tasks.clearHistory') }}
      </n-button>
    </div>

    <n-card v-if="!task.tasks.length" :bordered="true">
      <div class="tasks-empty">
        <n-icon :component="HourglassOutline" size="48" color="var(--on-surface-muted)" />
        <p class="text-muted mt-md">{{ t('tasks.emptyHint') }}</p>
      </div>
    </n-card>

    <template v-else>
      <section class="tasks-section">
        <div class="tasks-section__title">
          <div class="tasks-section__heading">
            <h2>{{ t('tasks.runningTitle') }}</h2>
            <span class="tasks-section__count">{{ runningTasks.length }}</span>
          </div>
        </div>

        <div v-if="runningTasks.length" class="tasks-list">
          <n-card
            v-for="item in runningTasks"
            :id="taskCardId(item)"
            :key="item.id"
            :bordered="true"
            size="small"
            class="task-workbench-card"
          >
            <template #header>
              <div class="task-workbench-card__top">
                <div>
                  <strong class="task-workbench-card__title">{{ item.input.split(/[/\\]/).pop() || item.input }}</strong>
                  <p class="task-workbench-card__subtitle">{{ item.model }}</p>
                </div>
                <n-tag :type="statusType(item.status)" :bordered="false" size="small">
                  <template #icon><n-icon :component="statusIcon(item.status)" /></template>
                  {{ statusLabel(item.status) }}
                </n-tag>
              </div>
            </template>

            <div class="task-workbench-card__progress">
              <div class="task-progress-head">
                <div class="task-progress-head__main">
                  <span>{{ progressTitle(item) }}</span>
                  <span v-if="progressDetail(item)" class="task-progress-head__detail">{{ progressDetail(item) }}</span>
                </div>
                <span>{{ Math.round(item.progress || 0) }}%</span>
              </div>
              <n-progress
                type="line"
                :percentage="Math.round(item.progress || 0)"
                :status="progressStatus(item.status)"
                :processing="isRunning(item.status)"
                :height="8"
                :show-indicator="false"
              />
              <p v-if="taskSubMessage(item)" class="text-muted text-sm task-message">{{ taskSubMessage(item) }}</p>
            </div>

            <div class="task-workbench-card__meta">
              <span>{{ t('tasks.createdAt') }}：{{ formatTime(item.createdAt) }}</span>
              <span>{{ t('tasks.updatedAt') }}：{{ formatTime(item.updatedAt) }}</span>
              <span>{{ t('tasks.duration') }}：{{ taskDuration(item) }}</span>
            </div>

            <div class="task-workbench-card__actions">
              <n-button
                v-if="isRunning(item.status)"
                size="tiny"
                secondary
                @click="handleCancel(item.id)"
              >
                {{ t('common.cancel') }}
              </n-button>
              <n-button
                v-if="['failed','cancelled'].includes(item.status)"
                size="tiny"
                secondary
                @click="handleRetry(item.id)"
              >
                <template #icon><n-icon :component="RefreshOutline" /></template>
                {{ t('tasks.retry') }}
              </n-button>
              <n-button size="tiny" secondary :disabled="!item.logs.length" @click="openLogs(item)">
                <template #icon><n-icon :component="TerminalOutline" /></template>
                {{ t('tasks.logs') }}
              </n-button>
              <n-button
                v-if="item.status === 'done'"
                size="tiny"
                secondary
                @click="jumpToResult(item)"
              >
                <template #icon><n-icon :component="FolderOpenOutline" /></template>
                {{ t('tasks.viewResult') }}
              </n-button>
              <n-button v-if="!isRunning(item.status)" size="tiny" quaternary @click="handleRemoveTask(item)">
                {{ t('tasks.remove') }}
              </n-button>
            </div>
          </n-card>
        </div>
        <n-card v-else :bordered="true" size="small">
          <div class="tasks-empty-inline">
            <n-icon :component="LayersOutline" size="28" color="var(--on-surface-muted)" />
            <span class="text-muted">{{ t('tasks.noRunningTasks') }}</span>
          </div>
        </n-card>
      </section>

      <section class="tasks-section">
        <div class="tasks-section__title">
          <div class="tasks-section__heading">
            <h2>{{ t('tasks.historyTitle') }}</h2>
            <span class="tasks-section__count">{{ historyTasks.length }}</span>
          </div>
          <n-button text type="primary" @click="historyExpanded = !historyExpanded">
            {{ historyExpanded ? t('tasks.collapse') : t('tasks.expand') }}
          </n-button>
        </div>

        <n-collapse-transition :show="historyExpanded">
          <div v-if="historyTasks.length" class="tasks-history-list">
            <div
              v-for="item in historyTasks"
              :id="taskCardId(item)"
              :key="item.id"
              class="tasks-history-row"
            >
              <div class="tasks-history-row__main">
                <strong>{{ item.input.split(/[/\\]/).pop() || item.input }}</strong>
                <span>{{ item.model }}</span>
              </div>
              <div class="tasks-history-row__meta">
                <n-tag size="small" :type="statusType(item.status)" :bordered="false">{{ statusLabel(item.status) }}</n-tag>
                <span>{{ taskDuration(item) }}</span>
                <span>{{ formatTime(item.updatedAt) }}</span>
              </div>
              <div class="tasks-history-row__actions">
                <n-button size="tiny" tertiary :disabled="!item.logs.length" @click="openLogs(item)">{{ t('tasks.logs') }}</n-button>
                <n-button v-if="item.status === 'done'" size="tiny" tertiary @click="jumpToResult(item)">{{ t('tasks.viewResult') }}</n-button>
                <n-button size="tiny" quaternary @click="handleRemoveTask(item)">{{ t('tasks.remove') }}</n-button>
              </div>
            </div>
          </div>
          <n-card v-else :bordered="true" size="small">
            <div class="tasks-empty-inline">
              <n-icon :component="ArchiveOutline" size="28" color="var(--on-surface-muted)" />
              <span class="text-muted">{{ t('tasks.noHistoryTasks') }}</span>
            </div>
          </n-card>
        </n-collapse-transition>
      </section>
    </template>

    <n-modal v-model:show="showLogModal" style="width:min(960px, 92vw)">
      <n-card
        :title="selectedLogTask ? `${selectedLogTask.input.split(/[/\\]/).pop() || selectedLogTask.input} - ${t('tasks.logs')}` : t('tasks.logs')"
        :bordered="false"
        size="small"
        role="dialog"
        aria-modal="true"
      >
        <template #header-extra>
          <n-tag v-if="selectedLogTask" size="small" :bordered="false" :type="statusType(selectedLogTask.status)">
            {{ t('tasks.logLineCount', { status: statusLabel(selectedLogTask.status), count: selectedLogTask.logs.length }) }}
          </n-tag>
        </template>

        <div v-if="selectedLogTask?.logs.length" class="log-console">
          <div
            v-for="(line, index) in selectedLogTask.logs"
            :key="`${index}-${line}`"
            class="log-line"
            :class="logClass(line)"
          >
            <span class="log-line-number">{{ String(index + 1).padStart(3, '0') }}</span>
            <span class="log-line-text">{{ line }}</span>
          </div>
        </div>
        <div v-else class="log-empty">{{ t('tasks.noLogs') }}</div>

        <template #footer>
          <div class="log-modal-footer">
            <span v-if="selectedLogTask" class="text-muted">{{ selectedLogTask.id }}</span>
            <n-button size="small" @click="showLogModal = false">{{ t('common.close') }}</n-button>
          </div>
        </template>
      </n-card>
    </n-modal>
  </div>
</template>

<style scoped>
.tasks-workbench {
  display: grid;
  gap: 20px;
}

.tasks-section {
  display: grid;
  gap: 12px;
}

.tasks-section__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.tasks-section__heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tasks-section__title h2 {
  margin: 0;
  font-size: 18px;
}

.tasks-section__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--primary-strong);
  background: var(--primary-soft);
  box-shadow: inset 0 0 0 1px var(--primary-border);
}

.tasks-list {
  display: grid;
  gap: 12px;
}

.task-workbench-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.task-workbench-card__title {
  display: block;
  font-size: 15px;
  line-height: 1.3;
}

.task-workbench-card__subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--on-surface-muted);
}

.task-workbench-card__progress {
  margin-top: 4px;
}

.task-workbench-card__meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--on-surface-muted);
  margin-top: 12px;
}

.task-workbench-card__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.tasks-history-list {
  display: grid;
  gap: 10px;
}

.tasks-history-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) auto;
  gap: 16px;
  align-items: center;
  padding: 14px 16px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--outline) 76%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 98%, transparent), color-mix(in srgb, var(--surface-1) 92%, var(--surface-2)));
  transition: border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease;
}

.tasks-history-row:hover {
  border-color: color-mix(in srgb, var(--primary-border) 74%, var(--outline));
  box-shadow: 0 10px 24px color-mix(in srgb, var(--primary-glow) 12%, transparent);
  transform: translateY(-1px);
}

.tasks-history-row__main {
  min-width: 0;
}

.tasks-history-row__main strong {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tasks-history-row__main span {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--on-surface-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tasks-history-row__meta {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--on-surface-muted);
}

.tasks-history-row__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.tasks-empty,
.tasks-empty-inline {
  text-align: center;
  padding: 32px 0;
}

.tasks-empty-inline {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px;
}

.task-progress-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  color: var(--on-surface);
  font-size: 12px;
  font-weight: 600;
}

.task-progress-head__main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.task-progress-head__main > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-progress-head__detail {
  flex-shrink: 0;
  color: var(--on-surface-muted);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.task-message {
  margin: 6px 0 0;
}

.log-console {
  max-height: min(62vh, 620px);
  overflow: auto;
  padding: 12px 0;
  border: 1px solid color-mix(in srgb, var(--outline) 86%, transparent);
  border-radius: 12px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.028), rgba(255,255,255,0.008)),
    color-mix(in srgb, var(--surface) 92%, #0e1218);
  color: #d6deeb;
  font-family: "JetBrains Mono", "Fira Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
}

.log-line {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 10px;
  padding: 1px 14px;
  white-space: pre-wrap;
  word-break: break-word;
}

.log-line:hover {
  background: color-mix(in srgb, var(--primary-soft) 14%, rgba(255, 255, 255, 0.02));
}

.log-line-number {
  user-select: none;
  color: #5e6a7d;
  text-align: right;
}

.log-line--info .log-line-text { color: #d6deeb; }
.log-line--debug .log-line-text { color: #82aaff; }
.log-line--success .log-line-text { color: #7ee787; }
.log-line--warn .log-line-text { color: #ffd166; }
.log-line--error .log-line-text { color: #ff6b7a; }

.log-empty {
  padding: 28px;
  text-align: center;
  color: var(--on-surface-muted);
}

.log-modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

@media (max-width: 1080px) {
  .tasks-history-row {
    grid-template-columns: 1fr;
  }

  .tasks-history-row__actions {
    justify-content: flex-start;
  }
}
</style>
