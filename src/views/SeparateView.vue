<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { UnlistenFn } from '@tauri-apps/api/event'
import {
  CubeOutline,
  CheckmarkCircle,
  PlayOutline,
  MusicalNotesOutline,
  SearchOutline,
  FolderOutline,
  CloudUploadOutline,
  CloseOutline,
  SettingsOutline,
  OpenOutline,
} from '@vicons/ionicons5'
import { useModelStore } from '@/stores/model'
import { useTaskStore } from '@/stores/task'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { buildModelCategoryOptionsFromModels, getModelCategoryLabel } from '@/utils/modelCategory'

const { t, locale } = useI18n()
const message = useMessage()
const router = useRouter()
const task = useTaskStore()
const model = useModelStore()
const settings = useSettingsStore()
const app = useAppStore()

const {
  inputFiles,
  useTta,
  debug,
  batchSize,
  overlapSize,
  chunkSize,
  standardizeMode,
  normalize,
  vrWindowSize,
  vrAggression,
  vrEnablePostProcess,
  vrPostProcessThreshold,
  vrHighEndProcess,
} = storeToRefs(task)
const { selectedModel, downloadedModels, isLoading } = storeToRefs(model)

const isDragging = ref(false)
const showSettingsDrawer = ref(false)
const modelSearch = ref('')
const modelCategoryFilter = ref('')
let unlistenDragDrop: UnlistenFn | null = null

const formatOptions = [
  { label: 'WAV', value: 'wav' },
  { label: 'FLAC', value: 'flac' },
  { label: 'MP3', value: 'mp3' },
  { label: 'M4A', value: 'm4a' },
]

function getFileKindLabel(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv'].includes(ext)) return t('separate.videoFile')
  return t('separate.audioFile')
}

const wavBitDepthOptions = computed(() => [
  { label: t('audio.pcm16'), value: 'PCM_16' },
  { label: t('audio.pcm24'), value: 'PCM_24' },
  { label: t('audio.float'), value: 'FLOAT' },
])
const flacBitDepthOptions = computed(() => [
  { label: t('audio.pcm16'), value: 'PCM_16' },
  { label: t('audio.pcm24'), value: 'PCM_24' },
])
const bitRateOptions = computed(() => [
  { label: t('audio.bitrate128'), value: '128k' },
  { label: t('audio.bitrate192'), value: '192k' },
  { label: t('audio.bitrate256'), value: '256k' },
  { label: t('audio.bitrate320'), value: '320k' },
  { label: t('audio.bitrate512'), value: '512k' },
])
const m4aCodecOptions = computed(() => [
  { label: t('audio.codecAac'), value: 'aac' },
])
const standardizeModeOptions = computed(() => [
  { label: t('inference.standardizeDefault'), value: 'default' },
  { label: t('inference.standardizeEnabled'), value: 'enabled' },
  { label: t('inference.standardizeDisabled'), value: 'disabled' },
])
const selectedModelName = computed(() => String(selectedModel.value || ''))
const listedDownloadedModels = computed(() => {
  return [...downloadedModels.value].sort((a, b) => (
    a.name.localeCompare(b.name, locale.value === 'zh-CN' ? 'zh-CN' : 'en')
  ))
})
const selectedModelListItem = computed(() => listedDownloadedModels.value.find(item => item.name === selectedModelName.value) || null)
const modelDownloaded = computed(() => Boolean(selectedModelListItem.value))
const currentModelInfo = computed(() => {
  if (model.selectedInfo?.name === selectedModelName.value) return model.selectedInfo
  return selectedModelListItem.value
})
const currentModelType = computed(() => String(currentModelInfo.value?.modelType || '').trim().toLowerCase())
const isVrModel = computed(() => currentModelType.value === 'vr')
const isMssModel = computed(() => !isVrModel.value)
const modelCategoryOptions = computed(() => [
  { label: t('common.all'), value: '' },
  ...buildModelCategoryOptionsFromModels(listedDownloadedModels.value, locale.value),
])
const filteredDownloadedModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase()
  const selectedCategory = modelCategoryFilter.value.trim().toLowerCase()
  return listedDownloadedModels.value.filter((item) => {
    const matchesQuery = !query
      || item.name.toLowerCase().includes(query)
      || item.aliases.some(alias => alias.toLowerCase().includes(query))
      || item.architecture.toLowerCase().includes(query)
      || item.modelType?.toLowerCase().includes(query)
      || item.targetStem.toLowerCase().includes(query)
      || item.configTargetInstrument.toLowerCase().includes(query)
      || item.category.toLowerCase().includes(query)
      || item.categoryCn.toLowerCase().includes(query)
      || item.classificationBasis.toLowerCase().includes(query)
    const matchesCategory = !selectedCategory
      || item.category.toLowerCase() === selectedCategory
      || item.primaryCategory.toLowerCase() === selectedCategory
      || item.secondaryCategory.toLowerCase() === selectedCategory
    return matchesQuery && matchesCategory
  })
})

