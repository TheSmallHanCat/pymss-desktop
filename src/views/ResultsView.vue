<script setup lang="ts">
import { computed, h, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ChevronDownOutline,
  FolderOpenOutline,
  FolderOutline,
  DocumentTextOutline,
  ColorWandOutline,
  SearchOutline,
  SwapVerticalOutline,
  TimeOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { useTaskStore, type SeparationTask } from '@/stores/task'
import { useEditorStore } from '@/stores/editor'
import { usePagedSelection } from '@/composables/usePagedSelection'
import { NCheckbox, useDialog, useMessage } from 'naive-ui'

type ResultSort = 'time_desc' | 'time_asc' | 'name_asc' | 'name_desc'

const { t } = useI18n()
const task = useTaskStore()
const editor = useEditorStore()
const message = useMessage()
const dialog = useDialog()

const search = ref('')
const sortBy = ref<ResultSort>('time_desc')
const expandedIds = ref<string[]>([])

const sortOptions = [
  { label: t('results.sortTimeDesc'), value: 'time_desc' },
  { label: t('results.sortTimeAsc'), value: 'time_asc' },
  { label: t('results.sortNameAsc'), value: 'name_asc' },
  { label: t('results.sortNameDesc'), value: 'name_desc' },
]

const filteredResults = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  const list = task.resultTasks.filter((item) => {
    if (!keyword) return true
    const fileName = getFileName(item.input)
    const haystack = [
      fileName,
      item.model,
      item.output,
      ...item.outputs.map((output) => output.stem),
      ...item.outputs.map((output) => output.path),
    ].join(' ').toLowerCase()
    return haystack.includes(keyword)
  })

  return [...list].sort((a, b) => {
    switch (sortBy.value) {
      case 'time_asc':
        return a.updatedAt - b.updatedAt
      case 'name_asc':
        return getFileName(a.input).localeCompare(getFileName(b.input), 'zh-CN')
      case 'name_desc':
        return getFileName(b.input).localeCompare(getFileName(a.input), 'zh-CN')
      case 'time_desc':
      default:
        return b.updatedAt - a.updatedAt
    }
  })
})
const pagedSelection = usePagedSelection(filteredResults, {
  initialPageSize: 24,
  pageSizeOptions: [12, 24, 48, 96],
})
const {
  selecting,
  selectedIds: selectedResultIds,
  selectedSet: selectedResultSet,
  page,
  pageSize,
  pageSizeOptions,
  allSelected: allResultsSelected,
  someSelected: someResultsSelected,
  toggleSelecting,
  toggleSelection: toggleResultSelection,
  toggleSelectPage: toggleSelectAllResults,
  ensureItemPage,
} = pagedSelection
const pagedResults = computed(() => pagedSelection.pagedItems.value)

watch([search, sortBy, pageSize], () => {
  page.value = 1
})

function getFileName(path: string) {
  return path.split(/[/\\]/).pop() || path
}

function resultCardId(item: Pick<SeparationTask, 'id'>) {
  return `result-card-${item.id}`
}

function openResultDir(item: SeparationTask) {
  task.revealPath(item.output)
}

async function openInEditor(item: SeparationTask) {
  try {
    const project = await editor.ensureProjectForTask(item, { loadIntoSession: false })
    await editor.openProjectWindow(project.id)
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('editor.notFound'))
  }
}

// 删除结果时仅删除当前结果对应的输出文件，避免误删共享输出目录
function trashTargets(item: SeparationTask) {
  const seen = new Set<string>()
  return item.outputs
    .map((output) => output.path?.trim())
    .filter((path): path is string => Boolean(path))
    .filter((path) => {
      if (seen.has(path)) return false
      seen.add(path)
      return true
    })
}

function trashTargetsForItems(items: SeparationTask[]) {
  const seen = new Set<string>()
  return items.flatMap((item) => trashTargets(item)).filter((path) => {
    if (seen.has(path)) return false
    seen.add(path)
    return true
  })
}

type RemoveMessageMode = 'single' | 'multiple'

function confirmRemoveListOnly(failedCount: number, totalCount: number, mode: RemoveMessageMode) {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    dialog.warning({
      title: t('results.removeFilesConfirmTitle'),
      content: t(mode === 'single' ? 'results.removeFilesConfirmContentSingle' : 'results.removeFilesConfirmContentMultiple', {
        failed: failedCount,
        total: totalCount,
      }),
      positiveText: t('results.removeListOnlyAction'),
      negativeText: t('results.keepResultAction'),
      positiveButtonProps: { type: 'error' },
      negativeButtonProps: { secondary: true },
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    })
  })
}

