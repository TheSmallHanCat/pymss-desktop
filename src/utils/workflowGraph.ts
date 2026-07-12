export type WorkflowGraphPoint = {
  x: number
  y: number
}

export type WorkflowGraphViewport = WorkflowGraphPoint & {
  k: number
}

export type WorkflowGraphNodeType =
  | 'input_audio'
  | 'separate'
  | 'save_outputs'
  | 'note'
  | 'load_audio_batch'
  | 'audio_ensemble'
  | 'audio_invert_phase'
  | 'audio_normalize'

export type WorkflowGraphNode = {
  id: string
  type: WorkflowGraphNodeType
  position: WorkflowGraphPoint
  data: Record<string, unknown>
}

export type WorkflowGraphEdgeEndpoint = {
  nodeId: string
  portId: string
}

export type WorkflowGraphEdge = {
  id: string
  source: WorkflowGraphEdgeEndpoint
  target: WorkflowGraphEdgeEndpoint
}

export type WorkflowGraph = {
  viewport: WorkflowGraphViewport
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
}

export type WorkflowGraphDefaults = {
  device: string
  output_format: string
  model_dir: string | null
  inference_params: Record<string, unknown>
}

export type WorkflowGraphDefinition = {
  version: 2
  kind: 'pymss-studio-graph'
  defaults: WorkflowGraphDefaults
  graph: WorkflowGraph
}

type LegacyStep = {
  id: string
  model: string
  input: string
  stems: string[]
  save: Record<string, string>
  overlapSize: number | null
}

type LegacyNodeEditorUi = {
  viewport: WorkflowGraphViewport
  nodes: Record<string, WorkflowGraphPoint>
  notes: Array<{
    id: string
    x: number
    y: number
    title: string
    content: string
    color: string
  }>
  collapsedStepIds: string[]
}

const DEFAULT_VIEWPORT: WorkflowGraphViewport = { x: 0, y: 0, k: 1 }

const GRAPH_INPUT_X = 72
const GRAPH_STEP_START_X = 384
const GRAPH_STEP_GAP = 318
const GRAPH_TOP_Y = 118
const GRAPH_SAVE_GAP = 420

