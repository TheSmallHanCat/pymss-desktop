import { computed, type ComputedRef } from 'vue'
import type { DialogApiInjection } from 'naive-ui/es/dialog/src/DialogProvider'
import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import type { ComposerTranslation } from 'vue-i18n'
import type { EditorSource, EditorSession } from '@/types/editor'
import type { useEditorStore } from '@/stores/editor'
import type { useTaskStore } from '@/stores/task'

type EditorStore = ReturnType<typeof useEditorStore>
type TaskStore = ReturnType<typeof useTaskStore>

type UseEditorAssetsOptions = {
  editor: EditorStore
  task: TaskStore
  message: MessageApiInjection
  dialog: DialogApiInjection
  t: ComposerTranslation
  session: ComputedRef<EditorSession | null>
  clearAssetPointerDrag: () => void
}

export function useEditorAssets(options: UseEditorAssetsOptions) {
  const { editor, task, message, dialog, t, session, clearAssetPointerDrag } = options

  const librarySources = computed(() => session.value?.sources || [])

  async function addSourceAsReference(source: EditorSource) {
    try {
      editor.addTrackFromSourceId(source.id)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  function addTrackFromAsset(sourceId: string) {
    try {
      editor.addTrackFromSourceId(sourceId)
      clearAssetPointerDrag()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  function revealSource(source: EditorSource) {
    void task.revealPath(source.path)
  }

  async function relinkSource(source: EditorSource) {
    try {
      const result = await editor.relinkSource(source.id)
      if (!result) return
      if (result.unresolved.length) {
        message.warning(t('editor.assetRelinkPartial', { resolved: result.relinked, unresolved: result.unresolved.length }))
        return
      }
      message.success(t('editor.assetRelinkSuccess', { count: result.relinked }))
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('editor.assetRelinkFailed'))
    }
  }

  function revealTrackSource(trackId: string) {
    const track = session.value?.tracks.find((item) => item.id === trackId)
    const source = track ? editor.sourceMap.get(track.sourceId) : null
    if (source) revealSource(source)
  }

  function openExportDir() {
    const path = editor.lastExport?.path || session.value?.sourceResultDir
    if (path) void task.revealPath(path)
  }

  function removeSource(source: EditorSource) {
    if (source.role === 'stem') {
      message.warning(t('editor.assetLocalProtected'))
      return
    }

    const linkedTrackCount = session.value?.tracks.filter((track) => track.sourceId === source.id).length || 0
    const commitRemoval = () => {
      const result = editor.removeSource(source.id)
      if (!result.removedSource) return

      if (result.removedTracks > 0) {
        message.success(t('editor.assetRemovedWithTracks', { count: result.removedTracks }))
        return
      }

      message.success(t('editor.assetRemoved'))
    }

    if (linkedTrackCount > 0) {
      dialog.warning({
        title: t('editor.removeAssetConfirmTitle'),
        content: t('editor.removeAssetConfirmContent', { count: linkedTrackCount }),
        positiveText: t('common.confirm'),
        negativeText: t('common.cancel'),
        onPositiveClick: commitRemoval,
      })
      return
    }

    commitRemoval()
  }

  return {
    librarySources,
    addSourceAsReference,
    addTrackFromAsset,
    revealSource,
    relinkSource,
    revealTrackSource,
    openExportDir,
    removeSource,
  }
}
