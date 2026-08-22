<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { darkTheme } from 'naive-ui'
import TitleBar from '@/components/TitleBar.vue'
import SideNav from '@/components/SideNav.vue'
import AppBrandMark from '@/components/AppBrandMark.vue'
import StartupOnboarding from '@/components/StartupOnboarding.vue'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { useUpdateStore } from '@/stores/update'
import { getResolvedThemeTokens, getThemeOverrides, resolvedIsDark } from '@/utils/theme'
import { useI18n } from 'vue-i18n'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-shell'
import { useWorkflowStore } from '@/stores/workflow'
import { activeRuntimeEnvironment, runtimeBackendLabel, runtimeCoreUpdateAvailable as hasRuntimeCoreUpdate } from '@/utils/runtime'

const settings = useSettingsStore()
const app = useAppStore()
const updates = useUpdateStore()
const workflow = useWorkflowStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const bootReady = ref(false)
const backgroundWarmupsStarted = ref(false)
const deferredPromptShown = ref(false)
const deferredUpdateModalVisible = ref(false)
const deferredUpdateInstalling = ref(false)
const deferredUpdateError = ref('')
const manualUpdatePromptShown = ref(false)
const manualUpdateModalVisible = ref(false)
const manualUpdateError = ref('')
const runtimeCorePromptVisible = ref(false)
const runtimeCorePromptShown = ref(false)
let unlistenNodeEditorClosed: UnlistenFn | undefined

const isDark = computed(() => resolvedIsDark(settings.themeMode))
const isStandaloneRoute = computed(() => route.path === '/editor' || route.path === '/workflow-node-editor')
const isWorkflowNodeEditorRoute = computed(() => route.path === '/workflow-node-editor')
const isMacOS = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const resolvedTheme = computed(() => getResolvedThemeTokens(settings.themeMode, settings.themeAccent))
const showStartupOnboarding = computed(() => bootReady.value && !isStandaloneRoute.value && settings.shouldShowStartupOnboarding)
const deferredUpdatePrompt = computed(() => updates.updateIsPrerelease
  ? t('settings.updatePrereleaseDeferredPrompt', { version: updates.latestVersion })
  : t('settings.updateDeferredPrompt', { version: updates.latestVersion }))
const manualUpdatePrompt = computed(() => updates.updateMessage || t('settings.updateManualInstallPrompt', { version: updates.latestVersion }))
const activeRuntime = computed(() => activeRuntimeEnvironment(app.runtimeInfo))
const runtimeCoreUpdateAvailable = computed(() => hasRuntimeCoreUpdate(
  activeRuntime.value,
  app.runtimeCoreVersions?.packages?.pymss?.latestVersion,
  app.runtimeCoreVersions?.packages?.['pymss-core']?.latestVersion,
))
const runtimeCorePromptContent = computed(() => t('settings.runtimeCoreStartupPrompt', {
  backend: runtimeBackendLabel(activeRuntime.value?.backend || t('settings.envNotChecked')),
  pymss: activeRuntime.value?.pymssVersion || activeRuntime.value?.packageVersions?.pymss || t('settings.runtimeCoreVersionUnknown'),
  core: activeRuntime.value?.pymssCoreVersion || activeRuntime.value?.packageVersions?.['pymss-core'] || t('settings.runtimeCoreVersionUnknown'),
  latest: app.runtimeCoreVersions?.packages?.pymss?.latestVersion || t('settings.runtimeCoreVersionUnknown'),
  coreLatest: app.runtimeCoreVersions?.packages?.['pymss-core']?.latestVersion || t('settings.runtimeCoreVersionUnknown'),
}))

const routeWarmupLoaders = [
  () => import('@/views/SeparateView.vue'),
  () => import('@/views/ModelsView.vue'),
  () => import('@/views/WorkflowsView.vue'),
  () => import('@/views/WorkflowNodeEditorView.vue'),
  () => import('@/views/ResultsView.vue'),
  () => import('@/views/SettingsView.vue'),
  () => import('@/views/DebugView.vue'),
]

function scheduleIdleWork(task: () => void) {
  const idleWindow = window as Window & typeof globalThis & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  }
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(() => task(), { timeout: 2000 })
    return
  }
  window.setTimeout(task, 400)
}

function startBackgroundWarmups() {
  if (backgroundWarmupsStarted.value || !bootReady.value || showStartupOnboarding.value) return
  backgroundWarmupsStarted.value = true
  scheduleIdleWork(() => {
    void Promise.allSettled(routeWarmupLoaders.map((load) => load()))
    if (!app.envInfo && !app.envLoading) {
      app.checkEnvInBackground().catch(() => {})
    }
  })
}

function showDeferredUpdatePrompt() {
  if (deferredPromptShown.value) return
  if (!updates.shouldShowDeferred || !updates.latestVersion) return
  if (updates.requiresManualInstall) return
  deferredPromptShown.value = true
  deferredUpdateError.value = ''
  deferredUpdateModalVisible.value = true
}

