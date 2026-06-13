<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  AddOutline,
  FolderOpenOutline,
  LibraryOutline,
  RefreshOutline,
  SearchOutline,
  SwapVerticalOutline,
  TimeOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import {
  isDefaultBlankProjectName,
  useEditorStore,
  type EditorProjectSummary,
} from '@/stores/editor'

type ProjectSort = 'time_desc' | 'time_asc' | 'name_asc' | 'name_desc'

const { t, locale } = useI18n()
const message = useMessage()
const dialog = useDialog()
const editor = useEditorStore()

const search = ref('')
const sortBy = ref<ProjectSort>('time_desc')
const creating = ref(false)
const refreshing = ref(false)
const deletingIds = ref<string[]>([])

const sortOptions = computed(() => [
  { label: t('projects.sortTimeDesc'), value: 'time_desc' },
  { label: t('projects.sortTimeAsc'), value: 'time_asc' },
  { label: t('projects.sortNameAsc'), value: 'name_asc' },
  { label: t('projects.sortNameDesc'), value: 'name_desc' },
])

const filteredProjects = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  const list = editor.projectSummaries.filter((item) => {
    if (!keyword) return true
    const haystack = [
      item.name,
      item.id,
      item.sourceTaskId || '',
      item.sourceResultDir || '',
      item.type === 'task' ? t('projects.fromResult') : t('projects.blankProject'),
    ].join(' ').toLowerCase()
    return haystack.includes(keyword)
  })

  return [...list].sort((a, b) => {
    switch (sortBy.value) {
      case 'time_asc':
        return a.updatedAt - b.updatedAt
      case 'name_asc':
        return a.name.localeCompare(b.name, locale.value)
      case 'name_desc':
        return b.name.localeCompare(a.name, locale.value)
      case 'time_desc':
      default:
        return b.updatedAt - a.updatedAt
    }
  })
})

function formatTime(value: number) {
  return new Date(value).toLocaleString()
}

function projectTypeLabel(item: EditorProjectSummary) {
  return item.type === 'task' ? t('projects.fromResult') : t('projects.blankProject')
}

function projectDisplayName(item: EditorProjectSummary) {
  if (item.type === 'blank' && isDefaultBlankProjectName(item.name)) {
    return t('projects.blankProjectDefaultName')
  }
  return item.name
}

function projectSourceLabel(item: EditorProjectSummary) {
  if (item.type === 'blank') return t('projects.blankProjectHint')
  return item.sourceResultDir || item.sourceTaskId || t('projects.fromResult')
}

function projectTaskLabel(item: EditorProjectSummary) {
  return item.sourceTaskId ? `${t('projects.sourceTaskId')} · ${item.sourceTaskId}` : ''
}

async function refreshProjects() {
  refreshing.value = true
  try {
    await editor.refreshProjects()
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('toast.unknownError'))
  } finally {
    refreshing.value = false
  }
}

async function openProject(item: EditorProjectSummary) {
  try {
    await editor.openProjectWindow(item.id)
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('editor.notFound'))
  }
}

async function createBlankProject() {
  creating.value = true
  try {
    const project = await editor.createBlankProject()
    message.success(t('projects.createSuccess'))
    await editor.openProjectWindow(project.id)
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('toast.unknownError'))
  } finally {
    creating.value = false
  }
}

function confirmDelete(item: EditorProjectSummary) {
  dialog.warning({
    title: t('projects.deleteTitle'),
    content: t('projects.deleteConfirm', { name: projectDisplayName(item) }),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      deletingIds.value = [...deletingIds.value, item.id]
      try {
        await editor.deleteProject(item.id)
        message.success(t('projects.deleteSuccess'))
      } catch (error) {
        message.error(error instanceof Error ? error.message : t('toast.unknownError'))
      } finally {
        deletingIds.value = deletingIds.value.filter((id) => id !== item.id)
      }
    },
  })
}

onMounted(() => {
  void refreshProjects()
})
</script>

