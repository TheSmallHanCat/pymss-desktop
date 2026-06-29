<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { FolderOpenOutline, MusicalNotesOutline } from '@vicons/ionicons5'
import { useEditorStore } from '@/stores/editor'
import { useTaskStore } from '@/stores/task'
import { useSettingsStore } from '@/stores/settings'
import EditorAssetPanel from '@/components/editor/EditorAssetPanel.vue'
import EditorExportDialog from '@/components/editor/EditorExportDialog.vue'
import EditorInspectorPanel from '@/components/editor/EditorInspectorPanel.vue'
import EditorMixer from '@/components/editor/EditorMixer.vue'
import EditorTransportBar from '@/components/editor/EditorTransportBar.vue'
import { useEditorAssetDrag } from '@/composables/useEditorAssetDrag'
import { useEditorAssets } from '@/composables/useEditorAssets'
import { useEditorExport } from '@/composables/useEditorExport'
import { useEditorLayout } from '@/composables/useEditorLayout'
import { useEditorMixerView } from '@/composables/useEditorMixerView'
import { useEditorPlayback } from '@/composables/useEditorPlayback'
import { useEditorProjectBridge } from '@/composables/useEditorProjectBridge'
import { useEditorShortcuts } from '@/composables/useEditorShortcuts'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const { t } = useI18n()
const editor = useEditorStore()
const task = useTaskStore()
const settings = useSettingsStore()

const MIXER_HEAD_WIDTH = 180
const ASSET_RAIL_WIDTH = 34
const ASSET_PANEL_WIDTH = 218
const RESIZER_WIDTH = 10
const hasTauriApis = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const shellEl = ref<HTMLElement | null>(null)
const mixerScrollEl = ref<HTMLElement | null>(null)
const assetPanelEl = ref<HTMLElement | null>(null)
const mixerRef = ref<InstanceType<typeof EditorMixer> | null>(null)

const session = computed(() => editor.session)
const routeProjectId = computed(() => String(route.query.projectId || ''))
const sessionName = computed(() => session.value?.name || t('editor.fallbackTitle'))
const {
  activeResize,
  assetPanelVisible,
  assetResizerVisible,
  inspectorPanelWidth,
  shellStyle,
  startResize,
  toggleAssetPanel,
} = useEditorLayout({
  shellEl,
  assetRailWidth: ASSET_RAIL_WIDTH,
  resizerWidth: RESIZER_WIDTH,
  minAssetWidth: 180,
  maxAssetWidth: 320,
  minCenterWidth: 520,
  minInspectorWidth: 240,
  maxInspectorWidth: 340,
  initialAssetWidth: ASSET_PANEL_WIDTH,
  initialInspectorWidth: 268,
})
const {
  draggingSourceName,
  draggingGhost,
  clearAssetPointerDrag,
  handleAssetPointerGrab,
} = useEditorAssetDrag({
  mixerRef,
})
const {
  librarySources,
  addSourceAsReference,
  addTrackFromAsset,
  revealSource,
  relinkSource,
  revealTrackSource,
  openExportDir,
  removeSource,
} = useEditorAssets({
  editor,
  task,
  message,
  dialog,
  t,
  session,
  clearAssetPointerDrag,
})
const { isDraggingExternal } = useEditorProjectBridge({
  routeProjectId,
  hasTauriApis,
  editor,
  assetPanelEl,
  message,
  t,
})
const {
  showExportDialog,
  exportFormatDraft,
  exportWavBitDepthDraft,
  exportFlacBitDepthDraft,
  openExportDialog,
  setExportDialogVisible,
  setExportFormat,
  setExportWavBitDepth,
  setExportFlacBitDepth,
  exportMix,
} = useEditorExport({
  editor,
  settings,
  message,
  t,
})
const playback = useEditorPlayback({ editor, scrollEl: mixerScrollEl, trackHeaderWidth: MIXER_HEAD_WIDTH })
const {
  transportVisualState,
  transportPendingAction,
  transportCanToggle,
  shouldFollowPlayhead,
  currentTime: playbackCurrentTime,
  loop: playbackLoop,
  trackLevels,
  playbackError,
  stop: playbackStop,
  toggleTransport,
  seek: playbackSeek,
} = playback
const relinkingMissingAssets = ref(false)
const missingSources = computed(() => editor.missingSources())
const missingAssetPreview = computed(() => missingSources.value.slice(0, 3).map((source) => source.name))
const {
  zoomFit,
  zoomAt,
  zoomIn,
  zoomOut,
  updatePlaybackLoop,
  handleMixerScrollReady,
} = useEditorMixerView({
  editor,
  trackHeaderWidth: MIXER_HEAD_WIDTH,
  scrollEl: mixerScrollEl,
  playbackLoop,
})