function handleRemoveResult(item: SeparationTask) {
  const deleteFiles = ref(false)
  dialog.warning({
    title: t('results.removeTitle'),
    content: () => h('div', { style: 'display:grid;gap:12px;' }, [
      h('span', t('results.removeContent')),
      h(NCheckbox, {
        checked: deleteFiles.value,
        'onUpdate:checked': (value: boolean) => { deleteFiles.value = value },
      }, { default: () => t('results.removeDeleteFiles') }),
    ]),
    positiveText: t('results.removeAction'),
    negativeText: t('common.cancel'),
    positiveButtonProps: { type: 'error' },
    onPositiveClick: async () => {
      if (!deleteFiles.value) {
        task.removeResult(item.id)
        message.success(t('results.removeSuccess'))
        return
      }

      const targets = trashTargets(item)
      if (!targets.length) {
        task.removeResult(item.id)
        message.warning(t('results.removeNoFilesSingle'))
        return
      }

      try {
        const result = await task.trashPaths(targets)
        if (!result.failed.length) {
          task.removeResult(item.id)
          message.success(t('results.removeFilesSuccessSingle'))
          return
        }

        const removeListOnly = await confirmRemoveListOnly(result.failed.length, targets.length, 'single')
        if (!removeListOnly) {
          message.warning(t('results.removeFilesKeptSingle'))
          return
        }
        task.removeResult(item.id)
        if (result.failed.length === targets.length) {
          message.warning(t('results.removeFilesAllFailedListOnly'))
        } else {
          message.warning(t('results.removeFilesPartialListOnly', { count: result.failed.length }))
        }
      } catch (error) {
        const removeListOnly = await confirmRemoveListOnly(targets.length, targets.length, 'single')
        if (!removeListOnly) {
          message.error(error instanceof Error ? error.message : t('results.removeFilesFailed'))
          return
        }
        task.removeResult(item.id)
        message.warning(t('results.removeFilesAllFailedListOnly'))
      }
    },
  })
}

function handleRemoveSelected() {
  const ids = [...selectedResultIds.value]
  if (!ids.length) return
  const items = task.resultTasks.filter((item) => ids.includes(item.id))
  const deleteFiles = ref(false)
  dialog.warning({
    title: t('results.removeSelectedTitle'),
    content: () => h('div', { style: 'display:grid;gap:12px;' }, [
      h('span', t('results.removeSelectedContent', { count: ids.length })),
      h(NCheckbox, {
        checked: deleteFiles.value,
        'onUpdate:checked': (value: boolean) => { deleteFiles.value = value },
      }, { default: () => t('results.removeDeleteFiles') }),
    ]),
    positiveText: t('results.removeSelectedPositive'),
    negativeText: t('common.cancel'),
    positiveButtonProps: { type: 'error' },
    onPositiveClick: async () => {
      const finishRemove = (silent = false) => {
        const removed = task.removeResults(ids)
        if (!silent && removed > 0) {
          message.success(t('results.removeSelectedSuccess', { count: removed }))
        }
        selectedResultIds.value = []
        selecting.value = false
      }

      if (!deleteFiles.value) {
        finishRemove()
        return
      }

      const targets = trashTargetsForItems(items)
      if (!targets.length) {
        finishRemove(true)
        message.warning(t('results.removeNoFilesMultiple'))
        return
      }

      try {
        const result = await task.trashPaths(targets)
        if (!result.failed.length) {
          finishRemove(true)
          message.success(t('results.removeFilesSuccessMultiple'))
          return
        }

        const removeListOnly = await confirmRemoveListOnly(result.failed.length, targets.length, 'multiple')
        if (!removeListOnly) {
          message.warning(t('results.removeFilesKeptMultiple'))
          return
        }
        finishRemove(true)
        if (result.failed.length === targets.length) {
          message.warning(t('results.removeFilesAllFailedListOnly'))
        } else {
          message.warning(t('results.removeFilesPartialListOnly', { count: result.failed.length }))
        }
      } catch (error) {
        const removeListOnly = await confirmRemoveListOnly(targets.length, targets.length, 'multiple')
        if (!removeListOnly) {
          message.error(error instanceof Error ? error.message : t('results.removeFilesFailed'))
          return
        }
        finishRemove(true)
        message.warning(t('results.removeFilesAllFailedListOnly'))
      }
    },
  })
}

function isExpanded(id: string) {
  return expandedIds.value.includes(id)
}

function toggleExpanded(id: string) {
  expandedIds.value = isExpanded(id)
    ? expandedIds.value.filter((item) => item !== id)
    : [...expandedIds.value, id]
}

function ensureExpanded(id: string) {
  if (!isExpanded(id)) {
    expandedIds.value = [...expandedIds.value, id]
  }
}

