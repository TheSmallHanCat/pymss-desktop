import { isWorkflowSeparationNodeType } from '@/workflows/formats'

export type GraphDefaults = {
  device: string
  outputFormat: string
}

export type GraphDefaultChanges = {
  device: boolean
  outputFormat: boolean
}

type GraphWidget = {
  name?: unknown
  value?: unknown
}

type GraphWidgetNode = {
  type?: unknown
  widgets?: GraphWidget[] | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function storeGraphDefaults(
  definition: Record<string, unknown>,
  defaults: GraphDefaults,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(definition)) as Record<string, unknown>
  const extra = isRecord(clone.extra) ? clone.extra : {}
  extra.appDefaults = {
    ...(isRecord(extra.appDefaults) ? extra.appDefaults : {}),
    device: defaults.device || 'auto',
    output_format: defaults.outputFormat || 'wav',
  }
  clone.extra = extra
  return clone
}

export function applyGraphDefaultWidgets(
  nodes: GraphWidgetNode[],
  defaults: GraphDefaults,
  changed: GraphDefaultChanges,
): void {
  for (const node of nodes) {
    const type = String(node.type || '')
    const widgets = Array.isArray(node.widgets) ? node.widgets : []
    if (changed.device && isWorkflowSeparationNodeType(type)) {
      const device = widgets.find(widget => widget.name === 'device')
      if (device) device.value = defaults.device || 'auto'
    }
    if (changed.outputFormat && type === 'pymss_save_audio') {
      const outputFormat = widgets.find(widget => widget.name === 'output_format')
      if (outputFormat) outputFormat.value = (defaults.outputFormat || 'wav').toLowerCase()
    }
  }
}
