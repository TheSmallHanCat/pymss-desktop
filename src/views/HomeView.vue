<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useDialog, useMessage } from 'naive-ui'
import {
  MusicalNotesOutline,
  CubeOutline,
  ListOutline,
  FolderOpenOutline,
  CheckmarkCircleOutline,
  HelpCircleOutline,
  ArrowForwardOutline,
} from '@vicons/ionicons5'
import { useAppStore } from '@/stores/app'
import { useModelStore } from '@/stores/model'
import { useSettingsStore } from '@/stores/settings'
import { useTaskStore } from '@/stores/task'
import AppBrandMark from '@/components/AppBrandMark.vue'

const { t } = useI18n()
const router = useRouter()
const dialog = useDialog()
const message = useMessage()
const app = useAppStore()
const models = useModelStore()
const settings = useSettingsStore()
const tasks = useTaskStore()
const migratingDataRoot = ref(false)

type Tone = 'primary' | 'success' | 'muted'

const stats = computed(() => {
  const downloaded = models.downloadedModels.length
  const total = models.models.length
  const running = tasks.runningTasks.length
  const results = tasks.resultJobs.length

  return [
    {
      key: 'models',
      icon: CubeOutline,
      label: t('home.statModelsLabel'),
      value: String(downloaded),
      hint: t('home.statModelsValue', { downloaded, total }),
      tone: 'primary' as Tone,
      path: '/models',
    },
    {
      key: 'running',
      icon: ListOutline,
      label: t('home.statRunningLabel'),
      value: String(running),
      hint: t('home.statRunningValue', { count: running }),
      tone: running > 0 ? ('primary' as Tone) : ('muted' as Tone),
      path: '/results',
    },
    {
      key: 'results',
      icon: FolderOpenOutline,
      label: t('home.statResultsLabel'),
      value: String(results),
      hint: t('home.statResultsValue', { count: results }),
      tone: 'success' as Tone,
      path: '/results',
    },
  ]
})

const guideSteps = computed(() => [
  {
    key: 'model',
    icon: CubeOutline,
    title: t('home.guideStep1Title'),
    desc: t('home.guideStep1Desc'),
    done: models.downloadedModels.length > 0,
    path: '/models',
  },
  {
    key: 'input',
    icon: MusicalNotesOutline,
    title: t('home.guideStep2Title'),
    desc: t('home.guideStep2Desc'),
    done: tasks.inputFiles.length > 0,
    path: '/separate',
  },
  {
    key: 'run',
    icon: ArrowForwardOutline,
    title: t('home.guideStep3Title'),
    desc: t('home.guideStep3Desc'),
    done: tasks.completedTasks.length > 0,
    path: '/separate',
  },
])

const envRows = computed(() => [
  { label: t('env.python'), value: app.envInfo?.pythonVersion || t('common.unknown') },
  { label: t('env.pymss'), value: app.envInfo?.pymssAvailable ? t('common.ready') : t('common.unknown') },
  { label: t('env.torch'), value: app.envInfo?.torchVersion || t('common.unknown') },
])
const dataRootSummary = computed(() => shortenMiddle(settings.dataRoot || t('common.notSet'), 74))

function shortenMiddle(text: string, maxLength = 48) {
  if (!text || text.length <= maxLength) return text
  const side = Math.max(8, Math.floor((maxLength - 3) / 2))
  return `${text.slice(0, side)}...${text.slice(-side)}`
}

function goto(path: string) {
  router.push(path)
}

async function checkEnv() {
  try {
    await app.checkEnvInBackground()
    message.success(t('toast.envChecked'))
  } catch {
    message.error(t('toast.envFailed'))
  }
}

async function migrateDataRootToPortable() {
  if (migratingDataRoot.value) return
  dialog.warning({
    title: t('separate.dataDirMigrationConfirmTitle'),
    content: t('separate.dataDirMigrationConfirmContent'),
    positiveText: t('separate.dataDirMigrationStart'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      migratingDataRoot.value = true
      try {
        const result = await settings.migrateDataRootToPortable()
        if (result.cleanupFailedPaths?.length) {
          message.warning(t('separate.dataDirMigrationCleanupPartial', { count: result.cleanupFailedPaths.length }))
        } else {
          message.success(t('separate.dataDirMigrationSuccess'))
        }
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error))
      } finally {
        migratingDataRoot.value = false
      }
    },
  })
}
</script>

