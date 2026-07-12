import {
  createWorkflowGraphEdgeId,
  createWorkflowGraphNodeId,
  readWorkflowGraphDefinition,
  serializeWorkflowGraphDefinition,
  sortWorkflowGraphStepNodes,
  type WorkflowGraphDefinition,
  type WorkflowGraphNode,
  type WorkflowGraphPoint,
  type WorkflowGraphViewport,
} from '@/utils/workflowGraph'

export type WorkflowCanvasPoint = WorkflowGraphPoint
export type WorkflowCanvasViewport = WorkflowGraphViewport

export type WorkflowNoteDraft = WorkflowCanvasPoint & {
  id: string
  title: string
  content: string
  color: string
}

export type WorkflowUtilityNodeKind = 'load_audio_batch' | 'audio_ensemble' | 'audio_invert_phase' | 'audio_normalize'

export type WorkflowUtilityNodeDraft = WorkflowCanvasPoint & {
  id: string
  kind: WorkflowUtilityNodeKind
  data: Record<string, unknown>
}

export type WorkflowNodeEditorUi = {
  viewport: WorkflowCanvasViewport
  nodes: Record<string, WorkflowCanvasPoint>
  notes: WorkflowNoteDraft[]
  collapsedStepIds: string[]
}

export type WorkflowStepDraft = {
  id: string
  model: string
  input: string
  stems: string[]
  save: Record<string, string>
  overlapSize: number | null
  modelKind: string | null
  customModelType: string | null
  // Round-trip carrier for comfy-mss fields that pymss-studio does not manage
  // directly (full MSS/VR params, per-stem Save Audio widgets, etc.). Purely
  // pass-through: never surfaced in the node editor UI or runtime compiler.
  comfyMeta?: Record<string, unknown>
}

export type WorkflowSaveTargetDraft = {
  source: string
  outputDir: string
}

export type WorkflowBatchInputConfig = {
  folder: string
  recursive: boolean
  sortFiles: boolean
}

export type WorkflowValidationSummary = {
  batchInputCount: number
  batchInputMissingFolderCount: number
  batchInputMultipleUnsupported: boolean
  utilityInputMissingCount: number
  danglingConnectionCount: number
  invalidConnectionCount: number
  duplicateInputConnectionCount: number
  graphCycleDetected: boolean
  saveOutputCount: number
  noSaveOutputs: boolean
}

export type WorkflowDefinitionDraft = {
  defaultDevice: string
  defaultFormat: string
  defaultNormalize: boolean
  steps: WorkflowStepDraft[]
  utilityNodes: WorkflowUtilityNodeDraft[]
  saveTargets: WorkflowSaveTargetDraft[]
  ui: WorkflowNodeEditorUi
}

export const DEFAULT_WORKFLOW_NODE_EDITOR_VIEWPORT: WorkflowCanvasViewport = { x: 0, y: 0, k: 1 }

const GRAPH_INPUT_X = 72
const GRAPH_STEP_START_X = 384
const GRAPH_STEP_GAP = 318
const GRAPH_TOP_Y = 118
const GRAPH_SAVE_GAP = 420

let workflowStepIdSeed = 0
let workflowNoteIdSeed = 0
let workflowUtilityNodeIdSeed = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readSeparateNodeData(node: WorkflowGraphNode) {
  const inferenceParams = isRecord(node.data.inferenceParams) ? node.data.inferenceParams : {}
  const overlapSize = typeof node.data.overlapSize === 'number' && Number.isFinite(node.data.overlapSize)
    ? node.data.overlapSize
    : (typeof inferenceParams.overlap_size === 'number' && Number.isFinite(inferenceParams.overlap_size)
      ? Number(inferenceParams.overlap_size)
      : null)
  return {
    model: String(node.data.model || ''),
    stems: Array.isArray(node.data.stems)
      ? node.data.stems.map(item => String(item || '').trim()).filter(Boolean)
      : [],
    overlapSize,
    collapsed: Boolean(node.data.collapsed),
    modelKind: typeof node.data.modelKind === 'string' && node.data.modelKind.trim() ? String(node.data.modelKind).trim() : null,
    customModelType: typeof node.data.customModelType === 'string' && node.data.customModelType.trim()
      ? String(node.data.customModelType).trim()
      : null,
    comfyMeta: isRecord(node.data.comfyMeta) ? clone(node.data.comfyMeta) : null,
  }
}

