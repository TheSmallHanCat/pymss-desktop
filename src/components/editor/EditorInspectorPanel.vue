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
}>()

const emit = defineEmits<{
  renameTrack: [trackId: string, name: string, commit?: boolean]
  toggleTrackFlag: [trackId: string, flag: 'muted' | 'solo']
  setTrackVolume: [trackId: string, value: number]
  beginTrackVolume: []
  commitTrackVolume: []
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
</script>

<template>
  <aside class="editor-inspector">
    <div class="editor-inspector__titlebar">
      <div class="editor-inspector__eyebrow">{{ t('editor.inspectorTitle') }}</div>
      <div class="editor-inspector__title">
        <strong>{{ selectedTrack ? selectedTrack.name : t('editor.projectInfo') }}</strong>
        <span>{{ selectedTrack ? t('editor.inspectorCompactHint') : t('editor.clipParamsIdle') }}</span>
      </div>
    </div>

    <div class="editor-inspector__scroll">
      <section v-if="selectedTrack" class="panel panel--track">
        <label class="panel-field">
          <span class="panel-field__label">{{ t('editor.inspectorFieldName') }}</span>
          <n-input
            v-model:value="renameDraft"
            size="small"
            @blur="commitRename"
            @keydown.enter.prevent="commitRename"
          />
        </label>

        <div class="track-strip">
          <div class="track-strip__flags">
            <button
              type="button"
              class="toggle-square"
              :class="{ 'toggle-square--active toggle-square--warning': selectedTrack!.muted }"
              @click="emit('toggleTrackFlag', selectedTrack!.id, 'muted')"
            >
              <span>M</span>
              <small>{{ t(selectedTrack!.muted ? 'editor.menuUnmuteTrack' : 'editor.menuToggleMute') }}</small>
            </button>
            <button
              type="button"
              class="toggle-square"
              :class="{ 'toggle-square--active': selectedTrack!.solo }"
              @click="emit('toggleTrackFlag', selectedTrack!.id, 'solo')"
            >
              <span>S</span>
              <small>{{ t(selectedTrack!.solo ? 'editor.menuUnsoloTrack' : 'editor.menuToggleSolo') }}</small>
            </button>
          </div>

          <label class="panel-field">
            <div class="panel-field__split panel-field__split--compact">
              <span class="panel-field__label">{{ t('editor.trackVolume') }}</span>
              <strong>{{ formatTrackVolume(selectedTrack!.volume) }}</strong>
            </div>
            <n-slider
              :value="selectedTrack!.volume"
              :min="0"
              :max="2"
              :step="0.01"
              :tooltip="false"
              @update:value="(value: number) => emit('setTrackVolume', selectedTrack!.id, value)"
              @dragstart="emit('beginTrackVolume')"
              @dragend="emit('commitTrackVolume')"
            />
          </label>

          <div class="dual-fields dual-fields--compact">
            <label class="panel-field">
              <span class="panel-field__label">{{ t('editor.fieldFadeIn') }}</span>
              <n-input-number
                :value="selectedTrack!.fadeIn"
                :min="0"
                :max="selectedSource?.duration || 0"
                :step="0.1"
                size="small"
                @update:value="(value: number | null) => selectedTrack && emit('setTrackFades', selectedTrack!.id, { fadeIn: numberOrZero(value) })"
              />
            </label>
            <label class="panel-field">
              <span class="panel-field__label">{{ t('editor.fieldFadeOut') }}</span>
              <n-input-number
                :value="selectedTrack!.fadeOut"
                :min="0"
                :max="selectedSource?.duration || 0"
                :step="0.1"
                size="small"
                @update:value="(value: number | null) => selectedTrack && emit('setTrackFades', selectedTrack!.id, { fadeOut: numberOrZero(value) })"
              />
            </label>
          </div>
        </div>
      </section>

      <section v-if="selectedTrack" class="panel panel--source panel--compact">
        <div class="panel__header">
          <strong>{{ t('editor.inspectorSectionSource') }}</strong>
        </div>

        <label class="panel-field">
          <span class="panel-field__label">{{ t('editor.trackSourcePath') }}</span>
          <n-input :value="selectedSource?.path || '-'" size="small" readonly />
        </label>

        <div class="meta-grid">
          <div class="meta-cell">
            <span>{{ t('editor.trackSourceDuration') }}</span>
            <strong>{{ formatTime(selectedSource?.duration || 0) }}</strong>
          </div>
          <div class="meta-cell">
            <span>{{ t('editor.trackSourceChannels') }}</span>
            <strong>{{ selectedSource?.channels || 0 }}</strong>
          </div>
          <div class="meta-cell">
            <span>{{ t('editor.trackSourceSampleRate') }}</span>
            <strong>{{ selectedSource?.sampleRate || 0 }}</strong>
          </div>
        </div>
      </section>

      <section v-if="!selectedTrack" class="panel panel--project stats">
        <div class="panel__header">
          <strong>{{ t('editor.projectInfo') }}</strong>
        </div>

        <dl class="stats-grid">
          <div class="meta-cell"><dt>{{ t('editor.tracks') }}</dt><dd>{{ session.tracks.length }}</dd></div>
          <div class="meta-cell"><dt>{{ t('editor.assets') }}</dt><dd>{{ session.sources.length }}</dd></div>
          <div class="meta-cell"><dt>{{ t('editor.totalDuration') }}</dt><dd>{{ formatTime(duration) }}</dd></div>
        </dl>

        <div v-if="lastExportPath" class="last-export">
          <span class="panel__eyebrow">{{ t('editor.inspectorSectionExport') }}</span>
          <strong>{{ t('editor.lastExport') }}</strong>
          <span>{{ shortPath(lastExportPath) }}</span>
          <n-button size="small" secondary @click="emit('openLocation')">{{ t('editor.openLocation') }}</n-button>
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
  gap: 8px;
  padding: 8px 8px 10px;
  border-left: 1px solid color-mix(in srgb, var(--outline) 58%, transparent);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--surface) 99%, transparent), color-mix(in srgb, var(--surface-1) 94%, transparent));
}

