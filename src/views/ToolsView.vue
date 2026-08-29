<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import {
  AnalyticsOutline,
  CloseCircleOutline,
  DocumentOutline,
  FolderOpenOutline,
  MusicalNoteOutline,
  RepeatOutline,
  SwapHorizontalOutline,
} from '@vicons/ionicons5'
import { useSettingsStore } from '@/stores/settings'
import AudioToolStatus from '@/components/tools/AudioToolStatus.vue'
import type { AudioToolKey, AudioToolResult } from '@/types/audioTools'
import { loadAppStore, saveAppStore } from '@/utils/appStore'

type WorkerEvent = {
  type: string
  payload?: {
    operation?: AudioToolKey
    completed?: number
    total?: number
    current?: string
  }
}

type StoredAudioToolsState = {
  activeTool?: AudioToolKey
  midiModelPath?: string
}

const { t } = useI18n()
const message = useMessage()
const settings = useSettingsStore()

const activeTool = ref<AudioToolKey>('convert')
const busyTool = ref<AudioToolKey | null>(null)
const result = ref<AudioToolResult | null>(null)
const errorMessage = ref('')
const progress = ref({ completed: 0, total: 0, current: '' })

const convertInputs = ref<string[]>([])
const convertOutputDir = ref('')
const convertFormat = ref('wav')
const convertSampleRate = ref(44100)
const convertChannels = ref(2)
const wavBitDepth = ref('PCM-24')
const flacBitDepth = ref('16-bit')
const mp3BitRate = ref('320k')
const oggBitRate = ref('320k')

const mergeInputDir = ref('')
const mergeOutputDir = ref('')

const referencePath = ref('')
const estimatedPath = ref('')

const midiInputPath = ref('')
const midiModelPath = ref('')
const midiOutputDir = ref('')
const midiBpm = ref(120)

let unlistenWorker: UnlistenFn | undefined
let stateRestored = false

const formatOptions = computed(() => [
  { label: 'WAV', value: 'wav' },
  { label: 'FLAC', value: 'flac' },
  { label: 'MP3', value: 'mp3' },
  { label: 'OGG', value: 'ogg' },
])
const sampleRateOptions = [32000, 44100, 48000].map(value => ({ label: `${value} Hz`, value }))
const channelOptions = computed(() => [
  { label: t('tools.mono'), value: 1 },
  { label: t('tools.stereo'), value: 2 },
])
const wavBitDepthOptions = ['PCM-16', 'PCM-24', 'PCM-32'].map(value => ({ label: value, value }))
const flacBitDepthOptions = ['16-bit', '32-bit'].map(value => ({ label: value, value }))
const mp3BitRateOptions = ['192k', '256k', '320k'].map(value => ({ label: value, value }))
const oggBitRateOptions = ['192k', '256k', '320k', '450k'].map(value => ({ label: value, value }))
const progressPercentage = computed(() => {
  if (!progress.value.total) return 0
  return Math.min(100, Math.round((progress.value.completed / progress.value.total) * 100))
})
const hasResult = computed(() => result.value?.operation === activeTool.value)

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function initializeOutputDirectories() {
  const defaultDir = settings.outputDir.trim()
  if (!defaultDir) return
  if (!convertOutputDir.value) convertOutputDir.value = defaultDir
  if (!mergeOutputDir.value) mergeOutputDir.value = defaultDir
  if (!midiOutputDir.value) midiOutputDir.value = defaultDir
}

watch(() => settings.outputDir, initializeOutputDirectories, { immediate: true })

watch(activeTool, () => {
  errorMessage.value = ''
  result.value = null
  progress.value = { completed: 0, total: 0, current: '' }
})

watch([activeTool, midiModelPath], () => {
  if (!stateRestored) return
  void saveAppStore('audio-tools', {
    activeTool: activeTool.value,
    midiModelPath: midiModelPath.value,
  }).catch((error) => {
    console.warn('[audio-tools] state save failed', error)
  })
})

async function pickAudioFiles() {
  const paths = await invoke<string[]>('pick_audio_files')
  if (!paths?.length) return
  const current = new Set(convertInputs.value)
  convertInputs.value = [...convertInputs.value, ...paths.filter(path => !current.has(path))]
}

async function pickSingleAudio(target: 'reference' | 'estimated' | 'midi') {
  const path = await invoke<string | null>('pick_single_audio_file')
  if (!path) return
  if (target === 'reference') referencePath.value = path
  if (target === 'estimated') estimatedPath.value = path
  if (target === 'midi') midiInputPath.value = path
}

