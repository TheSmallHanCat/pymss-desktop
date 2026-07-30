import { invoke } from '@tauri-apps/api/core'

export type AppStoreName = 'app-settings' | 'task-history' | 'model-state' | 'editor-ui' | 'workflow-state' | 'separate-state'

export const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

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

export async function saveAppStore(name: AppStoreName, data: unknown) {
  if (!isTauriRuntime()) {
    localStorage.setItem(localStoreKey(name), JSON.stringify(data))
    return
  }
  await invoke('save_app_store', { name, data })
}
