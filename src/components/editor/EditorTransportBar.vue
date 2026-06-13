<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowRedoOutline,
  ArrowUndoOutline,
  DownloadOutline,
  StopOutline,
  RefreshOutline,
  RepeatOutline,
  SaveOutline,
  VolumeMediumOutline,
  VolumeMuteOutline,
} from '@vicons/ionicons5'
import { formatTime } from '@/utils/editorTime'
import type { TransportPendingAction, TransportVisualState } from '@/stores/editorPlayback'

const props = defineProps<{
  sessionName: string
  trackCount: number
  currentTime: number
  duration: number
  transportVisualState: TransportVisualState
  transportPendingAction: TransportPendingAction
  transportCanToggle: boolean
  loop: boolean
  masterVolume: number
  masterPan: number
  canUndo: boolean
  canRedo: boolean
  saving: boolean
  exporting: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  reset: []
  toggleTransport: []
  stop: []
  'update:loop': [value: boolean]
  'update:masterVolume': [value: number]
  beginMasterVolume: []
  commitMasterVolume: []
  'update:masterPan': [value: number]
  beginMasterPan: []
  commitMasterPan: []
  undo: []
  redo: []
  save: []
  export: []
}>()

const { t } = useI18n()

const optimisticVisualState = ref<TransportVisualState | null>(null)
const renderedVisualState = computed<TransportVisualState>(() => optimisticVisualState.value || props.transportVisualState)
const showPauseButton = computed(() => renderedVisualState.value === 'pause')
const isStarting = computed(() => props.transportPendingAction === 'starting')
const isPausing = computed(() => props.transportPendingAction === 'pausing')
const transportLabel = computed(() => (showPauseButton.value ? t('common.pause') : t('common.resume')))
const transportPressed = ref(false)
const sessionMeta = computed(() => `${props.trackCount} ${t('editor.tracks')}`)
const timecode = computed(() => `${formatTime(props.currentTime)} / ${formatTime(props.duration)}`)
const volumeIcon = computed(() => props.masterVolume <= 0.01 ? VolumeMuteOutline : VolumeMediumOutline)

function formatTrackPan(value: number) {
  const pan = Number(value || 0)
  if (Math.abs(pan) < 0.025) return t('editor.panCenter')
  const amount = Math.round(Math.abs(pan) * 100)
  return pan < 0 ? `${t('editor.panLeft')} ${amount}` : `${t('editor.panRight')} ${amount}`
}

watch(() => props.transportVisualState, (value) => {
  if (optimisticVisualState.value === value) {
    optimisticVisualState.value = null
    return
  }
  if (props.transportPendingAction === null) {
    optimisticVisualState.value = null
  }
})

function handleTransportPointerDown(event: PointerEvent) {
  if (props.disabled || !props.transportCanToggle || event.button !== 0) return
  transportPressed.value = true
}

function clearTransportPressed() {
  transportPressed.value = false
}
</script>

<template>
  <header class="editor-transport">
    <div class="editor-transport__brand">
      <strong>{{ sessionName }}</strong>
      <span class="editor-transport__brand-meta">{{ sessionMeta }}</span>
    </div>

    <div class="editor-transport__center">
      <div class="transport-controls">
        <button
          class="transport-chip"
          type="button"
          :title="t('common.undo')"
          :aria-label="t('common.undo')"
          :disabled="disabled || !canUndo"
          @click="emit('undo')"
        >
          <span class="sr-only">{{ t('common.undo') }}</span>
          <n-icon :component="ArrowUndoOutline" />
        </button>
        <button
          class="transport-chip"
          type="button"
          :title="t('common.redo')"
          :aria-label="t('common.redo')"
          :disabled="disabled || !canRedo"
          @click="emit('redo')"
        >
          <span class="sr-only">{{ t('common.redo') }}</span>
          <n-icon :component="ArrowRedoOutline" />
        </button>
        <button
          class="transport-play"
          type="button"
          :disabled="disabled || !transportCanToggle"
          :data-state="showPauseButton ? 'pause' : 'play'"
          :data-pending="transportPendingAction || undefined"
          :data-pressed="transportPressed ? 'true' : undefined"
          :aria-label="transportLabel"
          :title="transportLabel"
          @pointerdown="handleTransportPointerDown"
          @pointerup="clearTransportPressed"
          @pointercancel="clearTransportPressed"
          @pointerleave="clearTransportPressed"
          @blur="clearTransportPressed"
          @click="emit('toggleTransport')"
        >
          <svg v-if="showPauseButton" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1.2" />
            <rect x="14" y="5" width="4" height="14" rx="1.2" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13l10-6.5z" />
          </svg>
        </button>
        <button
          class="transport-chip"
          type="button"
          :title="t('common.stop')"
          :aria-label="t('common.stop')"
          :disabled="disabled"
          @click="emit('stop')"
        >
          <n-icon :component="StopOutline" />
        </button>
        <button
          class="transport-chip"
          type="button"
          :title="t('common.reset')"
          :aria-label="t('common.reset')"
          :disabled="disabled"
          @click="emit('reset')"
        >
          <n-icon :component="RefreshOutline" />
        </button>
        <button
          class="transport-chip"
          type="button"
          :class="{ 'transport-chip--active': loop }"
          :title="t('common.loop')"
          :aria-label="t('common.loop')"
          :aria-pressed="loop"
          :disabled="disabled"
          @click="emit('update:loop', !loop)"
        >
          <n-icon :component="RepeatOutline" />
        </button>
      </div>

      <div class="transport-timecode">
        <code>{{ timecode }}</code>
      </div>
    </div>

    <div class="editor-transport__actions">
      <div class="master-strip">
        <div class="master-strip__row">
          <span class="master-strip__label">{{ t('editor.masterVolume') }}</span>
          <div class="master-strip__control">
            <n-icon :component="volumeIcon" />
            <n-slider
              :value="masterVolume"
              :min="0"
              :max="2"
              :step="0.01"
              :tooltip="false"
              :disabled="disabled"
              @update:value="(value: number) => emit('update:masterVolume', value)"
              @dragstart="emit('beginMasterVolume')"
              @dragend="emit('commitMasterVolume')"
            />
          </div>
        </div>
        <div class="master-strip__row">
          <span class="master-strip__label">{{ t('editor.balanceShort') }}</span>
          <div class="master-strip__pan">
            <span class="master-strip__pan-value">{{ formatTrackPan(masterPan) }}</span>
            <n-slider
              :value="masterPan"
              :min="-1"
              :max="1"
              :step="0.01"
              :tooltip="false"
              :disabled="disabled"
              @update:value="(value: number) => emit('update:masterPan', value)"
              @dragstart="emit('beginMasterPan')"
              @dragend="emit('commitMasterPan')"
            />
          </div>
        </div>
      </div>
      <n-button secondary size="small" :loading="saving" :disabled="disabled" @click="emit('save')">
        <template #icon><n-icon :component="SaveOutline" /></template>
        {{ t('editor.save') }}
      </n-button>
      <n-button type="primary" size="small" :loading="exporting" :disabled="disabled" @click="emit('export')">
        <template #icon><n-icon :component="DownloadOutline" /></template>
        {{ t('editor.export') }}
      </n-button>
    </div>
  </header>