let workflowGraphNodeSeed = 0
let workflowGraphEdgeSeed = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function readPoint(value: unknown): WorkflowGraphPoint | null {
  if (!isRecord(value)) return null
  const x = Number(value.x)
  const y = Number(value.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function readViewport(value: unknown): WorkflowGraphViewport | null {
  if (!isRecord(value)) return null
  const point = readPoint(value)
  if (!point) return null
  const k = Number(value.k)
  return Number.isFinite(k) ? { ...point, k: clamp(k, 0.25, 2.5) } : null
}

function createDefaultLegacyUi(steps: LegacyStep[]): LegacyNodeEditorUi {
  const nodes: Record<string, WorkflowGraphPoint> = {
    input: { x: GRAPH_INPUT_X, y: 210 },
    save: { x: 420 + Math.max(1, steps.length) * GRAPH_STEP_GAP, y: 192 },
  }
  steps.forEach((step, index) => {
    nodes[step.id] = { x: GRAPH_STEP_START_X + index * GRAPH_STEP_GAP, y: GRAPH_TOP_Y + (index % 2) * 96 }
  })
  return {
    viewport: { ...DEFAULT_VIEWPORT },
    nodes,
    notes: [],
    collapsedStepIds: [],
  }
}

function readLegacyNote(value: unknown) {
  if (!isRecord(value)) return null
  const point = readPoint(value)
  if (!point) return null
  return {
    id: String(value.id || '').trim() || createWorkflowGraphNodeId('note'),
    x: point.x,
    y: point.y,
    title: String(value.title || ''),
    content: String(value.content || ''),
    color: String(value.color || 'amber'),
  }
}

function safeStemDir(stem: string) {
  return stem.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_') || stem.trim() || 'stem'
}

function buildLegacyConsumedStemSet(steps: LegacyStep[]) {
  const consumed = new Set<string>()
  steps.forEach((step) => {
    const input = String(step.input || '').trim()
    if (!input.includes('.')) return
    const [sourceId, stem] = input.split('.', 2)
    if (!sourceId || !stem) return
    consumed.add(`${sourceId}.${stem}`)
  })
  return consumed
}

function readLegacyStepId(rawId: unknown, seen: Set<string>) {
  const candidate = String(rawId || '').trim() || createWorkflowGraphNodeId('step')
  if (!seen.has(candidate)) {
    seen.add(candidate)
    return candidate
  }
  const next = createWorkflowGraphNodeId('step')
  seen.add(next)
  return next
}

function readLegacySteps(definition: Record<string, unknown>) {
  const rawSteps = Array.isArray(definition.steps) ? definition.steps : []
  const seen = new Set<string>()
  return rawSteps.map((raw, index) => {
    const item = isRecord(raw) ? raw : {}
    const inference = isRecord(item.inference_params) ? item.inference_params : {}
    const save = isRecord(item.save) ? item.save : {}
    const id = readLegacyStepId(item.id, seen)
    const stems = Array.isArray(item.stems)
      ? item.stems.map(stem => String(stem || '').trim()).filter(Boolean)
      : Object.keys(save).map(stem => String(stem || '').trim()).filter(Boolean)
    return {
      id,
      model: String(item.model || ''),
      input: String(item.input || (index ? '' : 'input')),
      stems,
      save: Object.fromEntries(Object.entries(save).map(([stem, dir]) => [String(stem), String(dir || '')])),
      overlapSize: typeof inference.overlap_size === 'number' && Number.isFinite(inference.overlap_size)
        ? inference.overlap_size
        : null,
    } satisfies LegacyStep
  })
}

function readLegacyNodeEditorUi(definition: Record<string, unknown>, steps: LegacyStep[]): LegacyNodeEditorUi {
  const fallback = createDefaultLegacyUi(steps)
  const ui = isRecord(definition.ui) ? definition.ui : {}
  const nodeEditor = isRecord(ui.nodeEditor) ? ui.nodeEditor : {}
  const rawNodes = isRecord(nodeEditor.nodes) ? nodeEditor.nodes : {}
  const nodes: Record<string, WorkflowGraphPoint> = { ...fallback.nodes }
  Object.entries(rawNodes).forEach(([key, value]) => {
    const point = readPoint(value)
    if (point) nodes[key] = point
  })
  return {
    viewport: readViewport(nodeEditor.viewport) || fallback.viewport,
    nodes,
    notes: Array.isArray(nodeEditor.notes)
      ? nodeEditor.notes.map(readLegacyNote).filter((item): item is NonNullable<ReturnType<typeof readLegacyNote>> => Boolean(item))
      : [],
    collapsedStepIds: Array.isArray(nodeEditor.collapsedStepIds)
      ? nodeEditor.collapsedStepIds.map(item => String(item || '').trim()).filter(Boolean)
      : [],
  }
}

function parseGraphNode(value: unknown): WorkflowGraphNode | null {
  if (!isRecord(value)) return null
  const id = String(value.id || '').trim()
  const type = String(value.type || '').trim() as WorkflowGraphNodeType
  const position = readPoint(value.position)
  if (!id || !position) return null
  if (!['input_audio', 'separate', 'save_outputs', 'note', 'load_audio_batch', 'audio_ensemble', 'audio_invert_phase', 'audio_normalize'].includes(type)) return null
  return {
    id,
    type,
    position,
    data: isRecord(value.data) ? clone(value.data) : {},
  }
}

function parseGraphEdge(value: unknown): WorkflowGraphEdge | null {
  if (!isRecord(value)) return null
  const id = String(value.id || '').trim() || createWorkflowGraphEdgeId('edge')
  const source = isRecord(value.source) ? value.source : {}
  const target = isRecord(value.target) ? value.target : {}
  const sourceNodeId = String(source.nodeId || '').trim()
  const sourcePortId = String(source.portId || '').trim()
  const targetNodeId = String(target.nodeId || '').trim()
  const targetPortId = String(target.portId || '').trim()
  if (!sourceNodeId || !sourcePortId || !targetNodeId || !targetPortId) return null
  return {
    id,
    source: { nodeId: sourceNodeId, portId: sourcePortId },
    target: { nodeId: targetNodeId, portId: targetPortId },
  }
}

function ensureGraphCoreNodes(definition: WorkflowGraphDefinition): WorkflowGraphDefinition {
  const next = clone(definition)
  const nodesById = new Map(next.graph.nodes.map(node => [node.id, node]))
  if (!nodesById.has('input')) {
    next.graph.nodes.unshift({
      id: 'input',
      type: 'input_audio',
      position: { x: GRAPH_INPUT_X, y: 210 },
      data: {},
    })
  }
  if (!nodesById.has('save')) {
    next.graph.nodes.push({
      id: 'save',
      type: 'save_outputs',
      position: { x: 420 + Math.max(1, next.graph.nodes.filter(node => node.type === 'separate').length) * GRAPH_STEP_GAP + GRAPH_SAVE_GAP, y: 192 },
      data: { outputs: {} },
    })
  }
  return next
}

export function createWorkflowGraphNodeId(prefix = 'node') {
  workflowGraphNodeSeed += 1
  return `${prefix}_${Date.now().toString(36)}_${workflowGraphNodeSeed.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function createWorkflowGraphEdgeId(prefix = 'edge') {
  workflowGraphEdgeSeed += 1
  return `${prefix}_${Date.now().toString(36)}_${workflowGraphEdgeSeed.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function createEmptyWorkflowGraphDefinition(): WorkflowGraphDefinition {
  return {
    version: 2,
    kind: 'pymss-studio-graph',
    defaults: {
      device: 'auto',
      output_format: 'wav',
      model_dir: null,
      inference_params: {
        normalize: false,
      },
    },
    graph: {
      viewport: { ...DEFAULT_VIEWPORT },
      nodes: [
        { id: 'input', type: 'input_audio', position: { x: GRAPH_INPUT_X, y: 210 }, data: {} },
        { id: 'save', type: 'save_outputs', position: { x: 420 + GRAPH_STEP_GAP + GRAPH_SAVE_GAP, y: 192 }, data: { outputs: {} } },
      ],
      edges: [],
    },
  }
}

export function isWorkflowGraphDefinition(value: unknown): value is WorkflowGraphDefinition {
  return isRecord(value) && value.kind === 'pymss-studio-graph' && isRecord(value.graph)
}

export function migrateLegacyWorkflowToGraph(definition: Record<string, unknown>): WorkflowGraphDefinition {
  const defaults = isRecord(definition.defaults) ? definition.defaults : {}
  const inferenceDefaults = isRecord(defaults.inference_params) ? defaults.inference_params : {}
  const steps = readLegacySteps(definition)
  const ui = readLegacyNodeEditorUi(definition, steps)
  const consumedStemSet = buildLegacyConsumedStemSet(steps)
  const saveOutputs: Record<string, string> = {}
  const nodes: WorkflowGraphNode[] = [
    {
      id: 'input',
      type: 'input_audio',
      position: ui.nodes.input || { x: GRAPH_INPUT_X, y: 210 },
      data: {},
    },
    ...steps.map((step) => ({
      id: step.id,
      type: 'separate' as const,
      position: ui.nodes[step.id] || { x: GRAPH_STEP_START_X, y: GRAPH_TOP_Y },
      data: {
        model: step.model,
        stems: [...step.stems],
        overlapSize: step.overlapSize,
        collapsed: ui.collapsedStepIds.includes(step.id),
      },
    })),
    {
      id: 'save',
      type: 'save_outputs',
      position: ui.nodes.save || { x: 420 + Math.max(1, steps.length) * GRAPH_STEP_GAP + GRAPH_SAVE_GAP, y: 192 },
      data: { outputs: saveOutputs },
    },
    ...ui.notes.map(note => ({
      id: note.id,
      type: 'note' as const,
      position: { x: note.x, y: note.y },
      data: {
        title: note.title,
        content: note.content,
        color: note.color,
      },
    })),
  ]
  const edges: WorkflowGraphEdge[] = []

  steps.forEach((step) => {
    const input = String(step.input || '').trim()
    if (!input) return
    if (input === 'input') {
      edges.push({
        id: createWorkflowGraphEdgeId('edge_input'),
        source: { nodeId: 'input', portId: 'audio' },
        target: { nodeId: step.id, portId: 'input' },
      })
      return
    }
    const [sourceId, stem] = input.split('.', 2)
    if (!sourceId || !stem) return
    edges.push({
      id: createWorkflowGraphEdgeId('edge_input'),
      source: { nodeId: sourceId, portId: `stem:${stem}` },
      target: { nodeId: step.id, portId: 'input' },
    })
  })

  steps.forEach((step) => {
    step.stems.forEach((stem) => {
      const ref = `${step.id}.${stem}`
      const outputDir = String(step.save?.[stem] || '').trim() || (consumedStemSet.has(ref) ? '' : safeStemDir(stem))
      if (!outputDir) return
      saveOutputs[ref] = outputDir
      edges.push({
        id: createWorkflowGraphEdgeId('edge_save'),
        source: { nodeId: step.id, portId: `stem:${stem}` },
        target: { nodeId: 'save', portId: `save:${ref}` },
      })
    })
  })

  return {
    version: 2,
    kind: 'pymss-studio-graph',
    defaults: {
      device: String(defaults.device || 'auto'),
      output_format: String(defaults.output_format || 'wav'),
      model_dir: typeof defaults.model_dir === 'string' && defaults.model_dir.trim() ? String(defaults.model_dir).trim() : null,
      inference_params: {
        ...clone(inferenceDefaults),
        normalize: Boolean(inferenceDefaults.normalize),
      },
    },
    graph: {
      viewport: ui.viewport,
      nodes,
      edges,
    },
  }
}

export function readWorkflowGraphDefinition(value: unknown): WorkflowGraphDefinition {
  if (!isRecord(value)) return createEmptyWorkflowGraphDefinition()
  if (!isWorkflowGraphDefinition(value)) return migrateLegacyWorkflowToGraph(value)
  const defaults = (isRecord(value.defaults) ? value.defaults : {}) as Record<string, unknown>
  const inferenceDefaults = (isRecord(defaults.inference_params) ? defaults.inference_params : {}) as Record<string, unknown>
  const graph = (isRecord(value.graph) ? value.graph : {}) as Record<string, unknown>
  const normalized: WorkflowGraphDefinition = {
    version: 2,
    kind: 'pymss-studio-graph',
    defaults: {
      device: String(defaults.device || 'auto'),
      output_format: String(defaults.output_format || 'wav'),
      model_dir: typeof defaults.model_dir === 'string' && defaults.model_dir.trim() ? String(defaults.model_dir).trim() : null,
      inference_params: clone(inferenceDefaults),
    },
    graph: {
      viewport: readViewport(graph.viewport) || { ...DEFAULT_VIEWPORT },
      nodes: Array.isArray(graph.nodes)
        ? graph.nodes.map(parseGraphNode).filter((item: WorkflowGraphNode | null): item is WorkflowGraphNode => Boolean(item))
        : [],
      edges: Array.isArray(graph.edges)
        ? graph.edges.map(parseGraphEdge).filter((item: WorkflowGraphEdge | null): item is WorkflowGraphEdge => Boolean(item))
        : [],
    },
  }
  return ensureGraphCoreNodes(normalized)
}

export function serializeWorkflowGraphDefinition(definition: WorkflowGraphDefinition): Record<string, unknown> {
  return clone(ensureGraphCoreNodes(definition)) as Record<string, unknown>
}

export function normalizeWorkflowDefinition(definition: unknown): Record<string, unknown> {
  return serializeWorkflowGraphDefinition(readWorkflowGraphDefinition(definition))
}

export function getWorkflowDefinitionDefaults(definition: unknown): WorkflowGraphDefaults {
  return readWorkflowGraphDefinition(definition).defaults
}

export function sortWorkflowGraphStepNodes(definition: WorkflowGraphDefinition) {
  const stepNodes = definition.graph.nodes.filter(node => node.type === 'separate')
  const nodeMap = new Map(stepNodes.map(node => [node.id, node]))
  const incoming = new Map(stepNodes.map(node => [node.id, 0]))
  const outgoing = new Map(stepNodes.map(node => [node.id, [] as string[]]))

  definition.graph.edges.forEach((edge) => {
    if (edge.target.portId !== 'input') return
    if (!nodeMap.has(edge.target.nodeId)) return
    if (!nodeMap.has(edge.source.nodeId)) return
    incoming.set(edge.target.nodeId, (incoming.get(edge.target.nodeId) || 0) + 1)
    outgoing.set(edge.source.nodeId, [...(outgoing.get(edge.source.nodeId) || []), edge.target.nodeId])
  })

  const byPosition = (a: WorkflowGraphNode, b: WorkflowGraphNode) => {
    if (a.position.x !== b.position.x) return a.position.x - b.position.x
    if (a.position.y !== b.position.y) return a.position.y - b.position.y
    return a.id.localeCompare(b.id)
  }

  const queue = stepNodes
    .filter(node => (incoming.get(node.id) || 0) === 0)
    .sort(byPosition)
  const ordered: WorkflowGraphNode[] = []

  while (queue.length) {
    queue.sort(byPosition)
    const current = queue.shift()!
    ordered.push(current)
    ;(outgoing.get(current.id) || []).forEach((targetId) => {
      const nextCount = (incoming.get(targetId) || 0) - 1
      incoming.set(targetId, nextCount)
      if (nextCount === 0) {
        const target = nodeMap.get(targetId)
        if (target) queue.push(target)
      }
    })
  }

  if (ordered.length === stepNodes.length) return ordered

  const orderedSet = new Set(ordered.map(node => node.id))
  return [...ordered, ...stepNodes.filter(node => !orderedSet.has(node.id)).sort(byPosition)]
}
