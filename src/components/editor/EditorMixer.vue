<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AddOutline, EllipsisHorizontal, RemoveOutline, ScanOutline } from '@vicons/ionicons5'
import type { DropdownOption } from 'naive-ui'
import type { EditorSource, EditorTrack } from '@/types/editor'
import EditorWaveform from '@/components/editor/EditorWaveform.vue'
import { formatTime, formatTimecode } from '@/utils/editorTime'

const props = defineProps<{
  tracks: EditorTrack[]
  sourceMap: Map<string, EditorSource>
  selectedTrackId: string | null
  currentTime: number
  duration: number
  pixelsPerSecond: number
}>()

const emit = defineEmits<{
  selectTrack: [trackId: string]
  toggleMute: [trackId: string]
  toggleSolo: [trackId: string]
  seek: [time: number]
  removeTrack: [trackId: string]
  revealTrack: [trackId: string]
  contextMute: [trackId: string]
  contextSolo: [trackId: string]
  zoomIn: []
  zoomOut: []
  zoomFit: []
  zoomAt: [payload: { direction: 'in' | 'out'; anchorRatio: number }]
  'scroll-ready': [element: HTMLElement]
  addTrackFromAsset: [sourceId: string]
}>()

const { t } = useI18n()
const HEADER_WIDTH = 184
const scrollEl = ref<HTMLElement | null>(null)
const overviewBarEl = ref<HTMLElement | null>(null)
const scrubbingOverview = ref(false)

watch(
  () => scrollEl.value,
  (value) => {
    if (value) emit('scroll-ready', value)
  },
  { immediate: true },
)

const laneWidth = computed(() => Math.max(640, props.duration * props.pixelsPerSecond))
const playheadLeft = computed(() => HEADER_WIDTH + Math.max(0, props.currentTime * props.pixelsPerSecond))
const hasSolo = computed(() => props.tracks.some((track) => track.solo))
const progressRatio = computed(() => {
  if (props.duration <= 0) return 0
  return Math.max(0, Math.min(1, props.currentTime / props.duration))
})
const dropTargetTrackId = ref<string | null>(null)
const fallbackDropSourceId = ref<string | null>(null)
const showTrackMenu = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const contextTrack = ref<EditorTrack | null>(null)
const mixerRootEl = ref<HTMLElement | null>(null)

const trackMenuOptions = computed<DropdownOption[]>(() => {
  const track = contextTrack.value
  if (!track) return []
  return [
    {
      key: 'reveal',
      label: t('editor.menuRevealAsset'),
    },
    {
      key: 'remove',
      label: t('editor.removeTrack'),
    },
  ]
})

const rulerTicks = computed(() => {
  const total = props.duration
  if (total <= 0) return []
  const targetPx = 100
  const rawStep = targetPx / props.pixelsPerSecond
  const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300]
  const step = niceSteps.find((item) => item >= rawStep) || niceSteps[niceSteps.length - 1]
  const ticks: { time: number; left: number }[] = []
  for (let time = 0; time <= total; time += step) {
    ticks.push({ time, left: time * props.pixelsPerSecond })
  }
  if (!ticks.length || ticks[ticks.length - 1].time < total) {
    ticks.push({ time: total, left: total * props.pixelsPerSecond })
  }
  return ticks
})

function sourceFor(track: EditorTrack) {
  return props.sourceMap.get(track.sourceId) || null
}

function rowClass(track: EditorTrack) {
  return {
    'track-row--selected': track.id === props.selectedTrackId,
    'track-row--dimmed': track.muted || (hasSolo.value && !track.solo),
  }
}

function seekFromEvent(event: MouseEvent) {
  const element = event.currentTarget as HTMLElement
  const rect = element.getBoundingClientRect()
  const x = event.clientX - rect.left + element.scrollLeft
  emit('seek', Math.max(0, Math.min(props.duration, x / props.pixelsPerSecond)))
}

function seekOverviewFromClientX(clientX: number) {
  const element = overviewBarEl.value
  if (!element || props.duration <= 0) return
  const rect = element.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)))
  emit('seek', ratio * props.duration)
}

function handleOverviewPointerMove(event: PointerEvent) {
  if (!scrubbingOverview.value) return
  seekOverviewFromClientX(event.clientX)
}

function stopOverviewScrub() {
  if (!scrubbingOverview.value) return
  scrubbingOverview.value = false
  window.removeEventListener('pointermove', handleOverviewPointerMove)
  window.removeEventListener('pointerup', stopOverviewScrub)
  window.removeEventListener('pointercancel', stopOverviewScrub)
}

function handleOverviewPointerDown(event: PointerEvent) {
  if (props.duration <= 0 || event.button !== 0) return
  scrubbingOverview.value = true
  seekOverviewFromClientX(event.clientX)
  window.addEventListener('pointermove', handleOverviewPointerMove)
  window.addEventListener('pointerup', stopOverviewScrub)
  window.addEventListener('pointercancel', stopOverviewScrub)
}

