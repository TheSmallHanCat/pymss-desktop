<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { open } from '@tauri-apps/plugin-shell'
import { SUPPORTED_LOCALES, setLocaleWithTransition } from '@/i18n'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { useModelStore } from '@/stores/model'
import { useTaskStore } from '@/stores/task'
import { formatBytes } from '@/utils/format'
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
  SettingsOutline,
  SpeedometerOutline,
  SwapHorizontalOutline,
  LogoGithub,
} from '@vicons/ionicons5'

const { t } = useI18n()
const message = useMessage()
const settings = useSettingsStore()
const app = useAppStore()
const modelStore = useModelStore()
const task = useTaskStore()
const {
  themeMode,
  themeAccent,
  locale,
  dataRoot,
  modelDir,
  outputDir,
  settingsDir,
  editorProjectsDir,
  logsDir,
  tempDir,
  defaultDevice,
  downloadSource,
  maxConcurrentSeparations,
  modelDirMigrationState,
  isModelDirMigrating,
} = storeToRefs(settings)
const { downloadTasks } = storeToRefs(modelStore)
const { activeWorkerTasks } = storeToRefs(task)
const deviceOptions = computed(() => settings.deviceOptions(app.envInfo))
const themeAccentOptions = computed(() =>
  THEME_ACCENTS.map((accent) => ({
    value: accent,
    label: t(`settings.themeAccent${accent[0].toUpperCase()}${accent.slice(1)}`),
    preview: getThemeAccentPreview(accent, resolvedIsDark(themeMode.value)),
  })),
)
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
  { key: 'settings.outputDir', value: outputDir.value, fallback: 'outputs' },
  { key: 'settings.editorProjectsDir', value: editorProjectsDir.value, fallback: 'editor-projects' },
  { key: 'settings.settingsDir', value: settingsDir.value, fallback: 'settings' },
  { key: 'settings.logsDir', value: logsDir.value, fallback: 'logs' },
  { key: 'settings.tempDir', value: tempDir.value, fallback: 'temp' },
])
const hasActiveModelDirUsage = computed(() => {
  const hasRunningWorkerTask = activeWorkerTasks.value.length > 0
  const hasDownloadingModel = Object.values(downloadTasks.value).some((item) => item.status === 'downloading')
  return hasRunningWorkerTask || hasDownloadingModel || isModelDirMigrating.value
})
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

async function selectThemeMode(mode: ThemeMode, event: MouseEvent) {
  if (themeMode.value === mode) return
  const origin = getEventOrigin(event)
  await runRippleViewTransition(() => {
    themeMode.value = mode
    applyTheme(mode, themeAccent.value)
  }, origin)
}

async function selectThemeAccent(accent: ThemeAccent, event: MouseEvent) {
  if (themeAccent.value === accent) return
  const origin = getEventOrigin(event)
  await runRippleViewTransition(() => {
    themeAccent.value = accent
    applyTheme(themeMode.value, accent)
  }, origin)
}

async function selectLocale(code: typeof SUPPORTED_LOCALES[number]['code'], event: MouseEvent) {
  if (locale.value === code) return
  const origin = getEventOrigin(event)
  await runRippleViewTransition(() => {
    locale.value = code
    return setLocaleWithTransition(code)
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
      <n-grid-item :span="1">
        <n-card class="settings-card settings-card--compact" :bordered="true" size="small">
          <template #header>
            <div class="section-title">
              <span class="section-title__icon">
                <n-icon :component="ColorPaletteOutline" size="18" />
              </span>
              <span>{{ t('settings.appearance') }}</span>
            </div>
          </template>

          <div class="settings-stack settings-stack--compact">
            <section class="setting-block">
              <label class="text-muted text-sm">{{ t('settings.theme') }}</label>
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
            </section>

            <section class="setting-block">
              <label class="text-muted text-sm">{{ t('settings.themeColor') }}</label>
              <div class="theme-accent-grid">
                <button
                  v-for="accent in themeAccentOptions"
                  :key="accent.value"
                  type="button"
                  class="theme-accent-card"
                  :class="{ active: themeAccent === accent.value }"
                  @click="selectThemeAccent(accent.value, $event)"
                >
                  <span class="theme-accent-card__swatches">
                    <span
                      v-for="swatch in accent.preview"
                      :key="swatch"
                      class="theme-accent-card__swatch"
                      :style="{ background: swatch }"
                    />
                  </span>
                  <span class="theme-accent-card__label">{{ accent.label }}</span>
                </button>
              </div>
            </section>

            <section class="setting-block">
              <label class="text-muted text-sm">{{ t('settings.language') }}</label>
              <div class="language-switcher">
                <button
                  v-for="loc in SUPPORTED_LOCALES"
                  :key="loc.code"
                  type="button"
                  :class="{ active: locale === loc.code }"
                  @click="selectLocale(loc.code, $event)"
                >
                  {{ loc.label }}
                </button>
              </div>
            </section>
          </div>
        </n-card>
      </n-grid-item>

      <!-- Paths -->
      <n-grid-item :span="1">
        <n-card class="settings-card settings-card--feature" :bordered="true" size="small">
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

            <div class="path-grid">
              <div v-for="entry in dataDirEntries" :key="entry.key" class="path-subcard">
                <span>{{ t(entry.key) }}</span>
                <code class="path-field__value" :title="entry.value || entry.fallback">{{ dirName(entry.value, entry.fallback) }}</code>
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
  max-width: 1220px;
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
  align-items: stretch;
}

.settings-card {
  height: 100%;
}

.settings-card :deep(.n-card__header) {
  padding-bottom: 16px;
}

.settings-card :deep(.n-card__content) {
  padding-top: 0;
}

.settings-card--compact :deep(.n-card__content) {
  padding-bottom: 30px;
}

.settings-card--feature {
  position: relative;
}

.settings-card--feature::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: 18px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 8%, transparent), transparent 28%);
  opacity: 0.78;
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
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: var(--primary-strong);
  background: linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 72%, var(--surface-2)), color-mix(in srgb, var(--primary-softer) 58%, var(--surface-1)));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 72%, transparent),
    0 4px 14px color-mix(in srgb, var(--primary-glow) 12%, transparent);
}

