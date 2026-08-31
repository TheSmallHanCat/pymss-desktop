import { NODE_SPECS, type NodeSpec } from '@/litegraph/nodeSpecs'
import type { PymssYamlStep, PymssYamlWorkflow } from '@/utils/workflowSimple'
import { isSimpleWorkflowDefinition, WORKFLOW_FORMAT_VERSION } from '@/workflows/formats'
import { mergeSimpleInferenceParams } from '@/workflows/runtimeDefinition'

type GraphInput = {
  name: string
  type: string
  link: number | null
  shape?: number
  widget?: { name: string }
}

type GraphOutput = {
  name: string
  type: string
  links: number[] | null
}

type GraphNode = {
  id: number
  type: string
  pos: [number, number]
  size: [number, number]
  flags: Record<string, unknown>
  order: number
  mode: number
  inputs: GraphInput[]
  outputs: GraphOutput[]
  properties: Record<string, unknown>
  widgets_values: unknown[]
}

type GraphLink = [number, number, number, number, number, string]

export type SimpleToGraphModel = {
  name: string
  aliases?: string[]
  modelType?: string | null
  modelPath?: string
  source?: 'catalog' | 'debug' | 'user'
}

export type SimpleToGraphOptions = {
  models?: SimpleToGraphModel[]
  sourceWorkflowId?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function nodeSize(type: string): [number, number] {
  if (type === 'input_audio') return [260, 102]
  if (type === 'pymss_load_audio') return [260, 102]
  if (type === 'pymss_save_audio') return [260, 150]
  if (type.endsWith('separate')) return [420, 222]
  return [260, 178]
}

function specInputs(spec: NodeSpec): GraphInput[] {
  return spec.inputs.map(input => ({
    name: input.name,
    type: input.type,
    link: null,
    ...(input.shape === undefined ? {} : { shape: input.shape }),
    ...(input.widget ? { widget: { name: input.widget.name } } : {}),
  }))
}

function specOutputs(spec: NodeSpec): GraphOutput[] {
  return spec.outputs.map(output => ({ name: output.name, type: output.type, links: null }))
}

function dynamicStemOutputs(stems: string[]): GraphOutput[] {
  return stems.flatMap(stem => [
    { name: `${stem} (Audio)`, type: 'AUDIO', links: null },
    { name: `${stem} (String)`, type: 'STRING', links: null },
  ])
}

function normalizeWorkflow(definition: Record<string, unknown>): PymssYamlWorkflow {
  if (!isSimpleWorkflowDefinition(definition)) {
    throw new Error('Expected a simple workflow definition with a steps array')
  }
  const defaults = asRecord(definition.defaults)
  return {
    version: Number(definition.version || 1),
    defaults: {
      device: String(defaults.device || 'auto'),
      output_format: String(defaults.output_format || 'wav'),
      model_dir: defaults.model_dir === undefined ? undefined : String(defaults.model_dir || ''),
      inference_params: asRecord(defaults.inference_params),
    },
    steps: (definition.steps as unknown[]).map((value, index) => {
      const step = asRecord(value)
      return {
        id: String(step.id || `step${index + 1}`),
        model: String(step.model || ''),
        input: String(step.input || 'input'),
        stems: step.stems == null
          ? []
          : (Array.isArray(step.stems) ? step.stems : [step.stems]).map(String),
        save: Object.fromEntries(Object.entries(asRecord(step.save)).map(([key, item]) => [key, String(item || '')])),
        inference_params: asRecord(step.inference_params),
        model_type: step.model_type === undefined ? undefined : String(step.model_type),
        model_path: step.model_path === undefined ? undefined : String(step.model_path),
        config_path: step.config_path === undefined ? undefined : String(step.config_path),
        model_dir: step.model_dir === undefined ? undefined : String(step.model_dir),
        device: step.device === undefined ? undefined : String(step.device),
        output_format: step.output_format === undefined ? undefined : String(step.output_format),
        use_tta: step.use_tta === undefined ? undefined : Boolean(step.use_tta),
      }
    }),
  }
}

type ResolvedStepModel = {
  kind: 'mss' | 'vr' | 'custom'
  name: string
  modelType: string
}

function resolveStepModel(
  step: PymssYamlStep,
  models: SimpleToGraphModel[],
  defaultModelDir?: string | null,
): ResolvedStepModel {
  const model = models.find(item => (
    item.name === step.model
    || item.aliases?.includes(step.model)
    || (step.model_path && item.modelPath === step.model_path)
  ))
  if (step.model_path && model?.source !== 'user') {
    throw new Error(`Step ${step.id} uses an unregistered model_path; import the model before conversion`)
  }
  if (step.model_dir?.trim() && step.model_dir.trim() !== String(defaultModelDir || '').trim()) {
    throw new Error(`Step ${step.id} uses a per-step model_dir that cannot be represented by the graph editor`)
  }
  if (step.config_path && !step.model_path && model?.source !== 'user') {
    throw new Error(`Step ${step.id} defines config_path without a registered custom model`)
  }
  if (step.model_path || model?.source === 'user') {
    const name = model?.name || step.model
    if (!name.trim()) throw new Error(`Step ${step.id} has no registered custom model name`)
    return {
      kind: 'custom',
      name,
      modelType: String(step.model_type || model?.modelType || 'mel_band_roformer'),
    }
  }
  const directType = String(step.model_type || '').toLowerCase()
  return {
    kind: directType === 'vr' || String(model?.modelType || '').toLowerCase() === 'vr' ? 'vr' : 'mss',
    name: step.model,
    modelType: directType || String(model?.modelType || ''),
  }
}

function parameterWidgets(
  step: PymssYamlStep,
  kind: 'mss' | 'vr' | 'custom',
  defaultInference: Record<string, unknown>,
): unknown[] {
  const stepInference = asRecord(step.inference_params)
  const inference = mergeSimpleInferenceParams(defaultInference, stepInference, step.use_tta)
  if (kind === 'vr') {
    return [
      Number(inference.batch_size || 1),
      Number(inference.window_size || 512),
      Number(inference.aggression || 5),
      Boolean(inference.enable_tta),
      Boolean(inference.high_end_process),
      Boolean(inference.enable_post_process),
      Number(inference.post_process_threshold || 0.2),
      Boolean(inference.normalize),
    ]
  }
  return [
    Number(inference.batch_size || 1),
    inference.overlap_size == null ? 'Default' : String(inference.overlap_size),
    inference.chunk_size == null ? 'Default' : String(inference.chunk_size),
    Boolean(inference.normalize),
    Boolean(inference.enable_tta),
    Boolean(inference.standardize),
  ]
}

/**
 * Promote the constrained YAML workflow to a native comfy-mss graph. The
 * source definition is never mutated; callers persist the graph as a copy.
 */
export function convertSimpleWorkflowToGraph(
  definition: Record<string, unknown>,
  options: SimpleToGraphOptions = {},
): Record<string, unknown> {
  const workflow = normalizeWorkflow(definition)
  if (!workflow.steps.length) throw new Error('A workflow must contain at least one step')

  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const stepNodes = new Map<string, { node: GraphNode; stems: string[] }>()
  let nextNodeId = 1
  let nextLinkId = 1

  const addNode = (type: string, pos: [number, number], widgets: unknown[], outputs?: GraphOutput[]) => {
    const spec = NODE_SPECS[type]
    if (!spec) throw new Error(`Unsupported workflow node type: ${type}`)
    const node: GraphNode = {
      id: nextNodeId++,
      type,
      pos,
      size: nodeSize(type),
      flags: {},
      order: nodes.length,
      mode: 0,
      inputs: specInputs(spec),
      outputs: outputs || specOutputs(spec),
      properties: { 'Node name for S&R': type },
      widgets_values: widgets,
    }
    nodes.push(node)
    return node
  }

  const connect = (source: GraphNode, sourceSlot: number, target: GraphNode, targetSlot: number, type: string) => {
    if (!source.outputs[sourceSlot] || !target.inputs[targetSlot]) {
      throw new Error(`Invalid generated link from ${source.type}:${sourceSlot} to ${target.type}:${targetSlot}`)
    }
    const id = nextLinkId++
    links.push([id, source.id, sourceSlot, target.id, targetSlot, type])
    const sourceLinks = source.outputs[sourceSlot].links || []
    source.outputs[sourceSlot].links = [...sourceLinks, id]
    target.inputs[targetSlot].link = id
  }

  // Use pymss' task-bound source node instead of a named load slot. This keeps
  // simple workflow batch/folder inputs driven by the host input list after
  // promotion, while still producing a native graph that the editor can open.
  const inputNode = addNode('input_audio', [80, 220], [])
  const defaultInference = asRecord(workflow.defaults.inference_params)

  workflow.steps.forEach((step, index) => {
    if (!step.stems.length) throw new Error(`Step ${step.id} has no declared stems`)
    if (stepNodes.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`)

    const resolvedModel = resolveStepModel(
      step,
      options.models || [],
      workflow.defaults.model_dir,
    )
    if (!resolvedModel.name.trim()) throw new Error(`Step ${step.id} has no model`)
    const kind = resolvedModel.kind
    const paramsType = kind === 'vr' ? 'pymss_vr_params' : 'pymss_mss_params'
    const separateType = kind === 'vr' ? 'vr_separate' : kind === 'custom' ? 'custom_mss_separate' : 'mss_separate'
    const x = 420 + index * 720
    const params = addNode(paramsType, [x, 500], parameterWidgets(step, kind, defaultInference))
    const device = step.device || workflow.defaults.device || 'auto'
    const separateWidgets = kind === 'custom'
      ? [resolvedModel.name, resolvedModel.modelType, device, '0', false]
      : [resolvedModel.name, device, true, 'modelscope', '0', false]
    const separate = addNode(separateType, [x, 220], separateWidgets, dynamicStemOutputs(step.stems))
    connect(params, 0, separate, 1, kind === 'vr' ? 'PYMSS_VR_PARAMS' : 'PYMSS_MSS_PARAMS')

    if (step.input === 'input') {
      connect(inputNode, 0, separate, 0, 'AUDIO')
    } else {
      const separator = step.input.lastIndexOf('.')
      if (separator <= 0) throw new Error(`Invalid input reference for step ${step.id}: ${step.input}`)
      const sourceId = step.input.slice(0, separator)
      const sourceStem = step.input.slice(separator + 1)
      const source = stepNodes.get(sourceId)
      const sourceStemIndex = source?.stems.indexOf(sourceStem) ?? -1
      if (!source || sourceStemIndex < 0) {
        throw new Error(`Unknown input reference for step ${step.id}: ${step.input}`)
      }
      connect(source.node, sourceStemIndex * 2, separate, 0, 'AUDIO')
    }
    stepNodes.set(step.id, { node: separate, stems: step.stems })

    Object.entries(step.save || {}).forEach(([stem, outputFolder], saveIndex) => {
      const stemIndex = step.stems.indexOf(stem)
      if (stemIndex < 0) throw new Error(`Step ${step.id} cannot save unknown stem: ${stem}`)
      const outputFormat = step.output_format || workflow.defaults.output_format || 'wav'
      const save = addNode(
        'pymss_save_audio',
        [x + 440, 120 + saveIndex * 180],
        [outputFormat, String(outputFolder || 'Default'), '44100', 'FLOAT', 'PCM_24', '320k'],
      )
      connect(separate, stemIndex * 2, save, 0, 'AUDIO')
    })
  })

  return {
    last_node_id: nextNodeId - 1,
    last_link_id: nextLinkId - 1,
    nodes,
    links,
    version: 1,
    extra: {
      appDefaults: {
        device: workflow.defaults.device || 'auto',
        output_format: workflow.defaults.output_format || 'wav',
        ...(workflow.defaults.model_dir ? { model_dir: workflow.defaults.model_dir } : {}),
      },
      pymssStudio: {
        format: 'graph',
        formatVersion: WORKFLOW_FORMAT_VERSION,
        convertedFromFormat: 'simple',
        ...(options.sourceWorkflowId ? { sourceWorkflowId: options.sourceWorkflowId } : {}),
      },
    },
  }
}
