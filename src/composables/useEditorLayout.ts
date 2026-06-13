import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { loadAppStore, saveAppStore } from '@/utils/appStore'

type ResizeSide = 'assets' | 'inspector'

type ResizeState = {
  side: ResizeSide
  startX: number
  startAssetWidth: number
  startInspectorWidth: number
}

type UseEditorLayoutOptions = {
  shellEl: Ref<HTMLElement | null>
  assetRailWidth: number
  resizerWidth: number
  minAssetWidth: number
  maxAssetWidth: number
  minCenterWidth: number
  minInspectorWidth: number
  maxInspectorWidth: number
  initialAssetWidth: number
  initialInspectorWidth?: number
}

type EditorUiState = {
  assetCollapsed?: boolean
  assetPanelWidth?: number
  inspectorPanelWidth?: number
}

export function useEditorLayout(options: UseEditorLayoutOptions) {
  const {
    shellEl,
    assetRailWidth,
    resizerWidth,
    minAssetWidth,
    maxAssetWidth,
    minCenterWidth,
    minInspectorWidth,
    maxInspectorWidth,
    initialAssetWidth,
    initialInspectorWidth = 288,
  } = options

  const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1440)
  const inspectorPanelWidth = ref(initialInspectorWidth)
  const assetPanelWidth = ref(initialAssetWidth)
  const isAssetCollapsed = ref(false)
  const activeResize = ref<ResizeState | null>(null)
  const initialized = ref(false)

  const inspectorVisible = computed(() => viewportWidth.value > 1320)
  const assetPanelVisible = computed(() => !isAssetCollapsed.value && viewportWidth.value > 920)
  const assetResizerVisible = computed(() => assetPanelVisible.value)

  const shellStyle = computed(() => ({
    '--asset-rail-width': `${assetRailWidth}px`,
    '--asset-panel-width': assetPanelVisible.value ? `${assetPanelWidth.value}px` : '0px',
    '--asset-resizer-width': assetResizerVisible.value ? `${resizerWidth}px` : '0px',
    '--inspector-resizer-width': inspectorVisible.value ? `${resizerWidth}px` : '0px',
    '--inspector-width': inspectorVisible.value ? `${inspectorPanelWidth.value}px` : '0px',
  }))

  function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max)
  }

  function getShellWidth() {
    return shellEl.value?.clientWidth || window.innerWidth || 0
  }

  function getVisibleAssetHandleWidth() {
    return assetResizerVisible.value ? resizerWidth : 0
  }

  function getVisibleHandleWidth() {
    return inspectorVisible.value ? resizerWidth : 0
  }

  function getAvailableSidebarWidth() {
    const shellWidth = getShellWidth()
    return Math.max(0, shellWidth - minCenterWidth - getVisibleHandleWidth())
  }

  function getAvailableAssetWidth() {
    const shellWidth = getShellWidth()
    const inspectorWidth = inspectorVisible.value ? inspectorPanelWidth.value : 0
    return Math.max(
      0,
      shellWidth
        - assetRailWidth
        - minCenterWidth
        - inspectorWidth
        - getVisibleHandleWidth()
        - getVisibleAssetHandleWidth(),
    )
  }

  function clampInspectorWidth(width: number) {
    const responsiveMax = getAvailableSidebarWidth()
    return clamp(width, minInspectorWidth, Math.max(minInspectorWidth, Math.min(maxInspectorWidth, responsiveMax)))
  }

  function clampAssetWidth(width: number) {
    const responsiveMax = getAvailableAssetWidth()
    return clamp(width, minAssetWidth, Math.max(minAssetWidth, Math.min(maxAssetWidth, responsiveMax)))
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function savePanelWidths() {
    if (!initialized.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveAppStore('editor-ui', {
        assetCollapsed: isAssetCollapsed.value,
        assetPanelWidth: assetPanelWidth.value,
        inspectorPanelWidth: inspectorPanelWidth.value,
      } satisfies EditorUiState)
    }, 80)
  }

  function handleResizeMove(event: MouseEvent) {
    const state = activeResize.value
    if (!state) return
    if (state.side === 'assets') {
      assetPanelWidth.value = clampAssetWidth(state.startAssetWidth + (event.clientX - state.startX))
      return
    }
    inspectorPanelWidth.value = clampInspectorWidth(state.startInspectorWidth - (event.clientX - state.startX))
  }

  function stopResize() {
    if (!activeResize.value) return
    activeResize.value = null
    window.removeEventListener('mousemove', handleResizeMove)
    window.removeEventListener('mouseup', stopResize)
    savePanelWidths()
  }

  function startResize(side: ResizeSide, event: MouseEvent) {
    if (event.button !== 0) return
    if (side === 'assets' && !assetResizerVisible.value) return
    if (side === 'inspector' && !inspectorVisible.value) return
    event.preventDefault()
    activeResize.value = {
      side,
      startX: event.clientX,
      startAssetWidth: assetPanelWidth.value,
      startInspectorWidth: inspectorPanelWidth.value,
    }
    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', stopResize)
  }

  async function restorePanelWidths() {
    const stored = await loadAppStore<EditorUiState>('editor-ui')
    isAssetCollapsed.value = Boolean(stored?.assetCollapsed)
    assetPanelWidth.value = clampAssetWidth(Number(stored?.assetPanelWidth || assetPanelWidth.value))
    inspectorPanelWidth.value = clampInspectorWidth(Number(stored?.inspectorPanelWidth || inspectorPanelWidth.value))
    initialized.value = true
  }

  function syncPanelWidthsToViewport() {
    viewportWidth.value = window.innerWidth
    assetPanelWidth.value = clampAssetWidth(assetPanelWidth.value)
    inspectorPanelWidth.value = clampInspectorWidth(inspectorPanelWidth.value)
  }

  function toggleAssetPanel(force?: boolean) {
    const next = typeof force === 'boolean' ? force : !isAssetCollapsed.value
    if (isAssetCollapsed.value === next) return
    isAssetCollapsed.value = next
    savePanelWidths()
  }

  onMounted(() => {
    void restorePanelWidths()
    window.addEventListener('resize', syncPanelWidthsToViewport)
  })

  onBeforeUnmount(() => {
    stopResize()
    window.removeEventListener('resize', syncPanelWidthsToViewport)
  })

  return {
    viewportWidth,
    inspectorPanelWidth,
    assetPanelWidth,
    isAssetCollapsed,
    activeResize,
    inspectorVisible,
    assetPanelVisible,
    assetResizerVisible,
    shellStyle,
    startResize,
    stopResize,
    toggleAssetPanel,
  }
}
