<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { open } from '@tauri-apps/plugin-shell'
import { SYSTEM_LOCALE, setLocale, type LocaleSetting } from '@/i18n'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { useModelStore } from '@/stores/model'
import { useTaskStore } from '@/stores/task'
import { formatBytes } from '@/utils/format'
import { DEFAULT_SCALE_FACTOR, normalizeScaleFactor } from '@/utils/appZoom'
import {
  applyTheme,
  getThemeAccentPreview,
  resolvedIsDark,
  runRippleViewTransition,
  THEME_ACCENTS,
  type ThemeAccent,
  type ThemeMode,
} from '@/utils/theme'
import {
  ColorPaletteOutline,
  FolderOpenOutline,
  TerminalOutline,
  SettingsOutline,
  SpeedometerOutline,
  SwapHorizontalOutline,
  LogoGithub,
} from '@vicons/ionicons5'

const { t, locale: currentLocale } = useI18n()
const message = useMessage()
const settings = useSettingsStore()
const app = useAppStore()
const modelStore = useModelStore()
const task = useTaskStore()
const {
  themeMode,
  themeAccent,
  scaleFactor,
  locale,
  animationsEnabled,
  developerMode,
  dataRoot,
  modelDir,
  outputDir,
  settingsDir,
  editorProjectsDir,
  logsDir,
  defaultDevice,
  downloadSource,
  maxConcurrentSeparations,
  modelDirMigrationState,
  isModelDirMigrating,
} = storeToRefs(settings)
const { downloadTasks } = storeToRefs(modelStore)
const { activeWorkerTasks } = storeToRefs(task)
const developerDiagnostics = computed(() => app.diagnostics)
const recentWorkerEvents = computed(() => app.workerEvents.slice(0, 12))
const deviceOptions = computed(() => settings.deviceOptions(app.envInfo))
const themeAccentOptions = computed(() =>
  THEME_ACCENTS.map((accent) => ({
    value: accent,
    label: t(`settings.themeAccent${accent[0].toUpperCase()}${accent.slice(1)}`),
    preview: getThemeAccentPreview(accent, resolvedIsDark(themeMode.value)),
  })),
)
const languageOptions = computed(() => [
  { label: t('settings.languageSystem'), value: SYSTEM_LOCALE },
  { label: t('settings.languageSimplifiedChinese'), value: 'zh-CN' },
  { label: t('settings.languageEnglish'), value: 'en' },
])
const SCALE_FACTOR_PRESET_VALUES = [0.75, 0.9, 1, 1.1, 1.25, 1.5] as const
const scaleFactorPercent = computed(() => formatScaleFactorLabel(scaleFactor.value))
const scaleSliderIndex = computed({
  get: () => {
    const current = normalizeScaleFactor(scaleFactor.value)
    const exact = SCALE_FACTOR_PRESET_VALUES.findIndex((value) => isSameScaleFactor(value, current))
    if (exact !== -1) return exact
    let nearest = 0
    let minDiff = Number.POSITIVE_INFINITY
    SCALE_FACTOR_PRESET_VALUES.forEach((value, index) => {
      const diff = Math.abs(value - current)
      if (diff < minDiff) {
        minDiff = diff
        nearest = index
      }
    })
    return nearest
  },
  set: (index: number) => {
    const value = SCALE_FACTOR_PRESET_VALUES[index]
    if (value !== undefined) updateScaleFactor(value)
  },
})
const scaleSliderMarks = computed<Record<number, string>>(() =>
  SCALE_FACTOR_PRESET_VALUES.reduce<Record<number, string>>((marks, value, index) => {
    marks[index] = formatScaleFactorLabel(value)
    return marks
  }, {}),
)
const isDefaultScaleFactor = computed(() => isSameScaleFactor(scaleFactor.value, DEFAULT_SCALE_FACTOR))
const maxConcurrentSeparationsInput = computed({
  get: () => {
    const value = Number(maxConcurrentSeparations.value || 1)
    return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1
  },
  set: (value) => {
    const normalized = Number(value)
    maxConcurrentSeparations.value = Number.isFinite(normalized)
      ? Math.min(settings.MAX_CONCURRENT_SEPARATIONS, Math.max(1, Math.trunc(normalized)))
      : 1
  },
})
const dataDirEntries = computed(() => [
  { key: 'settings.editorProjectsDir', value: editorProjectsDir.value, fallback: 'editor-projects' },
  { key: 'settings.settingsDir', value: settingsDir.value, fallback: 'settings' },
  { key: 'settings.logsDir', value: logsDir.value, fallback: 'logs' },
])
const hasActiveModelDirUsage = computed(() => {
  const hasRunningWorkerTask = activeWorkerTasks.value.length > 0
  const hasDownloadingModel = Object.values(downloadTasks.value).some((item) => item.status === 'downloading')
  return hasRunningWorkerTask || hasDownloadingModel || isModelDirMigrating.value
})
const currentResolvedLanguageLabel = computed(() =>
  currentLocale.value === 'en'
    ? t('settings.languageEnglish')
    : t('settings.languageSimplifiedChinese'),
)
const appearanceThemeAccentLabel = computed(() =>
  t(`settings.themeAccent${themeAccent.value[0].toUpperCase()}${themeAccent.value.slice(1)}`),
)
const modelDirMigrationVisible = computed(() => modelDirMigrationState.value.status !== 'idle' && modelDirMigrationState.value.status !== 'confirm')
const modelDirMigrationProgress = computed(() => {
  const state = modelDirMigrationState.value
  if (['ready_to_switch', 'finalizing_cleanup', 'success'].includes(state.status)) return 100
  if (state.totalBytes > 0) return Math.max(0, Math.min(99, Math.round((state.copiedBytes / state.totalBytes) * 100)))
  if (state.totalFiles > 0) return Math.max(0, Math.min(99, Math.round((state.completedFiles / state.totalFiles) * 100)))
  return 0
})
const modelDirMigrationHasConflict = computed(() => modelDirMigrationState.value.status === 'conflict' && !!modelDirMigrationState.value.conflict)
const modelDirMigrationHasResult = computed(() => ['success', 'failed', 'aborted'].includes(modelDirMigrationState.value.status))
const isCheckingModelDir = ref(false)
const languageSelectWrap = ref<HTMLElement | null>(null)
const repoUrl = 'https://github.com/pymss-project/pymss-desktop'

