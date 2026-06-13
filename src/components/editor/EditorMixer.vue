<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { EllipsisHorizontal } from '@vicons/ionicons5'
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
  trackLevels: Record<string, [number, number]>
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
  zoomAt: [payload: { direction?: 'in' | 'out'; anchorRatio: number; deltaY?: number }]
  'scroll-ready': [element: HTMLElement]
  addTrackFromAsset: [sourceId: string]
}>()

const { t } = useI18n()
const HEADER_WIDTH = 180
const scrollEl = ref<HTMLElement | null>(null)
const scrollViewportWidth = ref(0)
let resizeObserver: ResizeObserver | null = null

watch(
  () => scrollEl.value,
  (value) => {
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
    if (value) {
      const syncViewportWidth = () => {
        scrollViewportWidth.value = value.clientWidth
      }
      syncViewportWidth()
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          syncViewportWidth()
        })
        resizeObserver.observe(value)
      }
      emit('scroll-ready', value)
    }
  },
  { immediate: true },
)

const laneWidth = computed(() => {
  const viewportLaneWidth = Math.max(0, scrollViewportWidth.value - HEADER_WIDTH)
  const contentWidth = props.duration > 0 ? props.duration * props.pixelsPerSecond : 0
  // Always fill at least the visible lane area so the track/timeline reaches the
  // inspector edge instead of being cut off where the audio content ends.
  return Math.max(1, Math.ceil(Math.max(contentWidth, viewportLaneWidth)))
})
const playheadLeft = computed(() => HEADER_WIDTH + Math.max(0, props.currentTime * props.pixelsPerSecond))
const hasSolo = computed(() => props.tracks.some((track) => track.solo))
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
      key: 'mute',
      label: track.muted ? t('editor.unmuteTrack') : t('editor.muteTrack'),
    },
    {
      key: 'solo',
      label: track.solo ? t('editor.unsoloTrack') : t('editor.soloTrack'),
    },
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

const rulerStep = computed(() => {
  const targetPx = 100
  const rawStep = targetPx / props.pixelsPerSecond
  const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300]
  return niceSteps.find((item) => item >= rawStep) || niceSteps[niceSteps.length - 1]
})

const laneStepPx = computed(() => Math.max(48, rulerStep.value * props.pixelsPerSecond))

const rulerTicks = computed(() => {
  const total = props.duration
  if (total <= 0) return []
  const step = rulerStep.value
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

function trackWaveWidth(track: EditorTrack) {
  const source = sourceFor(track)
  return Math.max(1, Math.ceil((source?.duration || 0) * props.pixelsPerSecond))
}

function trackClipWidth(track: EditorTrack) {
  return Math.max(1, Math.min(laneWidth.value, trackWaveWidth(track)))
}

function trackLevel(trackId: string) {
  return props.trackLevels[trackId] || [0, 0]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function trackMeterPeak(trackId: string) {
  const [left, right] = trackLevel(trackId)
  return Math.max(left, right)
}

function trackMeterStyle(trackId: string, channel: 0 | 1) {
  const raw = trackLevel(trackId)[channel]
  const normalized = clamp(raw > 0.012 ? Math.max(raw, 0.08) : 0, 0, 1)
  return {
    transform: `scaleY(${normalized})`,
    opacity: normalized > 0 ? 1 : 0,
  }
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

function handleTimelineWheel(event: WheelEvent) {
  const element = scrollEl.value
  if (!element) return

  if (event.ctrlKey || event.metaKey) {
    if (event.cancelable) event.preventDefault()
    const rect = element.getBoundingClientRect()
    const anchorRatio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, element.clientWidth)))
    emit('zoomAt', { direction: event.deltaY < 0 ? 'in' : 'out', anchorRatio, deltaY: event.deltaY })
    return
  }

  const canScrollVertically = element.scrollHeight > element.clientHeight + 1
  const horizontalIntent = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !canScrollVertically
  if (!horizontalIntent) return

  const delta = event.shiftKey
    ? (Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX)
    : (Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY)
  if (!delta) return

  if (event.cancelable) event.preventDefault()
  element.scrollLeft += delta
}

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

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

  if (key === 'mute') emit('contextMute', track.id)
  if (key === 'solo') emit('contextSolo', track.id)
  if (key === 'reveal') emit('revealTrack', track.id)
  if (key === 'remove') emit('removeTrack', track.id)
}