function workflowGraphSaveNodeIds(definition: WorkflowGraphDefinition) {
  return new Set(definition.graph.nodes.filter(node => node.type === 'save_outputs').map(node => node.id))
}

function graphSaveOutputMap(definition: WorkflowGraphDefinition) {
  const entries = definition.graph.nodes
    .filter(node => node.type === 'save_outputs')
    .flatMap((node) => {
      const outputs = isRecord(node.data.outputs) ? node.data.outputs : {}
      return Object.entries(outputs)
    })
  return Object.fromEntries(
    entries
      .map(([key, value]) => [String(key), String(value || '').trim()])
      .filter(([, value]) => Boolean(value)),
  ) as Record<string, string>
}

function normalizeSaveTargetSource(source: string) {
  const value = String(source || '').trim()
  if (!value) return ''
  if (value === 'input') return ''
  return value
}

function isUtilityNodeType(type: string): type is WorkflowUtilityNodeKind {
  return ['load_audio_batch', 'audio_ensemble', 'audio_invert_phase', 'audio_normalize'].includes(type)
}

function utilityInputPortIds(node: WorkflowUtilityNodeDraft) {
  if (node.kind === 'audio_ensemble') {
    const count = Math.max(2, Math.min(10, Number(node.data.inputCount) || 2))
    return Array.from({ length: count }, (_value, index) => `input:${index}`)
  }
  if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
    return ['input']
  }
  return []
}

function sourceNodeToDraftInputValue(source: WorkflowGraphNode | undefined, sourcePortId: string) {
  if (!source) return ''
  if (source.type === 'input_audio') return 'input'
  if (source.type === 'separate' && sourcePortId.startsWith('stem:')) {
    return `${source.id}.${sourcePortId.slice('stem:'.length)}`
  }
  if (isUtilityNodeType(source.type) && sourcePortId === 'audio') {
    return `utility:${source.id}`
  }
  return ''
}

function graphInputToDraftInput(definition: WorkflowGraphDefinition, stepId: string) {
  const inputEdge = definition.graph.edges.find(edge => edge.target.nodeId === stepId && edge.target.portId === 'input')
  if (!inputEdge) return 'input'
  const source = definition.graph.nodes.find(node => node.id === inputEdge.source.nodeId)
  return sourceNodeToDraftInputValue(source, inputEdge.source.portId) || 'input'
}

function graphUtilityInputMap(definition: WorkflowGraphDefinition, node: WorkflowGraphNode) {
  if (!isUtilityNodeType(node.type)) return {}
  const baseData = clone(node.data || {})
  const inputMap: Record<string, string> = {}
  definition.graph.edges
    .filter(edge => edge.target.nodeId === node.id)
    .forEach((edge) => {
      const source = definition.graph.nodes.find(item => item.id === edge.source.nodeId)
      const value = sourceNodeToDraftInputValue(source, edge.source.portId)
      if (value) inputMap[edge.target.portId] = value
    })

  if (node.type === 'audio_ensemble') {
    const inputCount = Math.max(2, Math.min(10, Number(baseData.inputCount) || 2))
    const inputs = Array.from({ length: inputCount }, (_value, index) => String(inputMap[`input:${index}`] || ''))
    return {
      ...baseData,
      inputCount,
      weights: Array.isArray(baseData.weights)
        ? [...baseData.weights].slice(0, inputCount)
        : Array.from({ length: inputCount }, () => 1),
      inputs,
    }
  }

  if (node.type === 'audio_invert_phase' || node.type === 'audio_normalize') {
    return {
      ...baseData,
      input: String(inputMap.input || ''),
    }
  }

  return baseData
}