function dirName(path: string, fallback: string) {
  const normalized = (path || '').trim().replace(/[\\/]+$/, '')
  if (!normalized) return fallback
  const segments = normalized.split(/[\\/]+/).filter(Boolean)
  return segments.at(-1) || fallback
}

function getEventOrigin(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement | null
  if (!target) return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const rect = target.getBoundingClientRect()
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  }
}

function getElementOrigin(element: HTMLElement | null) {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  }
}

function formatScaleFactorLabel(value: number) {
  return `${Math.round(normalizeScaleFactor(value) * 100)}%`
}

function isSameScaleFactor(left: unknown, right: unknown) {
  return Math.abs(normalizeScaleFactor(left) - normalizeScaleFactor(right)) < 0.001
}

function updateScaleFactor(value: number) {
  scaleFactor.value = normalizeScaleFactor(value)
}

function resetScaleFactorToDefault() {
  updateScaleFactor(DEFAULT_SCALE_FACTOR)
}

async function selectThemeMode(mode: ThemeMode, event: MouseEvent) {
  if (themeMode.value === mode) return
  const origin = animationsEnabled.value ? getEventOrigin(event) : undefined
  await runRippleViewTransition(() => {
    themeMode.value = mode
    applyTheme(mode, themeAccent.value)
  }, origin)
}

async function selectThemeAccent(accent: ThemeAccent, event: MouseEvent) {
  if (themeAccent.value === accent) return
  const origin = animationsEnabled.value ? getEventOrigin(event) : undefined
  await runRippleViewTransition(() => {
    themeAccent.value = accent
    applyTheme(themeMode.value, accent)
  }, origin)
}

async function selectLocale(code: LocaleSetting) {
  if (locale.value === code) return
  const origin = animationsEnabled.value
    ? (getElementOrigin(languageSelectWrap.value) || {
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      })
    : undefined
  await runRippleViewTransition(() => {
    locale.value = code
    setLocale(code)
  }, origin)
}