const normalizedOutputDir = computed(() => (settings.outputDir || 'results').trim() || 'results')
const outputPreview = computed(() => {
  const base = normalizedOutputDir.value.replace(/[\\/]$/, '')
  const separator = base.includes('\\') ? '\\' : '/'
  return settings.separateTaskOutputDir ? `${base}${separator}sep_${t('separate.taskIdPreview')}` : base
})
const formatLabel = computed(() => String(settings.defaultFormat || 'wav').toUpperCase())
const outputModeLabel = computed(() => settings.separateTaskOutputDir ? t('separate.outputModeSeparate') : t('separate.outputModeDirect'))
const outputSummaryPath = computed(() => shortenMiddle(outputPreview.value, 60))
const canStart = computed(() => inputFiles.value.length > 0 && modelDownloaded.value)

function getFileName(path: string) {
  return path.split(/[/\\]/).filter(Boolean).pop() || path
}

function categoryLabel(item: { categoryCn?: string; category?: string; primaryCategoryCn?: string; primaryCategory?: string } | null | undefined) {
  return getModelCategoryLabel(item, locale.value, t('common.notSet'))
}

function modelTargetLabel(item: {
  targetStem?: string
  configTargetInstrument?: string
} | null | undefined) {
  return item?.targetStem || item?.configTargetInstrument || t('common.notSet')
}

function modelArchitectureLabel(item: {
  architecture?: string
  modelType?: string | null
} | null | undefined) {
  return item?.architecture || item?.modelType || t('common.notSet')
}

function modelMetaLine(item: {
  targetStem?: string
  configTargetInstrument?: string
  architecture?: string
  modelType?: string | null
}) {
  return `${modelTargetLabel(item)} · ${modelArchitectureLabel(item)}`
}

function shortenMiddle(text: string, maxLength = 48) {
  if (text.length <= maxLength) return text
  const keep = Math.max(8, Math.floor((maxLength - 3) / 2))
  return `${text.slice(0, keep)}...${text.slice(-keep)}`
}

function handleSelectModel(item: (typeof listedDownloadedModels.value)[number]) {
  model.selectModel(item).catch(() => {})
}

watch(
  [listedDownloadedModels, selectedModel, isLoading],
  ([list, current, loading]) => {
    if (loading) return
    if (!list.length) return
    const valid = current && list.some((item) => item.name === current)
    if (!valid) {
      selectedModel.value = list[0].name
    }
  },
  { immediate: true },
)

onMounted(async () => {
  if (!app.envInfo && !app.envLoading) {
    app.checkEnvInBackground().catch(() => {})
  }
  try {
    unlistenDragDrop = await getCurrentWebview().onDragDropEvent(async (event) => {
      const type = event.payload.type
      if (type === 'over' || type === 'enter') {
        isDragging.value = true
      } else if (type === 'drop') {
        isDragging.value = false
        const paths = (event.payload as { paths?: string[] }).paths || []
        const added = await task.addPaths(paths)
        if (added > 0) message.success(t('separate.addedFiles', { count: added }))
        else message.warning(t('separate.noAudioAdded'))
      } else {
        isDragging.value = false
      }
    })
  } catch {
    // 非 Tauri 环境静默降级
  }
})

onBeforeUnmount(() => {
  if (unlistenDragDrop) unlistenDragDrop()
})