function utilityNodeInputValues(node: WorkflowUtilityNodeDraft) {
  if (node.kind === 'audio_ensemble') {
    const inputCount = Math.max(2, Math.min(10, Number(node.data.inputCount) || 2))
    const rawInputs = Array.isArray(node.data.inputs) ? node.data.inputs : []
    return Array.from({ length: inputCount }, (_value, index) => ({
      portId: `input:${index}`,
      value: String(rawInputs[index] || '').trim(),
    }))
  }
  if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
    return [{ portId: 'input', value: String(node.data.input || '').trim() }]
  }
  return []
}

function isExecutableGraphNodeType(type: string) {
  return ['input_audio', 'separate', 'load_audio_batch', 'audio_ensemble', 'audio_invert_phase', 'audio_normalize'].includes(type)
}

function workflowGraphHasCycle(definition: WorkflowGraphDefinition) {
  const executableIds = new Set(definition.graph.nodes
    .filter(node => isExecutableGraphNodeType(node.type))
    .map(node => node.id))
  const outgoing = new Map<string, string[]>()
  executableIds.forEach(id => outgoing.set(id, []))
  definition.graph.edges.forEach((edge) => {
    if (!executableIds.has(edge.source.nodeId) || !executableIds.has(edge.target.nodeId)) return
    outgoing.set(edge.source.nodeId, [...(outgoing.get(edge.source.nodeId) || []), edge.target.nodeId])
  })

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    visiting.add(nodeId)
    for (const nextId of outgoing.get(nodeId) || []) {
      if (visit(nextId)) return true
    }
    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }

  return [...executableIds].some(visit)
}

function workflowGraphSourcePortIsValid(node: WorkflowGraphNode, portId: string) {
  if (node.type === 'input_audio') return portId === 'audio'
  if (node.type === 'separate') {
    if (!portId.startsWith('stem:')) return false
    const stem = portId.slice('stem:'.length).trim().toLowerCase()
    const stems = Array.isArray(node.data.stems)
      ? node.data.stems.map(item => String(item || '').trim().toLowerCase()).filter(Boolean)
      : []
    return Boolean(stem && stems.includes(stem))
  }
  if (isUtilityNodeType(node.type)) return portId === 'audio'
  return false
}

function workflowGraphTargetPortIsValid(node: WorkflowGraphNode, portId: string) {
  if (node.type === 'separate') return portId === 'input'
  if (node.type === 'save_outputs') return portId.startsWith('save:')
  if (node.type === 'audio_ensemble') {
    if (!portId.startsWith('input:')) return false
    const index = Number(portId.slice('input:'.length))
    const inputCount = Math.max(2, Math.min(10, Number(node.data.inputCount) || 2))
    return Number.isInteger(index) && index >= 0 && index < inputCount
  }
  if (node.type === 'audio_invert_phase' || node.type === 'audio_normalize') return portId === 'input'
  return false
}

function workflowGraphEdgeIsValid(definition: WorkflowGraphDefinition, edge: WorkflowGraphDefinition['graph']['edges'][number]) {
  const source = definition.graph.nodes.find(node => node.id === edge.source.nodeId)
  const target = definition.graph.nodes.find(node => node.id === edge.target.nodeId)
  if (!source || !target) return false
  return workflowGraphSourcePortIsValid(source, edge.source.portId)
    && workflowGraphTargetPortIsValid(target, edge.target.portId)
}

