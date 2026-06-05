<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EditorExportFormat } from '@/types/editor'

const props = defineProps<{
  show: boolean
  sessionName: string
  duration: number
  trackCount: number
  exporting: boolean
  format: EditorExportFormat
  wavBitDepth: string
  flacBitDepth: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'update:format': [value: EditorExportFormat]
  'update:wav-bit-depth': [value: string]
  'update:flac-bit-depth': [value: string]
  confirm: []
}>()

const { t } = useI18n()

const exportFormatOptions = computed(() => [
  { label: 'WAV', value: 'wav' as EditorExportFormat },
  { label: 'FLAC', value: 'flac' as EditorExportFormat },
])

const wavBitDepthOptions = computed(() => [
  { label: 'PCM_16', value: 'PCM_16' },
  { label: 'PCM_24', value: 'PCM_24' },
  { label: 'FLOAT', value: 'FLOAT' },
])

const flacBitDepthOptions = computed(() => [
  { label: 'PCM_16', value: 'PCM_16' },
  { label: 'PCM_24', value: 'PCM_24' },
])

const exportSummaryRows = computed(() => [
  { label: t('editor.totalDuration'), value: props.duration ? `${Math.round(props.duration * 10) / 10}s` : '0s' },
  { label: t('editor.tracks'), value: String(props.trackCount) },
  { label: t('editor.exportSampleRateStrategy'), value: t('editor.exportSampleRateStrategyValue') },
])
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    class="editor-export-modal"
    :title="t('editor.exportDialogTitle')"
    :bordered="false"
    size="small"
    style="width: min(560px, calc(100vw - 32px));"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <div class="export-dialog">
      <div class="export-dialog__intro">
        <strong>{{ sessionName }}</strong>
        <span>{{ t('editor.exportDialogHint') }}</span>
      </div>

      <div class="export-dialog__form">
        <label class="export-dialog__field">
          <span>{{ t('editor.exportFormat') }}</span>
          <n-select
            :value="format"
            :options="exportFormatOptions"
            size="small"
            @update:value="(value: EditorExportFormat) => emit('update:format', value)"
          />
        </label>

        <label class="export-dialog__field" v-if="format === 'wav'">
          <span>{{ t('audio.wavBitDepth') }}</span>
          <n-select
            :value="wavBitDepth"
            :options="wavBitDepthOptions"
            size="small"
            @update:value="(value: string) => emit('update:wav-bit-depth', value)"
          />
        </label>

        <label class="export-dialog__field" v-if="format === 'flac'">
          <span>{{ t('audio.flacBitDepth') }}</span>
          <n-select
            :value="flacBitDepth"
            :options="flacBitDepthOptions"
            size="small"
            @update:value="(value: string) => emit('update:flac-bit-depth', value)"
          />
        </label>
      </div>

      <div class="export-dialog__section export-dialog__section--compact">
        <div class="export-dialog__section-title">{{ t('editor.exportRenderSummary') }}</div>
        <div class="export-summary">
          <div v-for="row in exportSummaryRows" :key="row.label" class="export-summary__item">
            <span>{{ row.label }}</span>
            <strong>{{ row.value }}</strong>
          </div>
          <div class="export-summary__item export-summary__item--wide">
            <span>{{ t('editor.exportProcessing') }}</span>
            <strong>{{ t('editor.exportProcessingValue') }}</strong>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="export-dialog__footer">
        <n-button secondary @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="exporting" @click="emit('confirm')">{{ t('editor.export') }}</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.editor-export-modal :deep(.n-card) {
  width: min(560px, calc(100vw - 32px)) !important;
  max-width: min(560px, calc(100vw - 32px)) !important;
  background:
    radial-gradient(circle at top right, rgba(255, 123, 84, 0.12), transparent 34%),
    linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 96%, transparent), var(--surface));
}

.export-dialog {
  display: grid;
  gap: 10px;
  width: 100%;
}

.export-dialog__intro {
  display: grid;
  gap: 4px;
  padding: 2px 2px 0;
}

.export-dialog__intro strong {
  font-size: 13px;
  line-height: 1.1;
}

.export-dialog__intro span {
  color: var(--on-surface-muted);
  font-size: 11px;
  line-height: 1.45;
}

.export-dialog__form {
  display: grid;
  gap: 10px;
}

.export-dialog__field {
  display: grid;
  gap: 6px;
}

.export-dialog__field span {
  color: var(--on-surface-muted);
  font-size: 11px;
  line-height: 1.2;
}

.export-dialog__section {
  display: grid;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 82%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 74%, transparent);
}

.export-dialog__section--compact {
  padding: 10px;
}

.export-dialog__section-title {
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.export-summary {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
}

.export-summary__item {
  display: grid;
  gap: 3px;
  padding: 8px 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-1) 80%, transparent);
}

.export-summary__item--wide {
  grid-column: auto;
}

.export-summary__item span {
  color: var(--on-surface-muted);
  font-size: 10px;
  line-height: 1.2;
}

.export-summary__item strong {
  font-size: 12px;
  line-height: 1.3;
}

.export-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.editor-export-modal :deep(.n-base-selection) {
  --n-color: color-mix(in srgb, var(--surface-1) 92%, transparent) !important;
  --n-border: 1px solid color-mix(in srgb, var(--outline) 60%, transparent) !important;
  --n-border-hover: 1px solid color-mix(in srgb, var(--outline) 78%, transparent) !important;
  --n-border-focus: 1px solid color-mix(in srgb, var(--primary) 50%, transparent) !important;
  --n-box-shadow-focus: 0 0 0 2px color-mix(in srgb, var(--primary-soft) 30%, transparent) !important;
}
</style>
