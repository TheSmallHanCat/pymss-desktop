import { listen } from '@tauri-apps/api/event'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import { useTaskStore } from '@/stores/task'
import { useModelStore, type WorkerEvent } from '@/stores/model'

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
    const workerEvent = event.payload as WorkerEvent
    app.pushWorkerEvent(workerEvent)
    void settings.handleWorkerEvent(workerEvent)
    tasks.handleWorkerEvent(workerEvent)
    models.handleWorkerEvent(workerEvent)
  }).catch(() => {})
}
