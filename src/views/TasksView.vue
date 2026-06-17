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
  TrashOutline,
  TerminalOutline,
  LayersOutline,
  ArchiveOutline,
  ListOutline,
  GridOutline,
} from '@vicons/ionicons5'
import { useTaskStore, type SeparationTask } from '@/stores/task'
import { usePagedSelection } from '@/composables/usePagedSelection'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const task = useTaskStore()

const terminalStatuses = ['done', 'failed', 'cancelled']
const showLogModal = ref(false)
const selectedLogTask = ref<SeparationTask | null>(null)
const cancellingTaskIds = ref<string[]>([])
const cancellingAllTasks = ref(false)

const COMPACT_THRESHOLD = 4
const runningDensity = ref<'comfortable' | 'compact'>('comfortable')
const densityManuallySet = ref(false)

const runningTasks = computed(() => {
  // 处理中（已开始执行）置顶，排队中排在下方；同组内按创建时间倒序
  return [...task.runningTasks].filter((item) => !item.taskHidden).sort((a, b) => {
    const aQueued = a.status === 'queued' ? 1 : 0
    const bQueued = b.status === 'queued' ? 1 : 0
    if (aQueued !== bQueued) return aQueued - bQueued
    return b.createdAt - a.createdAt
  })
})
const historyTasks = computed(() => task.taskBoardTasks.filter((item) => terminalStatuses.includes(item.status)))
const runningTaskCount = computed(() => runningTasks.value.length)
const isCompact = computed(() => runningDensity.value === 'compact')
const pagedSelection = usePagedSelection(historyTasks, {
  initialPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100],
})
const {
  selecting: historySelecting,
  selectedIds: selectedHistoryIds,
  selectedSet: selectedHistorySet,
  page: historyPage,
  pageSize: historyPageSize,
  pageSizeOptions: historyPageSizeOptions,
  pagedItems: pagedHistoryTasks,
  allSelected: allHistorySelected,
  someSelected: someHistorySelected,
  toggleSelecting: toggleHistorySelecting,
  toggleSelection: toggleHistorySelection,
  toggleSelectPage: toggleSelectAllHistory,
  ensureItemPage,
} = pagedSelection

// 进行中任务过多时自动切换到紧凑视图（用户未手动指定时）
watch(runningTaskCount, (count) => {
  if (densityManuallySet.value) return
  runningDensity.value = count > COMPACT_THRESHOLD ? 'compact' : 'comfortable'
}, { immediate: true })

function toggleDensity() {
  densityManuallySet.value = true
  runningDensity.value = isCompact.value ? 'comfortable' : 'compact'
}

function handleRemoveSelected() {
  const ids = [...selectedHistoryIds.value]
  if (!ids.length) return
  dialog.warning({
    title: t('tasks.removeSelectedTitle'),
    content: t('tasks.removeSelectedContent', { count: ids.length }),
    positiveText: t('tasks.removeSelectedPositive'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      const removed = task.removeTasks(ids)
      selectedHistoryIds.value = []
      historySelecting.value = false
      if (removed > 0) message.success(t('tasks.removeSelectedSuccess', { count: removed }))
    },
  })
}


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
  dialog.warning({
    title: t('tasks.cancelConfirmTitle'),
    content: t('tasks.cancelConfirmContent'),
    positiveText: t('tasks.cancelAction'),
    negativeText: t('common.cancel'),
    positiveButtonProps: { type: 'error' },
    negativeButtonProps: { secondary: true },
    onPositiveClick: async () => {
      if (cancellingTaskIds.value.includes(id)) return
      cancellingTaskIds.value = [...cancellingTaskIds.value, id]
      try {
        const ok = await task.cancelTask(id)
        if (ok) message.success(t('tasks.cancelSuccess'))
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err))
      } finally {
        cancellingTaskIds.value = cancellingTaskIds.value.filter((item) => item !== id)
      }
    },
  })
}