async function revealPath(path: string) {
  try {
    await task.revealPath(path)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function changeModelDir() {
  if (hasActiveModelDirUsage.value) {
    message.warning(t('settings.modelDirChangeBlocked'))
    return
  }
  const folder = await settings.pickModelDir()
  if (!folder) return
  isCheckingModelDir.value = true
  try {
    const result = await settings.prepareModelDirChange(folder)
    if (result.outcome === 'noop') {
      message.info(t('settings.modelDirSamePath'))
      return
    }
    if (result.outcome === 'switched') {
      message.success(t('settings.modelDirChanged'))
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    isCheckingModelDir.value = false
  }
}

async function changeOutputDir() {
  try {
    await settings.pickOutputDir()
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function openRepository() {
  try {
    await open(repoUrl)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

function closeModelDirMigrationDialog() {
  if (modelDirMigrationState.value.status === 'confirm') {
    settings.cancelModelDirChangeConfirmation()
    return
  }
  if (modelDirMigrationHasResult.value) {
    settings.clearModelDirMigrationState()
  }
}

async function confirmModelDirMigration() {
  try {
    await settings.confirmModelDirMigration()
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function resolveModelDirConflict(action: 'overwrite' | 'skip' | 'abort') {
  try {
    await settings.resolveModelDirConflict(action)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

onMounted(() => {
  if (!app.envInfo && !app.envLoading) {
    app.checkEnvInBackground().catch(() => {})
  }
})

</script>

<template>
  <div class="page page--settings">
    <div class="page-header-compact">
      <div class="page-header-compact__main">
        <h1>{{ t('settings.title') }}</h1>
        <p>{{ t('settings.subtitle') }}</p>
      </div>
      <n-button secondary size="small" class="repo-link-button" @click="openRepository">
        <template #icon><n-icon :component="LogoGithub" /></template>
        {{ t('settings.repositoryLink') }}
      </n-button>
    </div>

    <n-grid class="settings-grid" :cols="2" :x-gap="18" :y-gap="18" responsive="screen">
      <!-- Appearance -->
      <n-grid-item class="settings-grid__top-item" :span="1">
        <n-card class="settings-card settings-card--compact settings-card--appearance" :bordered="true" size="small">
          <template #header>
            <div class="section-title">
              <span class="section-title__icon">
                <n-icon :component="ColorPaletteOutline" size="18" />
              </span>
              <span>{{ t('settings.appearance') }}</span>
            </div>
          </template>

          <div class="appearance-list">
            <p class="appearance-hint">{{ t('settings.appearanceHint') }}</p>

            <div class="setting-row">
              <div class="setting-row__label">
                <label class="setting-row__title">{{ t('settings.theme') }}</label>
              </div>
              <div class="setting-row__control">
                <div class="theme-switcher">
                  <button
                    type="button"
                    :class="{ active: themeMode === 'system' }"
                    @click="selectThemeMode('system', $event)"
                  >
                    {{ t('settings.themeSystem') }}
                  </button>
                  <button
                    type="button"
                    :class="{ active: themeMode === 'dark' }"
                    @click="selectThemeMode('dark', $event)"
                  >
                    {{ t('settings.themeDark') }}
                  </button>
                  <button
                    type="button"
                    :class="{ active: themeMode === 'light' }"
                    @click="selectThemeMode('light', $event)"
                  >
                    {{ t('settings.themeLight') }}
                  </button>
                </div>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-row__label">
                <label class="setting-row__title">{{ t('settings.themeColor') }}</label>
              </div>
              <div class="setting-row__control">
                <div class="accent-dots">
                  <button
                    v-for="accent in themeAccentOptions"
                    :key="accent.value"
                    type="button"
                    class="accent-dot"
                    :class="{ active: themeAccent === accent.value }"
                    :title="accent.label"
                    :aria-label="accent.label"
                    @click="selectThemeAccent(accent.value, $event)"
                  >
                    <span
                      class="accent-dot__fill"
                      :style="{ background: `linear-gradient(135deg, ${accent.preview[0]} 0 50%, ${accent.preview[1]} 50% 100%)` }"
                    />
                  </button>
                  <span class="accent-current">{{ appearanceThemeAccentLabel }}</span>
                </div>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-row__label">
                <label class="setting-row__title">{{ t('settings.language') }}</label>
                <p v-if="locale === SYSTEM_LOCALE" class="setting-row__hint">
                  {{ t('settings.languageFollowSystemHint', { locale: currentResolvedLanguageLabel }) }}
                </p>
              </div>
              <div class="setting-row__control">
                <div ref="languageSelectWrap" class="language-select-wrap">
                  <n-select
                    :value="locale"
                    :options="languageOptions"
                    :consistent-menu-width="false"
                    @update:value="selectLocale"
                  />
                </div>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-row__label">
                <label class="setting-row__title">{{ t('settings.scaleFactor') }}</label>
                <button
                  type="button"
                  class="scale-reset"
                  :disabled="isDefaultScaleFactor"
                  @click="resetScaleFactorToDefault"
                >
                  {{ t('settings.restoreDefaultScale') }}
                </button>
              </div>
              <div class="setting-row__control">
                <div class="scale-control">
                  <n-slider
                    v-model:value="scaleSliderIndex"
                    :min="0"
                    :max="5"
                    :step="1"
                    :marks="scaleSliderMarks"
                    :tooltip="false"
                  />
                  <span class="scale-value">{{ scaleFactorPercent }}</span>
                </div>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-row__label">
                <label class="setting-row__title">{{ t('settings.animations') }}</label>
                <p class="setting-row__hint">{{ t('settings.animationsHint') }}</p>
              </div>
              <div class="setting-row__control">
                <n-switch v-model:value="animationsEnabled" />
              </div>
            </div>
          </div>
        </n-card>
      </n-grid-item>

      <!-- Paths -->
      <n-grid-item class="settings-grid__top-item" :span="1">
        <n-card class="settings-card settings-card--feature settings-card--paths" :bordered="true" size="small">
          <template #header>
            <div class="section-title">
              <span class="section-title__icon">
                <n-icon :component="FolderOpenOutline" size="18" />
              </span>
              <span>{{ t('settings.dataDir') }}</span>
            </div>
          </template>

          <div class="path-panel">
            <div class="path-panel__intro">{{ t('settings.pathsHint') }}</div>

            <div class="path-root-block">
              <div class="path-root-row">
                <code class="path-root" :title="dataRoot || t('common.notSet')">{{ dataRoot || t('common.notSet') }}</code>
                <n-button secondary size="small" :disabled="!dataRoot" @click="revealPath(dataRoot)">
                  {{ t('common.open') }}
                </n-button>
              </div>
            </div>

            <div class="path-primary-grid">
              <div class="path-item path-item--primary">
                <div class="path-item__head">
                  <div class="path-item__head-copy">
                    <strong>{{ t('settings.modelDir') }}</strong>
                  </div>
                  <div class="path-item__actions">
                    <n-tag v-if="hasActiveModelDirUsage && !isModelDirMigrating" :bordered="false" size="small" type="warning">
                      {{ t('settings.modelDirInUse') }}
                    </n-tag>
                    <n-button
                      secondary
                      type="primary"
                      size="small"
                      :loading="isCheckingModelDir"
                      :disabled="hasActiveModelDirUsage || isCheckingModelDir"
                      @click="changeModelDir"
                    >
                      <template #icon><n-icon :component="SwapHorizontalOutline" /></template>
                      {{ t('settings.changeModelDir') }}
                    </n-button>
                  </div>
                </div>
                <code class="path-item__value" :title="modelDir || t('common.notSet')">{{ modelDir || t('common.notSet') }}</code>
              </div>

              <div class="path-item path-item--primary">
                <div class="path-item__head">
                  <div class="path-item__head-copy">
                    <strong>{{ t('settings.outputDir') }}</strong>
                  </div>
                  <div class="path-item__actions">
                    <n-button secondary type="primary" size="small" @click="changeOutputDir">
                      <template #icon><n-icon :component="FolderOpenOutline" /></template>
                      {{ t('settings.changeOutputDir') }}
                    </n-button>
                  </div>
                </div>
                <code class="path-item__value" :title="outputDir || t('common.notSet')">{{ outputDir || t('common.notSet') }}</code>
              </div>
            </div>

            <div class="path-grid">
              <div v-for="entry in dataDirEntries" :key="entry.key" class="path-subcard">
                <span>{{ t(entry.key) }}</span>
                <code class="path-field__value" :title="entry.value || entry.fallback">{{ dirName(entry.value, entry.fallback) }}</code>
              </div>
            </div>
          </div>
        </n-card>
      </n-grid-item>

      <n-grid-item v-if="developerMode" :span="2">
        <n-card class="settings-card settings-card--feature" :bordered="true" size="small">
          <template #header>
            <div class="section-title">
              <span class="section-title__icon">
                <n-icon :component="TerminalOutline" size="18" />
              </span>
              <span>{{ t('settings.developerDiagnostics') }}</span>
            </div>
          </template>
          <div class="developer-panel">
            <div class="developer-panel__section">
              <h3>{{ t('settings.developerEnvTitle') }}</h3>
              <div class="developer-diagnostics">
                <div v-for="item in developerDiagnostics" :key="item.key" class="developer-diagnostic">
                  <span class="developer-diagnostic__label">{{ item.label }}</span>
                  <span class="developer-diagnostic__value">{{ item.value }}</span>
                  <small v-if="item.detail" class="developer-diagnostic__detail">{{ item.detail }}</small>
                </div>
              </div>
            </div>
            <div class="developer-panel__section">
              <h3>{{ t('settings.developerWorkerEvents') }}</h3>
              <div class="developer-log">
                <div v-if="recentWorkerEvents.length">
                  <div v-for="(event, index) in recentWorkerEvents" :key="index" class="developer-log__line">
                    <code>{{ event.type }}</code>
                    <span>{{ event.taskId || '-' }}</span>
                  </div>
                </div>
                <div v-else class="developer-log__empty">{{ t('settings.developerNoWorkerEvents') }}</div>
              </div>
            </div>
          </div>
        </n-card>
      </n-grid-item>

      <!-- Defaults & Execution -->
      <n-grid-item :span="2">
        <n-card class="settings-card" :bordered="true" size="small">
          <template #header>
            <div class="section-title">
              <span class="section-title__icon">
                <n-icon :component="SettingsOutline" size="18" />
              </span>
              <span>{{ t('settings.defaults') }}</span>
            </div>
          </template>

          <div class="settings-merged-layout">
            <section class="settings-group">
              <div class="setting-field">
                <label class="text-muted text-sm">{{ t('settings.defaultDevice') }}</label>
                <n-select
                  v-model:value="defaultDevice"
                  :options="deviceOptions"
                />
              </div>
            </section>

            <section class="settings-group">
              <div class="setting-field">
                <label class="text-muted text-sm">{{ t('settings.downloadSource') }}</label>
                <n-select
                  v-model:value="downloadSource"
                  :options="[
                    { label: 'ModelScope', value: 'modelscope' },
                    { label: 'Hugging Face', value: 'huggingface' },
                    { label: 'HF Mirror', value: 'hf-mirror' },
                  ]"
                />
              </div>
            </section>

            <section class="settings-group settings-group--soft">
              <div class="settings-group__head">
                <span class="settings-group__icon">
                  <n-icon :component="SpeedometerOutline" size="16" />
                </span>
                <span>{{ t('settings.execution') }}</span>
              </div>
              <div class="setting-field">
                <label class="text-muted text-sm">{{ t('settings.maxConcurrentSeparations') }}</label>
                <n-input-number
                  v-model:value="maxConcurrentSeparationsInput"
                  :min="1"
                  :max="settings.MAX_CONCURRENT_SEPARATIONS"
                  :precision="0"
                  :step="1"
                  clearable
                  style="width: 100%;"
                />
                <p class="text-muted text-sm setting-field__hint">
                  {{ t('settings.maxConcurrentSeparationsHint') }}
                </p>
              </div>
            </section>

            <section class="settings-group settings-group--soft">
              <div class="settings-group__head">
                <span class="settings-group__icon">
                  <n-icon :component="TerminalOutline" size="16" />
                </span>
                <span>{{ t('settings.developerMode') }}</span>
              </div>
              <div class="setting-field">
                <label class="text-muted text-sm">{{ t('settings.developerModeTitle') }}</label>
                <n-switch v-model:value="developerMode" />
                <p class="text-muted text-sm setting-field__hint">
                  {{ t('settings.developerModeHint') }}
                </p>
              </div>
            </section>
          </div>
        </n-card>
      </n-grid-item>
    </n-grid>

    <n-modal
      :show="isCheckingModelDir"
      style="width:min(420px, 88vw)"
      preset="card"
      :title="t('settings.modelDirCheckingTitle')"
      :mask-closable="false"
      :closable="false"
    >
      <div class="checking-dialog">
        <n-spin size="large" />
        <p class="checking-dialog__text">{{ t('settings.modelDirCheckingHint') }}</p>
      </div>
    </n-modal>

    <n-modal
      :show="modelDirMigrationState.status === 'confirm'"
      style="width:min(720px, 92vw)"
      preset="card"
      :title="t('settings.modelDirMigrationConfirmTitle')"
      :mask-closable="false"
      :closable="false"
      @close="closeModelDirMigrationDialog"
    >
      <div class="migration-dialog">
        <p class="migration-dialog__lead">{{ t('settings.modelDirMigrationConfirmLead') }}</p>
        <div class="migration-summary-grid">
          <div class="migration-summary-card migration-summary-card--path">
            <span>{{ t('settings.modelDirMigrationSource') }}</span>
            <code :title="modelDirMigrationState.sourceModelDir">{{ modelDirMigrationState.sourceModelDir }}</code>
          </div>
          <div class="migration-summary-card migration-summary-card--path">
            <span>{{ t('settings.modelDirMigrationTarget') }}</span>
            <code :title="modelDirMigrationState.targetModelDir">{{ modelDirMigrationState.targetModelDir }}</code>
          </div>
          <div class="migration-summary-card">
            <span>{{ t('settings.modelDirMigrationFileCount') }}</span>
            <strong>{{ modelDirMigrationState.totalFiles }}</strong>
          </div>
          <div class="migration-summary-card">
            <span>{{ t('settings.modelDirMigrationTotalSize') }}</span>
            <strong>{{ formatBytes(modelDirMigrationState.totalBytes) }}</strong>
          </div>
        </div>

        <n-alert v-if="modelDirMigrationState.preparation?.diskInsufficient" type="error" :show-icon="true" style="margin-top: 12px">
          {{ t('settings.modelDirMigrationDiskInsufficientHint', { available: formatBytes(modelDirMigrationState.preparation?.diskAvailableBytes ?? 0), needed: formatBytes(modelDirMigrationState.totalBytes) }) }}
        </n-alert>
        <n-alert v-else type="warning" :show-icon="true" style="margin-top: 12px">
          {{ t('settings.modelDirMigrationCloseWarning') }}
        </n-alert>
        <n-alert v-if="(modelDirMigrationState.preparation?.conflictCount || 0) > 0" type="info" :show-icon="true" style="margin-top: 8px">
          {{ t('settings.modelDirMigrationConflictHint', { count: modelDirMigrationState.preparation?.conflictCount || 0 }) }}
        </n-alert>
      </div>
      <template #footer>
        <div class="migration-dialog__footer">
          <n-button @click="closeModelDirMigrationDialog">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :disabled="!!modelDirMigrationState.preparation?.diskInsufficient" @click="confirmModelDirMigration">{{ t('settings.modelDirMigrationStart') }}</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal
      :show="modelDirMigrationVisible"
      style="width:min(760px, 92vw)"
      preset="card"
      :title="t('settings.modelDirMigrationTitle')"
      :mask-closable="false"
      :closable="modelDirMigrationHasResult"
      @close="closeModelDirMigrationDialog"
    >
      <div class="migration-dialog">
        <div class="migration-dialog__status">
          <div>
            <strong>{{ modelDirMigrationState.message || t('settings.modelDirMigrationPreparing') }}</strong>
            <p>{{ t('settings.modelDirMigrationProgressText', { completed: modelDirMigrationState.completedFiles, total: modelDirMigrationState.totalFiles }) }}</p>
          </div>
          <n-tag :bordered="false" size="small" :type="modelDirMigrationState.status === 'failed' ? 'error' : modelDirMigrationState.status === 'success' ? 'success' : modelDirMigrationState.status === 'aborted' ? 'default' : modelDirMigrationHasConflict ? 'warning' : 'info'">
            {{ modelDirMigrationState.status }}
          </n-tag>
        </div>

        <n-progress
          type="line"
          :percentage="modelDirMigrationProgress"
          :show-indicator="true"
          :height="12"
          :border-radius="8"
          status="default"
        />

        <div class="migration-progress-meta">
          <span>{{ t('settings.modelDirMigrationByteProgress', { copied: formatBytes(modelDirMigrationState.copiedBytes), total: formatBytes(modelDirMigrationState.totalBytes) }) }}</span>
          <span>{{ t('settings.modelDirMigrationProgressText', { completed: modelDirMigrationState.completedFiles, total: modelDirMigrationState.totalFiles }) }}</span>
        </div>

        <div class="migration-summary-grid">
          <div class="migration-summary-card">
            <span>{{ t('settings.modelDirMigrationSource') }}</span>
            <code>{{ modelDirMigrationState.sourceModelDir }}</code>
          </div>
          <div class="migration-summary-card">
            <span>{{ t('settings.modelDirMigrationTarget') }}</span>
            <code>{{ modelDirMigrationState.targetModelDir }}</code>
          </div>
        </div>

        <div v-if="modelDirMigrationState.currentPath" class="migration-current-path">
          <span>{{ t('settings.modelDirMigrationCurrentFile') }}</span>
          <code>{{ modelDirMigrationState.currentPath }}</code>
        </div>

        <n-alert v-if="modelDirMigrationHasConflict && modelDirMigrationState.conflict" type="warning" :show-icon="true">
          <template #header>{{ t('settings.modelDirMigrationConflictTitle') }}</template>
          <div class="migration-conflict">
            <p>{{ t('settings.modelDirMigrationConflictPrompt') }}</p>
            <code>{{ modelDirMigrationState.conflict.destinationPath }}</code>
            <small>{{ t('settings.modelDirMigrationConflictApplyAll') }}</small>
          </div>
        </n-alert>

        <n-alert v-if="modelDirMigrationState.status === 'failed'" type="error" :show-icon="true">
          {{ modelDirMigrationState.error || t('settings.modelDirMigrationFailedHint') }}
        </n-alert>

        <n-alert v-if="modelDirMigrationState.status === 'aborted'" type="default" :show-icon="true">
          {{ t('settings.modelDirMigrationAbortedHint') }}
        </n-alert>

        <n-alert v-if="modelDirMigrationState.status === 'success' && modelDirMigrationState.cleanupFailedFiles.length" type="warning" :show-icon="true">
          {{ t('settings.modelDirMigrationCleanupFailedHint', { count: modelDirMigrationState.cleanupFailedFiles.length }) }}
        </n-alert>
      </div>
      <template #footer>
        <div class="migration-dialog__footer">
          <template v-if="modelDirMigrationHasConflict">
            <n-button :loading="modelDirMigrationState.resolvingConflict" @click="resolveModelDirConflict('skip')">
              {{ t('settings.modelDirMigrationSkip') }}
            </n-button>
            <n-button type="warning" :loading="modelDirMigrationState.resolvingConflict" @click="resolveModelDirConflict('overwrite')">
              {{ t('settings.modelDirMigrationOverwrite') }}
            </n-button>
            <n-button type="error" secondary :loading="modelDirMigrationState.resolvingConflict" @click="resolveModelDirConflict('abort')">
              {{ t('settings.modelDirMigrationAbort') }}
            </n-button>
          </template>
          <template v-else-if="modelDirMigrationHasResult">
            <n-button type="primary" @click="closeModelDirMigrationDialog">{{ t('common.confirm') }}</n-button>
          </template>
          <template v-else>
            <n-button disabled>{{ t('settings.modelDirMigrationCloseBlocked') }}</n-button>
          </template>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.page--settings {
  max-width: 1180px;
}

.page-header-compact {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.page-header-compact__main {
  min-width: 0;
}

.repo-link-button {
  flex: 0 0 auto;
  margin-top: 4px;
}

.settings-grid {
  align-items: start;
  row-gap: 14px !important;
  column-gap: 14px !important;
}

.settings-grid__top-item {
  align-self: stretch;
  display: flex;
  min-width: 0;
}

.settings-grid__top-item > :deep(.n-card) {
  flex: 1 1 auto;
}

.settings-card {
  border-color: color-mix(in srgb, var(--outline) 58%, transparent) !important;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.025), transparent 42%),
    color-mix(in srgb, var(--surface-1) 72%, transparent) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}

.settings-card :deep(.n-card__header) {
  padding: 18px 20px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
}

.settings-card :deep(.n-card__content) {
  padding: 4px 20px 18px;
}

.settings-card--compact :deep(.n-card__content) {
  padding-bottom: 20px;
}

.settings-card--feature {
  position: relative;
}

.settings-card--feature::after {
  display: none;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  font-size: 15px;
  font-weight: 600;
}

.section-title__icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: color-mix(in srgb, var(--primary-strong) 74%, var(--on-surface-muted));
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-2));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 36%, transparent);
}

.appearance-list {
  display: grid;
}

.appearance-hint {
  margin: 0 0 4px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.7;
}

.setting-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 13px 0;
}

.setting-row + .setting-row {
  border-top: 1px solid color-mix(in srgb, var(--outline) 50%, transparent);
}

.setting-row__label {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.setting-row__title {
  color: var(--on-surface);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}

.setting-row__hint {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.6;
}

.setting-row__control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
}

.accent-dots {
  display: flex;
  align-items: center;
  gap: 8px;
}

.accent-dot {
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
  background: transparent;
  cursor: pointer;
  overflow: hidden;
  transition: transform 160ms ease, box-shadow 180ms ease, border-color 180ms ease;
}

.accent-dot__fill {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
}

.accent-dot:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--primary-border) 70%, var(--outline));
}

.accent-dot.active {
  border-color: transparent;
  box-shadow:
    0 0 0 2px var(--surface-1),
    0 0 0 4px var(--primary);
}

.accent-current {
  margin-left: auto;
  color: var(--on-surface-muted);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
}

.language-select-wrap {
  width: 100%;
  max-width: 240px;
}

.scale-reset {
  justify-self: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--primary-strong);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: color 150ms ease, opacity 150ms ease;
}