async function relinkMissingAssets() {
  try {
    relinkingMissingAssets.value = true
    const result = await editor.relinkMissingSources()
    if (!result) return
    if (result.unresolved.length) {
      message.warning(t('editor.assetRelinkPartial', { resolved: result.relinked, unresolved: result.unresolved.length }))
      return
    }
    message.success(t('editor.assetRelinkSuccess', { count: result.relinked }))
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('editor.assetRelinkFailed'))
  } finally {
    relinkingMissingAssets.value = false
  }
}

let pendingInitialZoomFitSessionId = ''
let appliedInitialZoomFitSessionId = ''

function scheduleInitialZoomFit(sessionId: string) {
  if (!sessionId || appliedInitialZoomFitSessionId === sessionId) return
  pendingInitialZoomFitSessionId = sessionId
  void nextTick(() => {
    requestAnimationFrame(() => {
      if (pendingInitialZoomFitSessionId !== sessionId) return
      if (editor.session?.id !== sessionId || editor.duration <= 0 || !mixerScrollEl.value) return
      zoomFit()
      appliedInitialZoomFitSessionId = sessionId
    })
  })
}

async function togglePlayback() {
  const ok = await toggleTransport()
  if (!ok && playbackError.value) message.error(playbackError.value)
}

function handleTrackMuteRequest(trackId: string) {
  editor.toggleTrackFlag(trackId, 'muted')
}

function handleTrackSoloRequest(trackId: string) {
  editor.toggleTrackFlag(trackId, 'solo')
}

function toggleSelectedTrackFlag(flag: 'muted' | 'solo') {
  if (!editor.selectedTrackId) return
  editor.toggleTrackFlag(editor.selectedTrackId, flag)
}

function removeSelectedTrack() {
  if (!editor.selectedTrackId) return
  editor.removeTrack(editor.selectedTrackId)
}

function handleTransportToggleRequest() {
  void togglePlayback()
}

function stopPlayback() {
  playbackStop(false)
}

function stopPlaybackAndReset() {
  playbackStop(true)
}

function resetPlayhead() {
  playbackSeek(0)
}

function seekBy(delta: number) {
  playbackSeek(Math.max(0, playbackCurrentTime.value + delta))
}

function setTrackVolume(trackId: string, value: number) {
  editor.setTrackVolume(trackId, value)
}

function setTrackPan(trackId: string, value: number) {
  editor.setTrackPan(trackId, value)
}

function setMasterVolume(value: number) {
  editor.setMasterVolume(value)
}

function setMasterPan(value: number) {
  editor.setMasterPan(value)
}

function setTrackFades(trackId: string, patch: { fadeIn?: number; fadeOut?: number }) {
  editor.setTrackFades(trackId, patch)
}

async function save() {
  await editor.saveProject()
  message.success(t('editor.saved'))
}

useEditorShortcuts({
  togglePlay: togglePlayback,
  stop: stopPlayback,
  undo: editor.undo,
  redo: editor.redo,
  zoomIn,
  zoomOut,
  save,
  toHome: resetPlayhead,
  seek: seekBy,
  toggleMute: () => toggleSelectedTrackFlag('muted'),
  toggleSolo: () => toggleSelectedTrackFlag('solo'),
  removeTrack: removeSelectedTrack,
})