function handleTimelineWheel(event: WheelEvent) {
  const element = scrollEl.value
  if (!element) return

  if (event.ctrlKey || event.metaKey) {
    if (event.cancelable) event.preventDefault()
    const rect = element.getBoundingClientRect()
    const anchorRatio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, element.clientWidth)))
    emit('zoomAt', { direction: event.deltaY < 0 ? 'in' : 'out', anchorRatio })
    return
  }

  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
  if (!delta) return

  if (event.cancelable) event.preventDefault()
  element.scrollLeft += delta
}

function allowAssetDrop(trackId?: string | null) {
  if (!fallbackDropSourceId.value) return
  dropTargetTrackId.value = trackId || null
}

function clearAssetDrop() {
  dropTargetTrackId.value = null
}

function commitAssetDrop() {
  const sourceId = fallbackDropSourceId.value
  clearAssetDrop()
  if (!sourceId) return
  emit('addTrackFromAsset', sourceId)
}

function setDraggingAssetSourceId(sourceId: string | null) {
  fallbackDropSourceId.value = sourceId
}

function setDropTargetTrackId(trackId: string | null) {
  if (!fallbackDropSourceId.value) {
    dropTargetTrackId.value = null
    return
  }
  dropTargetTrackId.value = trackId
}

function containsPoint(x: number, y: number) {
  const root = mixerRootEl.value
  if (!root) return false
  const rect = root.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function openTrackContextMenu(event: MouseEvent, track: EditorTrack) {
  emit('selectTrack', track.id)
  contextTrack.value = track
  showTrackMenu.value = false
  menuX.value = event.clientX
  menuY.value = event.clientY
  window.requestAnimationFrame(() => {
    showTrackMenu.value = true
  })
}

function handleTrackMenuSelect(key: string | number) {
  const track = contextTrack.value
  showTrackMenu.value = false
  if (!track) return

  if (key === 'reveal') emit('revealTrack', track.id)
  if (key === 'remove') emit('removeTrack', track.id)
}

onBeforeUnmount(() => {
  stopOverviewScrub()
})

defineExpose({
  setDraggingAssetSourceId,
  setDropTargetTrackId,
  containsPoint,
  commitAssetDrop,
})
</script>

<template>
  <section ref="mixerRootEl" class="editor-mixer">
    <div class="editor-mixer__toolbar">
      <div class="toolbar-copy">
        <strong>{{ t('editor.tracks') }} {{ tracks.length }}</strong>
        <button
          class="toolbar-help"
          type="button"
          :title="fallbackDropSourceId ? t('editor.dropCreatesTrack') : t('editor.wheelHint')"
          :aria-label="fallbackDropSourceId ? t('editor.dropCreatesTrack') : t('editor.wheelHint')"
        >
          ?
        </button>
      </div>

      <div class="toolbar-overview">
        <div
          ref="overviewBarEl"
          class="toolbar-overview__bar"
          :class="{ 'toolbar-overview__bar--disabled': duration <= 0 }"
          @pointerdown.prevent="handleOverviewPointerDown"
        >
          <span class="toolbar-overview__rail" />
          <span class="toolbar-overview__fill" :style="{ transform: `scaleX(${progressRatio})` }" />
          <span class="toolbar-overview__playhead" :style="{ left: `calc(${progressRatio * 100}% - 6px)` }" />
        </div>
      </div>

      <div class="toolbar-meta">
        <code>{{ formatTime(currentTime) }}</code>
        <span>/</span>
        <code>{{ formatTime(duration) }}</code>
      </div>

      <div class="toolbar-actions">
        <button class="toolbar-icon-button" type="button" :title="t('editor.zoomOut')" :aria-label="t('editor.zoomOut')" @click="emit('zoomOut')">
          <n-icon :component="RemoveOutline" />
        </button>
        <button class="toolbar-icon-button" type="button" :title="t('editor.zoomFit')" :aria-label="t('editor.zoomFit')" @click="emit('zoomFit')">
          <n-icon :component="ScanOutline" />
        </button>
        <button class="toolbar-icon-button" type="button" :title="t('editor.zoomIn')" :aria-label="t('editor.zoomIn')" @click="emit('zoomIn')">
          <n-icon :component="AddOutline" />
        </button>
      </div>
    </div>

    <div
      ref="scrollEl"
      class="editor-mixer__scroll"
      :style="{ '--lane-width': `${laneWidth}px` }"
      @wheel="handleTimelineWheel"
    >
      <div class="ruler">
        <div class="ruler__head" />
        <div class="ruler__track" :style="{ width: `${laneWidth}px` }" @click="seekFromEvent">
          <span v-for="tick in rulerTicks" :key="tick.time" class="ruler-tick" :style="{ transform: `translateX(${tick.left}px)` }">
            {{ formatTimecode(tick.time) }}
          </span>
        </div>
      </div>

      <div v-if="tracks.length" class="tracks">
        <div
          v-for="track in tracks"
          :key="track.id"
          class="track-row"
          :data-track-id="track.id"
          :class="rowClass(track)"
          @mousedown="emit('selectTrack', track.id)"
          @contextmenu.stop.prevent="openTrackContextMenu($event, track)"
          @mouseenter="allowAssetDrop(track.id)"
        >
          <div class="track-row__head">
            <div class="track-row__title">
              <span class="track-dot" :style="{ background: track.color || '#7aa2ff' }" />
              <div>
                <strong>{{ track.name }}</strong>
                <small>{{ sourceFor(track)?.name || '-' }}</small>
              </div>
            </div>
            <div class="track-row__buttons">
              <button class="chip" type="button" :class="{ 'chip--active chip--warning': track.muted }" @click.stop="emit('toggleMute', track.id)">M</button>
              <button class="chip" type="button" :class="{ 'chip--active': track.solo }" @click.stop="emit('toggleSolo', track.id)">S</button>
              <button class="chip chip--icon" type="button" @click.stop="openTrackContextMenu($event, track)"><n-icon :component="EllipsisHorizontal" /></button>
            </div>
          </div>

          <div class="track-row__lane" @click="seekFromEvent">
            <div class="track-wave" :style="{ width: `${laneWidth}px` }">
              <div class="track-wave__clip">
                <EditorWaveform
                  v-if="sourceFor(track)"
                  :peaks="sourceFor(track)?.peaks || []"
                  :asset-duration="sourceFor(track)?.duration || 0"
                  :duration="sourceFor(track)?.duration || 0"
                  :width="Math.max(1, (sourceFor(track)?.duration || 0) * pixelsPerSecond)"
                  :height="64"
                  :fade-in="track.fadeIn"
                  :fade-out="track.fadeOut"
                  :color="track.color || '#7aa2ff'"
                />
                <div v-else class="track-wave__empty">{{ t('editor.laneNoAudio') }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        v-else
        class="empty-state"
        :class="{ 'empty-state--drop-target': dropTargetTrackId === '__empty__' || Boolean(fallbackDropSourceId) }"
        @mouseenter="allowAssetDrop('__empty__')"
      >
        <strong>{{ t('editor.emptyTimeline') }}</strong>
        <span>{{ t('editor.emptyTimelineHint') }}</span>
      </div>

      <div v-if="fallbackDropSourceId && tracks.length" class="drop-new-track">
        {{ t('editor.dropCreatesTrack') }}
      </div>

      <span class="global-playhead" :style="{ transform: `translateX(${playheadLeft}px)` }" />
    </div>

    <n-dropdown
      placement="bottom-start"
      trigger="manual"
      :x="menuX"
      :y="menuY"
      :options="trackMenuOptions"
      :show="showTrackMenu"
      @clickoutside="showTrackMenu = false"
      @select="handleTrackMenuSelect"
    />
  </section>
</template>

<style scoped>
.editor-mixer {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--surface);
}

.editor-mixer__toolbar {
  display: grid;
  grid-template-columns: auto minmax(280px, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--outline);
  background: var(--surface-1);
}

.toolbar-copy {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-copy strong {
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
}

.toolbar-help {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-2) 90%, transparent);
  cursor: help;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

.toolbar-help:hover {
  color: var(--on-surface);
}

.toolbar-actions {
  display: flex;
  gap: 4px;
}

.toolbar-overview {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.toolbar-overview__bar {
  position: relative;
  width: min(100%, 960px);
  height: 10px;
  border-radius: 999px;
  cursor: pointer;
  overflow: hidden;
}

.toolbar-overview__bar--disabled {
  cursor: default;
  opacity: 0.55;
}

.toolbar-overview__rail,
.toolbar-overview__fill {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  border-radius: inherit;
}

.toolbar-overview__rail {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)),
    color-mix(in srgb, var(--surface-2) 88%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 54%, transparent),
    inset 0 1px 0 rgba(255,255,255,0.04);
}

