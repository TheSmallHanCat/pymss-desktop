import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import type { ComposerTranslation } from 'vue-i18n'
import type { useEditorStore } from '@/stores/editor'

type EditorStore = ReturnType<typeof useEditorStore>

type UseEditorProjectBridgeOptions = {
  routeProjectId: Ref<string>
  hasTauriApis: boolean
  editor: EditorStore
  assetPanelEl: Ref<HTMLElement | null>
  message: MessageApiInjection
  t: ComposerTranslation
}

export function useEditorProjectBridge(options: UseEditorProjectBridgeOptions) {
  const { routeProjectId, hasTauriApis, editor, assetPanelEl, message, t } = options

  const isDraggingExternal = ref(false)

  let unlistenDrop: UnlistenFn | null = null
  let unlistenOpenProject: UnlistenFn | null = null

  async function loadProject(projectId: string) {
    if (!projectId) return
    await editor.loadProject(projectId)
  }

  function isPointInAssetPanel(position: { x: number; y: number } | null | undefined) {
    const element = assetPanelEl.value
    if (!element || !position) return false

    const rect = element.getBoundingClientRect()
    const scale = window.devicePixelRatio || 1
    const x = position.x / scale
    const y = position.y / scale

    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  async function handleProjectLoad(projectId: string) {
    try {
      await loadProject(projectId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      message.error(t('editor.loadFailed', { detail }))
    }
  }

  async function handleExternalDrop(paths: string[]) {
    try {
      const result = await editor.scanAssets(paths)
      if (result.files.length) message.success(t('editor.importSuccess', { count: result.files.length }))
      else message.warning(t('editor.importEmpty'))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      message.error(detail || t('editor.importEmpty'))
    }
  }

  onMounted(async () => {
    if (!hasTauriApis) return

    try {
      unlistenDrop = await getCurrentWebview().onDragDropEvent(async (event) => {
        const type = event.payload.type
        if (type === 'over' || type === 'enter') {
          isDraggingExternal.value = isPointInAssetPanel(event.payload.position)
          return
        }

        if (type === 'drop') {
          const isDropInAssetPanel = isPointInAssetPanel(event.payload.position)
          isDraggingExternal.value = false
          if (!isDropInAssetPanel) return
          const paths = (event.payload as { paths?: string[] }).paths || []
          await handleExternalDrop(paths)
          return
        }

        isDraggingExternal.value = false
      })
    } catch {
      // browser preview fallback
    }

    unlistenOpenProject = await listen<{ projectId: string }>('pymss://editor-open-project', (event) => {
      void handleProjectLoad(event.payload.projectId)
    })
  })

  watch(routeProjectId, (projectId, previousProjectId) => {
    if (!hasTauriApis) return
    if (!projectId || projectId === previousProjectId) return
    void handleProjectLoad(projectId)
  }, { immediate: true })

  onBeforeUnmount(() => {
    unlistenDrop?.()
    unlistenOpenProject?.()
  })

  return {
    isDraggingExternal,
    loadProject,
  }
}