.editor-inspector__titlebar {
  display: grid;
  gap: 4px;
  padding: 2px 4px 0;
}

.editor-inspector__eyebrow,
.panel__eyebrow {
  color: color-mix(in srgb, var(--on-surface-muted) 88%, #8da2bc);
  font-size: 9px;
  line-height: 1;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.editor-inspector__title {
  display: grid;
  gap: 2px;
}

.editor-inspector__title strong {
  font-size: 16px;
  line-height: 1.15;
}

.editor-inspector__title span {
  color: var(--on-surface-muted);
  font-size: 10px;
  opacity: 0.82;
}

.editor-inspector__scroll {
  min-height: 0;
  overflow: auto;
  display: grid;
  align-content: start;
  gap: 8px;
}

.panel {
  display: grid;
  gap: 10px;
  padding: 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 34%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 34%, transparent),
    0 6px 18px rgba(7, 11, 18, 0.04);
}

.panel--compact {
  gap: 8px;
}

.panel__header {
  display: grid;
  gap: 2px;
}

.panel__header strong {
  font-size: 12px;
  line-height: 1.1;
}

.panel__hint {
  color: var(--on-surface-muted);
  font-size: 10px;
  line-height: 1.45;
}

.panel-field {
  display: grid;
  gap: 4px;
}

.panel-field__label {
  color: var(--on-surface-muted);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
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
}

.track-strip {
  display: grid;
  gap: 8px;
  padding: 8px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface) 76%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 28%, transparent);
}

.track-strip__flags {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.toggle-square {
  min-width: 0;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 0;
  border-radius: 10px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-2) 54%, transparent);
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}

.toggle-square:hover {
  color: var(--on-surface);
  transform: translateY(-1px);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 28%, transparent);
}

.toggle-square span {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  font-size: 11px;
  font-weight: 600;
}

.toggle-square small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  text-align: left;
}

.toggle-square--active {
  color: #fff;
  background: color-mix(in srgb, var(--primary) 70%, #24365a);
}

.toggle-square--active span {
  background: rgba(255, 255, 255, 0.12);
}

.toggle-square--warning {
  background: color-mix(in srgb, var(--warning) 70%, #3b241d);
}

.dual-fields {
  display: flex;
  gap: 6px;
}

.dual-fields--compact {
  align-items: start;
}

.dual-fields > .panel-field {
  flex: 1;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.meta-cell {
  display: grid;
  gap: 3px;
  padding: 7px 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 26%, transparent);
}

.meta-cell span,
.meta-cell dt {
  color: var(--on-surface-muted);
  font-size: 10px;
  line-height: 1.1;
}

.meta-cell strong,
.meta-cell dd {
  font-size: 12px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
}

.stats-grid dd {
  margin: 0;
  font-weight: 600;
  font-size: 13px;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.last-export {
  display: grid;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 46%, transparent);
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

  .meta-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 1360px) {
  .track-strip__flags {
    grid-template-columns: 1fr;
  }
}
</style>
