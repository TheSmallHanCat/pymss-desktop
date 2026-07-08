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
import { useTaskStore, type SeparationJob, type SeparationTask } from '@/stores/task'
import { useEditorStore } from '@/stores/editor'
import { usePagedSelection } from '@/composables/usePagedSelection'
import { NCheckbox, useDialog, useMessage } from 'naive-ui'

type ResultSort = 'time_desc' | 'time_asc' | 'name_asc' | 'name_desc'
type ResultGroup = SeparationJob & { items: SeparationTask[] }

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

const resultGroups = computed<ResultGroup[]>(() => {
  return task.resultJobs.map((job) => ({ ...job, items: job.tasks }))
})
const filteredResults = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  const list = resultGroups.value.filter((group) => {
    if (!keyword) return true
    const haystack = [
      group.id,
      group.model,
      group.output,
      ...group.items.map(item => getFileName(item.input)),
      ...group.items.map(item => item.output),
      ...group.items.flatMap(item => item.outputs.map((output) => output.stem)),
      ...group.items.flatMap(item => item.outputs.map((output) => output.path)),
    ].join(' ').toLowerCase()
    return haystack.includes(keyword)
  })

  return [...list].sort((a, b) => {
    switch (sortBy.value) {
      case 'time_asc':
        return a.updatedAt - b.updatedAt
      case 'name_asc':
        return getGroupTitle(a).localeCompare(getGroupTitle(b), 'zh-CN')
      case 'name_desc':
        return getGroupTitle(b).localeCompare(getGroupTitle(a), 'zh-CN')
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

function getGroupTitle(group: ResultGroup) {
  if (group.inputCount === 1) return getFileName(group.primary.input)
  return t('results.groupTitle', { count: group.inputCount, name: getFileName(group.primary.input) })
}

function resultCardId(item: Pick<ResultGroup, 'id'>) {
  return `result-card-${item.id}`
}

function openResultDir(group: ResultGroup) {
  task.revealPath(group.output)
}

async function openInEditor(item: SeparationTask) {
  try {
    const project = await editor.ensureProjectForTask(item, { loadIntoSession: false })
    await editor.openProjectWindow(project.id)
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('editor.notFound'))
  }
}

// 删除结果时仅回收当前结果对应的输出文件，避免误删共享目录或附加产物
function trashTargets(item: SeparationTask) {
  return task.resultTrashTargets(item)
}

function groupTaskIds(group: ResultGroup) {
  return group.items.map(item => item.id)
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

function handleRemoveResult(group: ResultGroup) {
  const ids = groupTaskIds(group)
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
        task.removeResults(ids)
        message.success(t('results.removeSuccess'))
        return
      }

      const targets = trashTargetsForItems(group.items)
      if (!targets.length) {
        task.removeResults(ids)
        message.warning(t('results.removeNoFilesSingle'))
        return
      }

      try {
        const result = await task.trashPaths(targets)
        if (!result.failed.length) {
          task.removeResults(ids)
          message.success(t('results.removeFilesSuccessSingle'))
          return
        }

        const removeListOnly = await confirmRemoveListOnly(result.failed.length, targets.length, 'single')
        if (!removeListOnly) {
          message.warning(t('results.removeFilesKeptSingle'))
          return
        }
        task.removeResults(ids)
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
        task.removeResults(ids)
        message.warning(t('results.removeFilesAllFailedListOnly'))
      }
    },
  })
}