.settings-stack {
  display: grid;
  gap: 18px;
}

.settings-stack--compact {
  gap: 22px;
}

.setting-block,
.setting-field {
  display: grid;
  gap: 10px;
}

.setting-field__hint {
  margin: 0;
  line-height: 1.6;
}

.language-switcher {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border: 1px solid color-mix(in srgb, var(--outline) 78%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 82%, transparent);
}

.language-switcher button {
  min-width: 0;
  border: 0;
  border-radius: 9px;
  padding: 8px 10px;
  color: var(--on-surface-muted);
  background: transparent;
  cursor: pointer;
  transition: 150ms ease;
}

.language-switcher button:hover {
  color: var(--on-surface);
  background: color-mix(in srgb, var(--surface-3) 78%, transparent);
}

.language-switcher button.active {
  color: color-mix(in srgb, var(--primary-strong) 88%, white 12%);
  background: color-mix(in srgb, var(--primary-soft) 54%, var(--surface-3));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 58%, transparent);
  font-weight: 600;
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
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--outline) 64%, transparent);
  border-radius: 14px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 96%, transparent), color-mix(in srgb, var(--surface-2) 38%, transparent));
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
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 84%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 72%, transparent);
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
  border: 1px solid color-mix(in srgb, var(--outline) 78%, transparent);
  border-radius: 13px;
  color: color-mix(in srgb, var(--on-surface) 92%, black 8%);
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
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

.path-item {
  display: grid;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
}

.path-item--primary {
  position: relative;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--primary-border) 34%, var(--outline));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 98%, transparent), color-mix(in srgb, var(--surface-1) 90%, var(--surface-2)));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 16%, transparent),
    0 12px 28px rgba(0, 0, 0, 0.10);
}

.path-item--primary::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--primary) 64%, white 8%), transparent);
  opacity: 0.82;
}

.path-item__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.path-item__head-copy {
  display: grid;
  gap: 4px;
}

.path-item__head-copy strong {
  font-size: 13px;
}

.path-item__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
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
  border: 1px solid color-mix(in srgb, var(--outline) 78%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 82%, transparent);
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
  color: color-mix(in srgb, var(--primary-strong) 88%, white 12%);
  background: color-mix(in srgb, var(--primary-soft) 54%, var(--surface-3));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-border) 58%, transparent);
  font-weight: 600;
}

.theme-accent-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}

.theme-accent-card {
  position: relative;
  display: grid;
  gap: 7px;
  justify-items: flex-start;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 76%, transparent);
  border-radius: 12px;
  color: var(--on-surface);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 96%, transparent), color-mix(in srgb, var(--surface-2) 74%, transparent));
  cursor: pointer;
  transition: border-color 180ms ease, background 180ms ease, transform 160ms ease, box-shadow 180ms ease;
}

.theme-accent-card::after {
  content: '';
  position: absolute;
  right: 10px;
  top: 10px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--outline) 78%, transparent);
  transition: background 180ms ease, box-shadow 180ms ease, transform 160ms ease;
}

.theme-accent-card:hover {
  border-color: color-mix(in srgb, var(--primary-border) 72%, var(--outline));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-softer) 26%, var(--surface-1)), color-mix(in srgb, var(--surface-2) 84%, transparent));
  transform: translateY(-1px);
  box-shadow: 0 8px 20px color-mix(in srgb, rgba(0, 0, 0, 0.28) 88%, transparent);
}

.theme-accent-card.active {
  border-color: var(--primary);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 20%, var(--surface-1)), color-mix(in srgb, var(--surface-2) 88%, transparent));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--primary-border) 54%, transparent),
    0 10px 22px color-mix(in srgb, var(--primary-glow) 18%, transparent);
}

.theme-accent-card.active::after {
  background: var(--primary);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--primary-soft) 30%, transparent),
    0 0 10px color-mix(in srgb, var(--primary-glow) 28%, transparent);
  transform: scale(1.04);
}

.theme-accent-card__swatches {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.theme-accent-card__swatch {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,0.22),
    0 2px 8px rgba(0,0,0,0.18);
}

.theme-accent-card__label {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
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

  .theme-accent-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .migration-summary-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 840px) {
  .settings-merged-layout {
    grid-template-columns: minmax(0, 1fr);
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

  .theme-accent-grid {
    grid-template-columns: minmax(0, 1fr);
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