async function handlePickFiles() {
  const before = inputFiles.value.length
  await task.pickFiles()
  const added = inputFiles.value.length - before
  if (added > 0) message.success(t('separate.addedFiles', { count: added }))
}

async function handlePickFolder() {
  const count = await task.pickInputFolder()
  if (count > 0) message.success(t('separate.folderScanned', { count }))
  else message.warning(t('separate.folderEmpty'))
}

async function start() {
  if (!inputFiles.value.length) {
    message.warning(t('separate.startHintNoInput'))
    return
  }
  if (!modelDownloaded.value) {
    message.warning(t('separate.startHintModelMissing'))
    return
  }
  try {
    const result = await task.startSeparation()
    if (result && result.failed > 0) {
      message.warning(t('separate.batchPartial', { succeeded: result.succeeded, failed: result.failed }))
    } else {
      message.success(t('separate.batchStarted', { count: result?.succeeded ?? 1 }))
    }
    task.clearInputFiles()
    router.push('/tasks')
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('toast.taskFailed'))
  }
}
</script>

<template>
  <div class="page separate-page">
    <div class="page-header-compact separate-header">
      <div>
        <h1>{{ t('separate.title') }}</h1>
        <p>{{ t('separate.workspaceHint') }}</p>
      </div>
    </div>

    <div class="workspace-grid">
      <section class="config-panel config-panel--input">
        <div class="panel-heading">
          <div class="panel-heading__icon"><n-icon :component="MusicalNotesOutline" /></div>
          <div>
            <h2>{{ t('separate.input') }}</h2>
            <p>{{ t('separate.inputPanelHint') }}</p>
          </div>
        </div>

        <div class="button-row">
          <n-button secondary @click="handlePickFiles">
            <template #icon><n-icon :component="MusicalNotesOutline" /></template>
            {{ t('separate.chooseFiles') }}
          </n-button>
          <n-button secondary @click="handlePickFolder">
            <template #icon><n-icon :component="FolderOutline" /></template>
            {{ t('separate.chooseFolder') }}
          </n-button>
        </div>

        <div class="candidate" :class="{ 'candidate--dragging': isDragging }">
          <div class="candidate__head">
            <strong>{{ t('separate.candidateTitle') }}</strong>
            <span>{{ t('separate.candidateCount', { count: inputFiles.length }) }}</span>
            <n-button
              v-if="inputFiles.length"
              text
              size="small"
              type="error"
              @click="task.clearInputFiles()"
            >
              {{ t('separate.clearAll') }}
            </n-button>
          </div>

          <div v-if="inputFiles.length" class="candidate__list">
            <div v-for="path in inputFiles" :key="path" class="candidate__item">
              <n-icon :component="MusicalNotesOutline" class="candidate__item-icon" />
              <div class="candidate__item-main">
                <strong :title="getFileName(path)">{{ getFileName(path) }}</strong>
                <span class="candidate__item-kind">{{ getFileKindLabel(path) }}</span>
                <code :title="path">{{ shortenMiddle(path, 56) }}</code>
              </div>
              <n-button quaternary circle size="tiny" :title="t('separate.remove')" @click="task.removeInputFile(path)">
                <template #icon><n-icon :component="CloseOutline" /></template>
              </n-button>
            </div>
          </div>

          <div v-else class="candidate__empty">
            <div class="candidate__empty-icon"><n-icon :component="CloudUploadOutline" /></div>
            <span>{{ isDragging ? t('separate.dropHere') : t('separate.candidateEmpty') }}</span>
          </div>
        </div>
      </section>

      <section class="config-panel config-panel--model">
        <div class="panel-heading">
          <div class="panel-heading__icon"><n-icon :component="CubeOutline" /></div>
          <div class="panel-heading__main">
            <h2>{{ t('separate.model') }}</h2>
            <p>{{ t('separate.modelPanelHint') }}</p>
          </div>
          <n-button text class="panel-heading__action" @click="router.push('/models')">
            {{ t('separate.manageModelsInline') }}
          </n-button>
        </div>

        <div class="model-panel__body">
          <div v-if="downloadedModels.length" class="model-picker">
            <div class="model-picker__toolbar">
              <n-input
                v-model:value="modelSearch"
                clearable
                :placeholder="t('separate.modelSearchPlaceholder')"
              >
                <template #prefix>
                  <n-icon :component="SearchOutline" />
                </template>
              </n-input>
              <n-select
                class="model-picker__category-select"
                v-model:value="modelCategoryFilter"
                :menu-props="{ class: 'model-picker__category-menu' }"
                :options="modelCategoryOptions"
              />
            </div>

            <div class="model-picker__divider" />

            <div v-if="filteredDownloadedModels.length" class="model-picker__list" role="listbox" :aria-label="t('separate.model')">
              <button
                v-for="item in filteredDownloadedModels"
                :key="item.name"
                type="button"
                role="option"
                :aria-selected="selectedModelName === item.name"
                class="model-picker__item"
                :class="{ 'model-picker__item--active': selectedModelName === item.name }"
                @click="handleSelectModel(item)"
              >
                <div class="model-picker__item-main">
                  <div class="model-picker__item-title">
                    <strong :title="item.name">{{ item.name }}</strong>
                    <span class="model-picker__item-tag" :title="categoryLabel(item)">{{ categoryLabel(item) }}</span>
                  </div>
                  <div class="model-picker__item-sub" :title="modelMetaLine(item)">
                    {{ modelMetaLine(item) }}
                  </div>
                </div>
                <n-icon v-if="selectedModelName === item.name" class="model-picker__item-check" :component="CheckmarkCircle" />
              </button>
            </div>
            <div v-else class="model-picker__empty">
              {{ t('separate.modelSearchEmpty') }}
            </div>
          </div>
          <div v-if="selectedModelName && !modelDownloaded" class="model-info-card model-info-card--warn">
            {{ t('separate.startHintModelMissing') }}
          </div>
          <div v-else-if="!downloadedModels.length" class="model-panel__empty-state" :class="{ 'model-panel__empty-state--loading': isLoading }">
            <div class="model-panel__empty-visual">
              <n-spin v-if="isLoading" size="large" />
              <n-icon v-else :component="CubeOutline" />
            </div>
            <div class="model-panel__empty-main">
              <strong>{{ isLoading ? t('separate.modelPanelLoadingTitle') : t('separate.modelPanelEmptyTitle') }}</strong>
              <p>{{ isLoading ? t('separate.modelPanelLoadingDesc') : t('separate.modelPanelEmptyDesc') }}</p>
            </div>
            <div class="model-panel__empty-actions">
              <n-button secondary :loading="isLoading" @click="model.loadModels()">
                {{ t('separate.modelPanelPrimaryAction') }}
              </n-button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div class="summary-bar">
      <div class="summary-bar__content">
        <div class="summary-bar__topline">
          <strong>{{ t('separate.outputSummaryTitle') }}</strong>
          <n-button quaternary size="small" @click="task.revealPath(normalizedOutputDir)">
            <template #icon><n-icon :component="OpenOutline" /></template>
            {{ t('separate.openOutput') }}
          </n-button>
        </div>
        <div class="summary-bar__path" :title="outputPreview">{{ outputSummaryPath }}</div>
        <div class="summary-bar__details">
          <span>{{ t('separate.currentFormat') }} · {{ formatLabel }}</span>
          <span>{{ t('separate.outputMode') }} · {{ outputModeLabel }}</span>
        </div>
      </div>

      <div class="summary-bar__actions">
        <n-button secondary size="large" @click="showSettingsDrawer = true">
          <template #icon><n-icon :component="SettingsOutline" /></template>
          {{ t('separate.configParams') }}
        </n-button>
        <n-button type="primary" size="large" :disabled="!canStart" @click="start">
          <template #icon><n-icon :component="PlayOutline" /></template>
          {{ t('separate.startTask') }}
        </n-button>
      </div>
    </div>

    <n-drawer v-model:show="showSettingsDrawer" :width="520" placement="right">
      <n-drawer-content class="settings-drawer" :title="t('separate.settingsDrawerTitle')" closable>
        <div class="settings-drawer__content">
          <div class="settings-group">
            <div class="settings-group__head">
              <strong>{{ t('separate.outputLocationTitle') }}</strong>
              <span>{{ t('separate.outputLocationHint') }}</span>
            </div>

            <div class="output-grid">
              <div class="field-block field-block--wide">
                <label>{{ t('settings.outputDir') }}</label>
                <n-input v-model:value="settings.outputDir" :placeholder="t('separate.outputDefault')" clearable />
              </div>
              <div class="field-block">
                <label>{{ t('settings.defaultFormat') }}</label>
                <n-select v-model:value="settings.defaultFormat" :options="formatOptions" />
              </div>
            </div>

            <div class="button-row">
              <n-button secondary @click="settings.pickOutputDir()">
                {{ t('separate.chooseOutput') }}
              </n-button>
              <n-button secondary @click="task.revealPath(normalizedOutputDir)">
                {{ t('separate.openOutput') }}
              </n-button>
            </div>

            <div class="settings-row">
              <div class="settings-row__copy">
                <strong>{{ t('separate.separateTaskOutputDir') }}</strong>
                <span>{{ t('separate.separateTaskOutputDirHint') }}</span>
              </div>
              <n-switch v-model:value="settings.separateTaskOutputDir" />
            </div>

            <div class="output-preview">
              <span>{{ t('separate.outputPreview') }}</span>
              <code :title="outputPreview">{{ outputPreview }}</code>
            </div>
          </div>

          <div class="settings-group">
            <div class="settings-group__head">
              <strong>{{ t('separate.runOptionsTitle') }}</strong>
              <span>{{ t('separate.runOptionsHint') }}</span>
            </div>
            <div class="check-list">
              <n-checkbox v-model:checked="useTta">{{ t('separate.tta') }}</n-checkbox>
              <n-checkbox v-model:checked="debug">{{ t('separate.debug') }}</n-checkbox>
              <n-checkbox v-model:checked="normalize">{{ t('inference.normalize') }}</n-checkbox>
            </div>
          </div>

          <div class="settings-group">
            <div class="settings-group__head">
              <strong>{{ t('separate.audioQualityTitle') }} · {{ formatLabel }}</strong>
              <span>{{ t('separate.audioQualityEditable') }}</span>
            </div>
            <n-grid :cols="2" :x-gap="16" :y-gap="16" responsive="screen">
              <n-grid-item v-if="settings.defaultFormat === 'wav'">
                <div class="field-block">
                  <label>{{ t('audio.wavBitDepth') }}</label>
                  <n-select v-model:value="settings.wavBitDepth" :options="wavBitDepthOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="settings.defaultFormat === 'flac'">
                <div class="field-block">
                  <label>{{ t('audio.flacBitDepth') }}</label>
                  <n-select v-model:value="settings.flacBitDepth" :options="flacBitDepthOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="settings.defaultFormat === 'mp3'">
                <div class="field-block">
                  <label>{{ t('audio.mp3BitRate') }}</label>
                  <n-select v-model:value="settings.mp3BitRate" :options="bitRateOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="settings.defaultFormat === 'm4a'">
                <div class="field-block">
                  <label>{{ t('audio.m4aBitRate') }}</label>
                  <n-select v-model:value="settings.m4aBitRate" :options="bitRateOptions" />
                </div>
              </n-grid-item>
              <n-grid-item v-if="settings.defaultFormat === 'm4a'">
                <div class="field-block">
                  <label>{{ t('audio.m4aCodec') }}</label>
                  <n-select v-model:value="settings.m4aCodec" :options="m4aCodecOptions" />
                </div>
              </n-grid-item>
            </n-grid>
          </div>

          <div class="settings-group">
            <n-collapse :default-expanded-names="[]">
              <n-collapse-item :title="t('inference.advancedParams')" name="inference">
                <p class="advanced-hint">{{ t('separate.advancedPanelHint') }}</p>
                <n-grid :cols="2" :x-gap="16" :y-gap="16" responsive="screen">
                  <n-grid-item v-if="isMssModel">
                    <div class="field-block">
                      <label>{{ t('inference.batchSize') }}</label>
                      <n-input-number v-model:value="batchSize" :min="1" :max="32" style="width:100%" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="isMssModel">
                    <div class="field-block">
                      <label>{{ t('inference.overlapSize') }}</label>
                      <n-input-number v-model:value="overlapSize" :min="0" :max="128" style="width:100%" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="isMssModel">
                    <div class="field-block">
                      <label>{{ t('inference.chunkSize') }}</label>
                      <n-input-number v-model:value="chunkSize" :min="0" :max="1048576" :step="1024" style="width:100%" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="isMssModel">
                    <div class="field-block">
                      <label>{{ t('inference.standardize') }}</label>
                      <n-select v-model:value="standardizeMode" :options="standardizeModeOptions" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="isVrModel">
                    <div class="field-block">
                      <label>{{ t('inference.batchSize') }}</label>
                      <n-input-number v-model:value="batchSize" :min="1" :max="32" style="width:100%" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="isVrModel">
                    <div class="field-block">
                      <label>{{ t('inference.vrWindowSize') }}</label>
                      <n-input-number v-model:value="vrWindowSize" :min="0" :max="4096" style="width:100%" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="isVrModel">
                    <div class="field-block">
                      <label>{{ t('inference.vrAggression') }}</label>
                      <n-input-number v-model:value="vrAggression" :min="0" :max="100" style="width:100%" />
                    </div>
                  </n-grid-item>
                  <n-grid-item v-if="isVrModel">
                    <div class="field-block">
                      <label>{{ t('inference.vrPostProcessThreshold') }}</label>
                      <n-input-number v-model:value="vrPostProcessThreshold" :min="0" :max="1" :step="0.05" style="width:100%" />
                    </div>
                  </n-grid-item>
                </n-grid>
                <div v-if="isVrModel" class="check-list check-list--spaced">
                  <n-checkbox v-model:checked="vrEnablePostProcess">{{ t('inference.vrEnablePostProcess') }}</n-checkbox>
                  <n-checkbox v-model:checked="vrHighEndProcess">{{ t('inference.vrHighEndProcess') }}</n-checkbox>
                </div>
              </n-collapse-item>
            </n-collapse>
          </div>
        </div>

        <template #footer>
          <div class="drawer-footer">
            <n-button type="primary" @click="showSettingsDrawer = false">{{ t('common.close') }}</n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.separate-page {
  display: grid;
  gap: 12px;
  min-height: 0;
}

