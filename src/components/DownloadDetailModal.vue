<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import {
  CloseOutline,
  CopyOutline,
  RefreshOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import type { DownloadLogEntry, DownloadTask } from '@/stores/model'

const props = defineProps<{
  show: boolean
  task: DownloadTask | null
  modelName: string
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'cancel'): void
  (e: 'resume'): void
  (e: 'delete'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
const message = useMessage()

const logContainerRef = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

const statusType = computed(() => {
  if (!props.task) return 'default'
  if (props.task.status === 'error') return 'error'
  if (props.task.status === 'downloading') return 'info'
  if (['paused', 'cancelled', 'interrupted'].includes(props.task.status)) return 'warning'
  return 'success'
})

const statusLabel = computed(() => {
  if (!props.task) return ''
  const map: Record<string, string> = {
    downloading: t('models.downloadStatusDownloading'),
    done: t('models.downloaded'),
    error: t('models.downloadStatusError'),
    paused: t('models.downloadStatusPaused'),
    cancelled: t('models.downloadStatusCancelled'),
    interrupted: t('models.downloadInterrupted'),
    idle: t('models.downloadStatusIdle'),
  }
  return map[props.task.status] || props.task.status
})

const progressColor = computed(() => {
  if (!props.task) return 'var(--primary)'
  if (props.task.status === 'error') return 'var(--danger)'
  if (['paused', 'cancelled', 'interrupted'].includes(props.task.status)) return 'var(--warning)'
  return 'var(--primary)'
})

const filesText = computed(() => {
  if (!props.task) return ''
  if (props.task.totalFiles > 1) {
    return t('models.fileProgress', {
      completed: props.task.completedFiles,
      total: props.task.totalFiles,
    })
  }
  return ''
})

const canCancel = computed(() => props.task?.status === 'downloading')
const canResume = computed(() =>
  props.task && ['paused', 'cancelled', 'error', 'interrupted'].includes(props.task.status),
)
const canDelete = computed(() =>
  props.task && ['paused', 'cancelled', 'error', 'interrupted'].includes(props.task.status),
)

const logs = computed<DownloadLogEntry[]>(() => props.task?.logs || [])

function formatTime(ts: number) {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function levelClass(level: string) {
  return `dl-log--${level}`
}

async function scrollToBottom() {
  if (!autoScroll.value) return
  await nextTick()
  const el = logContainerRef.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(() => logs.value.length, () => void scrollToBottom())
watch(() => props.show, (v) => {
  if (v) void scrollToBottom()
})

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  autoScroll.value = atBottom
}

async function copyAllLogs() {
  if (!props.task) return
  const text = props.task.logs
    .map((log) => `[${formatTime(log.ts)}] [${log.level}] ${log.message}`)
    .join('\n')
  if (!text) {
    message.info(t('models.downloadLogsEmpty'))
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('models.downloadLogsCopied'))
  } catch {
    message.error(t('models.downloadLogsCopyFailed'))
  }
}

function handleCancel() { emit('cancel') }
function handleResume() { emit('resume') }
function handleDelete() { emit('delete') }
function handleClose() {
  emit('update:show', false)
  emit('close')
}
</script>

<template>
  <n-modal
    :show="show"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <n-card
      class="download-detail-modal"
      :bordered="false"
      closable
      role="dialog"
      aria-modal="true"
      @close="handleClose"
    >
      <template #header>
        <div class="ddm-header">
          <span class="ddm-title">{{ t('models.downloadDetailTitle') }}</span>
          <span class="ddm-model" :title="modelName">{{ modelName }}</span>
          <n-tag
            v-if="task"
            :type="statusType"
            size="small"
            round
            :bordered="false"
          >
            {{ statusLabel }}
          </n-tag>
        </div>
      </template>

      <div v-if="task" class="ddm-body">
        <div class="ddm-progress">
          <div class="ddm-progress-info">
            <span class="ddm-progress-pct">{{ task.progress }}%</span>
            <span v-if="filesText" class="ddm-progress-files">{{ filesText }}</span>
            <span class="ddm-progress-msg" :title="task.message">{{ task.message }}</span>
          </div>
          <n-progress
            :percentage="task.progress"
            :show-indicator="false"
            :height="10"
            :border-radius="5"
            type="line"
            :color="progressColor"
            rail-color="var(--surface-3)"
          />
        </div>

        <div v-if="task.errorMessage" class="ddm-error">
          <strong>{{ t('models.downloadErrorLabel') }}</strong>
          <pre class="ddm-error-text">{{ task.errorMessage }}</pre>
        </div>

        <div class="ddm-logs-head">
          <span class="ddm-logs-title">{{ t('models.downloadLogs') }}</span>
          <div class="ddm-logs-actions">
            <n-button size="tiny" quaternary @click="copyAllLogs">
              <template #icon><n-icon :component="CopyOutline" /></template>
              {{ t('models.downloadCopyLogs') }}
            </n-button>
          </div>
        </div>
        <div
          ref="logContainerRef"
          class="ddm-logs"
          @scroll="onScroll"
        >
          <div v-if="!logs.length" class="ddm-logs-empty">
            {{ t('models.downloadLogsEmpty') }}
          </div>
          <div
            v-for="(log, idx) in logs"
            :key="idx"
            :class="['dl-log', levelClass(log.level)]"
          >
            <span class="dl-log-time">{{ formatTime(log.ts) }}</span>
            <span class="dl-log-level">{{ log.level }}</span>
            <span class="dl-log-msg">{{ log.message }}</span>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="ddm-footer">
          <n-button
            v-if="canCancel"
            type="error"
            secondary
            @click="handleCancel"
          >
            {{ t('common.cancel') }}
          </n-button>
          <n-button
            v-if="canResume"
            type="primary"
            @click="handleResume"
          >
            <template #icon><n-icon :component="RefreshOutline" /></template>
            {{ task?.status === 'interrupted' ? t('models.continueDownload') : t('common.resume') }}
          </n-button>
          <n-button
            v-if="canDelete"
            type="error"
            secondary
            @click="handleDelete"
          >
            <template #icon><n-icon :component="TrashOutline" /></template>
            {{ t('models.delete') }}
          </n-button>
          <n-button quaternary @click="handleClose">
            <template #icon><n-icon :component="CloseOutline" /></template>
            {{ t('common.close') }}
          </n-button>
        </div>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.download-detail-modal {
  width: min(680px, calc(100vw - 48px));
  max-height: min(640px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px;
}

.download-detail-modal :deep(.n-card-header) {
  flex: 0 0 auto;
  padding: 16px 20px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
}

.download-detail-modal :deep(.n-card__content) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  padding: 0;
}

.download-detail-modal :deep(.n-card-footer),
.download-detail-modal :deep(.n-card__footer) {
  flex: 0 0 auto;
  padding: 12px 20px 16px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
}

.ddm-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.ddm-title {
  font-size: 15px;
  font-weight: 600;
}

.ddm-model {
  font-size: 13px;
  color: var(--on-surface-muted);
  font-family: var(--font-mono, monospace);
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ddm-body {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  box-sizing: border-box;
  overflow: hidden;
}

.ddm-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.ddm-progress-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.ddm-progress-pct {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.ddm-progress-files {
  font-size: 12px;
  color: var(--on-surface-muted);
}

.ddm-progress-msg {
  font-size: 12px;
  color: var(--on-surface-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}

.ddm-error {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  flex-shrink: 0;
}

.ddm-error strong {
  display: block;
  font-size: 12px;
  color: var(--danger);
  margin-bottom: 4px;
}

.ddm-error-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--on-surface);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--font-mono, monospace);
  max-height: 100px;
  overflow-y: auto;
}

.ddm-logs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
  margin-bottom: 6px;
  flex-shrink: 0;
}

.ddm-logs-title {
  font-size: 13px;
  font-weight: 600;
}

.ddm-logs-actions {
  display: flex;
  gap: 6px;
}

.ddm-logs {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-2) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--outline) 50%, transparent);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.6;
}

.ddm-logs-empty {
  color: var(--on-surface-muted);
  text-align: center;
  padding: 24px 0;
}

.dl-log {
  display: grid;
  grid-template-columns: 64px 48px 1fr;
  gap: 8px;
  align-items: baseline;
  padding: 1px 0;
}

.dl-log-time {
  color: var(--on-surface-muted);
  font-variant-numeric: tabular-nums;
}

.dl-log-level {
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
  padding: 0 4px;
  border-radius: 3px;
}

.dl-log-msg {
  word-break: break-all;
  white-space: pre-wrap;
}

.dl-log--info .dl-log-level {
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-3) 60%, transparent);
}

.dl-log--warn {
  color: var(--warning);
}

.dl-log--warn .dl-log-level {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 18%, transparent);
}

.dl-log--error {
  color: var(--danger);
}

.dl-log--error .dl-log-level {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 18%, transparent);
}

.ddm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