.toolbar-overview__fill {
  inset: 2px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(255,123,84,0.92), rgba(242,180,90,0.96));
}

.toolbar-overview__playhead {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(255, 123, 84, 0.18);
  transform: translateY(-50%);
}

.toolbar-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--on-surface-muted);
}

.toolbar-meta code {
  font-family: 'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace;
  font-size: 12px;
  white-space: nowrap;
}

.toolbar-meta span {
  font-size: 11px;
  opacity: 0.72;
}

.toolbar-icon-button {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 9px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-2) 90%, transparent);
  cursor: pointer;
  transition: color 140ms ease, background 140ms ease, transform 140ms ease;
}

.toolbar-icon-button:hover {
  color: var(--on-surface);
  background: color-mix(in srgb, var(--primary-soft) 72%, var(--surface-2));
  transform: translateY(-1px);
}

.toolbar-icon-button:active {
  transform: translateY(0);
}

.editor-mixer__scroll {
  position: relative;
  min-height: 0;
  height: 100%;
  overflow: auto;
}

.ruler {
  position: sticky;
  top: 0;
  z-index: 5;
  display: grid;
  grid-template-columns: 184px auto;
  width: max-content;
  min-width: 100%;
  height: 34px;
  border-bottom: 1px solid var(--outline);
  background: var(--surface-2);
}