.separate-header {
  margin-bottom: 0;
}

.separate-header h1 {
  font-size: 22px;
}

.separate-header p {
  margin-top: 2px;
}

.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
  gap: 12px;
  align-items: stretch;
  height: clamp(420px, 62vh, 720px);
  min-height: 0;
}

.config-panel {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--outline) 78%, transparent);
  border-radius: 20px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 98%, transparent), color-mix(in srgb, var(--surface-1) 92%, var(--surface-2)));
  min-height: 0;
  height: 100%;
  overflow: hidden;
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.08);
}

.config-panel--input {
  grid-template-rows: auto auto minmax(0, 1fr);
}

.config-panel--model {
  grid-template-rows: auto minmax(0, 1fr);
}

.panel-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.panel-heading__main {
  min-width: 0;
  flex: 1;
}

.panel-heading__action {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--on-surface-muted);
}

.panel-heading__icon {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 12px;
  font-size: 19px;
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.panel-heading h2 {
  margin: 0;
  font-size: 16px;
  letter-spacing: -0.02em;
}

.panel-heading p {
  margin: 2px 0 0;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.candidate {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 8px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 76%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface-2) 46%, transparent);
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}

.candidate--dragging {
  border-color: var(--primary);
  border-style: dashed;
  background: color-mix(in srgb, var(--primary-soft) 28%, var(--surface-2));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--primary-border) 44%, transparent),
    0 12px 24px color-mix(in srgb, var(--primary-glow) 10%, transparent);
}