<template>
  <div class="page home-page">
    <section class="home-hero">
      <div class="home-hero__icon">
        <AppBrandMark :size="60" variant="hero" shadow />
      </div>
      <div class="home-hero__copy">
        <h1>{{ t('home.heroBrand') }}</h1>
        <p>{{ t('home.subtitle') }}</p>
      </div>
      <n-button type="primary" size="large" class="home-hero__cta" @click="goto('/separate')">
        <template #icon><n-icon :component="MusicalNotesOutline" /></template>
        {{ t('home.primaryAction') }}
      </n-button>
    </section>

    <div class="stat-grid">
      <button
        v-for="stat in stats"
        :key="stat.key"
        type="button"
        class="stat-card"
        @click="goto(stat.path)"
      >
        <span class="stat-card__icon" :class="`stat-card__icon--${stat.tone}`">
          <n-icon :component="stat.icon" />
        </span>
        <span class="stat-card__body">
          <span class="stat-card__value">{{ stat.value }}</span>
          <span class="stat-card__label">{{ stat.label }}</span>
          <span class="stat-card__hint">{{ stat.hint }}</span>
        </span>
      </button>
    </div>

    <div class="home-columns">
      <section class="home-card guide-card">
        <div class="home-card__head">
          <div>
            <h2>{{ t('home.guideTitle') }}</h2>
            <p>{{ t('home.guideSubtitle') }}</p>
          </div>
        </div>
        <div class="guide-steps">
          <button
            v-for="(step, index) in guideSteps"
            :key="step.key"
            type="button"
            class="guide-step"
            :class="{ 'guide-step--done': step.done }"
            @click="goto(step.path)"
          >
            <span class="guide-step__index">
              <n-icon v-if="step.done" :component="CheckmarkCircleOutline" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <span class="guide-step__copy">
              <strong>{{ step.title }}</strong>
              <small>{{ step.desc }}</small>
            </span>
            <span v-if="step.done" class="guide-step__badge">{{ t('home.guideDone') }}</span>
            <n-icon v-else class="guide-step__arrow" :component="ArrowForwardOutline" />
          </button>
        </div>
      </section>

      <section class="home-card env-card">
        <div class="home-card__head">
          <div class="home-card__head-title">
            <span class="home-card__head-icon">
              <n-icon :component="app.envReady ? CheckmarkCircleOutline : HelpCircleOutline" />
            </span>
            <h2>{{ t('home.envCardTitle') }}</h2>
          </div>
          <n-tag v-if="app.envReady" :bordered="false" size="small" type="success">{{ t('settings.envReady') }}</n-tag>
          <n-tag v-else-if="app.envInfo" :bordered="false" size="small" type="warning">{{ t('settings.envNeedsAttention') }}</n-tag>
          <n-tag v-else :bordered="false" size="small" type="info">{{ t('settings.envNotChecked') }}</n-tag>
        </div>
        <div class="env-rows">
          <div v-for="row in envRows" :key="row.label" class="env-row">
            <span class="env-row__label">{{ row.label }}</span>
            <span class="env-row__value">{{ row.value }}</span>
          </div>
        </div>
        <n-button block secondary :loading="app.envLoading" @click="checkEnv">
          {{ app.envLoading ? t('settings.checkingEnv') : t('settings.checkEnv') }}
        </n-button>
      </section>

      <section class="home-card data-dir-card">
        <div class="home-card__head">
          <div>
            <h2>{{ t('separate.dataDir') }}</h2>
            <p>{{ t('home.dataDirSubtitle') }}</p>
          </div>
        </div>
        <code class="data-dir-path" :title="settings.dataRoot || t('common.notSet')">{{ dataRootSummary }}</code>
        <n-button v-if="settings.appPaths?.canMigrateDataRootToPortable" secondary :loading="migratingDataRoot" @click="migrateDataRootToPortable">
          {{ t('separate.migrateDataDirToPortable') }}
        </n-button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.home-page {
  display: grid;
  gap: 18px;
}

.home-hero {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 26px 28px;
  border: 1px solid var(--outline);
  border-radius: 20px;
  background:
    radial-gradient(circle at 88% 18%, color-mix(in srgb, var(--primary-soft) 70%, transparent), transparent 42%),
    linear-gradient(135deg, color-mix(in srgb, var(--primary-soft) 55%, transparent), transparent 56%),
    var(--surface-1);
}

.home-hero__icon {
  width: 60px;
  height: 60px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
}

.home-hero__copy {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 6px;
}

.home-hero__copy h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 600;
  line-height: 1.1;
}

.home-hero__copy p {
  margin: 0;
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.5;
}

.home-hero__cta {
  flex: 0 0 auto;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--outline);
  border-radius: 16px;
  background: var(--surface-1);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: inherit;
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  border-color: var(--surface-3);
}

.stat-card__icon {
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 12px;
  font-size: 20px;
}

.stat-card__icon--primary {
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.stat-card__icon--success {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 16%, transparent);
}

.stat-card__icon--muted {
  color: var(--on-surface-muted);
  background: var(--surface-2);
}

.stat-card__body {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.stat-card__value {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.1;
}

.stat-card__label {
  font-size: 13px;
  font-weight: 600;
}

.stat-card__hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--on-surface-muted);
}

.home-columns {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.home-card {
  display: grid;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--outline);
  border-radius: 18px;
  background: var(--surface-1);
}

.home-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.home-card__head h2 {
  margin: 0;
  font-size: 16px;
}

.home-card__head p {
  margin: 4px 0 0;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.home-card__head-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.home-card__head-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  font-size: 17px;
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.guide-steps {
  display: grid;
  gap: 10px;
}

.guide-step {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--outline);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-2) 62%, transparent);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: inherit;
  transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
}

.guide-step:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--primary) 34%, var(--outline));
}

.guide-step__index {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--on-surface-muted);
  background: var(--surface-2);
}

.guide-step--done .guide-step__index {
  color: #fff;
  background: var(--success);
}

.guide-step__copy {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 2px;
}

.guide-step__copy strong {
  font-size: 13px;
}

.guide-step__copy small {
  font-size: 11px;
  color: var(--on-surface-muted);
}

.guide-step__badge {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--success);
}

.guide-step__arrow {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--on-surface-muted);
}

.env-rows {
  display: grid;
  gap: 8px;
}

.env-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.env-row__label {
  color: var(--on-surface-muted);
}

.env-row__value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.data-dir-card {
  gap: 12px;
}

.data-dir-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 10px 12px;
  border: 1px solid var(--outline);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 70%, transparent);
  color: var(--on-surface);
  font-size: 12px;
}

@media (max-width: 980px) {
  .home-columns {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .home-hero {
    flex-direction: column;
    align-items: flex-start;
  }

  .home-hero__cta {
    width: 100%;
  }

  .stat-grid {
    grid-template-columns: 1fr;
  }
}
</style>
