<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useMessage, useDialog } from 'naive-ui'
import {
  SearchOutline,
  DownloadOutline,
  CheckmarkCircleOutline,
  CloudDownloadOutline,
  RefreshOutline,
  CubeOutline,
  TrashOutline,
  FolderOpenOutline,
  ServerOutline,
} from '@vicons/ionicons5'
import { useModelStore, type ModelDefaultInferenceParams, type ModelEntry } from '@/stores/model'
import { useSettingsStore } from '@/stores/settings'
import { useTaskStore } from '@/stores/task'
import { formatBytes } from '@/utils/format'
import { buildModelCategoryOptionsFromPairs, getModelCategoryLabel } from '@/utils/modelCategory'

const { t, locale } = useI18n()
const message = useMessage()
const dialog = useDialog()
const modelStore = useModelStore()
const settings = useSettingsStore()
const taskStore = useTaskStore()
const {
  filteredModels,
  selectedInfo,
  selectedModel,
  search,
  supportedOnly,
  category,
  categories,
  categoriesCn,
  isLoading,
  detailLoading,
  modelDir,
  downloadTasks,
  deleteTasks,
  modelStorageSummary,
  storageLoading,
  batchDeleteState,
  residualCleanupState,
} = storeToRefs(modelStore)

const showDetail = ref(false)

const downloadedOnly = ref(false)
const page = ref(1)
const pageSize = ref(24)
const pageSizeOptions = [12, 24, 48, 96]
const showStorage = ref(false)
const storageSearch = ref('')
const storageSort = ref<'size-desc' | 'size-asc' | 'name-asc' | 'name-desc'>('size-desc')
const storageDownloadedOnly = ref(true)
const selectedStorageModels = ref<string[]>([])
const inferenceDraft = ref<Required<Pick<ModelDefaultInferenceParams, 'batch_size' | 'overlap_size' | 'chunk_size'>>>({
  batch_size: 1,
  overlap_size: 0,
  chunk_size: 0,
})

const categoryOptions = computed(() => {
  return buildModelCategoryOptionsFromPairs(categories.value, categoriesCn.value, locale.value, t('common.all'))
})

const sortedModels = computed(() => {
  const list = downloadedOnly.value
    ? filteredModels.value.filter((m) => m.downloaded)
    : filteredModels.value
  return [...list].sort((a, b) => {
    if (a.downloaded !== b.downloaded) return a.downloaded ? -1 : 1
    return 0
  })
})
const pagedModels = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return sortedModels.value.slice(start, start + pageSize.value)
})

const storageModels = computed(() => {
  const q = storageSearch.value.trim().toLowerCase()
  const list = modelStorageSummary.value?.models || []
  return [...list]
    .filter((item) => (!storageDownloadedOnly.value || item.downloaded)
      && (!q || item.name.toLowerCase().includes(q)))
    .sort((a, b) => {
      if (storageSort.value === 'size-desc') return b.sizeBytes - a.sizeBytes
      if (storageSort.value === 'size-asc') return a.sizeBytes - b.sizeBytes
      if (storageSort.value === 'name-desc') return b.name.localeCompare(a.name)
      return a.name.localeCompare(b.name)
    })
})

const allStorageModelsByName = computed(() => new Map((modelStorageSummary.value?.models || []).map((item) => [item.name, item])))

const selectedStorageBytes = computed(() => selectedStorageModels.value
  .map((name) => allStorageModelsByName.value.get(name))
  .filter((item): item is NonNullable<typeof item> => Boolean(item))
  .reduce((sum, item) => sum + item.sizeBytes, 0))

const hasDeletingSelectedStorageModels = computed(() => selectedStorageModels.value.some((name) => isDeletingModel(name)))

const batchDeleteProgress = computed(() => {
  if (!batchDeleteState.value.totalModels) return 0
  const currentTask = batchDeleteState.value.currentModel ? deleteTasks.value[batchDeleteState.value.currentModel] : null
  const currentFraction = currentTask && currentTask.totalFiles > 0
    ? currentTask.completedFiles / currentTask.totalFiles
    : 0
  return Math.max(0, Math.min(100, Math.round(((batchDeleteState.value.completedModels + currentFraction) / batchDeleteState.value.totalModels) * 100)))
})

function setStorageSelected(name: string, checked: boolean) {
  selectedStorageModels.value = checked
    ? Array.from(new Set([...selectedStorageModels.value, name]))
    : selectedStorageModels.value.filter((item) => item !== name)
}

watch([search, category, supportedOnly, downloadedOnly, pageSize], () => {
  page.value = 1
})

watch(sortedModels, (list) => {
  const maxPage = Math.max(1, Math.ceil(list.length / pageSize.value))
  if (page.value > maxPage) page.value = maxPage
})

watch(selectedInfo, (info) => {
  syncInferenceDraft(info)
}, { immediate: true })

function categoryLabel(model: ModelEntry) {
  return getModelCategoryLabel(model, locale.value, '—')
}

