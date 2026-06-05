<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { SUPPORTED_LOCALES } from '@/i18n'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { getThemeAccentPreview, resolvedIsDark, THEME_ACCENTS, type ThemeAccent } from '@/utils/theme'
import {
  ChevronDownOutline,
  ColorPaletteOutline,
  FolderOpenOutline,
  SettingsOutline,
} from '@vicons/ionicons5'

const { t } = useI18n()
const message = useMessage()
const settings = useSettingsStore()
const app = useAppStore()
const task = useTaskStore()
const showDataSubdirs = ref(false)
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
} = storeToRefs(settings)
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
  { key: 'settings.modelDir', value: modelDir.value, fallback: 'models' },
  { key: 'settings.outputDir', value: outputDir.value, fallback: 'outputs' },
  { key: 'settings.editorProjectsDir', value: editorProjectsDir.value, fallback: 'editor-projects' },
  { key: 'settings.settingsDir', value: settingsDir.value, fallback: 'settings' },
  { key: 'settings.logsDir', value: logsDir.value, fallback: 'logs' },
  { key: 'settings.tempDir', value: tempDir.value, fallback: 'temp' },
])

function dirName(path: string, fallback: string) {
  const normalized = (path || '').trim().replace(/[\\/]+$/, '')
  if (!normalized) return fallback
  const segments = normalized.split(/[\\/]+/).filter(Boolean)
  return segments.at(-1) || fallback
}

function selectThemeAccent(accent: ThemeAccent) {
  themeAccent.value = accent
}

async function revealPath(path: string) {
  try {
    await task.revealPath(path)
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
  <div class="page">
    <div class="page-header-compact">
      <div>
        <h1>{{ t('settings.title') }}</h1>
        <p>{{ t('settings.subtitle') }}</p>
      </div>
    </div>

    <n-grid :cols="2" :x-gap="16" :y-gap="16" responsive="screen">
      <!-- Appearance -->
      <n-grid-item :span="1">
        <n-card :bordered="true" size="small">
          <template #header>
            <div class="section-title">
              <span class="section-title__icon">
                <n-icon :component="ColorPaletteOutline" size="18" />
              </span>
              <span>{{ t('settings.appearance') }}</span>
            </div>
          </template>

          <label class="text-muted text-sm">{{ t('settings.theme') }}</label>
          <div class="theme-switcher">
            <button
              type="button"
              :class="{ active: themeMode === 'system' }"
              @click="themeMode = 'system'"
            >
              {{ t('settings.themeSystem') }}
            </button>
            <button
              type="button"
              :class="{ active: themeMode === 'dark' }"
              @click="themeMode = 'dark'"
            >
              {{ t('settings.themeDark') }}
            </button>
            <button
              type="button"
              :class="{ active: themeMode === 'light' }"
              @click="themeMode = 'light'"
            >
              {{ t('settings.themeLight') }}
            </button>
          </div>

          <label class="text-muted text-sm">{{ t('settings.themeColor') }}</label>
          <div class="theme-accent-grid">
            <button
              v-for="accent in themeAccentOptions"
              :key="accent.value"
              type="button"
              class="theme-accent-card"
              :class="{ active: themeAccent === accent.value }"
              @click="selectThemeAccent(accent.value)"
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

          <label class="text-muted text-sm">{{ t('settings.language') }}</label>
          <div style="display:flex;gap:8px;margin:8px 0 0">
            <n-button
              v-for="loc in SUPPORTED_LOCALES"
              :key="loc.code"
              size="small"
              :type="locale === loc.code ? 'primary' : 'default'"
              @click="locale = loc.code"
            >
              {{ loc.label }}
            </n-button>
          </div>
        </n-card>
      </n-grid-item>

      <!-- Paths -->
      <n-grid-item :span="1">
        <n-card :bordered="true" size="small">
          <template #header>
            <div class="section-title">
              <span class="section-title__icon">
                <n-icon :component="FolderOpenOutline" size="18" />
              </span>
              <span>{{ t('settings.dataDir') }}</span>
            </div>
          </template>

          <div class="path-panel">
            <button class="path-panel__intro-row" type="button" @click="showDataSubdirs = !showDataSubdirs">
              <span class="path-panel__intro">{{ t('settings.pathsHint') }}</span>
              <span class="path-panel__toggle">
                <n-icon
                  class="path-panel__toggle-icon"
                  :class="{ 'path-panel__toggle-icon--open': showDataSubdirs }"
                  :component="ChevronDownOutline"
                />
              </span>
            </button>

            <div class="path-root-row">
              <code class="path-root">{{ dataRoot || t('common.notSet') }}</code>
              <n-button secondary size="small" :disabled="!dataRoot" @click="revealPath(dataRoot)">
                {{ t('common.open') }}
              </n-button>
            </div>

            <n-collapse-transition :show="showDataSubdirs">
              <div class="path-grid">
                <div v-for="entry in dataDirEntries" :key="entry.key">
                  <span>{{ t(entry.key) }}</span>
                  <code class="path-field__value">{{ dirName(entry.value, entry.fallback) }}</code>
                </div>
              </div>
            </n-collapse-transition>
          </div>
        </n-card>
      </n-grid-item>

      <!-- Defaults -->
      <n-grid-item :span="2">
        <n-card :bordered="true" size="small">
          <template #header>
            <div class="section-title">
              <span class="section-title__icon">
                <n-icon :component="SettingsOutline" size="18" />
              </span>
              <span>{{ t('settings.defaults') }}</span>
            </div>
          </template>

          <n-grid :cols="2" :x-gap="16" :y-gap="16">
            <n-grid-item>
              <label class="text-muted text-sm">{{ t('settings.defaultDevice') }}</label>
              <n-select
                v-model:value="defaultDevice"
                :options="deviceOptions"
              />
            </n-grid-item>
            <n-grid-item>
              <label class="text-muted text-sm">{{ t('settings.downloadSource') }}</label>
              <n-select
                v-model:value="downloadSource"
                :options="[
                  { label: 'ModelScope', value: 'modelscope' },
                  { label: 'Hugging Face', value: 'huggingface' },
                  { label: 'HF Mirror', value: 'hf-mirror' },
                ]"
              />
            </n-grid-item>
          </n-grid>
        </n-card>
      </n-grid-item>

      <!-- Execution -->
      <n-grid-item :span="2">
        <n-card :bordered="true" size="small">
          <template #header>
            <div class="section-title">
              <span class="section-title__icon">
                <n-icon :component="SettingsOutline" size="18" />
              </span>
              <span>{{ t('settings.execution') }}</span>
            </div>
          </template>

          <n-grid :cols="2" :x-gap="16" :y-gap="16">
            <n-grid-item>
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
              <p class="text-muted text-sm" style="margin:8px 0 0">
                {{ t('settings.maxConcurrentSeparationsHint') }}
              </p>
            </n-grid-item>
          </n-grid>
        </n-card>
      </n-grid-item>
    </n-grid>
  </div>
</template>

<style scoped>
.section-title {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
}

.section-title__icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: var(--primary-strong);
  background: linear-gradient(180deg, var(--primary-soft), var(--primary-softer));
  box-shadow: inset 0 0 0 1px var(--primary-border);
}

