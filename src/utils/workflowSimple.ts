import {
  buildWorkflowDefinition,
  getWorkflowValidationSummary,
  hydrateWorkflowDefinition,
  type WorkflowDefinitionDraft,
} from '@/utils/workflowDefinition'
import { readWorkflowGraphDefinition, serializeWorkflowGraphDefinition } from '@/utils/workflowGraph'

export type SimpleWorkflowReasonCode =
  | 'utility_nodes'
  | 'unsupported_nodes'
  | 'custom_model_type'
  | 'comfy_metadata'
  | 'invalid_graph'
  | 'custom_save_behavior'

export type SimpleWorkflowAnalysis = {
  editable: boolean
  reasonCodes: SimpleWorkflowReasonCode[]
}

export type WorkflowOpenMode = 'simple' | 'advanced'

export type SimpleWorkflowSavePayload = {
  id?: string
  name: string
  description: string
  definition: Record<string, unknown>
  expectedUpdatedAt?: number
}

const SIMPLE_NODE_TYPES = new Set(['input_audio', 'separate', 'save_outputs', 'note'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function expectedSaveSources(draft: WorkflowDefinitionDraft) {
  const consumed = new Set(draft.steps
    .map(step => String(step.input || '').trim())
    .filter(input => input.includes('.')))
  return new Set(draft.steps.flatMap(step => step.stems
    .map(stem => `${step.id}.${stem}`)
    .filter(source => !consumed.has(source))))
}

function hasCanonicalInputTopology(definition: Record<string, unknown>) {
  const graph = readWorkflowGraphDefinition(definition)
  const nodesById = new Map(graph.graph.nodes.map(node => [node.id, node]))
  return graph.graph.nodes
    .filter(node => node.type === 'separate')
    .every((node) => {
      const incoming = graph.graph.edges.filter(edge => edge.target.nodeId === node.id && edge.target.portId === 'input')
      if (incoming.length !== 1) return false
      const edge = incoming[0]
      const source = nodesById.get(edge.source.nodeId)
      if (source?.type === 'input_audio') return edge.source.portId === 'audio'
      return source?.type === 'separate' && edge.source.portId.startsWith('stem:')
    })
}

function hasCanonicalSaveBehavior(definition: Record<string, unknown>, expected: Set<string>) {
  const graph = readWorkflowGraphDefinition(definition)
  const nodesById = new Map(graph.graph.nodes.map(node => [node.id, node]))
  const saveNodes = graph.graph.nodes.filter(node => node.type === 'save_outputs')
  if (saveNodes.length !== 1) return false
  const saveNode = saveNodes[0]
  const saveEdges = graph.graph.edges.filter(edge => edge.target.nodeId === saveNode.id)
  if (saveEdges.length !== expected.size) return false

  const outputs = isRecord(saveNode.data.outputs) ? saveNode.data.outputs : {}
  if (Object.keys(outputs).length !== expected.size) return false
  const seen = new Set<string>()
  for (const edge of saveEdges) {
    const sourceNode = nodesById.get(edge.source.nodeId)
    if (sourceNode?.type !== 'separate' || !edge.source.portId.startsWith('stem:')) return false
    const source = `${sourceNode.id}.${edge.source.portId.slice('stem:'.length)}`
    if (!expected.has(source) || seen.has(source)) return false
    if (edge.target.portId !== `save:${source}`) return false
    if (typeof outputs[source] !== 'string' || !String(outputs[source]).trim()) return false
    seen.add(source)
  }
  return seen.size === expected.size
}

export function analyzeSimpleWorkflow(definition: Record<string, unknown>): SimpleWorkflowAnalysis {
  const graph = readWorkflowGraphDefinition(definition)
  const draft = hydrateWorkflowDefinition(definition)
  const reasons = new Set<SimpleWorkflowReasonCode>()
  const runtimeNodes = graph.graph.nodes.filter(node => node.type !== 'note')

  if (draft.utilityNodes.length) reasons.add('utility_nodes')
  if (runtimeNodes.some(node => !SIMPLE_NODE_TYPES.has(node.type))) reasons.add('unsupported_nodes')
  if (runtimeNodes.filter(node => node.type === 'input_audio').length !== 1
    || runtimeNodes.filter(node => node.type === 'save_outputs').length !== 1) {
    reasons.add('unsupported_nodes')
  }
  if (draft.steps.some(step => Boolean(step.modelKind || step.customModelType))) reasons.add('custom_model_type')
  if (draft.steps.some(step => Boolean(step.comfyMeta))) reasons.add('comfy_metadata')

  const validation = getWorkflowValidationSummary(definition)
  if (
    validation.batchInputMultipleUnsupported
    || validation.batchInputMissingFolderCount
    || validation.utilityInputMissingCount
    || validation.danglingConnectionCount
    || validation.invalidConnectionCount
    || validation.duplicateInputConnectionCount
    || validation.graphCycleDetected
    || validation.noSaveOutputs
    || !draft.steps.length
  ) {
    reasons.add('invalid_graph')
  }
  if (!hasCanonicalInputTopology(definition)) reasons.add('invalid_graph')

  if (!hasCanonicalSaveBehavior(definition, expectedSaveSources(draft))) {
    reasons.add('custom_save_behavior')
  }

  return {
    editable: reasons.size === 0,
    reasonCodes: [...reasons],
  }
}

export function resolveWorkflowOpenMode(definition: Record<string, unknown>): WorkflowOpenMode {
  return analyzeSimpleWorkflow(definition).editable ? 'simple' : 'advanced'
}

export function hydrateSimpleWorkflow(definition: Record<string, unknown>): WorkflowDefinitionDraft {
  const analysis = analyzeSimpleWorkflow(definition)
  if (!analysis.editable) {
    throw new Error(`Workflow is not editable in simple mode: ${analysis.reasonCodes.join(', ')}`)
  }
  return hydrateWorkflowDefinition(definition)
}

export function buildSimpleWorkflowDefinition(
  draft: WorkflowDefinitionDraft,
  sourceDefinition?: Record<string, unknown>,
): Record<string, unknown> {
  if (draft.utilityNodes.length || draft.saveTargets.length) {
    throw new Error('Simple workflows cannot contain utility nodes or utility save targets')
  }
  if (draft.steps.some(step => Boolean(step.modelKind || step.customModelType || step.comfyMeta))) {
    throw new Error('Simple workflows cannot contain custom model or Comfy-MSS metadata')
  }
  const generated = readWorkflowGraphDefinition(buildWorkflowDefinition(draft))
  if (!sourceDefinition) return serializeWorkflowGraphDefinition(generated)

  const source = readWorkflowGraphDefinition(sourceDefinition)
  return serializeWorkflowGraphDefinition({
    ...generated,
    defaults: {
      ...source.defaults,
      device: generated.defaults.device,
      output_format: generated.defaults.output_format,
      model_dir: source.defaults.model_dir,
      inference_params: {
        ...source.defaults.inference_params,
        normalize: Boolean(generated.defaults.inference_params.normalize),
      },
    },
  })
}