function normalizedTagValue(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase()
}

function showModelTypeTag(model: ModelEntry) {
  if (!model.modelType) return false
  return normalizedTagValue(model.modelType) !== normalizedTagValue(model.architecture)
}

function hasRequiredCompanionFiles(model: ModelEntry) {
  return Boolean(model.configPath || (model.auxiliaryPaths && model.auxiliaryPaths.length > 0))
}

function requiredModelFileCount(model: ModelEntry) {
  return 1 + (model.configPath ? 1 : 0) + (model.auxiliaryPaths?.length || 0)
}

function isPartiallyAvailable(model: ModelEntry) {
  if (model.downloaded || !hasRequiredCompanionFiles(model) || !Array.isArray(model.missingPaths)) return false
  const missingCount = model.missingPaths.length
  const totalCount = requiredModelFileCount(model)
  return missingCount > 0 && missingCount < totalCount
}

function modelStatusLabel(model: ModelEntry) {
  if (!model.supported) return t('models.unsupported')
  if (model.downloaded) return t('models.downloaded')
  if (isPartiallyAvailable(model)) return t('models.partial')
  return t('models.notDownloaded')
}

function modelStatusType(model: ModelEntry) {
  if (!model.supported) return 'warning'
  if (model.downloaded) return 'success'
  if (isPartiallyAvailable(model)) return 'info'
  return 'default'
}

function downloadStatusMessage(modelName: string) {
  const task = downloadTasks.value[modelName]
  if (!task) return ''
  if (task.status === 'interrupted') return t('models.downloadInterrupted')
  return task.message || task.status
}

function deleteStatusMessage(modelName: string) {
  const task = deleteTasks.value[modelName]
  if (!task) return ''
  return task.message || t('models.deleting')
}

function isDeletingModel(modelName: string) {
  return deleteTasks.value[modelName]?.status === 'deleting'
}