.scale-reset:hover:not(:disabled) {
  color: color-mix(in srgb, var(--primary-strong) 80%, white 20%);
}

.scale-reset:disabled {
  color: var(--on-surface-muted);
  opacity: 0.5;
  cursor: not-allowed;
}

.scale-control {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 280px;
}

.scale-control :deep(.n-slider) {
  flex: 1;
}

.scale-control :deep(.n-slider-mark) {
  font-size: 11px;
}

.scale-value {
  flex: 0 0 auto;
  color: var(--primary-strong);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
}

.setting-field {
  display: grid;
  gap: 10px;
}

.setting-field__hint {
  margin: 0;
  line-height: 1.6;
}

.settings-merged-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(320px, 0.92fr);
  gap: 14px;
  align-items: start;
}

.settings-group {
  display: grid;
  gap: 10px;
}

.settings-group:nth-child(1) {
  grid-column: 1;
  grid-row: 1;
}

.settings-group:nth-child(2) {
  grid-column: 1;
  grid-row: 2;
}

.settings-group:nth-child(3) {
  grid-column: 2;
  grid-row: 1 / span 2;
}

.settings-group--soft {
  padding: 14px 0 0;
  border-top: 1px solid color-mix(in srgb, var(--outline) 42%, transparent);
  border-radius: 0;
  background: transparent;
  align-self: stretch;
  align-content: start;
}

