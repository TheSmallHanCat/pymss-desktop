import { invoke } from '@tauri-apps/api/core'

export type AppStoreName = 'app-settings' | 'task-history' | 'model-state' | 'editor-ui' | 'audio-tools' | 'workflow-state' | 'separate-state' | 'update-state'

export const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const saveQueues = new Map<AppStoreName, Promise<void>>()

function localStoreKey(name: AppStoreName) {
  return `pymss-studio:${name}`
}

export async function loadAppStore<T>(name: AppStoreName): Promise<T | null> {
  if (!isTauriRuntime()) {
    const raw = localStorage.getItem(localStoreKey(name))
    if (!raw) return null
    try {
      const value = JSON.parse(raw) as T
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  }
  const value = await invoke<T | null>('load_app_store', { name })
  return value && typeof value === 'object' ? value : null
}

async function writeAppStore(name: AppStoreName, data: unknown, serialized: string) {
  if (!isTauriRuntime()) {
    localStorage.setItem(localStoreKey(name), serialized)
    return
  }
  await invoke('save_app_store', { name, data })
}

export function saveAppStore(name: AppStoreName, data: unknown) {
  let serialized: string | undefined
  let snapshot: unknown
  try {
    serialized = JSON.stringify(data)
    if (serialized === undefined) {
      throw new TypeError(`App store "${name}" cannot persist an undefined value`)
    }
    snapshot = JSON.parse(serialized) as unknown
  } catch (error) {
    return Promise.reject(error)
  }
  const previous = saveQueues.get(name) ?? Promise.resolve()
  const save = previous
    .catch(() => undefined)
    .then(() => writeAppStore(name, snapshot, serialized))
  saveQueues.set(name, save)
  void save.finally(() => {
    if (saveQueues.get(name) === save) saveQueues.delete(name)
  }).catch(() => undefined)
  return save
}