function inferenceValue(model: ModelEntry | null | undefined, key: keyof typeof inferenceDraft.value, fallback: number) {
  const value = model?.defaultInferenceParams?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function syncInferenceDraft(model: ModelEntry | null | undefined) {
  inferenceDraft.value = {
    batch_size: inferenceValue(model, 'batch_size', 1),
    overlap_size: inferenceValue(model, 'overlap_size', 0),
    chunk_size: inferenceValue(model, 'chunk_size', 0),
  }
}

function hasInferenceOverride(model: ModelEntry | null | undefined) {
  return Boolean(model?.name && modelStore.getModelInferenceOverrides(model.name))
}

function saveInferenceDefaults() {
  if (!selectedInfo.value) return
  modelStore.setModelInferenceOverrides(selectedInfo.value.name, inferenceDraft.value)
  if (selectedModel.value === selectedInfo.value.name) {
    taskStore.applySelectedModelDefaults(modelStore.selectedInfo?.defaultInferenceParams, modelStore.selectedInfo?.modelType)
  }
  message.success(t('models.inferenceDefaultsSaved'))
}

function resetInferenceDefaults() {
  if (!selectedInfo.value) return
  modelStore.resetModelInferenceOverrides(selectedInfo.value.name)
  syncInferenceDraft(modelStore.selectedInfo)
  if (selectedModel.value === selectedInfo.value?.name) {
    taskStore.applySelectedModelDefaults(modelStore.selectedInfo?.defaultInferenceParams, modelStore.selectedInfo?.modelType)
  }
  message.success(t('models.inferenceDefaultsReset'))
}

async function loadModels() {
  try {
    await modelStore.loadModels()
  } catch {
    message.error(modelStore.error || t('models.empty'))
  }
}

function selectModel(model: ModelEntry) {
  showDetail.value = true
  void modelStore.selectModel(model).catch((err) => {
    message.error(err instanceof Error ? err.message : String(err))
  })
}

function handleDetailDrawerUpdate(value: boolean) {
  showDetail.value = value
  if (!value) {
    selectedInfo.value = null
  }
}

async function downloadModel(model: ModelEntry, event: MouseEvent) {
  event.stopPropagation()
  try {
    await modelStore.downloadModel(model.name)
    message.success(t('models.downloadStarted'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function cancelDownloadModel(model: ModelEntry, event: MouseEvent) {
  event.stopPropagation()
  await modelStore.cancelDownload(model.name)
}

function confirmDeleteModel(model: ModelEntry, event?: MouseEvent) {
  event?.stopPropagation()
  if (isDeletingModel(model.name)) return
  dialog.warning({
    title: t('models.deleteConfirmTitle'),
    content: t('models.deleteConfirmContent'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      modelStore.deleteModel(model.name).catch((err) => {
        message.error(err instanceof Error ? err.message : String(err))
      })
    },
  })
}


async function openStorageManager() {
  showStorage.value = true
  try {
    await modelStore.loadModelStorageSummary()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function openModelDir() {
  const path = modelStorageSummary.value?.modelDir || modelDir.value || settings.modelDir
  if (path) void taskStore.revealPath(path)
}

function confirmBatchDelete() {
  const names = selectedStorageModels.value.filter((name) => !isDeletingModel(name))
  if (!names.length) return
  dialog.warning({
    title: t('models.storageBatchDeleteConfirmTitle'),
    content: t('models.storageBatchDeleteConfirmContent', {
      count: names.length,
      size: formatBytes(selectedStorageBytes.value),
    }),
    positiveText: t('models.storageBatchDelete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      modelStore.deleteModels(names).then(() => {
        selectedStorageModels.value = selectedStorageModels.value.filter((name) => isDeletingModel(name))
        if (modelStore.batchDeleteState.failedModels.length) {
          message.warning(t('models.batchDeleteWithFailures', { count: modelStore.batchDeleteState.failedModels.length }))
        } else {
          message.success(t('models.batchDeleteSuccess'))
        }
      }).catch((err) => message.error(err instanceof Error ? err.message : String(err)))
    },
  })
}

function confirmCleanupResidual() {
  const summary = modelStorageSummary.value
  if (!summary?.residualFiles.length) return
  dialog.warning({
    title: t('models.storageCleanupConfirmTitle'),
    content: t('models.storageCleanupConfirmContent', {
      count: summary.residualFiles.length,
      size: formatBytes(summary.residualBytes),
    }),
    positiveText: t('models.storageCleanup'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      modelStore.cleanupModelResidualFiles().catch((err) => message.error(err instanceof Error ? err.message : String(err)))
    },
  })
}

watch(deleteTasks, (value) => {
  Object.values(value).forEach((task) => {
    if (task.status === 'done') {
      if (task.source !== 'batch') {
        message.success(t('models.deleteSuccess'))
        modelStore.clearDeleteTask(task.model)
      }
    } else if (task.status === 'error') {
      if (task.source !== 'batch') {
        message.error(`${t('models.deleteFailed')}: ${task.message}`)
        modelStore.clearDeleteTask(task.model)
      }
    }
  })
}, { deep: true })

watch(residualCleanupState, (state) => {
  if (state.status === 'done' && !state.active) {
    message.success(t('models.storageCleanupSuccess'))
    modelStore.resetResidualCleanupState()
  } else if (state.status === 'error' && !state.active && state.message) {
    message.error(`${t('models.cleanupFailed')}: ${state.message}`)
    modelStore.resetResidualCleanupState()
  }
}, { deep: true })

onMounted(() => {
  showDetail.value = false
  if (!modelStore.models.length) void loadModels()
})
</script>

<template>
  <div class="page">
    <div class="page-header-compact">
      <div>
        <h1>{{ t('models.title') }}</h1>
        <p>{{ t('models.subtitle') }}</p>
      </div>
      <div class="header-actions">
        <n-button secondary @click="openStorageManager">
          <template #icon><n-icon :component="ServerOutline" /></template>
          {{ t('models.storageManage') }}
        </n-button>
        <n-button secondary :loading="isLoading" @click="loadModels">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          {{ t('models.load') }}
        </n-button>
      </div>
    </div>

    <!-- Filter Toolbar -->
    <div class="toolbar">
      <div class="toolbar-row">
        <n-input
          v-model:value="search"
          :placeholder="t('models.search')"
          clearable
          class="search-input"
        >
          <template #prefix><n-icon :component="SearchOutline" /></template>
        </n-input>
        <n-select
          v-model:value="category"
          :options="categoryOptions"
          size="small"
          class="category-select"
          :consistent-menu-width="false"
        />
        <div class="toolbar-actions">
          <n-switch v-model:value="downloadedOnly" size="small" />
          <span class="text-sm text-muted">{{ t('models.downloadedOnly') }}</span>
          <n-divider vertical style="margin:0 4px" />
          <n-switch v-model:value="supportedOnly" size="small" />
          <span class="text-sm text-muted">{{ t('models.supportedOnly') }}</span>
          <n-tag size="small" :bordered="false" type="info" round>
            {{ sortedModels.length }}
          </n-tag>
        </div>
      </div>
    </div>

    <!-- Body: Model Grid + Detail Drawer -->
    <div class="models-body">
      <!-- Loading Skeleton -->
      <div v-if="isLoading" class="model-grid">
        <div v-for="i in 6" :key="i" class="skel-card">
          <n-skeleton text style="width:70%;height:18px;margin-bottom:12px" />
          <n-skeleton text style="width:40%;height:14px;margin-bottom:16px" />
          <n-skeleton text style="width:100%;height:12px;margin-bottom:6px" />
          <n-skeleton text style="width:80%;height:12px" />
        </div>
      </div>

      <!-- Empty State -->
      <div v-else-if="!sortedModels.length" class="empty-state">
        <n-icon :component="CubeOutline" size="48" color="var(--on-surface-muted)" />
        <p class="text-muted">{{ search || category || downloadedOnly ? t('models.searchEmpty') : t('models.empty') }}</p>
        <n-button v-if="!search && !category && !downloadedOnly && !modelStore.models.length" secondary @click="loadModels">
          {{ t('models.load') }}
        </n-button>
      </div>

      <!-- Model Grid -->
      <template v-else>
        <div class="model-grid">
          <div
            v-for="model in pagedModels"
            :key="model.name"
            :class="['model-card', {
              'model-card--selected': selectedModel === model.name,
              'model-card--unsupported': !model.supported
            }]"
            @click="selectModel(model)"
          >
          <!-- Card Header -->
          <div class="mc-header">
            <span class="mc-name">{{ model.name }}</span>
            <n-tag
              :bordered="false"
              size="tiny"
              :type="modelStatusType(model)"
              round
            >
              {{ modelStatusLabel(model) }}
            </n-tag>
          </div>

          <!-- Meta Tags -->
          <div class="mc-tags">
            <n-tag v-if="model.architecture" :bordered="false" size="tiny" type="info" round>
              {{ model.architecture }}
            </n-tag>
            <n-tag v-if="showModelTypeTag(model)" :bordered="false" size="tiny" round>
              {{ model.modelType }}
            </n-tag>
            <span class="mc-size">{{ formatBytes(model.sizeBytes) }}</span>
          </div>

          <!-- Key Info -->
          <div class="mc-meta">
            <div class="mc-meta-item">
              <span class="mc-label">{{ t('models.targetStem') }}</span>
              <span class="mc-value">{{ model.targetStem || '—' }}</span>
            </div>
            <div class="mc-meta-item">
              <span class="mc-label">{{ t('models.category') }}</span>
              <span class="mc-value">{{ categoryLabel(model) || '—' }}</span>
            </div>
          </div>

          <!-- Footer -->
          <div class="mc-footer">
            <div v-if="isDeletingModel(model.name)" class="mc-dl">
              <div class="mc-dl-info">
                <div class="mc-dl-status">
                  <span class="mc-dl-dot mc-dl-dot--downloading" />
                  <span class="mc-dl-msg">{{ deleteStatusMessage(model.name) || t('models.deleting') }}</span>
                </div>
                <span class="mc-dl-pct">{{ deleteTasks[model.name]?.progress || 0 }}%</span>
              </div>
              <n-progress
                :percentage="deleteTasks[model.name]?.progress || 0"
                :show-indicator="false"
                :height="8"
                :border-radius="4"
                type="line"
                :rail-color="'var(--surface-3)'"
              />
              <div class="mc-dl-files">
                {{ t('models.deleteProgress', { completed: deleteTasks[model.name]?.completedFiles || 0, total: deleteTasks[model.name]?.totalFiles || 0 }) }}
              </div>
            </div>
            <!-- Download button -->
            <n-button
              v-else-if="model.supported && !model.downloaded && (!downloadTasks[model.name] || downloadTasks[model.name].status === 'done')"
              block
              secondary
              size="small"
              @click="downloadModel(model, $event)"
            >
              <template #icon><n-icon :component="DownloadOutline" /></template>
              {{ t('common.download') }}
            </n-button>

            <!-- Download progress -->
            <div v-else-if="!model.downloaded && downloadTasks[model.name] && downloadTasks[model.name].status !== 'done'" class="mc-dl">
              <div class="mc-dl-info">
                <div class="mc-dl-status">
                  <span :class="['mc-dl-dot', `mc-dl-dot--${downloadTasks[model.name].status}`]" />
                  <span class="mc-dl-msg">{{ downloadStatusMessage(model.name) }}</span>
                </div>
                <span class="mc-dl-pct">{{ downloadTasks[model.name].progress }}%</span>
              </div>
              <n-progress
                :percentage="downloadTasks[model.name].progress"
                :show-indicator="false"
                :height="8"
                :border-radius="4"
                type="line"
                :color="downloadTasks[model.name].status === 'error' ? 'var(--danger)' : downloadTasks[model.name].status === 'interrupted' ? 'var(--warning)' : 'var(--primary)'"
                :rail-color="'var(--surface-3)'"
              />
              <div v-if="downloadTasks[model.name].totalFiles > 1" class="mc-dl-files">
                {{ t('models.fileProgress', { completed: downloadTasks[model.name].completedFiles, total: downloadTasks[model.name].totalFiles }) }}
              </div>
              <div class="mc-dl-actions">
                <n-button
                  v-if="downloadTasks[model.name].status === 'downloading'"
                  block
                  size="tiny"
                  secondary
                  @click="cancelDownloadModel(model, $event)"
                >
                  {{ t('common.cancel') }}
                </n-button>
                <template v-else-if="['paused','cancelled','error','interrupted'].includes(downloadTasks[model.name].status)">
                  <n-button
                    size="tiny"
                    type="primary"
                    style="flex:1"
                    @click="downloadModel(model, $event)"
                  >
                    {{ downloadTasks[model.name]?.status === 'interrupted' ? t('models.continueDownload') : t('common.resume') }}
                  </n-button>
                  <n-button
                    size="tiny"
                    type="error"
                    secondary
                    @click="confirmDeleteModel(model, $event)"
                  >
                    <template #icon><n-icon :component="TrashOutline" /></template>
                  </n-button>
                </template>
              </div>
            </div>

            <!-- Already downloaded -->
            <div v-else-if="model.downloaded" class="mc-done-row">
              <div class="mc-done">
                <n-icon :component="CheckmarkCircleOutline" color="var(--success)" size="16" />
                <span>{{ t('models.downloaded') }}</span>
              </div>
              <n-button
                size="tiny"
                quaternary
                type="error"
                @click="confirmDeleteModel(model, $event)"
              >
                <template #icon><n-icon :component="TrashOutline" /></template>
              </n-button>
            </div>
          </div>
          </div>
        </div>
        <div class="pagination-row">
          <span class="text-sm text-muted">{{ t('models.pageSummary', { total: sortedModels.length }) }}</span>
          <n-pagination
            v-model:page="page"
            v-model:page-size="pageSize"
            :item-count="sortedModels.length"
            :page-sizes="pageSizeOptions"
            show-size-picker
          />
        </div>
      </template>
    </div>

    <!-- Detail Drawer -->
    <n-drawer :show="showDetail" :width="380" placement="right" @update:show="handleDetailDrawerUpdate">
      <n-drawer-content :title="t('models.detail')" closable>
        <template v-if="selectedInfo">
          <div class="detail-content">
            <strong class="detail-name">{{ selectedInfo.name }}</strong>

            <div class="detail-badges">
              <n-tag v-if="detailLoading" :bordered="false" size="small" type="info" round>
                {{ t('common.refreshing') }}
              </n-tag>
              <n-tag v-if="selectedInfo.architecture" :bordered="false" size="small" type="info" round>
                {{ selectedInfo.architecture }}
              </n-tag>
              <n-tag
                :bordered="false"
                size="small"
                :type="modelStatusType(selectedInfo)"
                round
              >
                {{ modelStatusLabel(selectedInfo) }}
              </n-tag>
            </div>

            <n-divider style="margin:16px 0" />

            <div class="detail-grid">
              <div class="detail-row">
                <span class="detail-label">{{ t('models.type') }}</span>
                <span class="detail-val">{{ selectedInfo.modelType || '—' }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">{{ t('models.targetStem') }}</span>
                <span class="detail-val">{{ selectedInfo.targetStem || '—' }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">{{ t('models.size') }}</span>
                <span class="detail-val">{{ formatBytes(selectedInfo.sizeBytes) }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">{{ t('models.category') }}</span>
                <span class="detail-val">{{ categoryLabel(selectedInfo) || '—' }}</span>
              </div>
              <div v-if="selectedInfo.aliases?.length" class="detail-row">
                <span class="detail-label">{{ t('models.aliases') }}</span>
                <span class="detail-val">{{ selectedInfo.aliases.join(', ') }}</span>
              </div>
            </div>

            <n-divider style="margin:16px 0" />

            <div class="detail-inference">
              <div class="detail-section-head">
                <strong>{{ t('models.inferenceDefaultsTitle') }}</strong>
                <span>{{ t('models.inferenceDefaultsHint') }}</span>
              </div>
              <div class="inference-default-grid">
                <label class="inference-default-field">
                  <span>{{ t('inference.batchSize') }}</span>
                  <n-input-number v-model:value="inferenceDraft.batch_size" :min="1" :max="32" style="width:100%" />
                </label>
                <label class="inference-default-field">
                  <span>{{ t('inference.overlapSize') }}</span>
                  <n-input-number v-model:value="inferenceDraft.overlap_size" :min="0" :max="1048576" style="width:100%" />
                </label>
                <label class="inference-default-field">
                  <span>{{ t('inference.chunkSize') }}</span>
                  <n-input-number v-model:value="inferenceDraft.chunk_size" :min="0" :max="1048576" :step="1024" style="width:100%" />
                </label>
              </div>
              <div class="inference-default-actions">
                <div>
                  <n-button size="small" secondary :disabled="!hasInferenceOverride(selectedInfo)" @click="resetInferenceDefaults">
                    {{ t('models.inferenceDefaultsReset') }}
                  </n-button>
                  <n-button size="small" type="primary" @click="saveInferenceDefaults">
                    {{ t('common.save') }}
                  </n-button>
                </div>
              </div>
            </div>

            <n-divider style="margin:16px 0" />

            <div class="text-sm">
              <div class="detail-label" style="margin-bottom:6px">{{ t('models.path') }}</div>
              <code class="detail-path">{{ selectedInfo.modelPath }}</code>
            </div>
            <div v-if="isPartiallyAvailable(selectedInfo) && selectedInfo.missingPaths?.length" class="text-sm" style="margin-top:12px">
              <div class="detail-label" style="margin-bottom:6px">{{ t('models.partialHintTitle') }}</div>
              <div class="text-muted">{{ t('models.partialHint') }}</div>
              <ul class="detail-missing-list">
                <li v-for="path in selectedInfo.missingPaths" :key="path">
                  <code class="detail-path">{{ path }}</code>
                </li>
              </ul>
            </div>
          </div>
        </template>

        <template #footer>
          <div class="drawer-footer" v-if="selectedInfo">
            <!-- Not downloaded, no active task: show download -->
            <n-button
              v-if="selectedInfo.supported && !selectedInfo.downloaded && (!downloadTasks[selectedInfo.name] || downloadTasks[selectedInfo.name]?.status === 'done')"
              block
              type="primary"
              @click="downloadModel(selectedInfo!, $event)"
            >
              <template #icon><n-icon :component="CloudDownloadOutline" /></template>
              {{ t('common.download') }}
            </n-button>
            <!-- Downloading: show cancel -->
            <n-button
              v-if="downloadTasks[selectedInfo.name]?.status === 'downloading'"
              block
              secondary
              @click="cancelDownloadModel(selectedInfo!, $event)"
            >
              {{ t('common.cancel') }}
            </n-button>
            <!-- Paused/Cancelled/Error: show resume + delete -->
            <template v-if="!selectedInfo.downloaded && downloadTasks[selectedInfo.name] && ['paused','cancelled','error','interrupted'].includes(downloadTasks[selectedInfo.name]!.status)">
              <n-button
                block
                type="primary"
                @click="downloadModel(selectedInfo!, $event)"
              >
                {{ selectedInfo && downloadTasks[selectedInfo.name]?.status === 'interrupted' ? t('models.continueDownload') : t('common.resume') }}
              </n-button>
              <n-button
                block
                type="error"
                secondary
                @click="confirmDeleteModel(selectedInfo!)"
              >
                <template #icon><n-icon :component="TrashOutline" /></template>
                {{ t('models.delete') }}
              </n-button>
            </template>
            <!-- Downloaded: show status + delete -->
            <template v-if="isDeletingModel(selectedInfo.name)">
              <div class="mc-dl">
                <div class="mc-dl-info">
                  <div class="mc-dl-status">
                    <span class="mc-dl-dot mc-dl-dot--downloading" />
                    <span class="mc-dl-msg">{{ deleteStatusMessage(selectedInfo.name) || t('models.deleting') }}</span>
                  </div>
                  <span class="mc-dl-pct">{{ deleteTasks[selectedInfo.name]?.progress || 0 }}%</span>
                </div>
                <n-progress
                  :percentage="deleteTasks[selectedInfo.name]?.progress || 0"
                  :show-indicator="false"
                  :height="8"
                  :border-radius="4"
                  type="line"
                  :rail-color="'var(--surface-3)'"
                />
                <div class="mc-dl-files">
                  {{ t('models.deleteProgress', { completed: deleteTasks[selectedInfo.name]?.completedFiles || 0, total: deleteTasks[selectedInfo.name]?.totalFiles || 0 }) }}
                </div>
              </div>
            </template>
            <template v-else-if="selectedInfo.downloaded && (!downloadTasks[selectedInfo.name] || downloadTasks[selectedInfo.name]?.status === 'done')">
              <n-button
                block
                secondary
                disabled
              >
                <template #icon><n-icon :component="CheckmarkCircleOutline" /></template>
                {{ t('models.downloaded') }}
              </n-button>
              <n-button
                block
                type="error"
                secondary
                @click="confirmDeleteModel(selectedInfo!)"
              >
                <template #icon><n-icon :component="TrashOutline" /></template>
                {{ t('models.delete') }}
              </n-button>
            </template>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>

    <n-drawer v-model:show="showStorage" :width="760" placement="right">
      <n-drawer-content :title="t('models.storageTitle')" closable>
        <div class="storage-panel">
          <div class="storage-summary">
            <div class="storage-stat">
              <span>{{ t('models.storageTotal') }}</span>
              <strong>{{ formatBytes(modelStorageSummary?.totalBytes || 0) }}</strong>
            </div>
            <div class="storage-stat">
              <span>{{ t('models.storageDownloadedCount') }}</span>
              <strong>{{ modelStorageSummary?.downloadedCount || 0 }}</strong>
            </div>
            <div class="storage-stat">
              <span>{{ t('models.storageResidual') }}</span>
              <strong>{{ formatBytes(modelStorageSummary?.residualBytes || 0) }}</strong>
            </div>
          </div>

          <div class="storage-dir">
            <span class="text-muted">{{ t('models.modelDir') }}:</span>
            <code>{{ modelStorageSummary?.modelDir || modelDir || settings.modelDir || '?' }}</code>
          </div>

          <div class="storage-toolbar">
            <n-input v-model:value="storageSearch" :placeholder="t('models.storageSearch')" clearable>
              <template #prefix><n-icon :component="SearchOutline" /></template>
            </n-input>
            <n-select
              v-model:value="storageSort"
              :options="[
                { label: t('models.storageSortSizeDesc'), value: 'size-desc' },
                { label: t('models.storageSortSizeAsc'), value: 'size-asc' },
                { label: t('models.storageSortNameAsc'), value: 'name-asc' },
                { label: t('models.storageSortNameDesc'), value: 'name-desc' },
              ]"
              style="width:160px"
            />
            <n-switch v-model:value="storageDownloadedOnly" size="small" />
            <span class="text-sm text-muted">{{ t('models.downloadedOnly') }}</span>
          </div>

          <div class="storage-actions">
            <n-button size="small" secondary :loading="storageLoading" @click="modelStore.loadModelStorageSummary({ force: true })">
              <template #icon><n-icon :component="RefreshOutline" /></template>
              {{ t('models.storageRefresh') }}
            </n-button>
            <n-button size="small" secondary @click="openModelDir">
              <template #icon><n-icon :component="FolderOpenOutline" /></template>
              {{ t('models.openModelDir') }}
            </n-button>
            <n-button
              size="small"
              type="error"
              secondary
              :disabled="!selectedStorageModels.length || hasDeletingSelectedStorageModels || batchDeleteState.active || residualCleanupState.active"
              @click="confirmBatchDelete"
            >
              {{ t('models.storageBatchDelete') }}
              <span v-if="selectedStorageModels.length">（{{ selectedStorageModels.length }} / {{ formatBytes(selectedStorageBytes) }}）</span>
            </n-button>
            <n-button
              size="small"
              type="warning"
              secondary
              :disabled="!(modelStorageSummary?.residualFiles.length) || batchDeleteState.active || residualCleanupState.active"
              @click="confirmCleanupResidual"
            >
              {{ t('models.storageCleanup') }}
            </n-button>
          </div>

          <div v-if="batchDeleteState.active" class="storage-progress-card">
            <strong>{{ t('models.batchDeleting', { count: batchDeleteState.totalModels }) }}</strong>
            <span class="text-muted">{{ batchDeleteState.completedModels }} / {{ batchDeleteState.totalModels }}</span>
            <div class="text-sm text-muted">{{ batchDeleteState.currentModel }}</div>
            <div v-if="batchDeleteState.currentModel && deleteTasks[batchDeleteState.currentModel]" class="mc-dl-files">
              {{ t('models.deleteProgress', { completed: deleteTasks[batchDeleteState.currentModel]?.completedFiles || 0, total: deleteTasks[batchDeleteState.currentModel]?.totalFiles || 0 }) }}
            </div>
            <n-progress
              :percentage="batchDeleteProgress"
              :show-indicator="false"
              :height="8"
              :border-radius="4"
              type="line"
              :rail-color="'var(--surface-3)'"
            />
          </div>

          <div v-if="residualCleanupState.active" class="storage-progress-card">
            <strong>{{ t('models.cleanupInProgress') }}</strong>
            <span class="text-muted">{{ t('models.deleteProgress', { completed: residualCleanupState.completedFiles, total: residualCleanupState.totalFiles }) }}</span>
            <n-progress
              :percentage="residualCleanupState.progress"
              :show-indicator="false"
              :height="8"
              :border-radius="4"
              type="line"
              :rail-color="'var(--surface-3)'"
            />
          </div>

          <div class="storage-list">
            <label
              v-for="item in storageModels"
              :key="item.name"
              class="storage-row"
            >
              <n-checkbox
                :checked="selectedStorageModels.includes(item.name)"
                :disabled="item.sizeBytes <= 0 || isDeletingModel(item.name) || batchDeleteState.active || residualCleanupState.active"
                @update:checked="(checked: boolean) => setStorageSelected(item.name, checked)"
              />
              <div class="storage-row__main">
                <strong>{{ item.name }}</strong>
                <span>{{ item.files.filter((file) => file.exists).length }} files</span>
              </div>
              <n-tag size="small" :bordered="false" :type="item.downloaded ? 'success' : 'default'">
                {{ item.downloaded ? t('models.downloaded') : t('models.notDownloaded') }}
              </n-tag>
              <strong class="storage-row__size">{{ formatBytes(item.sizeBytes || item.expectedSizeBytes) }}</strong>
            </label>
            <div v-if="!storageModels.length" class="empty-state storage-empty">
              <n-icon :component="CubeOutline" size="36" color="var(--on-surface-muted)" />
              <span class="text-muted">{{ t('models.searchEmpty') }}</span>
            </div>
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
/* ===== Toolbar ===== */
.toolbar {
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.search-input {
  max-width: 380px;
  flex: 1;
  min-width: 200px;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

/* ===== Category Select ===== */
.category-select {
  width: 160px;
  flex-shrink: 0;
}

/* ===== Layout ===== */
.models-body {
  display: flex;
  flex-direction: column;
}

.model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  min-height: 200px;
}

.pagination-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 16px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 0;
  color: var(--on-surface-muted);
}

/* ===== Model Card ===== */
.model-card {
  cursor: pointer;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 76%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 98%, transparent), color-mix(in srgb, var(--surface-1) 92%, var(--surface-2)));
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.model-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.14);
  border-color: color-mix(in srgb, var(--outline) 90%, var(--primary-border));
}

.model-card--selected {
  border-color: var(--primary) !important;
  background: linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 14%, var(--surface-1)), color-mix(in srgb, var(--surface-1) 90%, var(--surface-2)));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--primary-border) 44%, transparent),
    0 10px 24px color-mix(in srgb, var(--primary-glow) 12%, transparent);
}