.settings-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: color-mix(in srgb, var(--on-surface-muted) 88%, var(--on-surface) 12%);
  font-size: 12px;
  font-weight: 600;
}

.settings-group__icon {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: color-mix(in srgb, var(--primary-strong) 78%, var(--on-surface-muted));
  background: color-mix(in srgb, var(--primary-soft) 36%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 36%, transparent);
}

.path-panel {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 14px;
}

.path-panel__intro {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.6;
}

.path-root-block {
  display: grid;
  gap: 8px;
}

.path-root-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}

.path-root {
  display: flex;
  align-items: center;
  min-height: 40px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 14px;
  border: 1px solid color-mix(in srgb, var(--outline) 56%, transparent);
  border-radius: 13px;
  color: color-mix(in srgb, var(--on-surface) 92%, black 8%);
  background: color-mix(in srgb, var(--surface) 26%, transparent);
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, "MiSans", "PingFang SC", "Microsoft YaHei", ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.45;
  letter-spacing: 0.01em;
}

.path-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 2px;
  padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 48%, transparent);
}

.path-primary-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
}

.path-item {
  display: grid;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--outline) 56%, transparent);
  background: color-mix(in srgb, var(--surface) 24%, transparent);
}

.path-item--primary {
  position: relative;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--primary-border) 34%, var(--outline));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 10%, transparent), transparent 58%),
    color-mix(in srgb, var(--surface) 26%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.035);
}