defineExpose({
  setDraggingAssetSourceId,
  setDropTargetTrackId,
  containsPoint,
  commitAssetDrop,
})
</script>

<template>
  <section ref="mixerRootEl" class="editor-mixer">
    <div
      ref="scrollEl"
      class="editor-mixer__scroll"
      :style="{ '--lane-width': `${laneWidth}px`, '--lane-step': `${laneStepPx}px` }"
      @wheel="handleTimelineWheel"
    >
      <div class="ruler">
        <div class="ruler__head">
          <span>{{ t('editor.tracks') }}</span>
          <small>{{ tracks.length }}</small>
        </div>
        <div class="ruler__track" :style="{ width: `${laneWidth}px` }" @click="seekFromEvent">
          <div class="ruler__grid">
            <span v-for="tick in rulerTicks" :key="tick.time" class="ruler-tick" :style="{ transform: `translateX(${tick.left}px)` }">
              {{ formatTimecode(tick.time) }}
            </span>
          </div>
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
            <div class="track-row__body">
              <div class="track-row__title">
                <span class="track-dot" :style="{ background: track.color || '#7aa2ff' }" />
                <strong>{{ track.name }}</strong>
              </div>
              <div class="track-row__subline">
                <div class="track-row__buttons">
                  <button
                    class="chip"
                    type="button"
                    :title="track.muted ? t('editor.unmuteTrack') : t('editor.muteTrack')"
                    :aria-label="track.muted ? t('editor.unmuteTrack') : t('editor.muteTrack')"
                    :class="{ 'chip--active chip--warning': track.muted }"
                    @click.stop="emit('toggleMute', track.id)"
                  >M</button>
                  <button
                    class="chip"
                    type="button"
                    :title="track.solo ? t('editor.unsoloTrack') : t('editor.soloTrack')"
                    :aria-label="track.solo ? t('editor.unsoloTrack') : t('editor.soloTrack')"
                    :class="{ 'chip--active': track.solo }"
                    @click.stop="emit('toggleSolo', track.id)"
                  >S</button>
                  <button
                    class="chip chip--icon"
                    type="button"
                    :title="t('editor.trackActions')"
                    :aria-label="t('editor.trackActions')"
                    @click.stop="openTrackContextMenu($event, track)"
                  ><n-icon :component="EllipsisHorizontal" /></button>
                </div>
                <span class="track-row__meta">{{ sourceFor(track)?.channels || 0 }}ch</span>
              </div>
            </div>
            <div
              class="track-meter"
              :class="{ 'track-meter--active': trackMeterPeak(track.id) > 0.02 }"
              :title="`${Math.round(trackLevel(track.id)[0] * 100)} / ${Math.round(trackLevel(track.id)[1] * 100)}`"
            >
              <span class="track-meter__bar"><i :style="trackMeterStyle(track.id, 0)" /></span>
              <span class="track-meter__bar"><i :style="trackMeterStyle(track.id, 1)" /></span>
            </div>
          </div>

          <div class="track-row__lane" @click="seekFromEvent">
            <div class="track-wave" :style="{ width: `${laneWidth}px`, '--track-color': track.color || '#7aa2ff' }">
              <div class="track-wave__clip" :style="{ width: `${trackClipWidth(track)}px` }">
                <EditorWaveform
                  v-if="sourceFor(track)"
                  :peaks="sourceFor(track)?.peaks || []"
                  :asset-duration="sourceFor(track)?.duration || 0"
                  :duration="sourceFor(track)?.duration || 0"
                  :width="trackWaveWidth(track)"
                  :height="42"
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
  display: block;
  background: color-mix(in srgb, var(--surface-1) 76%, var(--surface-2));
}

