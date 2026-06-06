import { listen } from '@tauri-apps/api/event'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import { useTaskStore } from '@/stores/task'
import { useModelStore } from '@/stores/model'

let registered = false
const hasTauriEventApi = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export function registerWorkerEvents() {
  if (registered || !hasTauriEventApi) return
  registered = true
  listen('pymss://worker-event', (event) => {
    const app = useAppStore()
    const settings = useSettingsStore()
    const tasks = useTaskStore()
    const models = useModelStore()
    app.pushWorkerEvent(event.payload)
    void settings.handleWorkerEvent(event.payload)
    tasks.handleWorkerEvent(event.payload)
    models.handleWorkerEvent(event.payload)
  }).catch(() => {})
}
