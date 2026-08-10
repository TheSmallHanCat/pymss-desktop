import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { initTheme } from './utils/theme'
import { registerWorkerEvents } from './utils/events'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { useUpdateStore } from '@/stores/update'
import './styles/global.scss'

async function bootstrap() {
  const pinia = createPinia()
  const app = createApp(App)
  app.use(pinia)
  app.use(router)
  app.use(i18n)

  const mounted = () => {
    if (!document.querySelector('#app')?.hasChildNodes()) app.mount('#app')
  }

  const settings = useSettingsStore(pinia)
  const appState = useAppStore(pinia)
  const updates = useUpdateStore(pinia)
  await settings.initialize().catch((error) => {
    console.warn('Failed to initialize settings', error)
  })
  await updates.initialize().catch((error) => {
    console.warn('Failed to initialize update store', error)
  })
  const tasks = await import('@/stores/task').then((mod) => mod.useTaskStore(pinia))
  await tasks.initialize().catch((error) => {
    console.warn('Failed to initialize tasks', error)
  })
  mounted()

  const models = await import('@/stores/model').then((mod) => mod.useModelStore(pinia))
  const workflows = await import('@/stores/workflow').then((mod) => mod.useWorkflowStore(pinia))
  await Promise.allSettled([models.initialize(), workflows.initialize()])
  initTheme(settings.themeMode, settings.themeAccent)
  registerWorkerEvents()
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const buildInfo = await invoke<{ version?: string; variant?: string; updateSupported?: boolean }>('get_build_info')
    appState.buildInfoVersion = buildInfo.version || ''
    appState.buildInfoVariant = buildInfo.variant || ''
    appState.buildInfoUpdateSupported = buildInfo.updateSupported === true
  } catch (error: unknown) {
    console.warn('Failed to load build info version', error)
  }
  if (appState.buildInfoVersion && updates.hasPendingDeferredVersion(appState.buildInfoVersion)) {
    updates.status = 'ready'
  }
  appState.checkRuntimeInfo().then((runtime) => {
    if (runtime.ready) {
      return models.loadModels()
    }
    return undefined
  }).catch((error) => {
    console.warn('Failed to preload model metadata', error)
  })
  void updates.checkForUpdates().catch((error) => {
    console.warn('Failed to check for updates', error)
  })
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap application', error)
})