.editor-mixer__scroll {
  position: relative;
  min-height: 0;
  height: 100%;
  overflow: auto;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--surface-1) 84%, var(--surface-2)),
      color-mix(in srgb, var(--surface-1) 62%, var(--surface-2))
    );
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--surface-4, var(--surface-3)) 82%, rgba(255,255,255,0.14))
    transparent;
}

.editor-mixer__scroll::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

.editor-mixer__scroll::-webkit-scrollbar-track {
  background: transparent;
  border-radius: 999px;
}

.editor-mixer__scroll::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.08)) padding-box,
    linear-gradient(180deg, rgba(130,146,174,0.86), rgba(92,108,136,0.92)) border-box;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
}

.editor-mixer__scroll::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(255,255,255,0.2), rgba(255,255,255,0.1)) padding-box,
    linear-gradient(180deg, rgba(255,151,105,0.95), rgba(255,123,84,0.92)) border-box;
}

.editor-mixer__scroll::-webkit-scrollbar-corner {
  background: transparent;
}

.ruler {
  position: sticky;
  top: 0;
  z-index: 5;
  display: grid;
  grid-template-columns: 180px auto;
  width: max-content;
  min-width: 100%;
  height: 30px;
  border-bottom: 1px solid var(--outline);
  background: color-mix(in srgb, var(--surface) 84%, var(--surface-1));
}

.ruler__head {
  position: sticky;
  left: 0;
  z-index: 6;
  width: 180px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  border-right: 1px solid var(--outline);
  background: color-mix(in srgb, var(--surface) 84%, var(--surface-1));
  color: var(--on-surface-muted);
}

.ruler__head span,
.ruler__head small {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ruler__grid {
  position: relative;
  width: 100%;
  height: 100%;
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
  grid-template-columns: 180px auto;
  width: max-content;
  min-width: 100%;
  min-height: 54px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 64%, transparent);
  background: transparent;
}

.tracks {
  position: relative;
  width: max-content;
  min-width: 100%;
  min-height: calc(100% - 30px);
  background-image:
    linear-gradient(90deg, transparent 179px, color-mix(in srgb, var(--outline) 82%, transparent) 179px 180px, transparent 180px),
    linear-gradient(90deg, transparent 0 calc(var(--lane-step) - 1px), color-mix(in srgb, var(--outline) 18%, transparent) calc(var(--lane-step) - 1px) var(--lane-step));
  background-size: 100% 100%, var(--lane-step) 100%;
  background-position: 0 0, 180px 0;
  background-repeat: no-repeat, repeat;
}

.track-row--selected {
  background: color-mix(in srgb, var(--primary-soft) 28%, transparent);
}

.track-row--dimmed .track-row__lane {
  opacity: 0.46;
}

.track-row__head {
  position: sticky;
  left: 0;
  z-index: 3;
  isolation: isolate;
  width: 180px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 8px;
  align-items: stretch;
  gap: 6px;
  padding: 5px 8px;
  border-right: 1px solid var(--outline);
  background: color-mix(in srgb, var(--surface) 74%, var(--surface-2));
}

.track-row--selected .track-row__head {
  background: color-mix(in srgb, var(--primary-soft) 40%, color-mix(in srgb, var(--surface) 82%, var(--surface-2)));
}

.track-row--selected .track-row__head::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #ff7b54;
}

.track-row__body {
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 4px;
}

.track-row__title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.track-row__title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.15;
}

.track-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  flex-shrink: 0;
}

.track-row__subline {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
}

.track-row__buttons {
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-start;
  flex-shrink: 0;
}

.track-row__meta {
  color: var(--on-surface-muted);
  font-size: 10px;
  white-space: nowrap;
  opacity: 0.82;
}

.chip {
  width: 23px;
  height: 23px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-1) 70%, var(--surface-2));
  cursor: pointer;
  font-size: 10px;
  transition: background 140ms ease, color 140ms ease, transform 120ms ease;
}

.chip:hover {
  color: var(--on-surface);
  background: color-mix(in srgb, var(--surface) 72%, var(--surface-2));
}

.chip:active {
  transform: scale(0.96);
}

.chip--active {
  color: #fff;
  background: var(--primary);
}