async function handleCancelAll() {
  dialog.warning({
    title: t('tasks.cancelAllConfirmTitle'),
    content: t('tasks.cancelAllConfirmContent'),
    positiveText: t('tasks.cancelAllAction'),
    negativeText: t('common.cancel'),
    positiveButtonProps: { type: 'error' },
    negativeButtonProps: { secondary: true },
    onPositiveClick: async () => {
      if (cancellingAllTasks.value) return
      cancellingAllTasks.value = true
      const loading = message.loading(t('tasks.cancelAllPending'), { duration: 0 })
      try {
        const result = await task.cancelAllTasks()
        if (result.cancelled > 0) {
          message.success(t('tasks.cancelAllSuccess', { cancelled: result.cancelled, total: result.total }))
        } else {
          message.warning(t('tasks.cancelAllNoneCancelled'))
        }
      } catch (err) {
        message.error(err instanceof Error ? err.message : t('tasks.cancelAllFailed'))
      } finally {
        loading.destroy()
        cancellingAllTasks.value = false
      }
    },
  })
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
  ensureItemPage(id)
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

    <n-card v-if="!task.taskBoardTasks.length" :bordered="true">
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
            <span class="tasks-section__count">{{ runningTaskCount }}</span>
          </div>
          <div class="tasks-section__tools">
            <n-button-group v-if="runningTaskCount" size="small">
              <n-button
                :type="!isCompact ? 'primary' : 'default'"
                :secondary="isCompact"
                @click="!isCompact || toggleDensity()"
              >
                <template #icon><n-icon :component="GridOutline" /></template>
                {{ t('tasks.densityComfortable') }}
              </n-button>
              <n-button
                :type="isCompact ? 'primary' : 'default'"
                :secondary="!isCompact"
                @click="isCompact || toggleDensity()"
              >
                <template #icon><n-icon :component="ListOutline" /></template>
                {{ t('tasks.densityCompact') }}
              </n-button>
            </n-button-group>
            <n-button
              v-if="runningTaskCount"
              size="small"
              tertiary
              type="error"
              :loading="cancellingAllTasks"
              :disabled="cancellingAllTasks"
              @click="handleCancelAll"
            >
              {{ t('tasks.cancelAllAction') }}
            </n-button>
          </div>
        </div>

        <div v-if="runningTasks.length && isCompact" class="tasks-running-compact">
          <div
            v-for="item in runningTasks"
            :id="taskCardId(item)"
            :key="item.id"
            class="running-compact-row"
          >
            <div class="running-compact-row__info">
              <n-icon class="running-compact-row__status" :component="statusIcon(item.status)" :class="`running-compact-row__status--${statusType(item.status)}`" />
              <div class="running-compact-row__text">
                <strong>{{ item.input.split(/[/\\]/).pop() || item.input }}</strong>
                <span>{{ progressTitle(item) }}<template v-if="progressDetail(item)"> · {{ progressDetail(item) }}</template></span>
              </div>
            </div>
            <div class="running-compact-row__progress">
              <n-progress
                type="line"
                :percentage="Math.round(item.progress || 0)"
                :status="progressStatus(item.status)"
                :processing="isRunning(item.status)"
                :height="6"
                :show-indicator="false"
              />
              <span class="running-compact-row__percent">{{ Math.round(item.progress || 0) }}%</span>
            </div>
            <div class="running-compact-row__actions">
              <n-button
                size="tiny"
                quaternary
                :disabled="!item.logs.length"
                :title="t('tasks.logs')"
                :aria-label="t('tasks.logs')"
                @click="openLogs(item)"
              >
                <template #icon><n-icon :component="TerminalOutline" /></template>
              </n-button>
              <n-button
                v-if="isRunning(item.status)"
                size="tiny"
                quaternary
                type="error"
                :loading="cancellingTaskIds.includes(item.id)"
                :disabled="cancellingTaskIds.includes(item.id)"
                :title="t('tasks.cancelAction')"
                :aria-label="t('tasks.cancelAction')"
                @click="handleCancel(item.id)"
              >
                <template #icon><n-icon :component="CloseCircleOutline" /></template>
              </n-button>
            </div>
          </div>
        </div>

        <div v-else-if="runningTasks.length" class="tasks-list">
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

            <div class="task-workbench-card__footer">
              <div class="task-workbench-card__meta">
                <span>{{ t('tasks.createdAt') }}：{{ formatTime(item.createdAt) }}</span>
                <span>{{ t('tasks.updatedAt') }}：{{ formatTime(item.updatedAt) }}</span>
                <span>{{ t('tasks.duration') }}：{{ taskDuration(item) }}</span>
              </div>

              <div class="task-workbench-card__actions">
                <n-button size="tiny" secondary :disabled="!item.logs.length" @click="openLogs(item)">
                  <template #icon><n-icon :component="TerminalOutline" /></template>
                  {{ t('tasks.logs') }}
                </n-button>
                <n-button
                  v-if="isRunning(item.status)"
                  size="tiny"
                  secondary
                  :loading="cancellingTaskIds.includes(item.id)"
                  :disabled="cancellingTaskIds.includes(item.id)"
                  @click="handleCancel(item.id)"
                >
                  {{ t('tasks.cancelAction') }}
                </n-button>
              </div>
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
          <template v-if="historyTasks.length">
            <n-button size="small" :type="historySelecting ? 'primary' : 'default'" :secondary="!historySelecting" @click="toggleHistorySelecting">
              {{ historySelecting ? t('tasks.batchExit') : t('tasks.batchSelect') }}
            </n-button>
          </template>
        </div>

        <div v-if="historySelecting && historyTasks.length" class="tasks-history-batchbar">
          <n-checkbox
            :checked="allHistorySelected"
            :indeterminate="someHistorySelected"
            @update:checked="toggleSelectAllHistory"
          >
            {{ t('tasks.selectPage') }}
          </n-checkbox>
          <span class="tasks-history-batchbar__count">{{ t('tasks.selectedCount', { count: selectedHistoryIds.length }) }}</span>
          <n-button
            size="small"
            type="error"
            :disabled="!selectedHistoryIds.length"
            @click="handleRemoveSelected"
          >
            <template #icon><n-icon :component="TrashOutline" /></template>
            {{ t('tasks.removeSelected') }}
          </n-button>
        </div>

        <div v-if="historyTasks.length" class="tasks-history-list">
          <div
            v-for="item in pagedHistoryTasks"
            :id="taskCardId(item)"
            :key="item.id"
            class="tasks-history-row"
            :class="{ 'tasks-history-row--selectable': historySelecting, 'tasks-history-row--selected': selectedHistorySet.has(item.id) }"
            @click="historySelecting && toggleHistorySelection(item.id)"
          >
            <n-checkbox
              v-if="historySelecting"
              class="tasks-history-row__check"
              :checked="selectedHistorySet.has(item.id)"
              @update:checked="toggleHistorySelection(item.id)"
              @click.stop
            />
            <div class="tasks-history-row__main">
              <strong>{{ item.input.split(/[/\\]/).pop() || item.input }}</strong>
              <span>{{ item.model }}</span>
            </div>
            <div class="tasks-history-row__meta">
              <n-tag size="small" :type="statusType(item.status)" :bordered="false">{{ statusLabel(item.status) }}</n-tag>
              <span>{{ taskDuration(item) }}</span>
              <span>{{ formatTime(item.updatedAt) }}</span>
            </div>
            <div v-if="!historySelecting" class="tasks-history-row__actions">
              <n-button size="tiny" tertiary :disabled="!item.logs.length" @click="openLogs(item)">{{ t('tasks.logs') }}</n-button>
              <n-button v-if="item.status === 'done'" size="tiny" tertiary @click="jumpToResult(item)">{{ t('tasks.viewResult') }}</n-button>
              <n-button size="tiny" quaternary @click="handleRemoveTask(item)">{{ t('tasks.remove') }}</n-button>
            </div>
          </div>
        </div>
        <div v-if="historyTasks.length" class="tasks-pagination">
          <n-pagination
            v-model:page="historyPage"
            v-model:page-size="historyPageSize"
            :item-count="historyTasks.length"
            :page-sizes="historyPageSizeOptions"
            show-size-picker
          />
        </div>
        <n-card v-else :bordered="true" size="small">
          <div class="tasks-empty-inline">
            <n-icon :component="ArchiveOutline" size="28" color="var(--on-surface-muted)" />
            <span class="text-muted">{{ t('tasks.noHistoryTasks') }}</span>
          </div>
        </n-card>
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

.tasks-section__tools {
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
  gap: 10px;
}

.tasks-running-compact {
  display: grid;
  gap: 6px;
}

.running-compact-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(140px, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 70%, transparent);
  background: color-mix(in srgb, var(--surface-1) 94%, var(--surface-2));
  transition: border-color 160ms ease, background 160ms ease;
}