async function pickFolder(target: 'convert-output' | 'merge-input' | 'merge-output' | 'midi-output') {
  const command = target === 'merge-input' ? 'pick_input_folder' : 'pick_output_folder'
  const path = await invoke<string | null>(command)
  if (!path) return
  if (target === 'convert-output') convertOutputDir.value = path
  if (target === 'merge-input') mergeInputDir.value = path
  if (target === 'merge-output') mergeOutputDir.value = path
  if (target === 'midi-output') midiOutputDir.value = path
}

async function pickMidiModel() {
  const path = await invoke<string | null>('pick_model_weights_file', {
    title: t('tools.midiModelPickerTitle'),
  })
  if (path) midiModelPath.value = path
}

async function revealPath(path: string) {
  try {
    await invoke('reveal_path', { path })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function executeTool(tool: AudioToolKey, payload: Record<string, unknown>) {
  if (busyTool.value) return
  busyTool.value = tool
  result.value = null
  errorMessage.value = ''
  progress.value = { completed: 0, total: 0, current: '' }
  try {
    const response = await invoke<AudioToolResult>('run_audio_tool', {
      payload: { operation: tool, ...payload },
    })
    result.value = response
    progress.value = {
      completed: progress.value.total || 1,
      total: progress.value.total || 1,
      current: '',
    }
    if ((response.failed?.length || 0) + (response.skipped?.length || 0) > 0) {
      message.warning(t('tools.completedWithSkipped'))
    } else {
      message.success(t('tools.completed'))
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    busyTool.value = null
  }
}

function runConvert() {
  if (!convertInputs.value.length || !convertOutputDir.value) return
  void executeTool('convert', {
    inputs: convertInputs.value,
    outputDir: convertOutputDir.value,
    outputFormat: convertFormat.value,
    sampleRate: convertSampleRate.value,
    channels: convertChannels.value,
    wavBitDepth: wavBitDepth.value,
    flacBitDepth: flacBitDepth.value,
    mp3BitRate: mp3BitRate.value,
    oggBitRate: oggBitRate.value,
  })
}

function runMerge() {
  if (!mergeInputDir.value || !mergeOutputDir.value) return
  void executeTool('merge', {
    inputDir: mergeInputDir.value,
    outputDir: mergeOutputDir.value,
  })
}

function runSdr() {
  if (!referencePath.value || !estimatedPath.value) return
  void executeTool('sdr', {
    referencePath: referencePath.value,
    estimatedPath: estimatedPath.value,
  })
}

function runMidi() {
  if (!midiInputPath.value || !midiModelPath.value || !midiOutputDir.value) return
  void executeTool('midi', {
    inputPath: midiInputPath.value,
    modelPath: midiModelPath.value,
    outputDir: midiOutputDir.value,
    bpm: midiBpm.value,
  })
}

onMounted(async () => {
  initializeOutputDirectories()
  try {
    const stored = await loadAppStore<StoredAudioToolsState>('audio-tools')
    if (stored?.activeTool && ['convert', 'merge', 'sdr', 'midi'].includes(stored.activeTool)) {
      activeTool.value = stored.activeTool
    }
    if (typeof stored?.midiModelPath === 'string') {
      midiModelPath.value = stored.midiModelPath
    }
  } catch (error) {
    console.warn('[audio-tools] state restore failed', error)
  } finally {
    stateRestored = true
  }
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  unlistenWorker = await listen<WorkerEvent>('pymss://worker-event', (event) => {
    const workerEvent = event.payload
    if (workerEvent.type !== 'audio_tool_progress') return
    const payload = workerEvent.payload
    if (!payload || payload.operation !== busyTool.value) return
    progress.value = {
      completed: Number(payload.completed || 0),
      total: Number(payload.total || 0),
      current: String(payload.current || ''),
    }
  })
})

onUnmounted(() => {
  unlistenWorker?.()
})
</script>

<template>
  <div class="page tools-page">
    <div class="page-header-compact">
      <div>
        <h1>{{ t('tools.title') }}</h1>
        <p>{{ t('tools.subtitle') }}</p>
      </div>
    </div>

    <n-tabs v-model:value="activeTool" type="segment" :animated="false" class="tools-tabs">
      <n-tab-pane name="convert">
        <template #tab>
          <n-icon :component="SwapHorizontalOutline" />
          <span>{{ t('tools.convertTitle') }}</span>
        </template>
        <div class="tool-layout">
          <section class="tool-card tool-card--main">
            <div class="tool-card__header">
              <div class="tool-icon"><n-icon :component="SwapHorizontalOutline" /></div>
              <div>
                <h2>{{ t('tools.convertTitle') }}</h2>
                <p>{{ t('tools.convertDescription') }}</p>
              </div>
            </div>

            <div class="form-section">
              <div class="field-heading">
                <label>{{ t('tools.inputFiles') }}</label>
                <span>{{ t('tools.selectedCount', { count: convertInputs.length }) }}</span>
              </div>
              <button type="button" class="file-picker" :disabled="Boolean(busyTool)" @click="pickAudioFiles">
                <n-icon :component="DocumentOutline" size="20" />
                <span>{{ convertInputs.length ? t('tools.addFiles') : t('tools.chooseFiles') }}</span>
              </button>
              <div v-if="convertInputs.length" class="selected-files">
                <div v-for="path in convertInputs" :key="path" class="selected-file">
                  <span :title="path">{{ fileName(path) }}</span>
                  <button type="button" :title="t('tools.removeFile')" @click="convertInputs = convertInputs.filter(item => item !== path)">
                    <n-icon :component="CloseCircleOutline" />
                  </button>
                </div>
              </div>
            </div>

            <div class="form-section">
              <label>{{ t('tools.outputDirectory') }}</label>
              <div class="path-field">
                <n-input :value="convertOutputDir" readonly :placeholder="t('tools.chooseOutputDirectory')" />
                <n-button secondary @click="pickFolder('convert-output')">
                  <template #icon><n-icon :component="FolderOpenOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>

            <div class="form-grid form-grid--four">
              <div class="form-section">
                <label>{{ t('tools.outputFormat') }}</label>
                <n-select v-model:value="convertFormat" :options="formatOptions" />
              </div>
              <div class="form-section">
                <label>{{ t('tools.sampleRate') }}</label>
                <n-select v-model:value="convertSampleRate" :options="sampleRateOptions" />
              </div>
              <div class="form-section">
                <label>{{ t('tools.channels') }}</label>
                <n-select v-model:value="convertChannels" :options="channelOptions" />
              </div>
              <div class="form-section">
                <label>{{ t('tools.quality') }}</label>
                <n-select v-if="convertFormat === 'wav'" v-model:value="wavBitDepth" :options="wavBitDepthOptions" />
                <n-select v-else-if="convertFormat === 'flac'" v-model:value="flacBitDepth" :options="flacBitDepthOptions" />
                <n-select v-else-if="convertFormat === 'mp3'" v-model:value="mp3BitRate" :options="mp3BitRateOptions" />
                <n-select v-else v-model:value="oggBitRate" :options="oggBitRateOptions" />
              </div>
            </div>

            <div class="tool-actions">
              <n-button
                type="primary"
                :loading="busyTool === 'convert'"
                :disabled="Boolean(busyTool) || !convertInputs.length || !convertOutputDir"
                @click="runConvert"
              >
                {{ t('tools.startConvert') }}
              </n-button>
            </div>
          </section>
          <aside class="tool-card tool-card--side">
            <h3>{{ t('tools.processingStatus') }}</h3>
            <p>{{ t('tools.convertHint') }}</p>
            <AudioToolStatus
              :busy="busyTool === 'convert'"
              :has-result="hasResult"
              :error="errorMessage"
              :progress="progress"
              :percentage="progressPercentage"
              :result="result"
              @reveal="revealPath"
            />
          </aside>
        </div>
      </n-tab-pane>

      <n-tab-pane name="merge">
        <template #tab>
          <n-icon :component="RepeatOutline" />
          <span>{{ t('tools.mergeTitle') }}</span>
        </template>
        <div class="tool-layout">
          <section class="tool-card tool-card--main">
            <div class="tool-card__header">
              <div class="tool-icon"><n-icon :component="RepeatOutline" /></div>
              <div>
                <h2>{{ t('tools.mergeTitle') }}</h2>
                <p>{{ t('tools.mergeDescription') }}</p>
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.inputDirectory') }}</label>
              <div class="path-field">
                <n-input :value="mergeInputDir" readonly :placeholder="t('tools.chooseInputDirectory')" />
                <n-button secondary @click="pickFolder('merge-input')">
                  <template #icon><n-icon :component="FolderOpenOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.outputDirectory') }}</label>
              <div class="path-field">
                <n-input :value="mergeOutputDir" readonly :placeholder="t('tools.chooseOutputDirectory')" />
                <n-button secondary @click="pickFolder('merge-output')">
                  <template #icon><n-icon :component="FolderOpenOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>
            <n-alert type="info" :bordered="false">{{ t('tools.mergeOrderHint') }}</n-alert>
            <div class="tool-actions">
              <n-button
                type="primary"
                :loading="busyTool === 'merge'"
                :disabled="Boolean(busyTool) || !mergeInputDir || !mergeOutputDir"
                @click="runMerge"
              >
                {{ t('tools.startMerge') }}
              </n-button>
            </div>
          </section>
          <aside class="tool-card tool-card--side">
            <h3>{{ t('tools.processingStatus') }}</h3>
            <p>{{ t('tools.mergeHint') }}</p>
            <AudioToolStatus
              :busy="busyTool === 'merge'"
              :has-result="hasResult"
              :error="errorMessage"
              :progress="progress"
              :percentage="progressPercentage"
              :result="result"
              @reveal="revealPath"
            />
          </aside>
        </div>
      </n-tab-pane>

      <n-tab-pane name="sdr">
        <template #tab>
          <n-icon :component="AnalyticsOutline" />
          <span>{{ t('tools.sdrTitle') }}</span>
        </template>
        <div class="tool-layout">
          <section class="tool-card tool-card--main">
            <div class="tool-card__header">
              <div class="tool-icon"><n-icon :component="AnalyticsOutline" /></div>
              <div>
                <h2>{{ t('tools.sdrTitle') }}</h2>
                <p>{{ t('tools.sdrDescription') }}</p>
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.referenceAudio') }}</label>
              <div class="path-field">
                <n-input :value="referencePath" readonly :placeholder="t('tools.chooseReferenceAudio')" />
                <n-button secondary @click="pickSingleAudio('reference')">
                  <template #icon><n-icon :component="DocumentOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.estimatedAudio') }}</label>
              <div class="path-field">
                <n-input :value="estimatedPath" readonly :placeholder="t('tools.chooseEstimatedAudio')" />
                <n-button secondary @click="pickSingleAudio('estimated')">
                  <template #icon><n-icon :component="DocumentOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>
            <n-alert type="info" :bordered="false">{{ t('tools.sdrHint') }}</n-alert>
            <div class="tool-actions">
              <n-button
                type="primary"
                :loading="busyTool === 'sdr'"
                :disabled="Boolean(busyTool) || !referencePath || !estimatedPath"
                @click="runSdr"
              >
                {{ t('tools.startSdr') }}
              </n-button>
            </div>
          </section>
          <aside class="tool-card tool-card--side">
            <h3>{{ t('tools.analysisResult') }}</h3>
            <p>{{ t('tools.sdrResultHint') }}</p>
            <AudioToolStatus
              :busy="busyTool === 'sdr'"
              :has-result="hasResult"
              :error="errorMessage"
              :progress="progress"
              :percentage="progressPercentage"
              :result="result"
              @reveal="revealPath"
            />
          </aside>
        </div>
      </n-tab-pane>

      <n-tab-pane name="midi">
        <template #tab>
          <n-icon :component="MusicalNoteOutline" />
          <span>{{ t('tools.midiTitle') }}</span>
        </template>
        <div class="tool-layout">
          <section class="tool-card tool-card--main">
            <div class="tool-card__header">
              <div class="tool-icon"><n-icon :component="MusicalNoteOutline" /></div>
              <div>
                <h2>{{ t('tools.midiTitle') }}</h2>
                <p>{{ t('tools.midiDescription') }}</p>
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.vocalAudio') }}</label>
              <div class="path-field">
                <n-input :value="midiInputPath" readonly :placeholder="t('tools.chooseVocalAudio')" />
                <n-button secondary @click="pickSingleAudio('midi')">
                  <template #icon><n-icon :component="DocumentOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
            </div>
            <div class="form-section">
              <label>{{ t('tools.midiModel') }}</label>
              <div class="path-field">
                <n-input :value="midiModelPath" readonly :placeholder="t('tools.chooseMidiModel')" />
                <n-button secondary @click="pickMidiModel">
                  <template #icon><n-icon :component="DocumentOutline" /></template>
                  {{ t('common.browse') }}
                </n-button>
              </div>
              <span class="field-hint">{{ t('tools.midiModelHint') }}</span>
            </div>
            <div class="form-grid">
              <div class="form-section">
                <label>{{ t('tools.bpm') }}</label>
                <n-input-number v-model:value="midiBpm" :min="30" :max="300" :step="1" />
              </div>
              <div class="form-section">
                <label>{{ t('tools.outputDirectory') }}</label>
                <div class="path-field">
                  <n-input :value="midiOutputDir" readonly :placeholder="t('tools.chooseOutputDirectory')" />
                  <n-button secondary @click="pickFolder('midi-output')">
                    <template #icon><n-icon :component="FolderOpenOutline" /></template>
                    {{ t('common.browse') }}
                  </n-button>
                </div>
              </div>
            </div>
            <n-alert type="warning" :bordered="false">{{ t('tools.midiAccuracyHint') }}</n-alert>
            <div class="tool-actions">
              <n-button
                type="primary"
                :loading="busyTool === 'midi'"
                :disabled="Boolean(busyTool) || !midiInputPath || !midiModelPath || !midiOutputDir"
                @click="runMidi"
              >
                {{ t('tools.startMidi') }}
              </n-button>
            </div>
          </section>
          <aside class="tool-card tool-card--side">
            <h3>{{ t('tools.processingStatus') }}</h3>
            <p>{{ t('tools.midiHint') }}</p>
            <AudioToolStatus
              :busy="busyTool === 'midi'"
              :has-result="hasResult"
              :error="errorMessage"
              :progress="progress"
              :percentage="progressPercentage"
              :result="result"
              @reveal="revealPath"
            />
          </aside>
        </div>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<style scoped>
.tools-page {
  max-width: 1440px;
}

.tools-tabs :deep(.n-tabs-nav) {
  max-width: 760px;
}

.tools-tabs :deep(.n-tabs-tab__label) {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.tools-tabs :deep(.n-tab-pane) {
  padding-top: 18px;
}

.tool-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  align-items: start;
}

.tool-card {
  border: 1px solid var(--outline);
  border-radius: 16px;
  background: var(--surface-1);
}

.tool-card--main {
  padding: 22px;
}

.tool-card--side {
  padding: 18px;
  min-height: 220px;
}

.tool-card--side h3 {
  margin: 0;
  font-size: 15px;
}

.tool-card--side > p {
  margin: 7px 0 18px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.65;
}

.tool-card__header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.tool-card__header h2 {
  margin: 0;
  font-size: 18px;
}

.tool-card__header p {
  margin: 4px 0 0;
  color: var(--on-surface-muted);
  font-size: 13px;
}

.tool-icon {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 11px;
  border: 1px solid color-mix(in srgb, var(--primary-border) 55%, var(--outline));
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
  color: var(--primary-strong);
  font-size: 18px;
}

.form-section {
  min-width: 0;
  margin-bottom: 18px;
}

.form-section > label,
.field-heading > label {
  display: block;
  margin-bottom: 7px;
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
}

.field-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.field-heading > span,
.field-hint {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.field-hint {
  display: block;
  margin-top: 6px;
  line-height: 1.55;
}

.form-grid {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 14px;
}

.form-grid--four {
  grid-template-columns: repeat(4, minmax(120px, 1fr));
}

.path-field {
  display: flex;
  gap: 8px;
}

.path-field .n-input {
  min-width: 0;
}

.file-picker {
  width: 100%;
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border: 1px dashed color-mix(in srgb, var(--outline) 82%, var(--primary-border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 38%, var(--surface-1));
  color: var(--on-surface-muted);
  cursor: pointer;
}

.file-picker:hover:not(:disabled) {
  border-color: var(--primary-border);
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 20%, var(--surface-1));
}

.file-picker:disabled {
  opacity: 0.5;
  cursor: default;
}

.selected-files {
  max-height: 148px;
  overflow: auto;
  margin-top: 8px;
  border: 1px solid color-mix(in srgb, var(--outline) 74%, transparent);
  border-radius: 10px;
}

.selected-file {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 52%, transparent);
  font-size: 12px;
}

.selected-file:last-child {
  border-bottom: 0;
}

.selected-file span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selected-file button {
  display: grid;
  place-items: center;
  border: 0;
  padding: 3px;
  background: transparent;
  color: var(--on-surface-muted);
  cursor: pointer;
}

.selected-file button:hover {
  color: var(--danger);
}

.tool-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
}

.tool-actions .n-button {
  min-width: 132px;
}

@media (max-width: 1120px) {
  .tool-layout {
    grid-template-columns: 1fr;
  }

  .tool-card--side {
    min-height: 0;
  }

  .form-grid--four {
    grid-template-columns: repeat(2, minmax(150px, 1fr));
  }
}

@media (max-width: 760px) {
  .form-grid,
  .form-grid--four {
    grid-template-columns: 1fr;
  }

  .path-field {
    align-items: stretch;
  }
}
</style>
