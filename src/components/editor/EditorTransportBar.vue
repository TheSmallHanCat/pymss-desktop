<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowRedoOutline,
  ArrowUndoOutline,
  DownloadOutline,
  RefreshOutline,
  RepeatOutline,
  SaveOutline,
  VolumeMediumOutline,
  VolumeMuteOutline,
} from '@vicons/ionicons5'
import { formatTime } from '@/utils/editorTime'
import type { TransportPendingAction, TransportVisualState } from '@/stores/editorPlayback'
import AppBrandMark from '@/components/AppBrandMark.vue'

const props = defineProps<{
  sessionName: string
  sessionHint: string
  trackCount: number
  currentTime: number
  duration: number
  transportVisualState: TransportVisualState
  transportPendingAction: TransportPendingAction
  transportCanToggle: boolean
  loop: boolean
  masterVolume: number
  saving: boolean
  exporting: boolean
  canUndo: boolean
  canRedo: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  reset: []
  toggleTransport: []
  'update:loop': [value: boolean]
  'update:masterVolume': [value: number]
  beginMasterVolume: []
  commitMasterVolume: []
  undo: []
  redo: []
  save: []
  export: []
}>()

const { t } = useI18n()

const volumeIcon = computed(() => props.masterVolume <= 0.01 ? VolumeMuteOutline : VolumeMediumOutline)
const optimisticVisualState = ref<TransportVisualState | null>(null)
const renderedVisualState = computed<TransportVisualState>(() => optimisticVisualState.value || props.transportVisualState)
const showPauseButton = computed(() => renderedVisualState.value === 'pause')
const isStarting = computed(() => props.transportPendingAction === 'starting')
const isPausing = computed(() => props.transportPendingAction === 'pausing')
const transportLabel = computed(() => (showPauseButton.value ? t('common.pause') : t('common.resume')))
const transportPressed = ref(false)

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

function handleTransportClick() {
  if (props.disabled || !props.transportCanToggle) return
  optimisticVisualState.value = showPauseButton.value ? 'play' : 'pause'
  emit('toggleTransport')
}
</script>

<template>
  <header class="editor-transport">
    <div class="editor-transport__brand">
      <AppBrandMark :size="34" shadow />
      <div class="brand-copy">
        <strong>{{ sessionName }}</strong>
        <span>{{ sessionHint }}</span>
      </div>
    </div>

    <div class="editor-transport__center">
      <div class="transport-controls">
        <button class="transport-chip" type="button" :disabled="disabled" @click="emit('undo')">
          <n-icon :component="ArrowUndoOutline" />
        </button>
        <button class="transport-chip" type="button" :disabled="disabled" @click="emit('redo')">
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
          @click="handleTransportClick"
        >
          <svg v-if="showPauseButton" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1.2" />
            <rect x="14" y="5" width="4" height="14" rx="1.2" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13l10-6.5z" />
          </svg>
          <span v-if="isStarting" class="transport-play__ring" aria-hidden="true" />
          <span v-if="isPausing" class="transport-play__pulse" aria-hidden="true" />
        </button>
        <button class="transport-chip" type="button" :disabled="disabled" @click="emit('reset')">
          <n-icon :component="RefreshOutline" />
        </button>
        <button class="transport-chip" type="button" :class="{ 'transport-chip--active': loop }" :disabled="disabled" @click="emit('update:loop', !loop)">
          <n-icon :component="RepeatOutline" />
        </button>
      </div>

    </div>

    <div class="editor-transport__actions">
      <div class="master-strip">
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
  grid-template-columns: minmax(220px, 1fr) auto minmax(320px, 1fr);
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--outline);
  background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent 70%), var(--surface-1);
}

.editor-transport__brand,
.editor-transport__actions,
.editor-transport__center {
  min-width: 0;
}

.editor-transport__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-mark {
  width: 34px;
  height: 34px;
}

.brand-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.brand-copy strong,
.brand-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brand-copy strong {
  font-size: 15px;
}

.brand-copy span {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.editor-transport__center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.transport-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.transport-chip,
.transport-play {
  border: 0;
  cursor: pointer;
}

.transport-chip {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: var(--on-surface-muted);
  background: var(--surface-2);
}

.transport-chip--active {
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.transport-play {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  position: relative;
  border-radius: 14px;
  color: #fff;
  background: linear-gradient(135deg, #ff7b54, #f2b45a);
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.18);
  padding: 0;
  transition: transform 140ms ease, box-shadow 160ms ease, opacity 140ms ease;
}

.transport-play:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 16px 30px rgba(0, 0, 0, 0.22);
}

.transport-play[data-pressed='true'] {
  transform: translateY(0) scale(0.96);
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.2);
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
  width: 22px;
  height: 22px;
  fill: currentColor;
  transition: transform 160ms ease, opacity 140ms ease;
}

.transport-play__ring,
.transport-play__pulse {
  position: absolute;
  inset: 6px;
  border-radius: inherit;
  pointer-events: none;
}

.transport-play__ring {
  border: 2px solid rgba(255,255,255,0.22);
  border-top-color: rgba(255,255,255,0.94);
  animation: transport-spin 0.9s linear infinite, transport-breathe 1.1s ease-in-out infinite;
}

.transport-play__pulse {
  border: 2px solid rgba(255,255,255,0.28);
  animation: transport-fade-pulse 220ms ease-out;
}

@keyframes transport-spin {
  to { transform: rotate(360deg); }
}

@keyframes transport-breathe {
  0%, 100% { opacity: 0.48; }
  50% { opacity: 1; }
}

@keyframes transport-fade-pulse {
  from {
    opacity: 0.72;
    transform: scale(0.84);
  }
  to {
    opacity: 0;
    transform: scale(1.1);
  }
}

.transport-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255,255,255,0.34);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.editor-transport__actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
}

.master-strip {
  width: 144px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 14px;
  background: var(--surface-2);
}

@media (max-width: 1200px) {
  .editor-transport {
    grid-template-columns: 1fr;
  }

  .editor-transport__center {
    justify-content: flex-start;
  }

  .transport-controls {
    flex-wrap: wrap;
  }

  .editor-transport__actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}
</style>