.running-compact-row:hover {
  border-color: color-mix(in srgb, var(--primary-border) 70%, var(--outline));
}

.running-compact-row__info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.running-compact-row__status {
  flex-shrink: 0;
  font-size: 18px;
}

.running-compact-row__status--info { color: var(--primary); }
.running-compact-row__status--success { color: var(--success); }
.running-compact-row__status--error { color: var(--danger); }
.running-compact-row__status--warning { color: var(--warning); }

.running-compact-row__text {
  min-width: 0;
}

.running-compact-row__text strong {
  display: block;
  font-size: 13px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.running-compact-row__text span {
  display: block;
  font-size: 11px;
  color: var(--on-surface-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.running-compact-row__progress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.running-compact-row__percent {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--on-surface-muted);
  min-width: 34px;
  text-align: right;
}

.running-compact-row__actions {
  display: flex;
  gap: 2px;
  justify-content: flex-end;
}

.tasks-history-batchbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--primary-border) 60%, var(--outline));
  background: var(--primary-softer);
}

.tasks-history-batchbar__count {
  font-size: 13px;
  color: var(--on-surface-muted);
  margin-right: auto;
}

.task-workbench-card {
  border-radius: 18px;
}

.task-workbench-card :deep(.n-card__content) {
  padding: 14px 16px 12px;
}