function showManualUpdatePrompt() {
  if (manualUpdatePromptShown.value || !bootReady.value) return
  if (!updates.requiresManualInstall || !updates.latestVersion) return
  manualUpdatePromptShown.value = true
  manualUpdateError.value = ''
  manualUpdateModalVisible.value = true
}

async function openManualUpdate() {
  const url = updates.manualInstallUrl || 'https://github.com/pymss-project/pymss-studio/releases/latest'
  try {
    await open(url)
    manualUpdateModalVisible.value = false
  } catch (error) {
    manualUpdateError.value = error instanceof Error ? error.message : String(error)
  }
}

function showRuntimeCorePrompt() {
  if (runtimeCorePromptShown.value || !bootReady.value || !runtimeCoreUpdateAvailable.value) return
  runtimeCorePromptShown.value = true
  runtimeCorePromptVisible.value = true
}

function openRuntimeSettings() {
  runtimeCorePromptVisible.value = false
  void router.push({ path: '/settings', query: { section: 'runtime' } })
}

async function installDeferredUpdate() {
  if (deferredUpdateInstalling.value) return
  deferredUpdateInstalling.value = true
  deferredUpdateError.value = ''
  deferredUpdateModalVisible.value = false
  try {
    await updates.downloadAndInstall()
  } catch (error) {
    deferredUpdateError.value = error instanceof Error ? error.message : String(error)
  } finally {
    deferredUpdateInstalling.value = false
  }
}

async function keepDeferredUpdateForNextLaunch() {
  deferredUpdateError.value = ''
  try {
    await updates.deferUntilNextLaunch()
    deferredUpdateModalVisible.value = false
  } catch (error) {
    deferredUpdateError.value = error instanceof Error ? error.message : String(error)
  }
}

onMounted(async () => {
  window.setTimeout(() => {
    bootReady.value = true
  }, 120)
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    unlistenNodeEditorClosed = await listen('pymss://workflow-node-editor-closed', () => {
      workflow.markNodeEditorClosed()
      void workflow.reload()
    })
  }
})

onUnmounted(() => {
  unlistenNodeEditorClosed?.()
})

watch([bootReady, showStartupOnboarding], () => {
  startBackgroundWarmups()
}, { immediate: true })

watch([bootReady, () => updates.shouldShowDeferred, () => updates.latestVersion], () => {
  if (bootReady.value) showDeferredUpdatePrompt()
}, { immediate: true })

watch([bootReady, () => updates.requiresManualInstall, () => updates.latestVersion], () => {
  showManualUpdatePrompt()
}, { immediate: true })

watch([bootReady, runtimeCoreUpdateAvailable], () => {
  showRuntimeCorePrompt()
}, { immediate: true })

const themeOverrides = computed(() => getThemeOverrides(settings.themeMode, settings.themeAccent))
</script>

