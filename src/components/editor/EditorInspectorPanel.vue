<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EditorSession, EditorSource } from '@/types/editor'
import { formatTime } from '@/utils/editorTime'

const props = defineProps<{
  session: EditorSession
  selectedTrackId: string | null
  selectedSource: EditorSource | null
  duration: number
  lastExportPath: string | null
  compact?: boolean
}>()

const emit = defineEmits<{
  renameTrack: [trackId: string, name: string, commit?: boolean]
  setTrackVolume: [trackId: string, value: number]
  setTrackPan: [trackId: string, value: number]
  beginTrackVolume: []
  commitTrackVolume: []
  beginTrackPan: []
  commitTrackPan: []
  setTrackFades: [trackId: string, patch: { fadeIn?: number; fadeOut?: number }]
  openLocation: []
  relinkSource: []
}>()

const { t } = useI18n()

const selectedTrack = computed(() => props.session.tracks.find((track) => track.id === props.selectedTrackId) || null)
const renameDraft = ref('')

watch(
  selectedTrack,
  (track) => {
    renameDraft.value = track?.name || ''
  },
  { immediate: true },
)

function commitRename() {
  if (!selectedTrack.value) return
  emit('renameTrack', selectedTrack.value.id, renameDraft.value, true)
}

function shortPath(path: string) {
  if (!path) return ''
  if (path.length <= 74) return path
  return `${path.slice(0, 28)}…${path.slice(-38)}`
}

function numberOrZero(value: number | null) {
  return Number(value || 0)
}