.candidate__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.candidate__head strong {
  font-size: 13px;
}

.candidate__head span {
  flex: 1;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.candidate__list {
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 8px;
  max-height: 100%;
  overflow-y: auto;
  padding-right: 2px;
}

.candidate__list,
.model-picker__list {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--outline) 70%, transparent) transparent;
}

.candidate__list::-webkit-scrollbar,
.model-picker__list::-webkit-scrollbar {
  width: 6px;
}

.candidate__list::-webkit-scrollbar-thumb,
.model-picker__list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--outline) 80%, transparent);
}

.candidate__list::-webkit-scrollbar-thumb:hover,
.model-picker__list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--on-surface-muted) 50%, transparent);
}

.candidate__list::-webkit-scrollbar-track,
.model-picker__list::-webkit-scrollbar-track {
  background: transparent;
}

.candidate__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
}

.candidate__item-icon {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--primary-strong);
}

.candidate__item-main {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 2px;
}

.candidate__item-kind {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 42%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 28%, transparent);
}

.candidate__item-main strong,
.candidate__item-main code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.candidate__item-main strong {
  font-size: 13px;
}

.candidate__item-main code {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.candidate__empty {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px 16px;
  text-align: center;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.6;
}

.candidate__empty-icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  font-size: 24px;
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 42%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 30%, transparent);
}

