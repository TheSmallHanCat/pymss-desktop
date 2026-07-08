<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import {
  AlertCircleOutline,
  CheckmarkCircleOutline,
  CloudDownloadOutline,
  FolderOpenOutline,
  InformationCircleOutline,
  PulseOutline,
  RefreshOutline,
  TerminalOutline,
  TimeOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { useAppStore, type DiagnosticLevel } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import { useTaskStore } from '@/stores/task'
import { useModelStore } from '@/stores/model'
import { formatBytes } from '@/utils/format'

const { t } = useI18n()
const message = useMessage()
const app = useAppStore()
const settings = useSettingsStore()
const task = useTaskStore()
const modelStore = useModelStore()

const { developerMode, dataRoot, modelDir, outputDir, settingsDir, editorProjectsDir, logsDir, tempDir, defaultDevice, downloadSource, maxConcurrentSeparations } = storeToRefs(settings)
const { activeWorkerTasks, runningTasks } = storeToRefs(task)
const { downloadTasks } = storeToRefs(modelStore)

const diagnostics = computed(() => app.diagnostics)
const env = computed(() => app.envInfo)
const recentWorkerEvents = computed(() => app.workerEvents.slice(0, 40))
const runningDownloadTasks = computed(() => Object.values(downloadTasks.value).filter((item) => item.status === 'downloading'))
const runtimeDevice = computed(() => settings.getRuntimeDeviceConfig(app.envInfo))
const cudaDevices = computed(() => env.value?.cudaDevices || [])
const runtimeRows = computed(() => [
  { label: t('debug.defaultDevice'), value: defaultDevice.value },
  { label: t('debug.resolvedDevice'), value: `${runtimeDevice.value.device} [${runtimeDevice.value.deviceIds.join(', ')}]` },
  { label: t('debug.downloadSource'), value: downloadSource.value },
  { label: t('debug.maxConcurrent'), value: String(maxConcurrentSeparations.value) },
])
const pathRows = computed(() => [
  { label: t('debug.dataRoot'), value: dataRoot.value },
  { label: t('debug.modelDir'), value: modelDir.value },
  { label: t('debug.outputDir'), value: outputDir.value },
  { label: t('debug.settingsDir'), value: settingsDir.value },
  { label: t('debug.editorProjectsDir'), value: editorProjectsDir.value },
  { label: t('debug.logsDir'), value: logsDir.value },
  { label: t('debug.tempDir'), value: tempDir.value },
])
const statusCards = computed(() => [
  { label: t('debug.envStatus'), value: app.envReady ? t('debug.ready') : t('debug.needsAttention'), tone: app.envReady ? 'ok' : 'warn' },
  { label: t('debug.activeWorkerTasks'), value: String(activeWorkerTasks.value.length), tone: activeWorkerTasks.value.length ? 'warn' : 'ok' },
  { label: t('debug.runningTasks'), value: String(runningTasks.value.length), tone: runningTasks.value.length ? 'warn' : 'ok' },
  { label: t('debug.downloadingModels'), value: String(runningDownloadTasks.value.length), tone: runningDownloadTasks.value.length ? 'warn' : 'ok' },
])

function diagnosticIcon(level: DiagnosticLevel) {
  if (level === 'ok') return CheckmarkCircleOutline
  if (level === 'warn') return WarningOutline
  return AlertCircleOutline
}

function eventTime(value: unknown) {
  const time = Date.parse(String(value || ''))
  if (!Number.isFinite(time)) return '-'
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time)
}

function shortTaskId(value: unknown) {
  const text = String(value || '').trim()
  if (!text) return '-'
  return text.length > 28 ? `${text.slice(0, 14)}…${text.slice(-10)}` : text
}

function formatPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return ''
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

