import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import type { ComposerTranslation } from 'vue-i18n'
import type { EditorExportFormat } from '@/types/editor'
import type { useEditorStore } from '@/stores/editor'
import type { useSettingsStore } from '@/stores/settings'

type EditorStore = ReturnType<typeof useEditorStore>
type SettingsStore = ReturnType<typeof useSettingsStore>

type UseEditorExportOptions = {
  editor: EditorStore
  settings: SettingsStore
  message: MessageApiInjection
  t: ComposerTranslation
}

export function useEditorExport(options: UseEditorExportOptions) {
  const { editor, settings, message, t } = options

  let lastExportFormat: EditorExportFormat = 'wav'
  const showExportDialog = ref(false)
  const exportFormatDraft = ref<EditorExportFormat>('wav')
  const exportWavBitDepthDraft = ref('PCM_24')
  const exportFlacBitDepthDraft = ref('PCM_24')
  const exportDirDraft = ref('')
  const exportDirPicking = ref(false)

  function getDefaultExportDir() {
    return settings.outputDir.trim() || ''
  }

  function openExportDialog() {
    exportFormatDraft.value = lastExportFormat
    exportWavBitDepthDraft.value = settings.wavBitDepth
    exportFlacBitDepthDraft.value = settings.flacBitDepth
    exportDirDraft.value = editor.lastExport?.path
      ? editor.lastExport.path.replace(/[\\/][^\\/]+$/, '')
      : getDefaultExportDir()
    showExportDialog.value = true
  }

  function closeExportDialog() {
    showExportDialog.value = false
  }

  function setExportDialogVisible(value: boolean) {
    if (!value) closeExportDialog()
  }

  function setExportFormat(value: EditorExportFormat) {
    exportFormatDraft.value = value
  }

  function setExportWavBitDepth(value: string) {
    exportWavBitDepthDraft.value = value
  }

  function setExportFlacBitDepth(value: string) {
    exportFlacBitDepthDraft.value = value
  }

  function setExportDir(value: string) {
    exportDirDraft.value = value
  }

  async function pickExportDir() {
    exportDirPicking.value = true
    try {
      const folder = await invoke<string | null>('pick_output_folder')
      if (folder) exportDirDraft.value = folder
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('editor.exportDirPickFailed'))
    } finally {
      exportDirPicking.value = false
    }
  }

  async function exportMix() {
    try {
      const result = await editor.exportMix({
        format: exportFormatDraft.value,
        exportDir: exportDirDraft.value.trim() || undefined,
        audioParams: {
          wavBitDepth: exportWavBitDepthDraft.value,
          flacBitDepth: exportFlacBitDepthDraft.value,
        },
      })
      settings.wavBitDepth = exportWavBitDepthDraft.value
      settings.flacBitDepth = exportFlacBitDepthDraft.value
      lastExportFormat = exportFormatDraft.value
      message.success(t('editor.exported', { path: result.path }))
      try {
        await invoke('reveal_path', { path: result.path })
      } catch {
        message.warning(t('editor.exportOpenFailed'))
      }
      closeExportDialog()
    } catch {
      message.error(editor.lastError || t('editor.exportFailed'))
    }
  }

  return {
    showExportDialog,
    exportFormatDraft,
    exportWavBitDepthDraft,
    exportFlacBitDepthDraft,
    exportDirDraft,
    exportDirPicking,
    openExportDialog,
    closeExportDialog,
    setExportDialogVisible,
    setExportFormat,
    setExportWavBitDepth,
    setExportFlacBitDepth,
    setExportDir,
    pickExportDir,
    exportMix,
  }
}
