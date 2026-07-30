import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { initTheme } from './utils/theme'
import { registerWorkerEvents } from './utils/events'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
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
  await settings.initialize().catch((error) => {
    console.warn('Failed to initialize settings', error)
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
  appState.checkRuntimeInfo().then((runtime) => {
    if (runtime.ready) {
      return models.loadModels()
    }
    return undefined
  }).catch((error) => {
    console.warn('Failed to preload model metadata', error)
  })
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap application', error)
})
