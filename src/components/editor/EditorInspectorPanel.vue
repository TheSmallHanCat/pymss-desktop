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
      <section v-if="selectedTrack" class="inspector-group">
        <div class="inspector-group__header">
          <strong>{{ t('editor.inspectorSectionCommon') }}</strong>
        </div>

        <div class="inspector-group__body">
          <label class="panel-field">
            <span class="panel-field__label">{{ t('editor.inspectorFieldName') }}</span>
            <n-input
              v-model:value="renameDraft"
              size="small"
              @blur="commitRename"
              @keydown.enter.prevent="commitRename"
            />
          </label>

          <label class="panel-field">
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

          <label class="panel-field">
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
      </section>

      <section v-if="selectedTrack" class="inspector-group">
        <div class="inspector-group__header">
          <strong>{{ t('editor.inspectorSectionAdvanced') }}</strong>
        </div>

        <div class="inspector-group__body">
          <div class="dual-fields">
            <label class="panel-field">
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
            <label class="panel-field">
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
      </section>

      <section v-if="selectedTrack" class="inspector-group">
        <div class="inspector-group__header">
          <strong>{{ t('editor.inspectorSectionSource') }}</strong>
        </div>

        <div class="inspector-group__body">
          <label class="panel-field">
            <span class="panel-field__label">{{ t('editor.trackSourcePath') }}</span>
            <n-input :value="selectedSource?.path || '-'" size="small" readonly />
          </label>

          <dl class="stats-grid" :class="{ 'stats-grid--compact': compact }">
            <div class="meta-cell"><dt>{{ t('editor.trackSourceDuration') }}</dt><dd>{{ formatTime(selectedSource?.duration || 0) }}</dd></div>
            <div class="meta-cell"><dt>{{ t('editor.trackSourceChannels') }}</dt><dd>{{ selectedSource?.channels || 0 }}</dd></div>
            <div class="meta-cell"><dt>{{ t('editor.trackSourceSampleRate') }}</dt><dd>{{ selectedSource?.sampleRate || 0 }}</dd></div>
          </dl>
        </div>
      </section>

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
  padding: 10px 12px 9px;
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
  gap: 0;
  padding: 0 12px 10px;
}

.editor-inspector--compact .editor-inspector__scroll {
  padding-inline: 8px;
}

.inspector-group {
  display: grid;
  gap: 7px;
  padding: 9px 0 10px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 60%, transparent);
}

.inspector-group:first-child {
  border-top: 0;
}

.inspector-group__header strong {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
}

.inspector-group__body {
  display: grid;
  gap: 8px;
}

.panel-field {
  display: grid;
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
  gap: 6px;
}

.dual-fields > .panel-field {
  flex: 1;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
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
  padding: 3px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 28%, transparent);
  border-radius: 0;
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
  gap: 4px;
  padding-top: 2px;
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
</style>
