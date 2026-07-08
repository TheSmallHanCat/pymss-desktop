<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { darkTheme } from 'naive-ui'
import TitleBar from '@/components/TitleBar.vue'
import SideNav from '@/components/SideNav.vue'
import AppBrandMark from '@/components/AppBrandMark.vue'
import StartupOnboarding from '@/components/StartupOnboarding.vue'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { getResolvedThemeTokens, getThemeOverrides, resolvedIsDark } from '@/utils/theme'
import { useI18n } from 'vue-i18n'

const settings = useSettingsStore()
const app = useAppStore()
const route = useRoute()
const { t } = useI18n()
const bootReady = ref(false)
const backgroundWarmupsStarted = ref(false)

const isDark = computed(() => resolvedIsDark(settings.themeMode))
const isEditorRoute = computed(() => route.path === '/editor')
const isMacOS = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const resolvedTheme = computed(() => getResolvedThemeTokens(settings.themeMode, settings.themeAccent))
const showStartupOnboarding = computed(() => bootReady.value && !isEditorRoute.value && settings.shouldShowStartupOnboarding)

const routeWarmupLoaders = [
  () => import('@/views/SeparateView.vue'),
  () => import('@/views/ModelsView.vue'),
  () => import('@/views/WorkflowsView.vue'),
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

onMounted(() => {
  window.setTimeout(() => {
    bootReady.value = true
  }, 120)
})

watch([bootReady, showStartupOnboarding], () => {
  startBackgroundWarmups()
}, { immediate: true })

const themeOverrides = computed(() => getThemeOverrides(settings.themeMode, settings.themeAccent))
</script>

<template>
  <n-config-provider :theme="isDark ? darkTheme : null" :theme-overrides="themeOverrides">
    <n-notification-provider>
      <n-message-provider>
        <n-dialog-provider>
        <div class="app-shell" :class="{ 'app-shell--editor': isEditorRoute, 'app-shell--native-titlebar': isMacOS, 'no-animations': !settings.animationsEnabled }">
          <div class="app-backdrop" />
          <TitleBar />
          <div class="app-body">
            <SideNav v-if="!isEditorRoute" />
            <main class="app-content">
              <router-view v-slot="{ Component, route }">
                <transition name="page" mode="out-in">
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
</style>