async function checkEnv() {
  try {
    await app.checkEnv()
    message.success(t('debug.envCheckDone'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function revealPath(path: string) {
  if (!path) return
  try {
    await task.revealPath(path)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

onMounted(() => {
  if (!app.envInfo && !app.envLoading) {
    app.checkEnvInBackground().catch(() => {})
  }
})
</script>

<template>
  <div class="page debug-page">
    <div class="page-header-compact debug-page__header">
      <div>
        <h1>{{ t('debug.title') }}</h1>
        <p>{{ t('debug.subtitle') }}</p>
      </div>
      <n-button type="primary" secondary :loading="app.envLoading" @click="checkEnv">
        <template #icon><n-icon :component="RefreshOutline" /></template>
        {{ app.envLoading ? t('settings.checkingEnv') : t('settings.checkEnv') }}
      </n-button>
    </div>

    <n-alert v-if="!developerMode" type="warning" :show-icon="true">
      {{ t('debug.disabledHint') }}
    </n-alert>

    <section class="debug-status-grid">
      <article v-for="item in statusCards" :key="item.label" class="debug-status-card" :class="`debug-status-card--${item.tone}`">
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </article>
    </section>

    <section class="debug-grid debug-grid--top">
      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="PulseOutline" />
            <span>{{ t('debug.environment') }}</span>
          </div>
        </template>
        <div class="diagnostic-list">
          <div v-for="item in diagnostics" :key="item.key" class="diagnostic-row" :class="`diagnostic-row--${item.level}`">
            <n-icon :component="diagnosticIcon(item.level)" />
            <div class="diagnostic-row__main">
              <strong>{{ item.label }}</strong>
              <span>{{ item.value }}</span>
              <code v-if="item.detail">{{ item.detail }}</code>
            </div>
          </div>
          <n-empty v-if="!diagnostics.length" :description="t('debug.envNotChecked')" />
        </div>
      </n-card>

      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="InformationCircleOutline" />
            <span>{{ t('debug.runtimeParams') }}</span>
          </div>
        </template>
        <div class="kv-list">
          <div v-for="row in runtimeRows" :key="row.label" class="kv-row">
            <span>{{ row.label }}</span>
            <code>{{ row.value || '-' }}</code>
          </div>
        </div>
        <div v-if="cudaDevices.length" class="cuda-list">
          <h3>{{ t('debug.cudaDevices') }}</h3>
          <div v-for="gpu in cudaDevices" :key="gpu.id" class="cuda-row">
            <span>CUDA {{ gpu.id }}</span>
            <strong>{{ gpu.name }}</strong>
            <code v-if="gpu.totalMemoryBytes">{{ formatBytes(gpu.totalMemoryBytes) }}</code>
          </div>
        </div>
      </n-card>
    </section>

    <n-card class="debug-card" :bordered="true" size="small">
      <template #header>
        <div class="debug-section-title">
          <n-icon :component="FolderOpenOutline" />
          <span>{{ t('debug.paths') }}</span>
        </div>
      </template>
      <div class="path-debug-grid">
        <div v-for="row in pathRows" :key="row.label" class="path-debug-row">
          <span>{{ row.label }}</span>
          <code :title="row.value || '-'">{{ row.value || '-' }}</code>
          <n-button size="tiny" secondary :disabled="!row.value" @click="revealPath(row.value)">
            {{ t('common.open') }}
          </n-button>
        </div>
      </div>
    </n-card>

    <section class="debug-grid">
      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="TimeOutline" />
            <span>{{ t('debug.activeTasks') }}</span>
          </div>
        </template>
        <div class="task-debug-list">
          <div v-for="item in runningTasks" :key="item.id" class="task-debug-row">
            <strong>{{ shortTaskId(item.id) }}</strong>
            <span>{{ item.status }}</span>
            <code :title="item.input">{{ item.model }}</code>
          </div>
          <n-empty v-if="!runningTasks.length" :description="t('debug.noActiveTasks')" />
        </div>
      </n-card>

      <n-card class="debug-card" :bordered="true" size="small">
        <template #header>
          <div class="debug-section-title">
            <n-icon :component="CloudDownloadOutline" />
            <span>{{ t('debug.downloadTasks') }}</span>
          </div>
        </template>
        <div class="task-debug-list">
          <div v-for="item in Object.values(downloadTasks)" :key="item.taskId" class="task-debug-row">
            <strong>{{ item.model }}</strong>
            <span>{{ item.status }} · {{ item.progress }}%</span>
            <code>{{ item.completedFiles }} / {{ item.totalFiles }}</code>
          </div>
          <n-empty v-if="!Object.values(downloadTasks).length" :description="t('debug.noDownloadTasks')" />
        </div>
      </n-card>
    </section>

    <n-card class="debug-card debug-card--events" :bordered="true" size="small">
      <template #header>
        <div class="debug-section-title">
          <n-icon :component="TerminalOutline" />
          <span>{{ t('debug.workerEvents') }}</span>
        </div>
      </template>
      <div class="worker-event-list">
        <details v-for="(event, index) in recentWorkerEvents" :key="`${event?.timestamp || ''}-${index}`" class="worker-event-row">
          <summary>
            <code>{{ event?.type || '-' }}</code>
            <span>{{ shortTaskId(event?.taskId) }}</span>
            <time>{{ eventTime(event?.timestamp) }}</time>
          </summary>
          <pre>{{ formatPayload(event?.payload) }}</pre>
        </details>
        <n-empty v-if="!recentWorkerEvents.length" :description="t('settings.developerNoWorkerEvents')" />
      </div>
    </n-card>
  </div>
</template>

<style scoped>
.debug-page {
  display: grid;
  gap: 14px;
  max-width: 1180px;
}

.debug-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.debug-status-grid,
.debug-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.debug-status-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.debug-status-card {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--outline) 52%, transparent);
  background: color-mix(in srgb, var(--surface-1) 72%, transparent);
}

.debug-status-card span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.debug-status-card strong {
  color: var(--on-surface);
  font-size: 24px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.debug-status-card--ok {
  border-color: color-mix(in srgb, var(--success) 26%, var(--outline));
}

.debug-status-card--warn {
  border-color: color-mix(in srgb, var(--warning) 42%, var(--outline));
}

.debug-card {
  border-color: color-mix(in srgb, var(--outline) 58%, transparent) !important;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.025), transparent 42%),
    color-mix(in srgb, var(--surface-1) 72%, transparent) !important;
}

.debug-card :deep(.n-card__header) {
  padding: 16px 18px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
}

.debug-card :deep(.n-card__content) {
  padding: 14px 18px 18px;
}

.debug-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
}

.diagnostic-list,
.kv-list,
.task-debug-list,
.worker-event-list {
  display: grid;
  gap: 8px;
}

.diagnostic-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 10px;
  padding: 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 42%, transparent);
}