watch(() => editor.session?.id, stopPlaybackAndReset)
watch(routeProjectId, (value) => {
  if (!value) {
    editor.clearSession()
  }
})
watch(
  () => [editor.session?.id || '', editor.duration, Boolean(mixerScrollEl.value)] as const,
  ([sessionId]) => scheduleInitialZoomFit(sessionId),
  { immediate: true },
)
</script>

<template>
  <div class="editor-view">
    <div
      ref="shellEl"
      class="editor-shell"
      :class="{
        'editor-shell--resizing': Boolean(activeResize),
        'editor-shell--playback-following': shouldFollowPlayhead,
      }"
      :style="shellStyle"
      @contextmenu.prevent
    >
      <EditorTransportBar
        :session-name="sessionName"
        :track-count="session?.tracks.length || 0"
        :current-time="playbackCurrentTime"
        :duration="editor.duration"
        :transport-visual-state="transportVisualState"
        :transport-pending-action="transportPendingAction"
        :transport-can-toggle="transportCanToggle"
        :loop="playbackLoop"
        :master-volume="editor.masterVolume"
        :master-pan="editor.masterPan"
        :saving="editor.saving"
        :exporting="editor.exporting"
        :can-undo="editor.canUndo"
        :can-redo="editor.canRedo"
        :disabled="!session"
        :missing-asset-count="missingSources.length"
        :missing-asset-preview="missingAssetPreview"
        :relinking-missing-assets="relinkingMissingAssets"
        @reset="resetPlayhead"
        @stop="stopPlaybackAndReset"
        @toggle-transport="handleTransportToggleRequest"
        @update:loop="updatePlaybackLoop"
        @update:master-volume="setMasterVolume"
        @begin-master-volume="editor.beginInteraction"
        @commit-master-volume="editor.commitInteraction"
        @update:master-pan="setMasterPan"
        @begin-master-pan="editor.beginInteraction"
        @commit-master-pan="editor.commitInteraction"
        @undo="editor.undo"
        @redo="editor.redo"
        @save="save"
        @export="openExportDialog"
        @relink-missing-assets="relinkMissingAssets"
      />

      <div v-if="editor.loading" class="editor-state">{{ t('editor.loading') }}</div>
      <div v-else-if="!routeProjectId" class="editor-empty-state">
        <span class="editor-empty-state__icon">
          <n-icon :component="FolderOpenOutline" />
        </span>
        <strong>{{ t('editor.noProjectSelected') }}</strong>
        <p>{{ t('editor.noProjectSelectedHint') }}</p>
        <div class="editor-empty-state__actions">
          <n-button type="primary" @click="router.push('/results')">
            <template #icon><n-icon :component="MusicalNotesOutline" /></template>
            {{ t('editor.openResultsList') }}
          </n-button>
        </div>
      </div>
      <div v-else-if="!session" class="editor-state">{{ t('editor.notFound') }}</div>
      <template v-else>
        <aside
          class="editor-shell__assets"
          :class="{ 'editor-shell__assets--collapsed': !assetPanelVisible }"
        >
          <div class="editor-shell__asset-rail">
            <button
              type="button"
              class="editor-shell__asset-toggle"
              :aria-pressed="assetPanelVisible"
              :aria-label="assetPanelVisible ? t('common.collapse') : t('editor.assetLibrary')"
              @click="toggleAssetPanel()"
            >
              <span class="editor-shell__asset-toggle-icon">
                <span />
              </span>
              <em>{{ t('editor.assetLibrary') }}</em>
            </button>
          </div>

          <div ref="assetPanelEl" class="editor-shell__asset-panel">
            <EditorAssetPanel
              :sources="librarySources"
              :tree="editor.assetTree"
              :external-dragging="isDraggingExternal"
              @source-add="addSourceAsReference"
              @source-pointer-grab="handleAssetPointerGrab"
              @source-reveal="revealSource"
              @source-relink="relinkSource"
              @source-remove="removeSource"
            />
          </div>
        </aside>

        <div
          class="editor-shell__resizer editor-shell__resizer--left"
          :class="{ 'editor-shell__resizer--hidden': !assetResizerVisible }"
          @mousedown="startResize('assets', $event)"
        >
          <span />
        </div>

        <div class="editor-shell__center">
          <EditorMixer
            ref="mixerRef"
            :tracks="session.tracks"
            :source-map="editor.sourceMap"
            :selected-track-id="editor.selectedTrackId"
            :current-time="playbackCurrentTime"
            :duration="editor.duration"
            :pixels-per-second="editor.pixelsPerSecond"
            :track-levels="trackLevels"
            @scroll-ready="handleMixerScrollReady"
            @select-track="editor.selectTrack"
            @toggle-mute="handleTrackMuteRequest"
            @toggle-solo="handleTrackSoloRequest"
            @context-mute="handleTrackMuteRequest"
            @context-solo="handleTrackSoloRequest"
            @seek="playbackSeek"
            @remove-track="editor.removeTrack"
            @reveal-track="revealTrackSource"
            @zoom-in="editor.zoomIn"
            @zoom-out="editor.zoomOut"
            @zoom-fit="zoomFit"
            @zoom-at="zoomAt"
            @add-track-from-asset="addTrackFromAsset"
          />
        </div>

        <div class="editor-shell__resizer editor-shell__resizer--right" @mousedown="startResize('inspector', $event)">
          <span />
        </div>

        <EditorInspectorPanel
          class="editor-shell__inspector"
          :session="session"
          :selected-track-id="editor.selectedTrackId"
          :selected-source="editor.selectedSource"
          :duration="editor.duration"
          :last-export-path="editor.lastExport?.path || null"
          :compact="inspectorPanelWidth <= 248"
          @rename-track="editor.renameTrack"
          @set-track-volume="setTrackVolume"
          @set-track-pan="setTrackPan"
          @begin-track-volume="editor.beginInteraction"
          @commit-track-volume="editor.commitInteraction"
          @begin-track-pan="editor.beginInteraction"
          @commit-track-pan="editor.commitInteraction"
          @set-track-fades="setTrackFades"
          @open-location="openExportDir"
          @relink-source="() => editor.selectedSource && relinkSource(editor.selectedSource)"
        />
      </template>
    </div>
    <div
      v-if="draggingSourceName && draggingGhost"
      class="editor-drag-ghost"
      :style="{ left: `${draggingGhost.x + 18}px`, top: `${draggingGhost.y + 18}px` }"
    >
      {{ draggingSourceName }}
    </div>

    <EditorExportDialog
      :show="showExportDialog"
      :session-name="sessionName"
      :duration="editor.duration"
      :track-count="session?.tracks.length || 0"
      :exporting="editor.exporting"
      :format="exportFormatDraft"
      :wav-bit-depth="exportWavBitDepthDraft"
      :flac-bit-depth="exportFlacBitDepthDraft"
      @update:show="setExportDialogVisible"
      @update:format="setExportFormat"
      @update:wav-bit-depth="setExportWavBitDepth"
      @update:flac-bit-depth="setExportFlacBitDepth"
      @confirm="exportMix"
    />
  </div>