function handleRemoveSelected() {
  const ids = [...selectedResultIds.value]
  if (!ids.length) return
  const groups = resultGroups.value.filter((group) => ids.includes(group.id))
  const taskIds = groups.flatMap(groupTaskIds)
  const items = groups.flatMap(group => group.items)
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
        const removed = task.removeResults(taskIds)
        if (!silent && removed > 0) {
          message.success(t('results.removeSelectedSuccess', { count: ids.length }))
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

function handleClearResults() {
  const groups = [...resultGroups.value]
  if (!groups.length) return
  const items = groups.flatMap(group => group.items)
  const deleteFiles = ref(false)
  dialog.warning({
    title: t('results.clearTitle'),
    content: () => h('div', { style: 'display:grid;gap:12px;' }, [
      h('span', t('results.clearContent', { count: groups.length })),
      h(NCheckbox, {
        checked: deleteFiles.value,
        'onUpdate:checked': (value: boolean) => { deleteFiles.value = value },
      }, { default: () => t('results.removeDeleteFiles') }),
    ]),
    positiveText: t('results.clearPositive'),
    negativeText: t('common.cancel'),
    positiveButtonProps: { type: 'error' },
    onPositiveClick: async () => {
      const itemIds = items.map((item) => item.id)
      const finishClear = (silent = false) => {
        const removed = task.clearResults(itemIds)
        if (!silent && removed > 0) {
          message.success(t('results.clearSuccess', { count: groups.length }))
        }
        selectedResultIds.value = []
        selecting.value = false
      }

      if (!deleteFiles.value) {
        finishClear()
        return
      }

      const targets = trashTargetsForItems(items)
      if (!targets.length) {
        finishClear(true)
        message.warning(t('results.removeNoFilesMultiple'))
        return
      }

      try {
        const result = await task.trashPaths(targets)
        if (!result.failed.length) {
          finishClear(true)
          message.success(t('results.removeFilesSuccessMultiple'))
          return
        }

        const removeListOnly = await confirmRemoveListOnly(result.failed.length, targets.length, 'multiple')
        if (!removeListOnly) {
          message.warning(t('results.removeFilesKeptMultiple'))
          return
        }
        finishClear(true)
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
        finishClear(true)
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

function outputFileName(value: string) {
  return getFileName(value) || shortenPath(value)
}

function scrollToFocusedResult(id: string | null) {
  if (!id) return
  const group = resultGroups.value.find(group => group.id === id || group.items.some(item => item.id === id))
  const groupId = group?.id || id
  ensureExpanded(groupId)
  ensureItemPage(groupId)
  nextTick(() => {
    const target = document.getElementById(resultCardId({ id: groupId }))
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
      <div class="results-page__header-actions">
        <n-button v-if="task.resultTasks.length" secondary @click="toggleSelecting">
          {{ selecting ? t('results.batchExit') : t('results.batchSelect') }}
        </n-button>
        <n-button
          v-if="task.resultTasks.length"
          secondary
          type="error"
          @click="handleClearResults"
        >
          <template #icon><n-icon :component="TrashOutline" /></template>
          {{ t('results.clearAction') }}
        </n-button>
      </div>
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

      <span class="results-toolbar__count">{{ filteredResults.length }} / {{ resultGroups.length }}</span>
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
            <strong>{{ getGroupTitle(item) }}</strong>
            <span class="result-row__meta">
              <span>{{ item.model }}</span>
              <span>{{ item.inputCount }} {{ t('results.inputUnit') }}</span>
              <span>{{ item.outputCount }} {{ t('results.stemUnit') }}</span>
              <span class="result-row__time"><n-icon :component="TimeOutline" /> {{ formatTime(item.updatedAt) }}</span>
            </span>
            <span class="result-row__path">{{ shortenPath(item.output) }}</span>
          </span>

          <span class="result-row__toggle" :class="{ 'result-row__toggle--open': isExpanded(item.id) }">
            <n-icon :component="ChevronDownOutline" />
          </span>
        </button>

        <div v-if="!selecting" class="result-row__actions">
          <n-button v-if="item.inputCount === 1" size="small" type="primary" @click.stop="openInEditor(item.primary)">
            <template #icon><n-icon :component="ColorWandOutline" /></template>
            {{ t('results.openInEditor') }}
          </n-button>
          <n-button size="small" type="primary" secondary @click.stop="openResultDir(item)">
            <template #icon><n-icon :component="FolderOpenOutline" /></template>
            {{ t('results.openDirectory') }}
          </n-button>
          <n-button size="small" quaternary type="error" @click.stop="handleRemoveResult(item)">
            <template #icon><n-icon :component="TrashOutline" /></template>
            {{ t('results.removeAction') }}
          </n-button>
        </div>

        <n-collapse-transition :show="isExpanded(item.id)">
          <div class="result-row__details">
            <section
              v-for="result in item.items"
              :key="result.id"
              :class="['result-detail-card', { 'result-detail-card--compact': item.items.length === 1 }]"
            >
              <div v-if="item.items.length > 1" class="result-detail-card__head">
                <div>
                  <strong>{{ getFileName(result.input) }}</strong>
                  <span>{{ result.outputs.length }} {{ t('results.stemUnit') }}</span>
                </div>
                <div class="result-detail-card__actions">
                  <n-button size="tiny" secondary @click.stop="openInEditor(result)">
                    <template #icon><n-icon :component="ColorWandOutline" /></template>
                    {{ t('results.openInEditor') }}
                  </n-button>
                  <n-button size="tiny" tertiary @click.stop="task.revealPath(result.output)">
                    <template #icon><n-icon :component="FolderOpenOutline" /></template>
                    {{ t('results.openDirectory') }}
                  </n-button>
                </div>
              </div>
              <div class="result-detail-card__stems">
                <div v-for="output in result.outputs" :key="output.path" class="stem-line" :title="output.path">
                  <span class="stem-line__stem">{{ output.stem }}</span>
                  <span class="stem-line__path">{{ outputFileName(output.path) }}</span>
                </div>
              </div>
            </section>
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
  gap: 12px;
}

.results-page__header {
  margin-bottom: 4px;
}

.results-page__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.results-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 210px auto;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 56%, transparent);
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.025), transparent 52%),
    color-mix(in srgb, var(--surface-1) 72%, transparent);
}

.results-toolbar__count {
  min-width: 66px;
  text-align: right;
  font-size: 12px;
  color: var(--on-surface-muted);
}

.results-list {
  display: grid;
  gap: 8px;
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
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 54%, transparent);
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.018), transparent 58%),
    color-mix(in srgb, var(--surface-1) 70%, transparent);
  transition: border-color 160ms ease, background 160ms ease;
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
  border-color: color-mix(in srgb, var(--primary) 22%, var(--outline));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 10%, transparent), transparent 58%),
    color-mix(in srgb, var(--surface-1) 74%, transparent);
}

