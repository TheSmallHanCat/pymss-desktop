import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { loadAppStore, saveAppStore } from '@/utils/appStore'
import { calculateEditorPanelCapacity } from '@/utils/editorLayout'

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
  inspectorRailWidth: number
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
  inspectorCollapsed?: boolean
  assetPanelWidth?: number
  inspectorPanelWidth?: number
}

export function useEditorLayout(options: UseEditorLayoutOptions) {
  const {
    shellEl,
    assetRailWidth,
    inspectorRailWidth,
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
  const isInspectorCollapsed = ref(true)
  const activeResize = ref<ResizeState | null>(null)
  const initialized = ref(false)

  // Keep a narrow inspector launcher available after the full panel is collapsed.
  // This gives the timeline its space without making track parameters inaccessible.
  const inspectorVisible = computed(() => viewportWidth.value > 760)
  const assetPanelVisible = computed(() => !isAssetCollapsed.value && viewportWidth.value > 920)
  const assetResizerVisible = computed(() => assetPanelVisible.value)
  const inspectorPanelVisible = computed(() => inspectorVisible.value && !isInspectorCollapsed.value)

  const shellStyle = computed(() => ({
    '--asset-rail-width': `${assetRailWidth}px`,
    '--asset-panel-width': assetPanelVisible.value ? `${assetPanelWidth.value}px` : '0px',
    '--asset-resizer-width': assetResizerVisible.value ? `${resizerWidth}px` : '0px',
    // The inspector toggle lives inside the panel. Only reserve the narrow
    // launcher width while the panel is collapsed; an expanded inspector no
    // longer carries a separate rail column.
    '--inspector-rail-width': inspectorVisible.value && !inspectorPanelVisible.value
      ? `${inspectorRailWidth}px`
      : '0px',
    '--inspector-resizer-width': inspectorPanelVisible.value ? `${resizerWidth}px` : '0px',
    '--inspector-width': inspectorPanelVisible.value ? `${inspectorPanelWidth.value}px` : '0px',
  }))

  function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max)
  }

  function getShellWidth() {
    return shellEl.value?.clientWidth || window.innerWidth || 0
  }

  function getPanelCapacity(overrides: {
    inspectorPanelVisible?: boolean
    inspectorRailVisible?: boolean
  } = {}) {
    const nextInspectorPanelVisible = overrides.inspectorPanelVisible ?? inspectorPanelVisible.value
    const nextInspectorRailVisible = overrides.inspectorRailVisible
      ?? (inspectorVisible.value && !nextInspectorPanelVisible)
    return calculateEditorPanelCapacity({
      shellWidth: getShellWidth(),
      minCenterWidth,
      assetRailWidth,
      inspectorRailWidth,
      resizerWidth,
      assetPanelWidth: assetPanelWidth.value,
      inspectorPanelWidth: inspectorPanelWidth.value,
      assetPanelVisible: assetPanelVisible.value,
      inspectorRailVisible: nextInspectorRailVisible,
      inspectorPanelVisible: nextInspectorPanelVisible,
    })
  }

  function clampInspectorWidth(width: number) {
    const responsiveMax = getPanelCapacity().availableInspectorWidth
    return clamp(width, minInspectorWidth, Math.max(minInspectorWidth, Math.min(maxInspectorWidth, responsiveMax)))
  }

  function clampAssetWidth(width: number) {
    const responsiveMax = getPanelCapacity().availableAssetWidth
    return clamp(width, minAssetWidth, Math.max(minAssetWidth, Math.min(maxAssetWidth, responsiveMax)))
  }

  function keepCenterWidthAvailable() {
    if (!assetPanelVisible.value || !inspectorPanelVisible.value) return false
    if (getPanelCapacity().centerWidth >= minCenterWidth) return false
    isAssetCollapsed.value = true
    return true
  }

  function clampPanelWidths() {
    assetPanelWidth.value = assetPanelVisible.value
      ? clampAssetWidth(assetPanelWidth.value)
      : clamp(assetPanelWidth.value, minAssetWidth, maxAssetWidth)
    inspectorPanelWidth.value = inspectorPanelVisible.value
      ? clampInspectorWidth(inspectorPanelWidth.value)
      : clamp(inspectorPanelWidth.value, minInspectorWidth, maxInspectorWidth)
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function savePanelWidths() {
    if (!initialized.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveAppStore('editor-ui', {
        assetCollapsed: isAssetCollapsed.value,
        inspectorCollapsed: isInspectorCollapsed.value,
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
    if (side === 'inspector' && !inspectorPanelVisible.value) return
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
    isInspectorCollapsed.value = typeof stored?.inspectorCollapsed === 'boolean'
      ? stored.inspectorCollapsed
      : true
    assetPanelWidth.value = clamp(
      Number(stored?.assetPanelWidth || assetPanelWidth.value),
      minAssetWidth,
      maxAssetWidth,
    )
    inspectorPanelWidth.value = clamp(
      Number(stored?.inspectorPanelWidth || inspectorPanelWidth.value),
      minInspectorWidth,
      maxInspectorWidth,
    )
    const layoutAdjusted = keepCenterWidthAvailable()
    clampPanelWidths()
    initialized.value = true
    if (layoutAdjusted) savePanelWidths()
  }

  function syncPanelWidthsToViewport() {
    viewportWidth.value = window.innerWidth
    const layoutAdjusted = keepCenterWidthAvailable()
    clampPanelWidths()
    if (layoutAdjusted) savePanelWidths()
  }

  function toggleAssetPanel(expanded?: boolean) {
    const shouldExpand = typeof expanded === 'boolean' ? expanded : isAssetCollapsed.value
    if (shouldExpand === !isAssetCollapsed.value) return
    if (
      shouldExpand
      && inspectorPanelVisible.value
      && getPanelCapacity().availableAssetWidth < minAssetWidth
    ) {
      isInspectorCollapsed.value = true
    }
    isAssetCollapsed.value = !shouldExpand
    if (shouldExpand) assetPanelWidth.value = clampAssetWidth(assetPanelWidth.value)
    savePanelWidths()
  }

  function toggleInspectorPanel(expanded?: boolean) {
    if (!inspectorVisible.value) return
    const shouldExpand = typeof expanded === 'boolean' ? expanded : isInspectorCollapsed.value
    if (shouldExpand === !isInspectorCollapsed.value) return
    if (
      shouldExpand
      && assetPanelVisible.value
      && getPanelCapacity({ inspectorPanelVisible: true }).availableInspectorWidth < minInspectorWidth
    ) {
      isAssetCollapsed.value = true
    }
    isInspectorCollapsed.value = !shouldExpand
    if (shouldExpand) inspectorPanelWidth.value = clampInspectorWidth(inspectorPanelWidth.value)
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
    isInspectorCollapsed,
    activeResize,
    inspectorVisible,
    inspectorPanelVisible,
    assetPanelVisible,
    assetResizerVisible,
    shellStyle,
    startResize,
    stopResize,
    toggleAssetPanel,
    toggleInspectorPanel,
  }
}