<template>
  <div class="page projects-page">
    <div class="page-header-compact projects-page__header">
      <div>
        <h1>{{ t('projects.title') }}</h1>
        <p>{{ t('projects.subtitle') }}</p>
      </div>
      <div class="projects-page__header-actions">
        <n-button secondary :loading="creating" @click="createBlankProject">
          <template #icon><n-icon :component="AddOutline" /></template>
          {{ t('projects.createBlank') }}
        </n-button>
      </div>
    </div>

    <div class="projects-toolbar">
      <n-input
        v-model:value="search"
        class="projects-toolbar__search"
        clearable
        :placeholder="t('projects.searchPlaceholder')"
      >
        <template #prefix><n-icon :component="SearchOutline" /></template>
      </n-input>

      <n-select
        v-model:value="sortBy"
        class="projects-toolbar__sort"
        size="small"
        :options="sortOptions"
      >
        <template #arrow><n-icon :component="SwapVerticalOutline" /></template>
      </n-select>

      <div class="projects-toolbar__aside">
        <span class="projects-toolbar__count">{{ filteredProjects.length }} / {{ editor.projectSummaries.length }}</span>
        <n-button quaternary size="small" :loading="refreshing" @click="refreshProjects">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          {{ t('common.refresh') }}
        </n-button>
      </div>
    </div>

    <div v-if="!editor.projectSummaries.length" class="projects-empty">
      <n-icon :component="LibraryOutline" size="46" />
      <strong>{{ t('projects.empty') }}</strong>
      <span>{{ t('projects.emptyHint') }}</span>
      <n-button type="primary" secondary :loading="creating" @click="createBlankProject">
        {{ t('projects.createBlank') }}
      </n-button>
    </div>

    <div v-else-if="!filteredProjects.length" class="projects-empty">
      <n-icon :component="SearchOutline" size="42" />
      <strong>{{ t('projects.noMatchTitle') }}</strong>
      <span>{{ t('projects.noMatchHint') }}</span>
    </div>

    <div v-else class="projects-list">
      <section
        v-for="item in filteredProjects"
        :key="item.id"
        class="project-row"
      >
        <div class="project-row__main">
          <span class="project-row__icon">
            <n-icon :component="LibraryOutline" size="18" />
          </span>

          <div class="project-row__body">
            <strong class="project-row__title" :title="projectDisplayName(item)">
              {{ projectDisplayName(item) }}
            </strong>
            <div class="project-row__meta">
              <span class="project-row__meta-item">
                {{ projectTypeLabel(item) }}
              </span>
              <span class="project-row__meta-item project-row__time">
                <n-icon :component="TimeOutline" />
                {{ formatTime(item.updatedAt) }}
              </span>
              <span v-if="item.sourceTaskId" class="project-row__meta-item">
                {{ projectTaskLabel(item) }}
              </span>
            </div>
            <span class="project-row__source" :title="projectSourceLabel(item)">{{ projectSourceLabel(item) }}</span>
          </div>
        </div>

        <div class="project-row__actions">
          <n-button size="small" type="primary" secondary @click="openProject(item)">
            <template #icon><n-icon :component="FolderOpenOutline" /></template>
            {{ t('projects.openProject') }}
          </n-button>
          <n-button
            size="small"
            tertiary
            type="error"
            :loading="deletingIds.includes(item.id)"
            @click="confirmDelete(item)"
          >
            <template #icon><n-icon :component="TrashOutline" /></template>
            {{ t('projects.deleteAction') }}
          </n-button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.projects-page {
  display: grid;
  gap: 14px;
}

.projects-page__header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.projects-page__header-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.projects-toolbar {
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

.projects-toolbar__aside {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.projects-toolbar__count {
  min-width: 66px;
  text-align: right;
  font-size: 12px;
  color: var(--on-surface-muted);
}

.projects-list {
  display: grid;
  gap: 10px;
}

.project-row {
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

.project-row:hover {
  border-color: color-mix(in srgb, var(--primary) 30%, var(--outline));
  background: color-mix(in srgb, var(--surface-1) 84%, var(--primary-soft));
  transform: translateY(-1px);
}

.project-row__main {
  min-width: 0;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.project-row__icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.project-row__body {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.project-row__title,
.project-row__source {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-row__title {
  display: block;
  min-width: 0;
  font-size: 15px;
  line-height: 1.25;
}

.project-row__source {
  display: block;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
}

.project-row__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.project-row__meta-item,
.project-row__time {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.project-row__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
}

.projects-empty {
  min-height: 260px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  border: 1px dashed var(--outline);
  border-radius: 20px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-1) 70%, transparent);
}

.projects-empty strong {
  color: var(--on-surface);
  font-size: 16px;
}

.projects-empty span {
  font-size: 13px;
  line-height: 1.6;
}

@media (max-width: 980px) {
  .projects-page__header {
    flex-direction: column;
    align-items: stretch;
  }

  .projects-page__header-actions {
    justify-content: flex-end;
  }

  .projects-toolbar {
    grid-template-columns: 1fr;
  }

  .projects-toolbar__aside {
    justify-content: space-between;
  }

  .projects-toolbar__count {
    text-align: left;
  }

  .project-row {
    grid-template-columns: 1fr;
  }

  .project-row__actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}
</style>