.model-panel__body {
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

.model-picker {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.model-picker__toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(180px, 0.7fr);
  gap: 8px;
}

.model-picker__divider {
  height: 1px;
  background: color-mix(in srgb, var(--outline) 78%, transparent);
}

.model-picker__list {
  min-height: 0;
  display: grid;
  gap: 4px;
  overflow-y: auto;
  max-height: min(340px, 42vh);
  padding: 6px;
  padding-right: 4px;
  border: 1px solid color-mix(in srgb, var(--outline) 76%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
}

.model-picker__item {
  min-width: 0;
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px 6px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, color 140ms ease;
}

.model-picker__item:hover {
  background: color-mix(in srgb, var(--surface-2) 66%, transparent);
}

.model-picker__item--active {
  border-color: color-mix(in srgb, var(--primary) 38%, transparent);
  background: color-mix(in srgb, var(--primary-soft) 20%, var(--surface-2));
  box-shadow: 0 8px 18px color-mix(in srgb, var(--primary-glow) 8%, transparent);
}

.model-picker__item--active::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 999px;
  background: var(--primary);
}

.model-picker__item-main {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 2px;
}

.model-picker__item-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-picker__item-title strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
}

.model-picker__item--active .model-picker__item-title strong {
  color: var(--primary-strong);
}