function shortenPath(value: string) {
  if (value.length <= 92) return value
  return `${value.slice(0, 34)}…${value.slice(-44)}`
}

function scrollToFocusedResult(id: string | null) {
  if (!id) return
  ensureExpanded(id)
  ensureItemPage(id)
  nextTick(() => {
    const target = document.getElementById(resultCardId({ id }))
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

watch(() => task.focusedResultTaskId, (value) => {
  if (value) {
    scrollToFocusedResult(value)
    task.focusResultTask(null)
  }
})

onMounted(() => {
  if (task.focusedResultTaskId) {
    scrollToFocusedResult(task.focusedResultTaskId)
    task.focusResultTask(null)
  }
})

function formatTime(value: number) {
  return new Date(value).toLocaleString()
}
</script>

<template>
  <div class="page results-page">
    <div class="page-header-compact results-page__header">
      <div>
        <h1>{{ t('results.title') }}</h1>
        <p>{{ t('results.subtitle') }}</p>
      </div>
      <n-button v-if="task.resultTasks.length" secondary @click="toggleSelecting">
        {{ selecting ? t('results.batchExit') : t('results.batchSelect') }}
      </n-button>
    </div>

    <div v-if="task.resultTasks.length" class="results-toolbar">
      <n-input
        v-model:value="search"
        class="results-toolbar__search"
        clearable
        :placeholder="t('results.searchPlaceholder')"
      >
        <template #prefix><n-icon :component="SearchOutline" /></template>
      </n-input>

      <n-select
        v-model:value="sortBy"
        class="results-toolbar__sort"
        size="small"
        :options="sortOptions"
      >
        <template #arrow><n-icon :component="SwapVerticalOutline" /></template>
      </n-select>

      <span class="results-toolbar__count">{{ filteredResults.length }} / {{ task.resultTasks.length }}</span>
    </div>

    <div v-if="selecting && filteredResults.length" class="results-batchbar">
      <n-checkbox
        :checked="allResultsSelected"
        :indeterminate="someResultsSelected"
        @update:checked="toggleSelectAllResults"
      >
        {{ t('results.selectPage') }}
      </n-checkbox>
      <span class="results-batchbar__count">{{ t('results.selectedCount', { count: selectedResultIds.length }) }}</span>
      <n-button
        size="small"
        type="error"
        :disabled="!selectedResultIds.length"
        @click="handleRemoveSelected"
      >
        <template #icon><n-icon :component="TrashOutline" /></template>
        {{ t('results.removeSelected') }}
      </n-button>
    </div>

    <div v-if="!task.resultTasks.length" class="results-empty">
      <n-icon :component="FolderOutline" size="46" />
      <strong>{{ t('results.empty') }}</strong>
      <span>{{ t('results.emptyHint') }}</span>
    </div>

    <div v-else-if="!filteredResults.length" class="results-empty">
      <n-icon :component="SearchOutline" size="42" />
      <strong>{{ t('results.noMatchTitle') }}</strong>
      <span>{{ t('results.noMatchHint') }}</span>
    </div>

    <div v-else class="results-list">
      <section
        v-for="item in pagedResults"
        :id="resultCardId(item)"
        :key="item.id"
        class="result-row"
        :class="{ 'result-row--selectable': selecting, 'result-row--selected': selectedResultSet.has(item.id) }"
      >
        <n-checkbox
          v-if="selecting"
          class="result-row__check"
          :checked="selectedResultSet.has(item.id)"
          @update:checked="toggleResultSelection(item.id)"
          @click.stop
        />
        <button class="result-row__main" type="button" @click="selecting ? toggleResultSelection(item.id) : toggleExpanded(item.id)">
          <span class="result-row__icon">
            <n-icon :component="DocumentTextOutline" size="18" />
          </span>

          <span class="result-row__body">
            <strong>{{ getFileName(item.input) }}</strong>
            <span class="result-row__meta">
              <span>{{ item.model }}</span>
              <span>{{ item.outputs.length }} stem</span>
              <span class="result-row__time"><n-icon :component="TimeOutline" /> {{ formatTime(item.updatedAt) }}</span>
            </span>
            <span class="result-row__path">{{ shortenPath(item.output) }}</span>
          </span>

          <span class="result-row__toggle" :class="{ 'result-row__toggle--open': isExpanded(item.id) }">
            <n-icon :component="ChevronDownOutline" />
          </span>
        </button>

        <div v-if="!selecting" class="result-row__actions">
          <n-button size="small" type="primary" @click="openInEditor(item)">
            <template #icon><n-icon :component="ColorWandOutline" /></template>
            {{ t('results.openInEditor') }}
          </n-button>
          <n-button size="small" type="primary" secondary @click="openResultDir(item)">
            <template #icon><n-icon :component="FolderOpenOutline" /></template>
            {{ t('results.openDirectory') }}
          </n-button>
          <n-button size="small" quaternary type="error" @click="handleRemoveResult(item)">
            <template #icon><n-icon :component="TrashOutline" /></template>
            {{ t('results.removeAction') }}
          </n-button>
        </div>

        <n-collapse-transition :show="isExpanded(item.id)">
          <div class="result-row__details">
            <div v-for="output in item.outputs" :key="output.path" class="stem-line">
              <span>{{ output.stem }}</span>
              <span class="stem-line__path">{{ output.path }}</span>
            </div>
          </div>
        </n-collapse-transition>
      </section>
    </div>

    <div v-if="filteredResults.length" class="results-pagination">
      <n-pagination
        v-model:page="page"
        v-model:page-size="pageSize"
        :item-count="filteredResults.length"
        :page-sizes="pageSizeOptions"
        show-size-picker
      />
    </div>
  </div>
</template>

<style scoped>
.results-page {
  display: grid;
  gap: 14px;
}

.results-page__header {
  margin-bottom: 4px;
}

.results-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 210px auto;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--outline);
  border-radius: 16px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--primary-soft) 44%, transparent), transparent 48%),
    color-mix(in srgb, var(--surface-1) 88%, transparent);
}