.path-item--primary::before {
  display: none;
}

.path-item__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.path-item__head-copy {
  min-width: min(100%, 128px);
  flex: 1 1 128px;
  display: grid;
  gap: 4px;
}

.path-item__head-copy strong {
  font-size: 13px;
  overflow-wrap: normal;
  word-break: normal;
}

.path-item__actions {
  min-width: 0;
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.path-item__actions :deep(.n-button) {
  max-width: 100%;
}

.path-item__value {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 11px 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 62%, transparent);
  background: color-mix(in srgb, var(--surface-2) 52%, var(--surface-1));
  color: color-mix(in srgb, var(--on-surface) 88%, var(--on-surface-muted));
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, "MiSans", "PingFang SC", "Microsoft YaHei", ui-monospace, monospace;
  font-size: 12px;
}

.path-subcard {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 34%, transparent);
  background: color-mix(in srgb, var(--surface-2) 18%, transparent);
}

.path-grid span {
  color: color-mix(in srgb, var(--on-surface-muted) 94%, var(--on-surface) 6%);
  font-size: 11px;
  font-weight: 600;
}

.path-field__value {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 6px 0 0;
  border: 0;
  border-radius: 0;
  color: color-mix(in srgb, var(--on-surface) 82%, var(--on-surface-muted));
  background: transparent;
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, "MiSans", "PingFang SC", "Microsoft YaHei", ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.45;
  letter-spacing: 0.01em;
}