.model-picker__item-tag {
  flex: 0 0 auto;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--primary) 24%, transparent);
  background: color-mix(in srgb, var(--primary-soft) 26%, var(--surface-2));
  color: color-mix(in srgb, var(--primary-strong) 86%, var(--on-surface));
  font-size: 9px;
  line-height: 1.4;
}

.model-picker__item-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 10px;
}

.model-picker__item--active .model-picker__item-tag {
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
  color: color-mix(in srgb, var(--primary-strong) 78%, var(--on-surface-muted));
}

.model-picker__item--active .model-picker__item-sub {
  color: color-mix(in srgb, var(--primary-strong) 72%, var(--on-surface-muted));
}

.model-picker__item-check {
  flex: 0 0 auto;
  font-size: 14px;
  color: var(--primary);
}

.model-picker__empty {
  padding: 14px 12px;
  border: 1px dashed var(--outline);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-1) 92%, transparent);
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.model-picker__category-select {
  min-width: 0;
}

.model-picker__category-select :deep(.n-base-selection) {
  border-radius: 12px;
}

.model-picker__category-select :deep(.n-base-selection.n-base-selection--active) {
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
}

:deep(.model-picker__category-menu) {
  margin-top: 6px;
  border-radius: 12px;
  overflow: hidden;
}

.model-info-card {
  padding: 10px 12px;
  border: 1px dashed var(--outline);
  border-radius: 12px;
}

.model-info-card--warn {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 56%, var(--outline));
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  font-size: 12px;
  line-height: 1.6;
}

.model-panel__empty-state {
  position: relative;
  overflow: hidden;
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  min-height: 270px;
  padding: 28px 24px;
  border: 1px dashed color-mix(in srgb, var(--outline) 82%, var(--primary-border));
  border-radius: 22px;
  background:
    radial-gradient(circle at top, color-mix(in srgb, var(--primary-soft) 8%, transparent), transparent 52%),
    linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 96%, transparent), color-mix(in srgb, var(--surface-1) 90%, transparent));
  text-align: center;
}