.results-toolbar__count {
  min-width: 66px;
  text-align: right;
  font-size: 12px;
  color: var(--on-surface-muted);
}

.results-list {
  display: grid;
  gap: 10px;
}

.results-pagination {
  display: flex;
  justify-content: flex-end;
}

.results-batchbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--primary-border) 60%, var(--outline));
  background: var(--primary-softer);
}

.results-batchbar__count {
  margin-right: auto;
  font-size: 13px;
  color: var(--on-surface-muted);
}

.result-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--outline);
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-1) 92%, transparent);
  transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
}

.result-row--selectable {
  grid-template-columns: auto minmax(0, 1fr);
}

.result-row--selected {
  border-color: color-mix(in srgb, var(--primary-border) 90%, transparent);
  background: var(--primary-softer);
}

.result-row__check {
  flex-shrink: 0;
}

.result-row:hover {
  border-color: color-mix(in srgb, var(--primary) 34%, var(--outline));
  background: color-mix(in srgb, var(--surface-1) 82%, var(--primary-soft));
  transform: translateY(-1px);
}

.result-row__main {
  min-width: 0;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 28px;
  align-items: center;
  gap: 12px;
  border: 0;
  padding: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.result-row__icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.result-row__body {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.result-row__body strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  line-height: 1.25;
}

.result-row__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 12px;
  font-family: inherit;
}

.result-row__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.result-row__time {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.result-row__toggle {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: var(--on-surface-muted);
  background: var(--surface-2);
  transition: transform 180ms ease, color 180ms ease, background 180ms ease;
}

.result-row__toggle--open {
  color: var(--primary-strong);
  background: var(--primary-soft);
  transform: rotate(180deg);
}

.result-row__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.result-row__details {
  grid-column: 1 / -1;
  display: grid;
  gap: 8px;
  padding: 12px 0 2px 54px;
}

.stem-line {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  padding: 9px 10px;
  border-radius: 12px;
  background: var(--surface-2);
}

.stem-line span {
  color: var(--primary-strong);
  font-size: 12px;
  font-weight: 600;
}

.stem-line__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 12px;
  font-family: inherit;
}

.results-empty {
  min-height: 260px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  border: 1px dashed var(--outline);
  border-radius: 20px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-1) 70%, transparent);
}

.results-empty strong {
  color: var(--on-surface);
  font-size: 15px;
}

.results-empty span {
  font-size: 13px;
}

@media (max-width: 980px) {
  .results-toolbar {
    grid-template-columns: 1fr;
  }

  .results-toolbar__count {
    text-align: left;
  }

  .results-pagination {
    justify-content: flex-start;
  }

  .result-row {
    grid-template-columns: 1fr;
  }

  .result-row__actions {
    justify-content: flex-start;
    padding-left: 54px;
  }

  .result-row__details {
    padding-left: 0;
  }
}

@media (max-width: 640px) {
  .result-row__main {
    grid-template-columns: 36px minmax(0, 1fr) 28px;
  }

  .result-row__icon {
    width: 36px;
    height: 36px;
    border-radius: 12px;
  }

  .result-row__actions {
    padding-left: 0;
  }

  .stem-line {
    grid-template-columns: 1fr;
    gap: 5px;
  }
}
</style>