function getWorkflowGraphIssueSummary(definition: WorkflowGraphDefinition) {
  const nodeIds = new Set(definition.graph.nodes.map(node => node.id))
  const danglingConnectionCount = definition.graph.edges.filter(edge => !nodeIds.has(edge.source.nodeId) || !nodeIds.has(edge.target.nodeId)).length
  const invalidConnectionCount = definition.graph.edges.filter(edge => nodeIds.has(edge.source.nodeId) && nodeIds.has(edge.target.nodeId) && !workflowGraphEdgeIsValid(definition, edge)).length
  const validEdges = definition.graph.edges.filter(edge => nodeIds.has(edge.source.nodeId) && nodeIds.has(edge.target.nodeId) && workflowGraphEdgeIsValid(definition, edge))
  const incomingPortCounts = new Map<string, number>()
  validEdges.forEach((edge) => {
    const key = `${edge.target.nodeId}:${edge.target.portId}`
    incomingPortCounts.set(key, (incomingPortCounts.get(key) || 0) + 1)
  })
  const duplicateInputConnectionCount = [...incomingPortCounts.values()].filter(count => count > 1).length
  const saveNodeIds = workflowGraphSaveNodeIds(definition)
  const saveOutputCount = validEdges.filter(edge => saveNodeIds.has(edge.target.nodeId) && edge.target.portId.startsWith('save:')).length
  return {
    danglingConnectionCount,
    invalidConnectionCount,
    duplicateInputConnectionCount,
    graphCycleDetected: workflowGraphHasCycle(definition),
    saveOutputCount,
    noSaveOutputs: saveOutputCount === 0,
  }
}

function buildWorkflowConsumedValueSet(steps: WorkflowStepDraft[], utilityNodes: WorkflowUtilityNodeDraft[] = []) {
  const consumed = new Set<string>()
  const collect = (rawValue: string) => {
    const value = normalizeSaveTargetSource(rawValue)
    if (!value) return
    consumed.add(value)
  }
  steps.forEach(step => collect(step.input))
  utilityNodes.forEach((node) => {
    utilityNodeInputValues(node).forEach(({ value }) => collect(value))
  })
  return consumed
}

function draftInputValueToGraphEdge(targetNodeId: string, targetPortId: string, value: string) {
  const input = String(value || '').trim()
  if (!input) return null
  if (input === 'input') {
    return {
      id: createWorkflowGraphEdgeId('edge_input'),
      source: { nodeId: 'input', portId: 'audio' },
      target: { nodeId: targetNodeId, portId: targetPortId },
    }
  }
  if (input.startsWith('utility:')) {
    const utilityNodeId = input.slice('utility:'.length).trim()
    if (!utilityNodeId) return null
    return {
      id: createWorkflowGraphEdgeId('edge_utility'),
      source: { nodeId: utilityNodeId, portId: 'audio' },
      target: { nodeId: targetNodeId, portId: targetPortId },
    }
  }
  const [sourceId, stem] = input.split('.', 2)
  if (!sourceId || !stem) return null
  return {
    id: createWorkflowGraphEdgeId('edge_input'),
    source: { nodeId: sourceId, portId: `stem:${stem}` },
    target: { nodeId: targetNodeId, portId: targetPortId },
  }
}