</template>

<style scoped>
.editor-view {
  position: relative;
}

.editor-shell {
  --asset-rail-width: 34px;
  --asset-panel-width: 218px;
  --asset-resizer-width: 10px;
  --inspector-resizer-width: 10px;
  --inspector-width: 268px;
  position: relative;
  height: calc(100vh - 40px);
  display: grid;
  grid-template-columns:
    calc(var(--asset-rail-width) + var(--asset-panel-width))
    var(--asset-resizer-width)
    minmax(0, 1fr)
    var(--inspector-resizer-width)
    var(--inspector-width);
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--surface);
  color: var(--on-surface);
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  transition: grid-template-columns 220ms ease;
}

.editor-shell :deep(input),
.editor-shell :deep(textarea),
.editor-shell :deep([contenteditable='true']),
.editor-shell :deep(.n-input__input-el),
.editor-shell :deep(.n-base-selection-input) {
  user-select: text;
  -webkit-user-select: text;
}

.editor-shell :deep(.editor-transport) {
  grid-column: 1 / -1;
}

.editor-shell__assets {
  grid-column: 1;
  grid-row: 2;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--asset-rail-width) minmax(0, var(--asset-panel-width));
  border-right: 1px solid var(--outline);
  background: color-mix(in srgb, var(--surface) 90%, var(--surface-1));
  transition: grid-template-columns 220ms ease, border-color 180ms ease;
}