function formatTrackVolume(value: number) {
  const volume = Math.max(0, Number(value || 0))
  const percent = `${Math.round(volume * 100)}%`
  if (volume <= 0.0001) return `${percent} · -∞ dB`
  const db = 20 * Math.log10(volume)
  const normalized = `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
  return `${percent} · ${normalized}`
}

function formatTrackPan(value: number) {
  const pan = Number(value || 0)
  if (Math.abs(pan) < 0.025) return t('editor.panCenter')
  const amount = Math.round(Math.abs(pan) * 100)
  return pan < 0 ? `${t('editor.panLeft')} ${amount}` : `${t('editor.panRight')} ${amount}`
}

const sourceMeta = computed(() => [
  props.selectedSource ? formatTime(props.selectedSource.duration || 0) : '',
  props.selectedSource ? `${props.selectedSource.channels || 0}ch` : '',
  props.selectedSource ? `${props.selectedSource.sampleRate || 0}` : '',
].filter(Boolean).join(' · '))

const fadeMax = computed(() => props.selectedSource?.duration || 0)
</script>

<template>
  <aside class="editor-inspector" :class="{ 'editor-inspector--compact': compact }">
    <div class="editor-inspector__titlebar">
      <div class="editor-inspector__eyebrow">{{ selectedTrack ? t('editor.trackParams') : t('editor.inspectorTitle') }}</div>
      <div class="editor-inspector__title">
        <strong>{{ selectedTrack ? selectedTrack.name : t('editor.projectInfo') }}</strong>
        <span>{{ selectedTrack ? (sourceMeta || t('editor.laneNoAudio')) : t('editor.clipParamsIdle') }}</span>
      </div>
    </div>

    <div class="editor-inspector__scroll">
      <section v-if="selectedTrack" class="inspector-group inspector-group--primary">
        <div class="inspector-group__header">
          <strong>{{ t('editor.inspectorSectionCommon') }}</strong>
          <span>{{ t('editor.inspectorTrackContext') }}</span>
        </div>

        <div class="inspector-group__body inspector-group__body--dense">
          <label class="panel-field panel-field--compact">
            <span class="panel-field__label">{{ t('editor.inspectorFieldName') }}</span>
            <n-input
              v-model:value="renameDraft"
              size="small"
              @blur="commitRename"
              @keydown.enter.prevent="commitRename"
            />
          </label>

          <div class="dual-fields dual-fields--stacked">
            <label class="panel-field panel-field--compact">
              <div class="panel-field__split panel-field__split--compact">
                <span class="panel-field__label">{{ t('editor.trackVolume') }}</span>
                <strong>{{ formatTrackVolume(selectedTrack.volume) }}</strong>
              </div>
              <n-slider
                :value="selectedTrack.volume"
                :min="0"
                :max="2"
                :step="0.01"
                :tooltip="false"
                @update:value="(value: number) => selectedTrack && emit('setTrackVolume', selectedTrack.id, value)"
                @dragstart="emit('beginTrackVolume')"
                @dragend="emit('commitTrackVolume')"
              />
            </label>

            <label class="panel-field panel-field--compact">
              <div class="panel-field__split panel-field__split--compact">
                <span class="panel-field__label">{{ t('editor.balance') }}</span>
                <strong>{{ formatTrackPan(selectedTrack.pan) }}</strong>
              </div>
              <n-slider
                :value="selectedTrack.pan"
                :min="-1"
                :max="1"
                :step="0.01"
                :tooltip="false"
                @update:value="(value: number) => selectedTrack && emit('setTrackPan', selectedTrack.id, value)"
                @dragstart="emit('beginTrackPan')"
                @dragend="emit('commitTrackPan')"
              />
            </label>
          </div>
        </div>
      </section>

      <details v-if="selectedTrack" class="inspector-group inspector-group--secondary">
        <summary class="inspector-group__header">
          <strong>{{ t('editor.inspectorSectionAdvanced') }}</strong>
          <span>{{ t('editor.inspectorTrackTuning') }}</span>
        </summary>

        <div class="inspector-group__body inspector-group__body--dense">
          <div class="dual-fields">
            <label class="panel-field panel-field--compact">
              <span class="panel-field__label">{{ t('editor.fieldFadeIn') }}</span>
              <n-input-number
                :value="selectedTrack.fadeIn"
                :min="0"
                :max="fadeMax"
                :step="0.1"
                size="small"
                @update:value="(value: number | null) => selectedTrack && emit('setTrackFades', selectedTrack.id, { fadeIn: numberOrZero(value) })"
              />
            </label>
            <label class="panel-field panel-field--compact">
              <span class="panel-field__label">{{ t('editor.fieldFadeOut') }}</span>
              <n-input-number
                :value="selectedTrack.fadeOut"
                :min="0"
                :max="fadeMax"
                :step="0.1"
                size="small"
                @update:value="(value: number | null) => selectedTrack && emit('setTrackFades', selectedTrack.id, { fadeOut: numberOrZero(value) })"
              />
            </label>
          </div>
        </div>
      </details>

      <div v-if="selectedTrack && selectedSource?.missing" class="source-missing-card">
        <strong>{{ t('editor.assetMissing') }}</strong>
        <span>{{ t('editor.assetMissingHint') }}</span>
        <n-button size="small" type="warning" ghost @click="emit('relinkSource')">
          {{ t('editor.assetRelink') }}
        </n-button>
      </div>

      <details v-if="selectedTrack" class="inspector-group inspector-group--source" :open="Boolean(selectedSource?.missing)">
        <summary class="inspector-group__header">
          <strong>{{ t('editor.inspectorSectionSource') }}</strong>
          <span>{{ t('editor.inspectorSourceContext') }}</span>
        </summary>

        <div class="inspector-group__body inspector-group__body--dense">
          <label class="panel-field panel-field--compact">
            <span class="panel-field__label">{{ t('editor.trackSourcePath') }}</span>
            <n-input :value="selectedSource?.path || '-'" size="small" readonly />
          </label>

          <dl class="stats-grid" :class="{ 'stats-grid--compact': compact }">
            <div class="meta-cell"><dt>{{ t('editor.trackSourceDuration') }}</dt><dd>{{ formatTime(selectedSource?.duration || 0) }}</dd></div>
            <div class="meta-cell"><dt>{{ t('editor.trackSourceChannels') }}</dt><dd>{{ selectedSource?.channels || 0 }}</dd></div>
            <div class="meta-cell"><dt>{{ t('editor.trackSourceSampleRate') }}</dt><dd>{{ selectedSource?.sampleRate || 0 }}</dd></div>
          </dl>
        </div>
      </details>

      <section v-else class="inspector-group inspector-group--project">
        <div class="inspector-group__header">
          <strong>{{ t('editor.projectInfo') }}</strong>
        </div>

        <div class="inspector-group__body">
          <dl class="stats-grid" :class="{ 'stats-grid--compact': compact }">
            <div class="meta-cell"><dt>{{ t('editor.tracks') }}</dt><dd>{{ session.tracks.length }}</dd></div>
            <div class="meta-cell"><dt>{{ t('editor.assets') }}</dt><dd>{{ session.sources.length }}</dd></div>
            <div class="meta-cell"><dt>{{ t('editor.totalDuration') }}</dt><dd>{{ formatTime(duration) }}</dd></div>
          </dl>

          <div v-if="lastExportPath" class="last-export">
            <span class="panel-field__label">{{ t('editor.inspectorSectionExport') }}</span>
            <strong>{{ t('editor.lastExport') }}</strong>
            <span>{{ shortPath(lastExportPath) }}</span>
            <n-button size="small" secondary @click="emit('openLocation')">{{ t('editor.openLocation') }}</n-button>
          </div>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.editor-inspector {
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 0;
  padding: 0;
  border-left: 0;
  background: color-mix(in srgb, var(--surface) 90%, var(--surface-1));
}

.editor-inspector__titlebar {
  display: grid;
  gap: 3px;
  padding: 9px 12px 8px;
  border-bottom: 1px solid var(--outline);
}

.editor-inspector__eyebrow {
  color: var(--on-surface-muted);
  font-size: 9px;
  line-height: 1;
  letter-spacing: 0.08em;
}

.editor-inspector__title {
  display: grid;
  gap: 2px;
}

.editor-inspector__title strong,
.editor-inspector__title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-inspector__title strong {
  font-size: 14px;
  line-height: 1.15;
}

.editor-inspector__title span {
  color: var(--on-surface-muted);
  font-size: 10px;
}

.editor-inspector__scroll {
  min-height: 0;
  overflow: auto;
  display: grid;
  align-content: start;
  gap: 7px;
  padding: 7px 12px 9px;
}

.editor-inspector--compact .editor-inspector__scroll {
  padding-inline: 8px;
}

.inspector-group {
  display: grid;
  gap: 8px;
  padding: 9px 10px 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 94%, var(--surface-1));
}

details.inspector-group {
  gap: 0;
}

details.inspector-group[open] {
  gap: 8px;
}

.inspector-group:first-child {
  border-top: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
}

.inspector-group__header strong {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
}

.inspector-group__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

summary.inspector-group__header {
  min-height: 16px;
  cursor: pointer;
  list-style: none;
}

summary.inspector-group__header::-webkit-details-marker {
  display: none;
}

summary.inspector-group__header::after {
  content: '+';
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1;
}

details.inspector-group[open] > summary.inspector-group__header::after {
  content: '−';
}

.inspector-group__header span {
  color: var(--on-surface-muted);
  font-size: 9px;
  white-space: nowrap;
}

.inspector-group__body {
  display: grid;
  gap: 10px;
}

.inspector-group__body--dense {
  gap: 8px;
}

.panel-field {
  display: grid;
  gap: 4px;
}

.panel-field--compact {
  gap: 3px;
}

.panel-field__label {
  color: var(--on-surface-muted);
  font-size: 11px;
  letter-spacing: 0;
}

.panel-field__split {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.panel-field__split--compact strong {
  text-align: right;
}

.panel-field__split strong {
  font-size: 11px;
  line-height: 1.2;
  color: var(--on-surface);
}

.dual-fields {
  display: flex;
  gap: 8px;
}

.dual-fields--stacked {
  display: grid;
  grid-template-columns: 1fr;
}

.dual-fields > .panel-field {
  flex: 1;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 4px;
  margin: 0;
}

.stats-grid--compact {
  grid-template-columns: 1fr;
}

.meta-cell {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 24%, transparent);
  background: transparent;
}

.meta-cell dt {
  color: var(--on-surface-muted);
  font-size: 11px;
  line-height: 1.1;
}

.meta-cell dd {
  margin: 0;
  font-weight: 600;
  font-size: 12px;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.meta-cell:last-child {
  border-bottom: 0;
}

.last-export {
  display: grid;
  gap: 5px;
  padding: 6px 0 0;
}

.last-export strong {
  font-size: 11px;
}

.last-export span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 10px;
}

.source-missing-card {
  display: grid;
  gap: 5px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--warning) 26%, transparent);
  background: color-mix(in srgb, var(--warning) 8%, transparent);
}

.source-missing-card strong {
  font-size: 12px;
  color: color-mix(in srgb, var(--warning) 84%, var(--on-surface));
}

.source-missing-card span {
  font-size: 11px;
  color: var(--on-surface-muted);
  line-height: 1.5;
}

.editor-inspector :deep(.n-input),
.editor-inspector :deep(.n-input-number),
.editor-inspector :deep(.n-base-selection),
.editor-inspector :deep(.n-slider) {
  --n-color: color-mix(in srgb, var(--surface) 90%, transparent) !important;
}

.editor-inspector :deep(.n-input),
.editor-inspector :deep(.n-input-number .n-input) {
  --n-border: 1px solid color-mix(in srgb, var(--outline) 34%, transparent) !important;
  --n-border-hover: 1px solid color-mix(in srgb, var(--outline) 48%, transparent) !important;
  --n-border-focus: 1px solid color-mix(in srgb, var(--primary) 38%, transparent) !important;
  --n-box-shadow-focus: 0 0 0 2px color-mix(in srgb, var(--primary-soft) 34%, transparent) !important;
}

.editor-inspector :deep(.n-slider-rail),
.editor-inspector :deep(.n-slider-rail__fill) {
  border-radius: 999px;
}

@media (max-width: 1480px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 1360px) {
  .inspector-group {
    padding-inline: 8px;
  }
}
</style>