.model-panel__empty-state::before {
  content: '';
  position: absolute;
  inset: -30% -20%;
  background:
    radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--primary-soft) 16%, transparent), transparent 32%),
    radial-gradient(circle at 80% 30%, color-mix(in srgb, var(--info) 12%, transparent), transparent 30%),
    radial-gradient(circle at 50% 75%, color-mix(in srgb, var(--primary) 10%, transparent), transparent 34%);
  opacity: 0.9;
  pointer-events: none;
}

.model-panel__empty-state--loading::before {
  opacity: 0.7;
}

.model-panel__empty-visual {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 68px;
  height: 68px;
  border: 1px solid color-mix(in srgb, var(--primary) 22%, var(--outline));
  border-radius: 22px;
  background: color-mix(in srgb, var(--surface-1) 78%, var(--primary-soft));
  color: var(--primary);
  box-shadow: 0 14px 30px color-mix(in srgb, var(--primary) 10%, transparent);
}

.model-panel__empty-visual :deep(.n-spin-body) {
  color: var(--primary);
}

.model-panel__empty-visual .n-icon {
  font-size: 30px;
}

.model-panel__empty-main {
  position: relative;
  z-index: 1;
  max-width: 340px;
}

.model-panel__empty-main strong {
  display: block;
  font-size: 15px;
  line-height: 1.4;
}

.model-panel__empty-main p {
  margin-top: 8px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.75;
}

.model-panel__empty-actions {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.model-panel__empty-actions .n-button {
  min-width: 130px;
}

.summary-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--outline);
  border-radius: 20px;
  background: color-mix(in srgb, var(--surface-1) 88%, transparent);
}

.summary-bar__content {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 6px;
}

.summary-bar__topline {
  display: flex;
  align-items: center;
  gap: 10px;
}

.summary-bar__topline strong {
  font-size: 13px;
}

.summary-bar__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.summary-bar__details {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.summary-bar__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.settings-drawer__content {
  display: grid;
  gap: 14px;
  min-height: 0;
  padding-top: 18px;
  padding-bottom: 8px;
}

.settings-drawer :deep(.n-drawer-header) {
  padding: 18px 20px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 86%, transparent);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
}

.settings-drawer :deep(.n-drawer-header__main) {
  font-size: 15px;
  font-weight: 600;
}

.settings-drawer :deep(.n-drawer-body-content-wrapper) {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.settings-drawer :deep(.n-drawer-body-content) {
  min-height: 0;
  padding: 0 20px 20px;
}

.settings-drawer :deep(.n-drawer-footer) {
  padding: 14px 20px 16px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 86%, transparent);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
}

.field-block {
  display: grid;
  gap: 6px;
}

.field-block label {
  font-size: 12px;
  color: var(--on-surface-muted);
}

.output-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  gap: 12px;
}

.settings-group {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--outline);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface-2) 62%, transparent);
}

.settings-group__head {
  display: grid;
  gap: 3px;
}

.settings-group__head strong {
  font-size: 13px;
}

.settings-group__head span {
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--outline);
  border-radius: 12px;
  background: var(--surface-1);
}

.settings-row__copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.settings-row__copy strong {
  font-size: 13px;
}

.settings-row__copy span {
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.output-preview {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--outline);
  border-radius: 12px;
  background: var(--surface-1);
}

.output-preview span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.output-preview code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.advanced-hint {
  margin: 0 0 12px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.check-list {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 18px;
}

.check-list--spaced {
  margin-top: 14px;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

@media (max-width: 1100px) {
  .workspace-grid,
  .output-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace-grid {
    height: auto;
  }

  .model-picker__toolbar {
    grid-template-columns: minmax(0, 1fr);
  }

  .summary-bar {
    flex-direction: column;
    align-items: stretch;
  }

  .summary-bar__actions {
    justify-content: flex-end;
    flex-wrap: wrap;
  }
}

@media (max-width: 620px) {
  .settings-drawer__content,
  .settings-drawer :deep(.n-drawer-body-content) {
    padding-left: 16px;
    padding-right: 16px;
  }

  .settings-drawer :deep(.n-drawer-header),
  .settings-drawer :deep(.n-drawer-footer) {
    padding-left: 16px;
    padding-right: 16px;
  }
}

@media (max-width: 720px) {
  .candidate {
    height: 300px;
  }

  .model-picker {
    height: 300px;
  }
}
</style>