.ruler__head {
  position: sticky;
  left: 0;
  z-index: 6;
  width: 184px;
  border-right: 1px solid var(--outline);
  background: var(--surface-2);
  box-shadow: 12px 0 18px rgba(12, 18, 28, 0.06);
}

.ruler__track {
  position: relative;
  width: var(--lane-width);
}

.ruler-tick {
  position: absolute;
  top: 0;
  left: 0;
  padding: 7px 0 0 4px;
  border-left: 1px solid var(--outline);
  color: var(--on-surface-muted);
  font-size: 10px;
  white-space: nowrap;
}

.track-row {
  display: grid;
  grid-template-columns: 184px auto;
  width: max-content;
  min-width: 100%;
  min-height: 78px;
  border-bottom: 1px solid var(--outline);
  background: var(--surface-1);
}

.track-row--selected {
  background: color-mix(in srgb, var(--primary-soft) 60%, var(--surface-1));
}

.track-row--dimmed .track-row__lane {
  opacity: 0.42;
}

.track-row__head {
  position: sticky;
  left: 0;
  z-index: 3;
  isolation: isolate;
  width: 184px;
  display: grid;
  align-content: center;
  gap: 10px;
  padding: 10px 8px;
  border-right: 1px solid var(--outline);
  background: var(--surface-2);
  box-shadow: 12px 0 18px rgba(12, 18, 28, 0.06);
}

.track-row--selected .track-row__head {
  background: color-mix(in srgb, var(--primary-soft) 60%, var(--surface-2));
}

.track-row__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.track-row__title div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.track-row__title strong,
.track-row__title small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-row__title strong {
  font-size: 12px;
}

.track-row__title small {
  color: var(--on-surface-muted);
  font-size: 10px;
}

.track-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.track-row__buttons {
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-start;
}

.chip {
  width: 22px;
  height: 20px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  color: var(--on-surface-muted);
  background: var(--surface-1);
  cursor: pointer;
  font-size: 10px;
}

.chip--active {
  color: #fff;
  background: var(--primary);
}

.chip--warning {
  background: var(--warning);
}

.track-row__lane {
  position: relative;
  z-index: 0;
  width: var(--lane-width);
  overflow: hidden;
}

.track-wave {
  position: relative;
  height: 100%;
  min-width: 100%;
}

.track-wave__clip {
  position: absolute;
  inset: 10px auto 10px 0;
  height: calc(100% - 20px);
  min-width: 1px;
  overflow: hidden;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 72%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--on-surface-muted) 12%, transparent);
}

.track-wave__empty {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.empty-state {
  display: grid;
  gap: 6px;
  margin: 24px;
  padding: 28px;
  border-radius: 18px;
  background: var(--surface-1);
  text-align: center;
}

.empty-state--drop-target {
  outline: 1px dashed #ff7b54;
  background: color-mix(in srgb, rgba(255,123,84,0.16) 72%, var(--surface-1));
}

.empty-state span {
  color: var(--on-surface-muted);
}

.drop-new-track {
  position: sticky;
  left: 204px;
  bottom: 16px;
  z-index: 7;
  width: fit-content;
  margin: 12px 24px 20px 204px;
  padding: 10px 14px;
  border: 1px dashed #ff7b54;
  border-radius: 999px;
  color: var(--primary-strong);
  background: color-mix(in srgb, rgba(255,123,84,0.18) 68%, var(--surface-1));
  box-shadow: var(--shadow-soft);
  font-size: 12px;
}

.global-playhead {
  position: absolute;
  top: 34px;
  bottom: 0;
  left: 0;
  z-index: 2;
  width: 2px;
  background: #ff7b54;
  box-shadow: 0 0 10px rgba(255, 123, 84, 0.4);
  pointer-events: none;
}

@media (max-width: 1360px) {
  .editor-mixer__toolbar {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .toolbar-meta {
    justify-content: flex-end;
  }

  .toolbar-actions {
    justify-content: flex-end;
  }
}
</style>
