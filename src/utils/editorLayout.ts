export type EditorLayoutMetrics = {
  shellWidth: number
  minCenterWidth: number
  assetRailWidth: number
  inspectorRailWidth: number
  resizerWidth: number
  assetPanelWidth: number
  inspectorPanelWidth: number
  assetPanelVisible: boolean
  inspectorRailVisible: boolean
  inspectorPanelVisible: boolean
}

export function calculateEditorPanelCapacity(metrics: EditorLayoutMetrics) {
  const inspectorRailWidth = metrics.inspectorRailVisible ? metrics.inspectorRailWidth : 0
  const assetPanelWidth = metrics.assetPanelVisible
    ? metrics.assetPanelWidth + metrics.resizerWidth
    : 0
  const inspectorPanelWidth = metrics.inspectorPanelVisible
    ? metrics.inspectorPanelWidth + metrics.resizerWidth
    : 0
  const fixedRailWidth = metrics.assetRailWidth + inspectorRailWidth

  return {
    centerWidth: Math.max(
      0,
      metrics.shellWidth - fixedRailWidth - assetPanelWidth - inspectorPanelWidth,
    ),
    availableAssetWidth: Math.max(
      0,
      metrics.shellWidth
        - metrics.minCenterWidth
        - fixedRailWidth
        - inspectorPanelWidth
        - metrics.resizerWidth,
    ),
    availableInspectorWidth: Math.max(
      0,
      metrics.shellWidth
        - metrics.minCenterWidth
        - fixedRailWidth
        - assetPanelWidth
        - metrics.resizerWidth,
    ),
  }
}
