/**
 * The node editor's canvas vocabulary: selection keys, port tokens, and the pure geometry that
 * turns them into pixels.
 *
 * These were previously implicit string conventions built and taken apart inline in dozens of
 * places inside the editor component (`key.startsWith('step:')`, `key.slice('note:'.length)`, …).
 * A typo in any one of them fails silently — the key simply matches nothing — so the shapes are
 * defined and tested here instead.
 */

export type WorkflowCanvasPointLike = { x: number, y: number }

/**
 * What a selection key refers to.
 *
 * `input` and `save` are singletons and are their own keys; everything else is prefixed because
 * ids only have to be unique within their kind.
 */
export type WorkflowSelectionKind = 'input' | 'save' | 'step' | 'note' | 'utility'

export type WorkflowSelection = {
  kind: WorkflowSelectionKind
  /** The node id. For `input` and `save` this equals the kind. */
  id: string
}

export function stepSelectionKey(stepId: string) {
  return `step:${stepId}`
}

export function noteSelectionKey(noteId: string) {
  return `note:${noteId}`
}

export function utilitySelectionKey(nodeId: string) {
  return `utility:${nodeId}`
}

const SELECTION_PREFIXES: ReadonlyArray<[WorkflowSelectionKind, string]> = [
  ['step', 'step:'],
  ['note', 'note:'],
  ['utility', 'utility:'],
]

/**
 * Takes a selection key apart. Returns null for anything unrecognised, so callers fail closed
 * rather than acting on a node id that was never there.
 */
export function parseSelectionKey(key: string): WorkflowSelection | null {
  const value = String(key || '')
  if (!value) return null
  if (value === 'input' || value === 'save') return { kind: value, id: value }
  for (const [kind, prefix] of SELECTION_PREFIXES) {
    if (value.startsWith(prefix)) {
      const id = value.slice(prefix.length)
      return id ? { kind, id } : null
    }
  }
  return null
}

/** The graph node id a selection key points at, or '' when the key is not a node. */
export function selectionKeyNodeId(key: string) {
  return parseSelectionKey(key)?.id || ''
}

// --------------------------------------------------------------------------------------
// Port tokens — the keys used to look up a measured port position in the DOM
// --------------------------------------------------------------------------------------

export function utilityInputPortToken(nodeId: string, portId: string) {
  return `in:utility:${nodeId}:${portId}`
}

export function utilityOutputPortToken(nodeId: string) {
  return `out:utility:${nodeId}`
}

/**
 * The input ports a utility node exposes.
 *
 * Only an ensemble takes more than one, and its count is clamped: the editor cannot draw an
 * unbounded number of ports, and a corrupt value must not produce an empty or enormous node.
 */
export const UTILITY_ENSEMBLE_MIN_INPUTS = 2
export const UTILITY_ENSEMBLE_MAX_INPUTS = 10

export function utilityInputPortIds(kind: string, inputCount?: unknown): string[] {
  if (kind === 'audio_ensemble') {
    const raw = Number(inputCount) || UTILITY_ENSEMBLE_MIN_INPUTS
    const count = Math.max(UTILITY_ENSEMBLE_MIN_INPUTS, Math.min(UTILITY_ENSEMBLE_MAX_INPUTS, raw))
    return Array.from({ length: count }, (_value, index) => `input:${index}`)
  }
  if (kind === 'audio_invert_phase' || kind === 'audio_normalize') return ['input']
  // A batch input node produces audio without consuming any.
  return []
}

// --------------------------------------------------------------------------------------
// Geometry
// --------------------------------------------------------------------------------------

/**
 * The cubic bezier connecting two ports.
 *
 * The horizontal control offset grows with the distance so long connections bow out instead of
 * cutting through the nodes between them, with a floor so short ones still read as curves.
 */
export function connectionPath(source: WorkflowCanvasPointLike, target: WorkflowCanvasPointLike) {
  const dx = Math.max(80, Math.abs(target.x - source.x) * 0.42)
  return `M ${source.x} ${source.y} C ${source.x + dx} ${source.y}, ${target.x - dx} ${target.y}, ${target.x} ${target.y}`
}

export function clampZoom(value: number, min: number, max: number) {
  // Only NaN needs a guard: Math.min/max already pin the infinities to the range, but NaN passes
  // straight through and would propagate into every transform on the canvas, blanking it out.
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Screen coordinates to canvas-world coordinates, given the viewport transform. */
export function screenToWorldPoint(
  clientX: number,
  clientY: number,
  rect: { left: number, top: number },
  viewport: { x: number, y: number, k: number },
): WorkflowCanvasPointLike {
  const scale = viewport.k || 1
  return {
    x: (clientX - rect.left - viewport.x) / scale,
    y: (clientY - rect.top - viewport.y) / scale,
  }
}

/**
 * The viewport translation that keeps the point under the cursor fixed while zooming.
 *
 * Without this, zooming drifts the canvas away from whatever the user is pointing at.
 */
export function zoomAroundPoint(
  clientX: number,
  clientY: number,
  nextScale: number,
  rect: { left: number, top: number },
  viewport: { x: number, y: number, k: number },
) {
  const world = screenToWorldPoint(clientX, clientY, rect, viewport)
  return {
    x: clientX - rect.left - world.x * nextScale,
    y: clientY - rect.top - world.y * nextScale,
    k: nextScale,
  }
}

/** Whether two axis-aligned rectangles overlap — used by the marquee selection. */
export function rectsIntersect(
  a: { x: number, y: number, width: number, height: number },
  b: { x: number, y: number, width: number, height: number },
) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y
}

/** A drag from one point to another as a normalised rectangle. */
export function marqueeRect(start: WorkflowCanvasPointLike, current: WorkflowCanvasPointLike) {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  }
}
