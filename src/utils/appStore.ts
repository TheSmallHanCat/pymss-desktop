import { invoke } from '@tauri-apps/api/core'

export type AppStoreName = 'app-settings' | 'task-history' | 'model-state' | 'editor-ui' | 'workflow-state'

export async function loadAppStore<T>(name: AppStoreName): Promise<T | null> {
  const value = await invoke<T | null>('load_app_store', { name })
  return value && typeof value === 'object' ? value : null
}

export async function saveAppStore(name: AppStoreName, data: unknown) {
  await invoke('save_app_store', { name, data })
}