.result-row__main {
  min-width: 0;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 26px;
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
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  color: color-mix(in srgb, var(--primary-strong) 78%, var(--on-surface-muted));
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
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
  font-size: 13px;
  line-height: 1.25;
}

.result-row__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--on-surface-muted);
  font-size: 11px;
  font-family: inherit;
}

.result-row__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 10px;
  color: var(--on-surface-muted);
  font-size: 11px;
}

.result-row__time {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.result-row__toggle {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-2) 68%, transparent);
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
  gap: 10px;
  padding: 12px 0 2px 54px;
}

.result-detail-card {
  display: grid;
  gap: 10px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 48%, transparent);
  border-radius: 13px;
  background: color-mix(in srgb, var(--surface) 28%, transparent);
}

.result-detail-card--compact {
  gap: 8px;
  max-width: 760px;
  padding: 0;
  border: 0;
  background: transparent;
}

.result-detail-card__head {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.result-detail-card__head > div:first-child {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.result-detail-card__head strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.result-detail-card__head span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.result-detail-card__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.result-detail-card__stems {
  display: grid;
  gap: 8px;
}

.stem-line {
  display: grid;
  grid-template-columns: minmax(92px, 132px) minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 54%, transparent);
}

.stem-line span {
  font-size: 12px;
}

.stem-line__stem {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--primary-strong);
  font-weight: 700;
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
  border: 1px dashed color-mix(in srgb, var(--outline) 64%, transparent);
  border-radius: 18px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-1) 58%, transparent);
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

  .result-detail-card__head {
    align-items: flex-start;
    flex-direction: column;
  }

  .result-detail-card__actions {
    justify-content: flex-start;
  }

  .stem-line {
    grid-template-columns: 1fr;
    gap: 5px;
  }
}
</style>