.chip--warning {
  background: var(--warning);
}

.track-meter {
  display: grid;
  grid-template-columns: repeat(2, 3px);
  gap: 2px;
  align-items: end;
  justify-content: center;
  min-height: 100%;
  flex-shrink: 0;
  align-self: stretch;
  opacity: 1;
}

.track-meter__bar {
  position: relative;
  width: 3px;
  height: 100%;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--on-surface-muted) 10%, transparent);
}

.track-meter--active {
  opacity: 1;
}

.track-meter--active .track-meter__bar {
  background: color-mix(in srgb, var(--on-surface-muted) 12%, transparent);
}

.track-meter__bar i {
  position: absolute;
  inset: 0;
  transform-origin: center bottom;
  border-radius: inherit;
  opacity: 0;
  background: linear-gradient(180deg, rgba(255, 106, 106, 0.95), rgba(255, 170, 102, 0.92) 52%, rgba(92, 214, 132, 0.9));
  transition: transform 70ms linear, opacity 90ms linear;
}

.track-row__lane {
  position: relative;
  z-index: 0;
  width: var(--lane-width);
  overflow: hidden;
  background: color-mix(in srgb, var(--surface) 76%, var(--surface-1));
  box-shadow: inset 1px 0 0 color-mix(in srgb, var(--outline) 44%, transparent);
}

.track-row--selected .track-row__lane {
  background: color-mix(in srgb, var(--primary-soft) 16%, transparent);
}

.track-wave {
  position: relative;
  height: 100%;
  min-width: 100%;
}

.track-wave__clip {
  position: absolute;
  top: 4px;
  left: 0;
  bottom: 4px;
  height: calc(100% - 8px);
  max-width: 100%;
  min-width: 1px;
  overflow: hidden;
  border-radius: 0 2px 2px 0;
  border-top: 1px solid color-mix(in srgb, var(--track-color, var(--on-surface-muted)) 22%, transparent);
  border-right: 1px solid color-mix(in srgb, var(--track-color, var(--on-surface-muted)) 22%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--track-color, var(--on-surface-muted)) 22%, transparent);
  border-left: 0;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--track-color, #7aa2ff) 22%, color-mix(in srgb, var(--surface-1) 52%, var(--surface-2))),
      color-mix(in srgb, var(--track-color, #7aa2ff) 13%, color-mix(in srgb, var(--surface-1) 52%, var(--surface-2)))
    );
  box-shadow: none;
}

/* Explicit end-cap so the clip terminus is clearly pinned to the right edge. */
.track-wave__clip::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 3px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--track-color, #7aa2ff) 58%, transparent),
    color-mix(in srgb, var(--track-color, #7aa2ff) 38%, transparent)
  );
  box-shadow: -2px 0 6px color-mix(in srgb, var(--track-color, #7aa2ff) 22%, transparent);
  pointer-events: none;
}

/* Continuous ambience line that deepens toward the tail and merges into the end-cap. */
.track-wave__clip::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  transform: translateY(-50%);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--track-color, #7aa2ff) 22%, transparent),
    color-mix(in srgb, var(--track-color, #7aa2ff) 40%, transparent)
  );
  opacity: 0.62;
  pointer-events: none;
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
  margin: 0;
  padding: 48px 28px;
  background: transparent;
  text-align: center;
}

.empty-state strong {
  font-size: 14px;
}

.empty-state--drop-target {
  outline: 1px dashed #ff7b54;
  outline-offset: -12px;
  background: color-mix(in srgb, rgba(255,123,84,0.08) 72%, transparent);
}

.empty-state span {
  color: var(--on-surface-muted);
}

.drop-new-track {
  position: sticky;
  left: 200px;
  bottom: 16px;
  z-index: 7;
  width: fit-content;
  margin: 12px 24px 20px 200px;
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
  top: 30px;
  bottom: 0;
  left: 0;
  z-index: 2;
  width: 2px;
  background: #ff7b54;
  box-shadow: 0 0 10px rgba(255, 123, 84, 0.4);
  pointer-events: none;
}
</style>