.theme-switcher {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin: 0;
  padding: 4px;
  border: 1px solid color-mix(in srgb, var(--outline) 56%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface) 34%, transparent);
}

.theme-switcher button {
  min-width: 0;
  border: 0;
  border-radius: 9px;
  padding: 8px 8px;
  color: var(--on-surface-muted);
  background: transparent;
  cursor: pointer;
  transition: 150ms ease;
}

.theme-switcher button:hover {
  color: var(--on-surface);
  background: color-mix(in srgb, var(--surface-3) 76%, transparent);
}

.theme-switcher button.active {
  color: color-mix(in srgb, var(--primary-strong) 86%, var(--on-surface));
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-3));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 42%, transparent);
  font-weight: 600;
}

.checking-dialog {
  display: grid;
  justify-items: center;
  gap: 14px;
  padding: 10px 0 4px;
}

.checking-dialog__text {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.7;
  text-align: center;
}

.migration-dialog {
  display: grid;
  gap: 14px;
}

.migration-dialog__lead {
  margin: 0;
  color: var(--on-surface-muted);
  line-height: 1.7;
}

.migration-dialog__status {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.migration-dialog__status p {
  margin: 6px 0 0;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.migration-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.migration-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.migration-summary-card--path {
  grid-column: 1 / -1;
}

.migration-summary-card {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 82%, transparent);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
}

.migration-summary-card span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.migration-summary-card strong,
.migration-summary-card code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.migration-summary-card code,
.migration-current-path code,
.migration-conflict code {
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
  background: color-mix(in srgb, var(--surface-2) 76%, transparent);
  color: color-mix(in srgb, var(--on-surface) 86%, var(--on-surface-muted));
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, "MiSans", "PingFang SC", "Microsoft YaHei", ui-monospace, monospace;
  font-size: 12px;
}

.migration-progress-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.migration-current-path {
  display: grid;
  gap: 6px;
}

.migration-current-path span {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.migration-conflict {
  display: grid;
  gap: 8px;
}

.migration-conflict p,
.migration-conflict small {
  margin: 0;
}

.migration-conflict small {
  color: var(--on-surface-muted);
}

@media (max-width: 1200px) {
  .path-root-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .settings-merged-layout {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .settings-group:nth-child(1),
  .settings-group:nth-child(2),
  .settings-group:nth-child(3) {
    grid-column: auto;
    grid-row: auto;
  }

  .settings-group--soft {
    grid-column: 1 / -1;
  }

  .path-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .path-primary-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .migration-summary-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 840px) {
  .settings-merged-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .settings-grid__top-item {
    display: block;
  }

  .settings-group--soft {
    grid-column: auto;
  }

  .path-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .page-header-compact {
    flex-direction: column;
  }

  .repo-link-button {
    margin-top: 0;
  }

  .setting-row {
    grid-template-columns: 1fr;
  }

  .setting-row__control {
    justify-content: flex-start;
  }

  .language-select-wrap {
    max-width: none;
  }

  .scale-control {
    width: 100%;
    min-width: 0;
  }

  .path-item__head,
  .migration-dialog__status {
    flex-direction: column;
  }

  .path-item__actions {
    justify-content: flex-start;
  }

  .migration-progress-meta {
    flex-direction: column;
  }
}
</style>