.diagnostic-row--ok { color: var(--success); }
.diagnostic-row--warn { color: var(--warning); }
.diagnostic-row--error { color: var(--danger); }

.diagnostic-row__main {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--on-surface);
}

.diagnostic-row__main span,
.kv-row span,
.path-debug-row span,
.task-debug-row span,
.cuda-row span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.diagnostic-row__main code,
.kv-row code,
.path-debug-row code,
.task-debug-row code,
.cuda-row code,
.worker-event-row code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
  font-size: 12px;
}

.kv-row,
.path-debug-row,
.task-debug-row,
.cuda-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 36%, transparent);
}

.path-debug-grid {
  display: grid;
  gap: 8px;
}

.path-debug-row {
  grid-template-columns: 150px minmax(0, 1fr) auto;
}

.cuda-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
}

.cuda-list h3 {
  margin: 0;
  font-size: 13px;
}

.cuda-row {
  grid-template-columns: 80px minmax(0, 1fr) auto;
}

.task-debug-row {
  grid-template-columns: minmax(0, 1fr) auto minmax(120px, 0.5fr);
}

.task-debug-row strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.worker-event-row {
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 36%, transparent);
  overflow: hidden;
}

.worker-event-row summary {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(100px, 0.8fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
}

.worker-event-row summary span,
.worker-event-row summary time {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.worker-event-row pre {
  max-height: 260px;
  margin: 0;
  overflow: auto;
  padding: 12px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 40%, transparent);
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 980px) {
  .debug-status-grid,
  .debug-grid {
    grid-template-columns: 1fr;
  }

  .path-debug-row,
  .task-debug-row,
  .worker-event-row summary {
    grid-template-columns: 1fr;
  }
}
</style>