</template>

<style scoped>
.editor-transport {
  display: grid;
  grid-template-columns: 220px minmax(340px, 1fr) 360px;
  align-items: center;
  gap: 14px;
  height: 46px;
  padding: 0 14px;
  border-bottom: 1px solid var(--outline);
  background: var(--surface);
}

.editor-transport__brand,
.editor-transport__center,
.editor-transport__actions {
  min-width: 0;
}

.editor-transport__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.editor-transport__brand strong,
.editor-transport__brand-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-transport__brand strong {
  font-size: 13px;
  font-weight: 600;
}

.editor-transport__brand-meta {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--outline) 44%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-2) 80%, transparent);
  color: var(--on-surface-muted);
  font-size: 10px;
}

.editor-transport__center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-width: 0;
}

.transport-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.transport-chip,
.transport-play {
  border: 0;
  cursor: pointer;
}

.transport-chip {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--on-surface-muted);
  background: transparent;
  transition: color 140ms ease, background 140ms ease;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.transport-chip:not(:disabled):hover {
  color: var(--on-surface);
  background: var(--surface-2);
}

.transport-chip:disabled {
  opacity: 0.4;
  cursor: default;
}

.transport-chip--active {
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.transport-play {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  position: relative;
  border-radius: 8px;
  color: #fff;
  background: var(--primary);
  box-shadow: none;
  padding: 0;
  transition: transform 140ms ease, background 140ms ease, opacity 140ms ease;
}

.transport-play:not(:disabled):hover {
  transform: translateY(-1px);
  background: color-mix(in srgb, var(--primary) 88%, white);
}

.transport-play[data-pressed='true'] {
  transform: translateY(0) scale(0.97);
}

.transport-play:disabled {
  cursor: default;
}

.transport-play[data-pending='starting'] svg {
  transform: scale(0.94);
}

.transport-play[data-pending='pausing'] svg {
  transform: scale(0.88);
  opacity: 0.92;
}

.transport-play svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
  transition: transform 160ms ease, opacity 140ms ease;
}

.transport-timecode {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.transport-timecode code {
  padding: 4px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-2) 88%, transparent);
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
  font-family: 'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.editor-transport__actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.master-strip {
  min-width: 180px;
  display: grid;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--outline) 44%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-2) 72%, transparent);
}

.master-strip__row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.master-strip__label {
  color: var(--on-surface-muted);
  font-size: 10px;
  white-space: nowrap;
}

.master-strip__control,
.master-strip__pan {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.master-strip__pan {
  gap: 8px;
}

.master-strip__pan-value {
  width: 34px;
  flex-shrink: 0;
  color: var(--on-surface-muted);
  font-size: 10px;
  text-align: right;
}

@media (max-width: 1280px) {
  .editor-transport {
    grid-template-columns: 1fr;
    height: auto;
    padding-block: 8px;
  }

  .editor-transport__center,
  .editor-transport__actions {
    justify-content: flex-start;
  }

  .editor-transport__actions {
    flex-wrap: wrap;
  }
}
</style>
