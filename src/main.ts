import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { initTheme } from './utils/theme'
import { registerWorkerEvents } from './utils/events'
import { useSettingsStore } from '@/stores/settings'
import './styles/global.scss'

async function bootstrap() {
  const pinia = createPinia()
  const app = createApp(App)
  app.use(pinia)

  const settings = useSettingsStore(pinia)
  await settings.initialize()
  const tasks = await import('@/stores/task').then((mod) => mod.useTaskStore(pinia))
  const models = await import('@/stores/model').then((mod) => mod.useModelStore(pinia))
  const workflows = await import('@/stores/workflow').then((mod) => mod.useWorkflowStore(pinia))
  await Promise.all([tasks.initialize(), models.initialize(), workflows.initialize()])
  initTheme(settings.themeMode, settings.themeAccent)
  registerWorkerEvents()

  app.use(router)
  app.use(i18n)
  app.mount('#app')
  models.loadModels().catch((error) => {
    console.warn('Failed to preload model metadata', error)
  })
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap application', error)
})
