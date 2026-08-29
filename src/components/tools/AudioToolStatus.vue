<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckmarkCircleOutline, FolderOpenOutline } from '@vicons/ionicons5'
import type { AudioToolProgress, AudioToolResult } from '@/types/audioTools'

const props = defineProps<{
  busy: boolean
  hasResult: boolean
  error: string
  progress: AudioToolProgress
  percentage: number
  result: AudioToolResult | null
}>()

const emit = defineEmits<{
  reveal: [path: string]
}>()

const { t } = useI18n()

const outputPath = computed(() => props.result?.outputPath || props.result?.outputDir || '')
const outputs = computed(() => props.result?.outputPaths || (props.result?.outputPath ? [props.result.outputPath] : []))
const failures = computed(() => [...(props.result?.failed || []), ...(props.result?.skipped || [])])
const completedCount = computed(() => {
  if (!props.result) return 0
  return props.result.operation === 'convert'
    ? props.result.succeeded || outputs.value.length
    : props.result.merged || 1
})

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}
</script>

<template>
  <div v-if="error" class="status-message status-message--error">
    {{ error }}
  </div>

  <div v-else-if="busy" class="status-stack">
    <n-progress
      type="line"
      :percentage="percentage"
      processing
      :height="8"
      :show-indicator="false"
    />
    <span class="status-current" :title="progress.current">{{ progress.current }}</span>
    <small>{{ progress.completed }} / {{ progress.total || '—' }}</small>
  </div>

  <div v-else-if="!hasResult || !result" class="status-message">
    {{ t('tools.waiting') }}
  </div>

  <div v-else-if="result.operation === 'sdr'" class="metric-grid">
    <div class="metric-item">
      <span>SDR</span>
      <strong>{{ result.averageSdr ?? '—' }} dB</strong>
    </div>
    <div class="metric-item">
      <span>SI-SDR</span>
      <strong>{{ result.averageSiSdr ?? '—' }} dB</strong>
    </div>
    <div class="channel-values">
      <span>SDR: {{ (result.sdr || []).map(value => `${value} dB`).join(' / ') }}</span>
      <span>SI-SDR: {{ (result.siSdr || []).map(value => `${value} dB`).join(' / ') }}</span>
    </div>
  </div>

  <div v-else class="status-stack">
    <div class="status-success">
      <n-icon :component="CheckmarkCircleOutline" />
      <strong>{{ t('tools.outputCount', { count: completedCount }) }}</strong>
    </div>
    <div v-for="path in outputs.slice(0, 4)" :key="path" class="output-file" :title="path">
      {{ fileName(path) }}
    </div>
    <small v-if="outputs.length > 4">+{{ outputs.length - 4 }}</small>
    <div v-if="failures.length" class="status-warning">
      <strong>{{ t('tools.skippedCount', { count: failures.length }) }}</strong>
      <span v-for="failure in failures.slice(0, 3)" :key="failure.path" :title="failure.message">
        {{ fileName(failure.path) }}：{{ failure.message }}
      </span>
    </div>
    <n-button v-if="outputPath" secondary size="small" @click="emit('reveal', outputPath)">
      <template #icon><n-icon :component="FolderOpenOutline" /></template>
      {{ t('tools.openOutputLocation') }}
    </n-button>
  </div>
</template>

<style scoped>
.status-stack {
  display: grid;
  gap: 10px;
}

.status-current,
.output-file {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.status-stack small {
  color: var(--on-surface-muted);
}

.status-message {
  min-height: 90px;
  display: grid;
  place-items: center;
  border: 1px dashed color-mix(in srgb, var(--outline) 70%, transparent);
  border-radius: 11px;
  color: var(--on-surface-muted);
  font-size: 12px;
  text-align: center;
  padding: 14px;
  word-break: break-word;
}

.status-message--error {
  border-color: color-mix(in srgb, var(--danger) 32%, var(--outline));
  color: var(--danger);
}

.status-success {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--success);
}

.status-warning {
  display: grid;
  gap: 4px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--warning) 30%, var(--outline));
  border-radius: 9px;
  color: var(--warning);
  font-size: 11px;
}

.status-warning span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--warning) 65%, var(--on-surface-muted));
}

.metric-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.metric-item {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--outline);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 48%, var(--surface-1));
}

.metric-item span {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.metric-item strong {
  font-size: 17px;
}

.channel-values {
  grid-column: 1 / -1;
  display: grid;
  gap: 5px;
  color: var(--on-surface-muted);
  font: 11px/1.5 var(--font-mono);
  overflow-wrap: anywhere;
}
</style>
