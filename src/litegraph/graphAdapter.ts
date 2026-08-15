/**
 * Thin adapter between litegraph.serialize() output and the comfy-mss JSON
 * pymss.graph.load_comfy_file expects.
 *
 * litegraph's ISerialisedGraph is already the comfy format (nodes/links with
 * widgets_values). We only normalise a couple of things:
 *  - strip empty/undefined fields pymss does not need
 *  - ensure links are the 6-tuple [id, src, srcSlot, dst, dstSlot, type]
 *  - drop the litegraph-only `floatingLinks` / `reroutes` arrays
 */
import type { ISerialisedGraph, ISerialisedNode } from '@comfyorg/litegraph/dist/types/serialisation'

export interface ComfyNode {
  id: number
  type: string
  pos: [number, number]
  size: [number, number]
  flags: Record<string, unknown>
  order: number
  mode: number
  inputs?: unknown[]
  outputs?: unknown[]
  properties?: Record<string, unknown>
  widgets_values?: unknown[]
  title?: string
}

export interface ComfyLink {
  0: number // link id
  1: number // source node id
  2: number // source slot
  3: number // target node id
  4: number // target slot
  5: string // type
}

export interface ComfyWorkflow {
  last_node_id: number
  last_link_id: number
  nodes: ComfyNode[]
  links: ComfyLink[]
  version: number
  extra?: Record<string, unknown>
}

/**
 * Convert a litegraph-serialized graph into a clean comfy-mss workflow dict
 * suitable for pymss.graph.load_comfy_file (after JSON.stringify).
 */
export function litegraphToComfy(serialized: ISerialisedGraph | any): ComfyWorkflow {
  const rawNodes: ISerialisedNode[] = serialized.nodes || []
  const nodes: ComfyNode[] = rawNodes.map((n) => {
    const out: ComfyNode = {
      id: Number(n.id),
      type: String(n.type),
      pos: Array.isArray(n.pos) ? [Number(n.pos[0]) || 0, Number(n.pos[1]) || 0] : [0, 0],
      size: Array.isArray(n.size) ? [Number(n.size[0]) || 0, Number(n.size[1]) || 0] : [0, 0],
      flags: (n.flags as Record<string, unknown>) || {},
      order: Number(n.order ?? 0),
      mode: Number(n.mode ?? 0),
    }
    if (n.inputs) out.inputs = n.inputs
    if (n.outputs) out.outputs = n.outputs
    if (n.title) out.title = String(n.title)
    if (n.properties && Object.keys(n.properties).length) out.properties = n.properties
    // litegraph writes widgets_values only when serialize_widgets is set on the node
    const wv = (n as any).widgets_values
    if (Array.isArray(wv)) out.widgets_values = wv
    return out
  })

  const links: ComfyLink[] = []
  for (const l of serialized.links || []) {
    if (Array.isArray(l)) {
      if (l.length < 6) continue
      links.push({ 0: Number(l[0]), 1: Number(l[1]), 2: Number(l[2]), 3: Number(l[3]), 4: Number(l[4]), 5: String(l[5]) } as ComfyLink)
      continue
    }
    // litegraph serialize() emits object-format links
    // ({id, origin_id, origin_slot, target_id, target_slot, type});
    // convert them into the comfy 6-tuple so pymss/comfy-mss can read them.
    const obj = l as Record<string, any>
    if (!obj || typeof obj !== 'object' || obj.id === undefined) continue
    links.push({
      0: Number(obj.id),
      1: Number(obj.origin_id),
      2: Number(obj.origin_slot),
      3: Number(obj.target_id),
      4: Number(obj.target_slot),
      5: String(obj.type ?? ''),
    } as ComfyLink)
  }

  const wf: ComfyWorkflow = {
    last_node_id: Number(serialized.last_node_id ?? (nodes.length ? Math.max(...nodes.map((n) => n.id)) : 0)),
    last_link_id: Number(serialized.last_link_id ?? (links.length ? Math.max(...links.map((l) => l[0])) : 0)),
    nodes,
    links,
    version: 1,
  }
  if (serialized.extra) wf.extra = serialized.extra
  return wf
}

/** JSON string for pymss.graph.load_comfy_file. */
export function toComfyJson(serialized: ISerialisedGraph | any): string {
  return JSON.stringify(litegraphToComfy(serialized), null, 2)
}

/**
 * Convert comfy-style link tuples ([id, src, srcSlot, dst, dstSlot, type])
 * into the object format litegraph 0.17's LGraph.configure() expects
 * ({ id, origin_id, origin_slot, target_id, target_slot, type }).
 * Without this, configure() sees undefined link ids and collapses every link
 * onto one entry.
 */
export function comfyLinksToLitegraph(links: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const l of links || []) {
    // litegraph serialize() already emits object-format links
    // ({id, origin_id, ...}) — exactly what configure() wants.
    if (l && typeof l === 'object' && !Array.isArray(l) && (l as any).origin_id !== undefined) {
      out.push(l as Record<string, unknown>)
      continue
    }
    // Comfy 6-tuple, either a real array or the numeric-key object
    // ({0: id, 1: src, ...}) produced by litegraphToComfy — JSON round-trips
    // the latter into objects with numeric keys that must be re-read by index.
    const tuple = Array.isArray(l)
      ? l
      : l && typeof l === 'object' && (l as any)[0] !== undefined
        ? [0, 1, 2, 3, 4, 5].map(i => (l as any)[i])
        : null
    if (!tuple || tuple.length < 6) continue
    out.push({
      id: Number(tuple[0]),
      type: String(tuple[5]),
      origin_id: Number(tuple[1]),
      origin_slot: Number(tuple[2]),
      target_id: Number(tuple[3]),
      target_slot: Number(tuple[4]),
    })
  }
  return out
}