.editor-shell__assets--collapsed {
  border-right-color: color-mix(in srgb, var(--outline) 46%, transparent);
}

.editor-shell__asset-rail {
  min-height: 0;
  padding: 6px 4px;
  border-right: 1px solid var(--outline);
  background: color-mix(in srgb, var(--surface) 88%, var(--surface-1));
}

.editor-shell__asset-toggle {
  width: 100%;
  display: grid;
  justify-items: center;
  gap: 0;
  padding: 4px 0;
  border: 0;
  border-radius: 8px;
  color: var(--on-surface-muted);
  background: transparent;
  cursor: pointer;
  transition: color 180ms ease, background 180ms ease, transform 180ms ease;
}

.editor-shell__asset-toggle:hover {
  color: var(--on-surface);
  background: var(--surface-2);
}

.editor-shell__asset-toggle-icon {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-2) 92%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 54%, transparent);
}

.editor-shell__asset-toggle-icon span {
  width: 12px;
  height: 10px;
  position: relative;
  display: block;
}

.editor-shell__asset-toggle-icon span::before,
.editor-shell__asset-toggle-icon span::after,
.editor-shell__asset-toggle-icon span {
  border-radius: 999px;
  background: currentColor;
}

.editor-shell__asset-toggle-icon span::before,
.editor-shell__asset-toggle-icon span::after {
  content: '';
  position: absolute;
  left: 0;
  width: 12px;
  height: 2px;
}

.editor-shell__asset-toggle-icon span {
  height: 2px;
}

.editor-shell__asset-toggle-icon span::before {
  top: -5px;
}

.editor-shell__asset-toggle-icon span::after {
  top: 5px;
}

.editor-shell__asset-toggle em {
  display: none;
}

.editor-shell__asset-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.editor-shell__center {
  /* Center occupies col3. The right resizer mirrors the left one as a real
     layout column so dragging remains reliable and predictable. */
  grid-column: 3;
  grid-row: 2;
  min-width: 0;
  min-height: 0;
  display: grid;
  overflow: hidden;
  background: color-mix(in srgb, var(--surface-1) 76%, var(--surface-2));
}

.editor-shell__inspector {
  grid-column: 5;
  grid-row: 2;
  min-width: 0;
  min-height: 0;
  border-left: 0;
  position: relative;
  z-index: 5;
}

.editor-shell__resizer {
  position: relative;
  grid-row: 2;
  width: 10px;
  cursor: col-resize;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.02)),
    color-mix(in srgb, var(--surface-2) 86%, transparent);
  user-select: none;
  z-index: 6;
}

.editor-shell__resizer::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255,123,84,0), rgba(255,123,84,0.08), rgba(255,123,84,0));
  opacity: 0;
  transition: opacity 140ms ease;
}

.editor-shell__resizer--left {
  grid-column: 2;
  background: transparent;
  border-left: 1px solid transparent;
  border-right: 1px solid transparent;
}