<template>
  <n-config-provider :theme="isDark ? darkTheme : null" :theme-overrides="themeOverrides">
    <n-notification-provider>
      <n-message-provider>
        <n-dialog-provider>
        <div class="app-shell" :class="{ 'app-shell--editor': isStandaloneRoute, 'app-shell--workflow-node-editor': isWorkflowNodeEditorRoute, 'app-shell--native-titlebar': isMacOS, 'no-animations': !settings.animationsEnabled }">
          <div class="app-backdrop" />
          <TitleBar v-if="!isWorkflowNodeEditorRoute" />
          <div class="app-body">
            <SideNav v-if="!isStandaloneRoute" />
            <main class="app-content">
              <router-view v-slot="{ Component, route }">
                <component v-if="isWorkflowNodeEditorRoute" :is="Component" :key="route.fullPath" />
                <transition v-else name="page" mode="out-in">
                  <component :is="Component" :key="route.path" />
                </transition>
              </router-view>
            </main>
          </div>
          <transition name="boot-fade">
            <div v-if="!bootReady" class="boot-splash">
              <AppBrandMark class="boot-splash__mark" :size="58" shadow />
            <div class="boot-splash__copy">
              <strong>Pymss Studio</strong>
                <span>{{ t('app.bootPreparing') }}</span>
              </div>
            </div>
          </transition>
          <StartupOnboarding v-if="showStartupOnboarding" />
        </div>
        <n-modal v-model:show="deferredUpdateModalVisible" preset="dialog" type="warning" :mask-closable="false" :closable="false">
          <template #header>
            {{ t('settings.updateDeferred') }}
          </template>
          <div>{{ deferredUpdatePrompt }}</div>
          <n-alert v-if="deferredUpdateError" type="error" :bordered="false" style="margin-top: 12px">
            {{ deferredUpdateError }}
          </n-alert>
          <template #action>
            <n-button secondary :disabled="deferredUpdateInstalling" @click="keepDeferredUpdateForNextLaunch">
              {{ t('settings.updateRemindLater') }}
            </n-button>
            <n-button type="primary" :loading="deferredUpdateInstalling" @click="installDeferredUpdate">
              {{ t('settings.installUpdate') }}
            </n-button>
          </template>
        </n-modal>
        <n-modal v-model:show="manualUpdateModalVisible" preset="dialog" type="warning" :mask-closable="false" :closable="false">
          <template #header>
            {{ t('settings.updateManualInstallTitle') }}
          </template>
          <div>{{ manualUpdatePrompt }}</div>
          <n-alert v-if="manualUpdateError" type="error" :bordered="false" style="margin-top: 12px">
            {{ manualUpdateError }}
          </n-alert>
          <template #action>
            <n-button secondary @click="manualUpdateModalVisible = false">
              {{ t('common.close') }}
            </n-button>
            <n-button type="primary" @click="openManualUpdate">
              {{ t('settings.updateOpenGitHub') }}
            </n-button>
          </template>
        </n-modal>
        <n-modal v-model:show="runtimeCorePromptVisible" preset="dialog" type="warning" :mask-closable="false" :closable="false">
          <template #header>
            {{ t('settings.runtimeCoreStartupTitle') }}
          </template>
          <div>{{ runtimeCorePromptContent }}</div>
          <template #action>
            <n-button secondary @click="runtimeCorePromptVisible = false">
              {{ t('settings.runtimeCoreStartupLater') }}
            </n-button>
            <n-button type="warning" @click="openRuntimeSettings">
              {{ t('settings.runtimeCoreStartupOpenSettings') }}
            </n-button>
          </template>
        </n-modal>
        <n-modal :show="updates.isInstallOverlayVisible" preset="card" :mask-closable="false" :closable="false" class="update-install-modal" :bordered="false">
          <div class="update-install-panel">
            <div class="update-install-panel__head">
              <strong>
                {{ updates.status === 'failed' ? t('settings.updateInstallFailed') : updates.status === 'installing' ? t('settings.updateInstalling') : t('settings.updateDownloading') }}
              </strong>
              <span>{{ updates.status === 'failed' ? t('settings.updateInstallFailedHint') : t('settings.updateInstallOverlayHint') }}</span>
            </div>
            <n-progress
              v-if="updates.status !== 'failed'"
              type="line"
              :percentage="updates.downloadProgressPercent"
              :processing="updates.status === 'downloading'"
              :show-indicator="updates.downloadTotalBytes > 0"
              status="success"
            />
            <p v-if="updates.status === 'downloading' && updates.downloadTotalBytes > 0" class="update-install-panel__meta">
              {{ t('settings.updateDownloadProgress', { percent: updates.downloadProgressPercent }) }}
            </p>
            <p v-else-if="updates.status === 'installing'" class="update-install-panel__meta">
              {{ t('settings.updateInstallRestarting') }}
            </p>
            <n-alert v-if="updates.status === 'failed' && updates.error" type="error" :bordered="false">
              {{ updates.error }}
            </n-alert>
            <div v-if="updates.status === 'failed'" class="update-install-panel__actions">
              <n-button secondary @click="updates.dismissInstallError()">{{ t('common.close') }}</n-button>
            </div>
          </div>
        </n-modal>
        </n-dialog-provider>
      </n-message-provider>
    </n-notification-provider>
  </n-config-provider>
</template>

<style scoped>
.boot-splash {
  position: absolute;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  gap: 14px;
  background:
    radial-gradient(circle at 20% 16%, color-mix(in srgb, v-bind('resolvedTheme.primarySoft') 90%, transparent), transparent 28%),
    linear-gradient(180deg, rgba(255,255,255,0.03), transparent 32%),
    var(--surface);
}

.boot-splash__mark {
  flex: 0 0 auto;
}

.boot-splash__copy {
  display: grid;
  gap: 6px;
  text-align: center;
}

.boot-splash__copy strong {
  font-size: 18px;
  letter-spacing: 0.01em;
}

.boot-splash__copy span {
  font-size: 12px;
  color: var(--on-surface-muted);
}

.boot-fade-enter-active,
.boot-fade-leave-active {
  transition: opacity 240ms ease;
}

.boot-fade-enter-from,
.boot-fade-leave-to {
  opacity: 0;
}

.update-install-modal {
  width: min(440px, calc(100vw - 32px));
}

.update-install-panel {
  display: grid;
  gap: 16px;
}

.update-install-panel__head {
  display: grid;
  gap: 6px;
}

.update-install-panel__head strong {
  color: var(--on-surface);
  font-size: 17px;
}

.update-install-panel__head span,
.update-install-panel__meta {
  color: var(--on-surface-muted);
  font-size: 12px;
}

.update-install-panel__meta {
  margin: -6px 0 0;
}

.update-install-panel__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