.model-card--unsupported {
  opacity: 0.55;
}

/* Card header */
.mc-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.mc-name {
  font-size: 13px;
  font-weight: 600;
  word-break: break-word;
  flex: 1;
  min-width: 0;
  line-height: 1.4;
}

/* Tags row */
.mc-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mc-size {
  font-size: 11px;
  color: var(--on-surface-muted);
  margin-left: auto;
}

/* Meta info */
.mc-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
}

.mc-meta-item {
  display: flex;
  gap: 6px;
  min-width: 0;
}

.mc-label {
  color: var(--on-surface-muted);
  flex-shrink: 0;
}

.mc-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Footer */
.mc-footer {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--outline);
}

/* Download progress */
.mc-dl {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mc-dl-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.mc-dl-status {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.mc-dl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--primary);
  animation: pulse 1.5s infinite;
}

.mc-dl-dot--downloading {
  background: var(--primary);
}

.mc-dl-dot--error {
  background: var(--danger);
  animation: none;
}

.mc-dl-dot--paused,
.mc-dl-dot--cancelled,
.mc-dl-dot--interrupted {
  background: var(--warning);
  animation: none;
}

.mc-dl-dot--done {
  background: var(--success);
  animation: none;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.mc-dl-msg {
  font-size: 11px;
  color: var(--on-surface-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mc-dl-pct {
  font-size: 13px;
  font-weight: 600;
  color: var(--on-surface);
  flex-shrink: 0;
  margin-left: 8px;
}

.mc-dl-files {
  font-size: 11px;
  color: var(--on-surface-muted);
}

.mc-dl-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.mc-done {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: var(--success);
  padding: 4px 0;
}

.mc-done-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* ===== Drawer Footer ===== */
.drawer-footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ===== Skeleton ===== */
.skel-card {
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--outline);
  background: var(--surface-1);
}

/* ===== Detail Drawer ===== */
.detail-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-name {
  font-size: 16px;
  font-weight: 600;
  word-break: break-word;
  line-height: 1.4;
}

.detail-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.detail-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  gap: 12px;
}

.detail-label {
  color: var(--on-surface-muted);
  flex-shrink: 0;
}

.detail-val {
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-path {
  font-size: 11px;
  word-break: break-all;
  color: var(--on-surface-muted);
  background: var(--surface-2);
  padding: 8px 10px;
  border-radius: 8px;
  display: block;
}

.detail-section-head {
  display: grid;
  gap: 4px;
  margin-bottom: 10px;
}

.detail-section-head strong {
  font-size: 13px;
}

.detail-section-head span {
  font-size: 12px;
  color: var(--on-surface-muted);
  line-height: 1.5;
}

.detail-inference {
  display: grid;
  gap: 10px;
}

.inference-default-grid {
  display: grid;
  gap: 10px;
}

.inference-default-field {
  display: grid;
  gap: 6px;
}

.inference-default-field > span {
  font-size: 12px;
  color: var(--on-surface-muted);
}

.inference-default-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.inference-default-actions > div {
  display: flex;
  align-items: center;
  gap: 8px;
}


.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.storage-panel {
  display: grid;
  gap: 14px;
}

.storage-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.storage-stat {
  padding: 14px;
  border: 1px solid var(--outline);
  border-radius: 12px;
  background: var(--surface-1);
}

.storage-stat span {
  display: block;
  font-size: 12px;
  color: var(--on-surface-muted);
}

.storage-stat strong {
  display: block;
  margin-top: 6px;
  font-size: 18px;
}

.storage-dir {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
  font-size: 12px;
}

.storage-dir code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
}

.storage-toolbar,
.storage-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.storage-toolbar .n-input {
  flex: 1;
  min-width: 220px;
}

.storage-list {
  display: grid;
  gap: 8px;
  max-height: 56vh;
  overflow: auto;
  padding-right: 4px;
}

.storage-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--outline);
  background: var(--surface-1);
}

.storage-row__main {
  min-width: 0;
}

.storage-row__main strong,
.storage-row__main span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.storage-row__main span {
  margin-top: 4px;
  font-size: 12px;
  color: var(--on-surface-muted);
}

.storage-row__size {
  font-size: 13px;
  white-space: nowrap;
}

.storage-empty {
  padding: 32px 0;
}

.storage-progress-card {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--outline);
  background: var(--surface-1);
}

/* ===== Responsive ===== */
@media (max-width: 900px) {
  .search-input {
    max-width: 100%;
  }

  .model-grid {
    grid-template-columns: 1fr;
  }
}
</style>