function draftToGraph(draft: WorkflowDefinitionDraft): WorkflowGraphDefinition {
  ensureWorkflowStepIds(draft.steps)
  const ui = draft.ui ? cloneWorkflowNodeEditorUi(draft.ui) : createDefaultWorkflowNodeEditorUi(draft.steps)
  const consumedValueSet = buildWorkflowConsumedValueSet(draft.steps, draft.utilityNodes || [])
  const saveOutputs: Record<string, string> = {}

  const nodes: WorkflowGraphNode[] = [
    {
      id: 'input',
      type: 'input_audio',
      position: ui.nodes.input || { x: GRAPH_INPUT_X, y: 210 },
      data: {},
    },
    ...draft.steps.map((step, index) => ({
      id: step.id,
      type: 'separate' as const,
      position: ui.nodes[step.id] || { x: GRAPH_STEP_START_X + index * GRAPH_STEP_GAP, y: GRAPH_TOP_Y + (index % 2) * 96 },
      data: {
        model: step.model,
        stems: [...step.stems],
        overlapSize: step.overlapSize,
        collapsed: (ui.collapsedStepIds || []).includes(step.id),
        modelKind: step.modelKind,
        customModelType: step.customModelType,
        ...(step.comfyMeta && isRecord(step.comfyMeta) ? { comfyMeta: clone(step.comfyMeta) } : {}),
      },
    })),
    {
      id: 'save',
      type: 'save_outputs',
      position: ui.nodes.save || { x: 420 + Math.max(1, draft.steps.length) * GRAPH_STEP_GAP + GRAPH_SAVE_GAP, y: 192 },
      data: { outputs: saveOutputs },
    },
    ...(draft.utilityNodes || []).map(node => ({
      id: node.id,
      type: node.kind,
      position: { x: node.x, y: node.y },
      data: clone(node.data || {}),
    })),
    ...(ui.notes || []).map(note => ({
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

  const edges = draft.steps.flatMap((step) => {
    const input = String(step.input || '').trim()
    const edge = draftInputValueToGraphEdge(step.id, 'input', input)
    return edge ? [edge] : []
  })

  ;(draft.utilityNodes || []).forEach((node) => {
    utilityNodeInputValues(node).forEach(({ portId, value }) => {
      const edge = draftInputValueToGraphEdge(node.id, portId, value)
      if (edge) edges.push(edge)
    })
  })

  draft.steps.forEach((step) => {
    step.stems.forEach((stem) => {
      const ref = `${step.id}.${stem}`
      if (consumedValueSet.has(ref)) return
      const outputDir = step.save?.[stem]?.trim() || safeWorkflowStemDir(stem)
      saveOutputs[ref] = outputDir
      edges.push({
        id: createWorkflowGraphEdgeId('edge_save'),
        source: { nodeId: step.id, portId: `stem:${stem}` },
        target: { nodeId: 'save', portId: `save:${ref}` },
      })
    })
  })

  ;(draft.utilityNodes || []).forEach((node) => {
    const ref = `utility:${node.id}`
    if (consumedValueSet.has(ref)) return
    const target = (draft.saveTargets || []).find(item => item.source === ref)
    const outputDir = target?.outputDir?.trim() || safeWorkflowStemDir(`${node.kind}_${node.id.slice(-6)}`)
    saveOutputs[ref] = outputDir
    edges.push({
      id: createWorkflowGraphEdgeId('edge_save'),
      source: { nodeId: node.id, portId: 'audio' },
      target: { nodeId: 'save', portId: `save:${ref}` },
    })
  })

  return {
    version: 2,
    kind: 'pymss-studio-graph',
    defaults: {
      device: draft.defaultDevice || 'auto',
      output_format: draft.defaultFormat || 'wav',
      model_dir: null,
      inference_params: {
        normalize: Boolean(draft.defaultNormalize),
      },
    },
    graph: {
      viewport: { ...ui.viewport },
      nodes,
      edges,
    },
  }
}

function graphToDraft(definition: WorkflowGraphDefinition): WorkflowDefinitionDraft {
  const stepNodes = sortWorkflowGraphStepNodes(definition)
  const saveOutputs = graphSaveOutputMap(definition)
  const steps = stepNodes.map((node) => {
    const data = readSeparateNodeData(node)
    return {
      id: node.id,
      model: data.model,
      input: graphInputToDraftInput(definition, node.id),
      stems: [...data.stems],
      save: Object.fromEntries(data.stems.map(stem => [stem, saveOutputs[`${node.id}.${stem}`] || safeWorkflowStemDir(stem)])),
      overlapSize: data.overlapSize,
      modelKind: data.modelKind,
      customModelType: data.customModelType,
      ...(data.comfyMeta ? { comfyMeta: data.comfyMeta } : {}),
    } satisfies WorkflowStepDraft
  })
  if (!steps.length) steps.push(createStepDraft())
  ensureWorkflowStepIds(steps)

  const nodes = Object.fromEntries(definition.graph.nodes
    .filter(node => node.type !== 'note')
    .map(node => [node.id, { x: node.position.x, y: node.position.y }])) as Record<string, WorkflowCanvasPoint>

  if (!nodes.input) nodes.input = { x: GRAPH_INPUT_X, y: 210 }
  if (!nodes.save) nodes.save = { x: 420 + Math.max(1, steps.length) * GRAPH_STEP_GAP + GRAPH_SAVE_GAP, y: 192 }
  steps.forEach((step, index) => {
    if (!nodes[step.id]) nodes[step.id] = { x: GRAPH_STEP_START_X + index * GRAPH_STEP_GAP, y: GRAPH_TOP_Y + (index % 2) * 96 }
  })

  const notes = definition.graph.nodes
    .filter(node => node.type === 'note')
    .map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      title: String(node.data.title || ''),
      content: String(node.data.content || ''),
      color: String(node.data.color || 'amber'),
    }))

  const utilityNodes = definition.graph.nodes
    .filter(node => ['load_audio_batch', 'audio_ensemble', 'audio_invert_phase', 'audio_normalize'].includes(node.type))
    .map((node) => ({
      id: node.id,
      kind: node.type as WorkflowUtilityNodeKind,
      x: node.position.x,
      y: node.position.y,
      data: graphUtilityInputMap(definition, node),
    }))

  const saveNodeIds = workflowGraphSaveNodeIds(definition)
  const saveTargets = definition.graph.edges
    .filter(edge => saveNodeIds.has(edge.target.nodeId) && edge.target.portId.startsWith('save:'))
    .map((edge) => {
      const sourceNode = definition.graph.nodes.find(node => node.id === edge.source.nodeId)
      if (!sourceNode) return null
      const source = sourceNodeToDraftInputValue(sourceNode, edge.source.portId)
      if (!source || !source.startsWith('utility:')) return null
      return {
        source,
        outputDir: saveOutputs[source] || safeWorkflowStemDir(`${sourceNode.type}_${sourceNode.id.slice(-6)}`),
      } satisfies WorkflowSaveTargetDraft
    })
    .filter((item): item is WorkflowSaveTargetDraft => Boolean(item))

  return {
    defaultDevice: String(definition.defaults.device || 'auto'),
    defaultFormat: String(definition.defaults.output_format || 'wav'),
    defaultNormalize: Boolean(isRecord(definition.defaults.inference_params) ? definition.defaults.inference_params.normalize : false),
    steps,
    utilityNodes,
    saveTargets,
    ui: {
      viewport: { ...definition.graph.viewport },
      nodes,
      notes,
      collapsedStepIds: stepNodes.filter(node => Boolean(node.data.collapsed)).map(node => node.id),
    },
  }
}

export function createWorkflowStepId() {
  workflowStepIdSeed += 1
  return `step_${Date.now().toString(36)}_${workflowStepIdSeed.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function createStepDraft(index = 0): WorkflowStepDraft {
  return {
    id: createWorkflowStepId(),
    model: '',
    input: index ? '' : 'input',
    stems: [],
    save: {},
    overlapSize: null,
    modelKind: null,
    customModelType: null,
  }
}

export function createWorkflowNoteId() {
  workflowNoteIdSeed += 1
  return `note_${Date.now().toString(36)}_${workflowNoteIdSeed.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function createWorkflowUtilityNodeId(prefix = 'tool') {
  workflowUtilityNodeIdSeed += 1
  return `${prefix}_${Date.now().toString(36)}_${workflowUtilityNodeIdSeed.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function createWorkflowNoteDraft(point?: Partial<WorkflowCanvasPoint>): WorkflowNoteDraft {
  return {
    id: createWorkflowNoteId(),
    x: Math.round(point?.x ?? 540),
    y: Math.round(point?.y ?? 132),
    title: '',
    content: '',
    color: 'amber',
  }
}

export function createWorkflowUtilityNodeDraft(
  kind: WorkflowUtilityNodeKind,
  point?: Partial<WorkflowCanvasPoint>,
): WorkflowUtilityNodeDraft {
  const base: WorkflowUtilityNodeDraft = {
    id: createWorkflowUtilityNodeId(kind),
    kind,
    x: Math.round(point?.x ?? 540),
    y: Math.round(point?.y ?? 132),
    data: {},
  }
  if (kind === 'load_audio_batch') {
    base.data = { folder: '', recursive: false, sortFiles: true }
  } else if (kind === 'audio_ensemble') {
    base.data = { inputCount: 2, ensembleType: 'avg_wave', weights: [1, 1], inputs: ['', ''] }
  } else if (kind === 'audio_invert_phase' || kind === 'audio_normalize') {
    base.data = { input: '' }
  }
  return base
}

export function createDefaultWorkflowNodeEditorUi(steps: WorkflowStepDraft[] = [createStepDraft()]): WorkflowNodeEditorUi {
  const nodes: Record<string, WorkflowCanvasPoint> = {
    input: { x: 72, y: 210 },
    save: { x: 420 + Math.max(1, steps.length) * 318, y: 192 },
  }
  steps.forEach((step, index) => {
    nodes[step.id || `step_${index + 1}`] = { x: 384 + index * 318, y: 118 + (index % 2) * 96 }
  })
  return {
    viewport: { ...DEFAULT_WORKFLOW_NODE_EDITOR_VIEWPORT },
    nodes,
    notes: [],
    collapsedStepIds: [],
  }
}

export function cloneWorkflowNodeEditorUi(ui: WorkflowNodeEditorUi): WorkflowNodeEditorUi {
  return {
    viewport: { ...ui.viewport },
    nodes: Object.fromEntries(Object.entries(ui.nodes).map(([key, value]) => [key, { ...value }])),
    notes: (ui.notes || []).map(note => ({ ...note })),
    collapsedStepIds: [...(ui.collapsedStepIds || [])],
  }
}

export function parseModelStems(value?: unknown) {
  const seen = new Set<string>()
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，;；/|\n]+/)
  return rawItems
    .map(item => String(item || '').trim().replace(/^[\s"'[\](){}]+|[\s"'[\](){}]+$/g, ''))
    .filter((item) => {
      if (!item) return false
      const key = item.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function ensureWorkflowStepIds(steps: WorkflowStepDraft[]) {
  const seen = new Set<string>()
  steps.forEach((step) => {
    const nextId = String(step.id || '').trim() || createWorkflowStepId()
    step.id = seen.has(nextId) ? createWorkflowStepId() : nextId
    seen.add(step.id)
  })
}

export function getWorkflowStepDisplayId(index: number) {
  return `step_${index + 1}`
}

export function buildWorkflowRuntimeIdMap(steps: WorkflowStepDraft[]) {
  ensureWorkflowStepIds(steps)
  return new Map(steps.map((step, index) => [step.id, getWorkflowStepDisplayId(index)]))
}

export function safeWorkflowStemDir(stem: string) {
  return stem.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_') || stem
}

export function buildWorkflowConsumedStemSet(steps: WorkflowStepDraft[]) {
  const consumed = new Set<string>()
  steps.forEach((step) => {
    const rawInput = String(step.input || '').trim()
    if (!rawInput.includes('.')) return
    const [sourceId, stem] = rawInput.split('.', 2)
    if (!sourceId || !stem) return
    consumed.add(`${sourceId}.${stem}`)
  })
  return consumed
}

export function buildWorkflowConsumedValueSetForDraft(
  steps: WorkflowStepDraft[],
  utilityNodes: WorkflowUtilityNodeDraft[] = [],
) {
  return buildWorkflowConsumedValueSet(steps, utilityNodes)
}

export function getWorkflowBatchInputConfigs(definition: Record<string, unknown>): WorkflowBatchInputConfig[] {
  const draft = hydrateWorkflowDefinition(definition)
  return (draft.utilityNodes || [])
    .filter(node => node.kind === 'load_audio_batch')
    .map((node) => {
      const folder = String(node.data.folder || '').trim()
      if (!folder) return null
      return {
        folder,
        recursive: Boolean(node.data.recursive),
        sortFiles: node.data.sortFiles === undefined ? true : Boolean(node.data.sortFiles),
      }
    })
    .filter((item): item is WorkflowBatchInputConfig => Boolean(item))
}

export function getWorkflowBatchInputFolders(definition: Record<string, unknown>): string[] {
  return getWorkflowBatchInputConfigs(definition).map(item => item.folder)
}

export type WorkflowValidationTranslator = (key: string, params?: Record<string, unknown>) => string

/**
 * Single source of truth mapping a validation summary to a user-facing error
 * message. All entry points (separate page, workflows page, node editor,
 * task store) must use this to avoid divergence. Pass the caller's translator
 * (`useI18n().t` or `i18n.global.t`) so this stays free of i18n coupling.
 */
export function workflowValidationErrorMessage(
  summary: WorkflowValidationSummary | null | undefined,
  translate: WorkflowValidationTranslator,
): string {
  if (!summary) return ''
  if (summary.batchInputMultipleUnsupported) return translate('workflows.batchInputMultipleUnsupported')
  if (summary.batchInputMissingFolderCount > 0) return translate('workflows.batchInputFolderRequired')
  if (summary.utilityInputMissingCount > 0) return translate('workflows.utilityInputsRequired', { count: summary.utilityInputMissingCount })
  if (summary.danglingConnectionCount > 0) return translate('workflows.workflowDanglingConnections', { count: summary.danglingConnectionCount })
  if (summary.invalidConnectionCount > 0) return translate('workflows.workflowInvalidConnections', { count: summary.invalidConnectionCount })
  if (summary.duplicateInputConnectionCount > 0) return translate('workflows.workflowDuplicateInputConnections', { count: summary.duplicateInputConnectionCount })
  if (summary.graphCycleDetected) return translate('workflows.workflowCycleDetected')
  if (summary.noSaveOutputs) return translate('workflows.workflowNoSaveOutputs')
  return ''
}

export function getWorkflowValidationSummary(definition: Record<string, unknown>): WorkflowValidationSummary {
  const graph = readWorkflowGraphDefinition(definition)
  const draft = hydrateWorkflowDefinition(definition)
  const batchInputNodes = (draft.utilityNodes || []).filter(node => node.kind === 'load_audio_batch')
  const batchInputMissingFolderCount = batchInputNodes.filter(node => !String(node.data.folder || '').trim()).length
  const utilityInputMissingCount = (draft.utilityNodes || []).reduce((total, node) => {
    return total + utilityNodeInputValues(node).filter(({ value }) => !value).length
  }, 0)
  const graphIssues = getWorkflowGraphIssueSummary(graph)
  return {
    batchInputCount: batchInputNodes.length,
    batchInputMissingFolderCount,
    batchInputMultipleUnsupported: batchInputNodes.length > 1,
    utilityInputMissingCount,
    ...graphIssues,
  }
}

export function getWorkflowUtilityNodeInputMissingCount(node: WorkflowUtilityNodeDraft) {
  return utilityNodeInputValues(node).filter(({ value }) => !value).length
}

export function stripWorkflowUi(definition: Record<string, unknown>): Record<string, unknown> {
  return serializeWorkflowGraphDefinition(readWorkflowGraphDefinition(definition))
}

export function buildWorkflowDefinition(draft: WorkflowDefinitionDraft): Record<string, unknown> {
  return serializeWorkflowGraphDefinition(draftToGraph(draft))
}

export function hydrateWorkflowDefinition(definition: Record<string, unknown>): WorkflowDefinitionDraft {
  return graphToDraft(readWorkflowGraphDefinition(definition))
}