.task-workbench-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.task-workbench-card__title {
  display: block;
  font-size: 15px;
  line-height: 1.3;
}

.task-workbench-card__subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--on-surface-muted);
}

.task-workbench-card__progress {
  margin-top: 2px;
}

.task-workbench-card__meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--on-surface-muted);
  margin-top: 8px;
}

.task-workbench-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}

.task-workbench-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  margin-left: auto;
}

.tasks-history-list {
  display: grid;
  gap: 8px;
}

.tasks-pagination {
  display: flex;
  justify-content: flex-end;
}

.tasks-history-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) auto;
  gap: 16px;
  align-items: center;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--outline) 76%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 98%, transparent), color-mix(in srgb, var(--surface-1) 92%, var(--surface-2)));
  transition: border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease;
}

.tasks-history-row--selectable {
  grid-template-columns: auto minmax(0, 1.2fr) minmax(0, 1fr);
  cursor: pointer;
}

.tasks-history-row--selected {
  border-color: color-mix(in srgb, var(--primary-border) 90%, transparent);
  background: var(--primary-softer);
}

.tasks-history-row__check {
  flex-shrink: 0;
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
  border: 1px solid #202938;
  border-radius: 12px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.028), rgba(255,255,255,0.008)),
    #0e1218;
  color: #d6deeb;
  font-family: "JetBrains Mono", "Fira Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.03),
    0 10px 28px rgba(7, 10, 16, 0.16);
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
  background: rgba(130, 170, 255, 0.08);
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

  .tasks-history-row--selectable {
    grid-template-columns: auto 1fr;
  }

  .tasks-pagination {
    justify-content: flex-start;
  }

  .running-compact-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .running-compact-row__progress {
    grid-column: 1 / -1;
  }

  .tasks-history-row__actions {
    justify-content: flex-start;
  }

  .task-workbench-card__footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .task-workbench-card__actions {
    margin-left: 0;
    justify-content: flex-start;
  }
}
</style>