.editor-shell__resizer--right {
  grid-column: 4;
  background: transparent;
  border-left: 1px solid transparent;
  border-right: 1px solid transparent;
}

.editor-shell__resizer--right span {
  width: 2px;
  height: 38px;
  opacity: 0;
  background: color-mix(in srgb, var(--on-surface-muted) 14%, transparent);
}

.editor-shell__resizer--right:hover {
  background: linear-gradient(
    180deg,
    transparent,
    color-mix(in srgb, var(--surface-2) 42%, transparent),
    transparent
  );
  border-left-color: color-mix(in srgb, var(--outline) 40%, transparent);
  border-right-color: color-mix(in srgb, var(--outline) 40%, transparent);
}

.editor-shell__resizer--right:hover span,
.editor-shell--resizing .editor-shell__resizer--right span {
  opacity: 1;
  height: 56px;
  background: color-mix(in srgb, #ff7b54 52%, var(--on-surface-muted));
}

.editor-shell__resizer--left span {
  width: 2px;
  height: 38px;
  opacity: 0;
  background: color-mix(in srgb, var(--on-surface-muted) 14%, transparent);
}

.editor-shell__resizer--left:hover {
  background: linear-gradient(
    180deg,
    transparent,
    color-mix(in srgb, var(--surface-2) 42%, transparent),
    transparent
  );
  border-left-color: color-mix(in srgb, var(--outline) 40%, transparent);
  border-right-color: color-mix(in srgb, var(--outline) 40%, transparent);
}

.editor-shell__resizer--left:hover span,
.editor-shell--resizing .editor-shell__resizer--left span {
  opacity: 1;
  height: 56px;
  background: color-mix(in srgb, #ff7b54 52%, var(--on-surface-muted));
}

.editor-shell__resizer--hidden {
  pointer-events: none;
}

.editor-shell__resizer--hidden span,
.editor-shell__resizer--hidden::before {
  opacity: 0;
}

.editor-shell__resizer span {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 3px;
  height: 48px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--on-surface-muted) 32%, transparent);
  transform: translate(-50%, -50%);
  transition: background 140ms ease, height 140ms ease;
}

.editor-shell__resizer:hover::before,
.editor-shell--resizing .editor-shell__resizer::before {
  opacity: 1;
}

.editor-shell__resizer:hover span,
.editor-shell--resizing .editor-shell__resizer span {
  height: 72px;
  background: color-mix(in srgb, #ff7b54 66%, var(--on-surface-muted));
}

.editor-state {
  grid-column: 1 / -1;
  grid-row: 2;
  display: grid;
  place-items: center;
  color: var(--on-surface-muted);
}

.editor-empty-state {
  grid-column: 1 / -1;
  grid-row: 2;
  height: 100%;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  padding: 24px;
  color: var(--on-surface-muted);
  text-align: center;
}

.editor-empty-state__icon {
  width: 62px;
  height: 62px;
  display: grid;
  place-items: center;
  border-radius: 18px;
  font-size: 28px;
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.editor-empty-state strong {
  color: var(--on-surface);
  font-size: 18px;
}

.editor-empty-state p {
  margin: 0;
  max-width: 460px;
  font-size: 13px;
  line-height: 1.7;
}

.editor-empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}

.editor-shell--resizing {
  cursor: col-resize;
  /* Disable the column animation while dragging so the divider stays flush with
     the cursor instead of lerping and momentarily overlapping the mixer. */
  transition: none;
}

.editor-shell--playback-following .editor-shell__center {
  overflow: hidden;
}

.editor-drag-ghost {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  max-width: 260px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--primary) 28%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-2) 96%, transparent);
  color: var(--on-surface);
  font-size: 12px;
  line-height: 1.2;
  box-shadow: 0 14px 28px rgba(12, 18, 28, 0.2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 920px) {
  .editor-shell__assets {
    grid-template-columns: var(--asset-rail-width);
  }

  .editor-shell__asset-panel {
    display: none;
  }
}
</style>
