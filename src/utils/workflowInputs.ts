/**
 * Runtime input slots of a comfy-mss workflow.
 *
 * A load node declares a named slot via its input_name widget (slot 1 for
 * pymss_load_audio, slot 3 for pymss_load_audio_batch). Hosts key the
 * run_dag `inputs` mapping by these names (pymss >= 2.1.2 strict contract:
 * a declared-but-unprovided name is an error; no positional fallback).
 */

export interface WorkflowInputSlot {
  /** slot name from the node's input_name widget */
  name: string
  /** node type (pymss_load_audio / pymss_load_audio_batch / LoadAudio) */
  nodeType: string
  nodeId: number | string
}

export interface WorkflowInputsAnalysis {
  slots: WorkflowInputSlot[]
  /** load nodes with neither an embedded source nor a runtime slot key */
  unresolved: Array<{ nodeId: number | string; widget: string; nodeType: string }>
  /** load nodes that carry their own real file path in the audio widget */
  selfContained: number
}

const LOAD_TYPES = new Set(['pymss_load_audio', 'LoadAudio', 'pymss_load_audio_batch'])
const INPUT_NAME_SLOT: Record<string, number> = {
  pymss_load_audio: 1,
  LoadAudio: 1,
  pymss_load_audio_batch: 3,
}

function widgetAt(values: unknown, index: number): string {
  if (!Array.isArray(values)) return ''
  const raw = values[index]
  return raw === null || raw === undefined ? '' : String(raw).trim()
}

/** A widget value that looks like an absolute/relative path on disk. */
function looksLikePath(value: string): boolean {
  if (!value) return false
  return value.startsWith('/') || value.startsWith('\\')
    || /^[a-zA-Z]:[\\/]/.test(value)
    || value.includes('/')
    || value.includes('\\')
}

export function analyzeWorkflowInputs(definition: Record<string, unknown> | null | undefined): WorkflowInputsAnalysis {
  const nodes = definition && Array.isArray(definition.nodes) ? definition.nodes as any[] : []
  const slots: WorkflowInputSlot[] = []
  const unresolved: WorkflowInputsAnalysis['unresolved'] = []
  let selfContained = 0
  for (const node of nodes) {
    const type = String(node?.type || '')
    if (!LOAD_TYPES.has(type)) continue
    const nameSlot = INPUT_NAME_SLOT[type]
    const inputName = widgetAt(node.widgets_values, nameSlot)
    const audioWidget = type === 'pymss_load_audio_batch' ? '' : widgetAt(node.widgets_values, 0)
    if (inputName) {
      if (!slots.some(slot => slot.name === inputName)) {
        slots.push({ name: inputName, nodeType: type, nodeId: node.id })
      }
    } else if (looksLikePath(audioWidget)) {
      // graph carries its own input file
      selfContained += 1
    } else if (type === 'pymss_load_audio_batch') {
      const folder = widgetAt(node.widgets_values, 0)
      if (folder) selfContained += 1
      else unresolved.push({ nodeId: node.id, widget: '', nodeType: type })
    } else if (audioWidget) {
      // Legacy pymss/ComfyUI load nodes use the audio widget itself as the
      // runtime input key when no dedicated input_name widget exists.
      if (!slots.some(slot => slot.name === audioWidget)) {
        slots.push({ name: audioWidget, nodeType: type, nodeId: node.id })
      }
    } else {
      unresolved.push({ nodeId: node.id, widget: audioWidget, nodeType: type })
    }
  }
  return { slots, unresolved, selfContained }
}