.path-panel {
  display: grid;
  gap: 10px;
}

.path-panel__intro-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.path-panel__intro {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.6;
}

.path-panel__toggle {
  width: 28px;
  height: 28px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: var(--on-surface-muted);
  background: var(--surface-2);
  transition: color 180ms ease, background 180ms ease;
}

.path-panel__intro-row:hover .path-panel__toggle {
  color: var(--on-surface);
  background: color-mix(in srgb, var(--surface-2) 72%, var(--primary-soft));
}

.path-panel__toggle-icon {
  transition: transform 180ms ease, color 180ms ease;
}

.path-panel__toggle-icon--open {
  color: var(--primary-strong);
  transform: rotate(180deg);
}

.path-root-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.path-root {
  display: flex;
  align-items: center;
  min-height: 38px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 82%, transparent);
  border-radius: 12px;
  color: color-mix(in srgb, var(--on-surface) 92%, black 8%);
  background: var(--surface-1);
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.45;
  letter-spacing: 0.01em;
}

.path-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding-top: 2px;
}

.path-grid > div {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 72%, transparent);
}

.path-grid span {
  color: color-mix(in srgb, var(--on-surface-muted) 88%, var(--on-surface) 12%);
  font-size: 12px;
  font-weight: 600;
}

.path-field__value {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--outline) 72%, transparent);
  color: color-mix(in srgb, var(--on-surface) 84%, var(--on-surface-muted));
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  font-family: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.4;
  letter-spacing: 0.01em;
}

.theme-switcher {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin: 8px 0 16px;
  padding: 4px;
  border: 1px solid var(--outline);
  border-radius: 12px;
  background: var(--surface-2);
}

.theme-switcher button {
  min-width: 0;
  border: 0;
  border-radius: 9px;
  padding: 7px 8px;
  color: var(--on-surface-muted);
  background: transparent;
  cursor: pointer;
  transition: 150ms ease;
}

.theme-switcher button:hover {
  color: var(--on-surface);
  background: var(--surface-3);
}

.theme-switcher button.active {
  color: var(--primary-strong);
  background: var(--primary-soft);
  font-weight: 600;
}

.theme-accent-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 8px 0 16px;
}

.theme-accent-card {
  display: grid;
  gap: 8px;
  justify-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--outline);
  border-radius: 12px;
  color: var(--on-surface);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 92%, transparent), color-mix(in srgb, var(--surface-2) 90%, transparent));
  cursor: pointer;
  transition: 180ms ease;
}

.theme-accent-card:hover {
  border-color: var(--primary-border);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-softer) 60%, var(--surface-1)), color-mix(in srgb, var(--primary-soft) 42%, var(--surface-2)));
  transform: translateY(-1px);
  box-shadow: 0 10px 26px color-mix(in srgb, var(--primary-glow) 42%, transparent);
}

.theme-accent-card.active {
  border-color: var(--primary);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--primary-soft) 54%, var(--surface-1)), color-mix(in srgb, var(--primary-softer) 62%, var(--surface-2)));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--primary-border) 82%, transparent),
    0 14px 30px color-mix(in srgb, var(--primary-glow) 46%, transparent);
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
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.3);
}

.theme-accent-card__label {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}

@media (max-width: 1200px) {
  .path-root-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .path-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .theme-accent-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 840px) {
  .path-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .path-panel__toggle {
    justify-content: center;
  }

  .theme-accent-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
