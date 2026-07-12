import type { ModelEntry } from '@/stores/model'
import {
  buildWorkflowConsumedStemSet,
  buildWorkflowConsumedValueSetForDraft,
  buildWorkflowDefinition,
  createWorkflowNoteDraft,
  createWorkflowUtilityNodeDraft,
  hydrateWorkflowDefinition,
  parseModelStems,
  safeWorkflowStemDir,
  type WorkflowDefinitionDraft,
  type WorkflowStepDraft,
  type WorkflowUtilityNodeDraft,
} from '@/utils/workflowDefinition'

type ComfyLinkTuple = [number, number, number, number, number, string]

type ComfyWorkflowNode = {
  id: number
  type: string
  pos?: [number, number]
  size?: [number, number]
  order?: number
  mode?: number
  flags?: Record<string, unknown>
  inputs?: Array<Record<string, unknown> & { name?: string; link?: number | null }>
  outputs?: Array<Record<string, unknown> & { name?: string; type?: string; links?: number[] | null }>
  properties?: Record<string, unknown>
  widgets_values?: unknown[]
}

type ComfyWorkflow = {
  id?: string
  revision?: number
  last_node_id?: number
  last_link_id?: number
  nodes?: ComfyWorkflowNode[]
  links?: Array<ComfyLinkTuple | unknown>
  groups?: unknown[]
  config?: Record<string, unknown>
  extra?: Record<string, unknown>
  version?: number
}

type StepKind = 'mss' | 'vr' | 'custom'

type ExportNode = ComfyWorkflowNode & {
  inputs: Array<Record<string, unknown> & { name?: string; link?: number | null }>
  outputs: Array<Record<string, unknown> & { name?: string; type?: string; links?: number[] | null }>
}

export type ComfyMssImportResult = {
  definition: Record<string, unknown>
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

function patchWidgets(base: unknown[], patches: Record<number, unknown>): unknown[] {
  const next = Array.isArray(base) ? [...base] : []
  Object.entries(patches).forEach(([index, value]) => {
    const slot = Number(index)
    if (Number.isInteger(slot) && slot >= 0) next[slot] = value
  })
  return next
}

function readComfyMetaSection(step: WorkflowStepDraft, key: string): Record<string, unknown> | null {
  const meta = step.comfyMeta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const section = (meta as Record<string, unknown>)[key]
  return isRecord(section) ? section : null
}

function readComfyMetaWidgets(section: Record<string, unknown> | null): unknown[] | null {
  if (!section) return null
  return Array.isArray(section.widgets) ? section.widgets : null
}

function readNodePosition(node: ComfyWorkflowNode, fallbackX: number, fallbackY: number) {
  const pos = Array.isArray(node.pos) ? node.pos : []
  const x = Number(pos[0])
  const y = Number(pos[1])
  return {
    x: Number.isFinite(x) ? Math.round(x) : fallbackX,
    y: Number.isFinite(y) ? Math.round(y) : fallbackY,
  }
}

function readStringWidget(node: ComfyWorkflowNode, index: number, fallback = '') {
  const value = node.widgets_values?.[index]
  return typeof value === 'string' ? value.trim() : fallback
}

function readBoolWidget(node: ComfyWorkflowNode, index: number, fallback = false) {
  const value = node.widgets_values?.[index]
  return typeof value === 'boolean' ? value : fallback
}

function readNumberWidget(node: ComfyWorkflowNode, index: number, fallback: number | null = null) {
  const value = node.widgets_values?.[index]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseDefaultInt(value: unknown) {
  const text = String(value || '').trim()
  if (!text || text.toLowerCase() === 'default') return null
  const parsed = Number.parseInt(text, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function cleanComfyModelName(value: string) {
  const text = value.trim()
  if (!text) return ''
  return text
    .replace(/^\[[^\]]+\]\s*/u, '')
    .replace(/^【[^】]+】\s*/u, '')
    .trim()
}

function normalizeModelIdentifier(value: string) {
  return cleanComfyModelName(value)
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.trim()
    .toLowerCase() || ''
}

function stemNameFromPort(name: unknown) {
  const text = String(name || '').trim()
  if (!text) return ''
  return text
    .replace(/\s*\((audio|string)\)\s*$/iu, '')
    .trim()
}

function createStepIdFromComfyNodeId(nodeId: number) {
  return `step_comfy_${nodeId}`
}

function outputSlotIndexForStem(stems: string[], stem: string, kind: 'audio' | 'string') {
  const index = stems.findIndex(item => item === stem)
  if (index < 0) return -1
  return index * 2 + (kind === 'audio' ? 0 : 1)
}

function toComfyInputs(items: Array<{ name: string; type?: string; link?: number | null; label?: string; shape?: number }>) {
  return items.map(item => ({
    name: item.name,
    localized_name: item.label || item.name,
    label: item.label || item.name,
    type: item.type,
    link: item.link ?? null,
    ...(typeof item.shape === 'number' ? { shape: item.shape } : {}),
  }))
}

function toComfyOutputs(items: Array<{ name: string; type?: string; label?: string }>) {
  return items.map(item => ({
    name: item.name,
    localized_name: item.label || item.name,
    label: item.label || item.name,
    type: item.type,
    links: [] as number[],
  }))
}

function parseComfyWorkflow(input: unknown): ComfyWorkflow {
  if (!isRecord(input)) throw new Error('Comfy workflow JSON 必须是对象。')
  return input as ComfyWorkflow
}

function buildLinkMap(workflow: ComfyWorkflow) {
  const links = new Map<number, ComfyLinkTuple>()
  asArray(workflow.links).forEach((item) => {
    if (!Array.isArray(item) || item.length < 6) return
    const linkId = Number(item[0])
    const sourceNodeId = Number(item[1])
    const sourceSlot = Number(item[2])
    const targetNodeId = Number(item[3])
    const targetSlot = Number(item[4])
    const linkType = String(item[5] || '')
    if (![linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot].every(value => Number.isFinite(value))) return
    links.set(linkId, [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, linkType])
  })
  return links
}

function outputNameFromLink(node: ComfyWorkflowNode | undefined, slotIndex: number) {
  if (!node) return ''
  const output = asArray(node.outputs)[slotIndex] as Record<string, unknown> | undefined
  return String(output?.name || output?.label || output?.localized_name || '').trim()
}

function nodeTypeKind(type: string): StepKind | null {
  const normalized = type.trim()
  if (normalized === 'mss_separate' || normalized === 'mss_separate_list') return 'mss'
  if (normalized === 'vr_separate' || normalized === 'vr_separate_list') return 'vr'
  if (normalized === 'custom_mss_separate' || normalized === 'custom_mss_separate_list') return 'custom'
  return null
}

function isListSeparateNode(type: string) {
  return ['mss_separate_list', 'vr_separate_list', 'custom_mss_separate_list'].includes(type.trim())
}

function findMatchingModelEntry(modelName: string, models: ModelEntry[]) {
  const target = normalizeModelIdentifier(modelName)
  if (!target) return null
  return models.find((item) => {
    const candidates = [
      item.name,
      ...(item.aliases || []),
      item.modelPath,
      item.configPath || '',
    ]
      .map(normalizeModelIdentifier)
      .filter(Boolean)
    return candidates.some(candidate => candidate === target || target.endsWith(candidate) || candidate.endsWith(target))
  }) || null
}

function stemsFromModelEntry(modelName: string, kind: StepKind, models: ModelEntry[]) {
  const matched = findMatchingModelEntry(modelName, models)
  if (!matched) {
    if (kind === 'vr') return ['Vocals', 'Instrumental']
    return []
  }
  const stems = parseModelStems(matched.configInstruments)
  if (stems.length) return stems
  const targetStem = String(matched.targetStem || '').trim()
  if (targetStem) return [targetStem]
  if (kind === 'vr') return ['Vocals', 'Instrumental']
  return []
}

function inferStepKind(step: WorkflowStepDraft, models: ModelEntry[]) {
  if (step.modelKind === 'mss' || step.modelKind === 'vr' || step.modelKind === 'custom') {
    return step.modelKind
  }
  const matched = findMatchingModelEntry(step.model, models)
  if (matched) {
    if (String(matched.modelType || '').toLowerCase() === 'vr') return 'vr' as const
    if (
      String(matched.category || '').toLowerCase().includes('custom')
      || String(matched.primaryCategory || '').toLowerCase().includes('custom')
      || String(matched.secondaryCategory || '').toLowerCase().includes('custom')
      || /[\\/]custom[\\/]/i.test(matched.modelPath || '')
      || /[\\/]custom[\\/]/i.test(matched.configPath || '')
    ) {
      return 'custom' as const
    }
  }
  return 'mss' as const
}

function customModelTypeFor(step: WorkflowStepDraft, models: ModelEntry[]) {
  if (step.customModelType) return step.customModelType
  const matched = findMatchingModelEntry(step.model, models)
  return matched?.architecture || matched?.modelType || 'mel_band_roformer'
}

function addLink(
  links: ComfyLinkTuple[],
  nodesById: Map<number, ExportNode>,
  sourceNodeId: number,
  sourceSlot: number,
  targetNodeId: number,
  targetSlot: number,
  type: string,
) {
  const linkId = links.length + 1
  const tuple: ComfyLinkTuple = [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, type]
  links.push(tuple)
  const sourceNode = nodesById.get(sourceNodeId)
  const targetNode = nodesById.get(targetNodeId)
  if (sourceNode?.outputs[sourceSlot]) {
    sourceNode.outputs[sourceSlot].links ||= []
    ;(sourceNode.outputs[sourceSlot].links as number[]).push(linkId)
  }
  if (targetNode?.inputs[targetSlot]) {
    targetNode.inputs[targetSlot].link = linkId
  }
}

function createUuidLike() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `workflow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function addImportNote(
  draft: WorkflowDefinitionDraft,
  x: number,
  y: number,
  title: string,
  content: string,
  color: 'amber' | 'blue' | 'green' | 'rose' = 'amber',
) {
  const note = createWorkflowNoteDraft({ x, y })
  note.title = title
  note.content = content
  note.color = color
  draft.ui.notes.push(note)
}

function addImportUtilityNode(
  draft: WorkflowDefinitionDraft,
  kind: WorkflowUtilityNodeDraft['kind'],
  x: number,
  y: number,
  data?: Record<string, unknown>,
) {
  const node = createWorkflowUtilityNodeDraft(kind, { x, y })
  node.data = {
    ...(node.data || {}),
    ...(data || {}),
  }
  draft.utilityNodes.push(node)
  return node
}

function workflowValueToComfySource(
  value: string,
  loadNodeId: number,
  stepNodeIds: Map<string, number>,
  stepStemNames: Map<string, string[]>,
  utilityNodeIds: Map<string, number>,
) {
  const input = String(value || '').trim()
  if (!input || input === 'input') {
    return { nodeId: loadNodeId, slot: 0, type: 'AUDIO' }
  }
  if (input.startsWith('utility:')) {
    const nodeId = utilityNodeIds.get(input.slice('utility:'.length).trim())
    return nodeId ? { nodeId, slot: 0, type: 'AUDIO' } : null
  }
  const [sourceId, sourceStem] = input.split('.', 2)
  if (!sourceId || !sourceStem) return { nodeId: loadNodeId, slot: 0, type: 'AUDIO' }
  const upstreamNodeId = stepNodeIds.get(sourceId)
  const upstreamStems = stepStemNames.get(sourceId) || []
  const sourceSlot = outputSlotIndexForStem(upstreamStems, sourceStem, 'audio')
  if (upstreamNodeId && sourceSlot >= 0) {
    return { nodeId: upstreamNodeId, slot: sourceSlot, type: 'AUDIO' }
  }
  return { nodeId: loadNodeId, slot: 0, type: 'AUDIO' }
}

function resolveImportedAudioInputValue(
  sourceNode: ComfyWorkflowNode | undefined,
  sourceOutputName: string,
  comfyToStepId: Map<number, string>,
  comfyToUtilityId: Map<number, string>,
) {
  if (!sourceNode) return ''
  if (sourceNode.type === 'pymss_load_audio') return 'input'
  if (sourceNode.type === 'pymss_load_audio_batch') {
    const utilityId = comfyToUtilityId.get(sourceNode.id)
    return utilityId ? `utility:${utilityId}` : 'input'
  }
  if (nodeTypeKind(sourceNode.type)) {
    const sourceStem = stemNameFromPort(sourceOutputName)
    const sourceStepId = comfyToStepId.get(sourceNode.id) || createStepIdFromComfyNodeId(sourceNode.id)
    return sourceStem ? `${sourceStepId}.${sourceStem}` : ''
  }
  const utilityId = comfyToUtilityId.get(sourceNode.id)
  if (utilityId) return `utility:${utilityId}`
  return ''
}

export function importComfyMssWorkflow(input: unknown, options?: { models?: ModelEntry[] }): ComfyMssImportResult {
  const workflow = parseComfyWorkflow(input)
  const models = options?.models || []
  const warnings: string[] = []
  const nodes = asArray<ComfyWorkflowNode>(workflow.nodes).filter(item => isRecord(item) && typeof item.id === 'number' && typeof item.type === 'string')
  if (!nodes.length) throw new Error('未在 JSON 中找到 ComfyUI 节点。')

  const supportedSeparateNodes = nodes.filter(node => Boolean(nodeTypeKind(node.type)))
  const listSeparateNodes = nodes.filter(node => isListSeparateNode(node.type))
  if (!supportedSeparateNodes.length) {
    throw new Error('未找到可导入的 comfy-mss 分离节点。')
  }
  if (listSeparateNodes.length) {
    warnings.push('检测到 List 分离节点，已尽量按普通多 stem 工作流导入；复杂列表语义会被折叠为桌面端工作流。')
  }

  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const links = buildLinkMap(workflow)
  const loadNodes = nodes.filter(node => node.type === 'pymss_load_audio' || node.type === 'pymss_load_audio_batch')
  if (loadNodes.length > 1) warnings.push('检测到多个输入节点，当前仅按连接关系导入主链路，其他输入节点已忽略。')
  if (loadNodes.some(node => node.type === 'pymss_load_audio_batch')) {
    warnings.push('检测到批量输入节点，已导入为桌面端批量输入节点；桌面端会按目录扫描后逐文件运行。')
  }
  const unsupportedTransformNodes = nodes.filter(node => [
    'pymss_audio_ensemble',
    'pymss_audio_invert_phase',
    'pymss_audio_normalize',
  ].includes(node.type))

  const orderedSeparateNodes = [...supportedSeparateNodes].sort((a, b) => {
    const pa = readNodePosition(a, 0, 0)
    const pb = readNodePosition(b, 0, 0)
    if (pa.x !== pb.x) return pa.x - pb.x
    if (pa.y !== pb.y) return pa.y - pb.y
    return a.id - b.id
  })

  let defaultDevice = 'auto'
  let defaultFormat = 'wav'
  let defaultNormalize = false
  let inputPosition = { x: 72, y: 210 }
  let saveXValues: number[] = []
  let saveYValues: number[] = []

  const draft: WorkflowDefinitionDraft = {
    defaultDevice,
    defaultFormat,
    defaultNormalize,
    steps: [],
    utilityNodes: [],
    saveTargets: [],
    ui: {
      viewport: { x: 0, y: 0, k: 1 },
      nodes: {},
      notes: [],
      collapsedStepIds: [],
    },
  }

  const comfyToStepId = new Map<number, string>()
  const comfyToUtilityId = new Map<number, string>()

  const firstLoad = loadNodes[0]
  if (firstLoad) inputPosition = readNodePosition(firstLoad, 72, 210)

  loadNodes
    .filter(node => node.type === 'pymss_load_audio_batch')
    .forEach((node) => {
      const pos = readNodePosition(node, 180, 280)
      const draftNode = addImportUtilityNode(draft, 'load_audio_batch', pos.x, pos.y, {
        folder: readStringWidget(node, 0, ''),
        recursive: readBoolWidget(node, 1, false),
        sortFiles: readBoolWidget(node, 2, true),
      })
      comfyToUtilityId.set(node.id, draftNode.id)
    })

  unsupportedTransformNodes.forEach((node) => {
    const pos = readNodePosition(node, 420, 180)
    if (node.type === 'pymss_audio_ensemble') {
      const widgets = asArray(node.widgets_values)
      const inputCount = Math.max(2, Math.min(10, Number.parseInt(String(widgets[0] || '2'), 10) || 2))
      const rawWeights = widgets.slice(2).map(value => Number(value)).filter(value => Number.isFinite(value))
      const draftNode = addImportUtilityNode(draft, 'audio_ensemble', pos.x, pos.y, {
        inputCount,
        ensembleType: String(widgets[1] || 'avg_wave'),
        weights: rawWeights.length ? rawWeights.slice(0, inputCount) : Array.from({ length: inputCount }, () => 1),
        inputs: Array.from({ length: inputCount }, () => ''),
      })
      comfyToUtilityId.set(node.id, draftNode.id)
      return
    }
    if (node.type === 'pymss_audio_invert_phase') {
      const draftNode = addImportUtilityNode(draft, 'audio_invert_phase', pos.x, pos.y, { input: '' })
      comfyToUtilityId.set(node.id, draftNode.id)
      return
    }
    if (node.type === 'pymss_audio_normalize') {
      const draftNode = addImportUtilityNode(draft, 'audio_normalize', pos.x, pos.y, { input: '' })
      comfyToUtilityId.set(node.id, draftNode.id)
    }
  })

  orderedSeparateNodes.forEach((node, index) => {
    const stepId = createStepIdFromComfyNodeId(node.id)
    comfyToStepId.set(node.id, stepId)
    const nodePos = readNodePosition(node, 384 + index * 318, 118 + (index % 2) * 96)
    const kind = nodeTypeKind(node.type) || 'mss'
    const model = cleanComfyModelName(readStringWidget(node, 0, ''))
    const device = kind === 'custom' ? readStringWidget(node, 2, 'auto') : readStringWidget(node, 1, 'auto')
    if (index === 0 && device) defaultDevice = device

    const stems = asArray(node.outputs)
      .filter((output) => String((output as Record<string, unknown>)?.type || '').toUpperCase() === 'AUDIO')
      .map((output) => stemNameFromPort((output as Record<string, unknown>)?.name))
      .filter(Boolean)
    const inferredStems = stems.length ? stems : stemsFromModelEntry(model, kind, models)

    const step: WorkflowStepDraft = {
      id: stepId,
      model,
      input: 'input',
      stems: inferredStems,
      save: {},
      overlapSize: null,
      modelKind: kind,
      customModelType: kind === 'custom' ? readStringWidget(node, 1, 'mel_band_roformer') : null,
    }
    // Round-trip carrier: keep the original comfy widgets so fields pymss-studio
    // does not manage (batch_size / chunk_size / tta / standardize / VR params /
    // sample_rate / bit-depth ...) survive an import → edit → export cycle.
    const comfyMeta: Record<string, unknown> = {
      separate: { type: node.type, widgets: cloneJson(asArray(node.widgets_values)) },
    }
    const comfySaveMeta: Record<string, { widgets: unknown[] }> = {}
    if (!step.stems.length) {
      warnings.push(`节点 ${node.id} 未能推断输出 stems，已导入为空步骤；请在桌面端补全输出音轨。`)
    }

    const paramsInputIndex = asArray(node.inputs).findIndex(inputDef => String((inputDef as Record<string, unknown>)?.name || '').trim() === 'params')
    if (paramsInputIndex >= 0) {
      const linkId = Number((asArray(node.inputs)[paramsInputIndex] as Record<string, unknown>)?.link)
      const link = links.get(linkId)
      if (link) {
        const paramsNode = nodeMap.get(link[1])
        if (paramsNode?.type === 'pymss_mss_params') {
          step.overlapSize = parseDefaultInt(paramsNode.widgets_values?.[1])
          defaultNormalize = defaultNormalize || readBoolWidget(paramsNode, 3, false)
          comfyMeta.params = { type: paramsNode.type, widgets: cloneJson(asArray(paramsNode.widgets_values)) }
        } else if (paramsNode?.type === 'pymss_vr_params') {
          defaultNormalize = defaultNormalize || readBoolWidget(paramsNode, 7, false)
          comfyMeta.params = { type: paramsNode.type, widgets: cloneJson(asArray(paramsNode.widgets_values)) }
        }
      }
    }

    const audioInputIndex = asArray(node.inputs).findIndex(inputDef => String((inputDef as Record<string, unknown>)?.name || '').trim() === 'audio')
    if (audioInputIndex >= 0) {
      const linkId = Number((asArray(node.inputs)[audioInputIndex] as Record<string, unknown>)?.link)
      const link = links.get(linkId)
      if (link) {
        const sourceNode = nodeMap.get(link[1])
        const sourceValue = resolveImportedAudioInputValue(
          sourceNode,
          outputNameFromLink(sourceNode, link[2]),
          comfyToStepId,
          comfyToUtilityId,
        )
        if (sourceValue) {
          step.input = sourceValue
        } else {
          warnings.push(`节点 ${node.id} 的输入来自不支持的节点类型 ${sourceNode?.type || 'unknown'}，已回退为原始输入。`)
        }
      }
    }

    asArray(node.outputs).forEach((output, outputIndex) => {
      const outputType = String((output as Record<string, unknown>)?.type || '').toUpperCase()
      if (outputType !== 'AUDIO') return
      const stem = stemNameFromPort((output as Record<string, unknown>)?.name)
      const outputLinks = asArray<number>((output as Record<string, unknown>)?.links)
      outputLinks.forEach((linkId) => {
        const link = links.get(Number(linkId))
        if (!link) return
        const targetNode = nodeMap.get(link[3])
        if (targetNode?.type !== 'pymss_save_audio') return
        const outputDir = readStringWidget(targetNode, 1, '')
        if (outputDir && outputDir.toLowerCase() !== 'default') {
          if (isListSeparateNode(node.type) && step.stems.length) {
            step.stems.forEach((item) => {
              step.save[item] = outputDir
            })
          } else if (stem) {
            step.save[stem] = outputDir
          }
        }
        // Preserve the full Save Audio widgets for round-trip fidelity.
        if (stem) {
          comfySaveMeta[stem] = { widgets: cloneJson(asArray(targetNode.widgets_values)) }
        } else if (isListSeparateNode(node.type)) {
          step.stems.forEach((item) => {
            comfySaveMeta[item] = { widgets: cloneJson(asArray(targetNode.widgets_values)) }
          })
        }
        const savePos = readNodePosition(targetNode, nodePos.x + 420, nodePos.y + outputIndex * 48)
        saveXValues.push(savePos.x)
        saveYValues.push(savePos.y)
        const format = readStringWidget(targetNode, 0, '')
        if (format) defaultFormat = format
      })
    })

    if (Object.keys(comfySaveMeta).length) comfyMeta.save = comfySaveMeta
    step.comfyMeta = comfyMeta

    draft.steps.push(step)
    draft.ui.nodes[step.id] = nodePos
  })

  draft.defaultDevice = defaultDevice
  draft.defaultFormat = defaultFormat
  draft.defaultNormalize = defaultNormalize
  draft.ui.nodes.input = inputPosition
  draft.ui.nodes.save = {
    x: saveXValues.length ? Math.round(saveXValues.reduce((sum, value) => sum + value, 0) / saveXValues.length) : 420 + Math.max(1, draft.steps.length) * 318,
    y: saveYValues.length ? Math.round(saveYValues.reduce((sum, value) => sum + value, 0) / saveYValues.length) : 192,
  }

  const ds = isRecord(workflow.extra?.ds) ? workflow.extra?.ds as Record<string, unknown> : null
  const scale = Number(ds?.scale)
  const offset = Array.isArray(ds?.offset) ? ds?.offset : []
  const offsetX = Number(offset[0])
  const offsetY = Number(offset[1])
  if (Number.isFinite(scale)) {
    draft.ui.viewport.k = Math.max(0.25, Math.min(2.5, scale))
  }
  if (Number.isFinite(offsetX)) draft.ui.viewport.x = Math.round(offsetX)
  if (Number.isFinite(offsetY)) draft.ui.viewport.y = Math.round(offsetY)

  unsupportedTransformNodes.forEach((node) => {
    const utilityPos = readNodePosition(node, 420, 180)
    const utilityId = comfyToUtilityId.get(node.id)
    const utilityNode = draft.utilityNodes.find(item => item.id === utilityId)
    if (!utilityNode) return
    if (utilityNode.kind === 'audio_ensemble') {
      const inputCount = Math.max(2, Math.min(10, Number(utilityNode.data.inputCount) || 2))
      const inputs = Array.from({ length: inputCount }, (_value, index) => {
        const inputDef = asArray(node.inputs)[index] as Record<string, unknown> | undefined
        const linkId = Number(inputDef?.link)
        const link = links.get(linkId)
        const sourceNode = link ? nodeMap.get(link[1]) : undefined
        return resolveImportedAudioInputValue(
          sourceNode,
          outputNameFromLink(sourceNode, link?.[2] ?? -1),
          comfyToStepId,
          comfyToUtilityId,
        )
      })
      utilityNode.data = {
        ...utilityNode.data,
        inputCount,
        inputs,
      }
      return
    }
    if (utilityNode.kind === 'audio_invert_phase' || utilityNode.kind === 'audio_normalize') {
      const inputDef = asArray(node.inputs)[0] as Record<string, unknown> | undefined
      const linkId = Number(inputDef?.link)
      const link = links.get(linkId)
      const sourceNode = link ? nodeMap.get(link[1]) : undefined
      utilityNode.data = {
        ...utilityNode.data,
        input: resolveImportedAudioInputValue(
          sourceNode,
          outputNameFromLink(sourceNode, link?.[2] ?? -1),
          comfyToStepId,
          comfyToUtilityId,
        ),
      }
    }

    asArray(node.outputs).forEach((output) => {
      const outputType = String((output as Record<string, unknown>)?.type || '').toUpperCase()
      if (outputType !== 'AUDIO') return
      const outputLinks = asArray<number>((output as Record<string, unknown>)?.links)
      outputLinks.forEach((linkId) => {
        const link = links.get(Number(linkId))
        if (!link) return
        const targetNode = nodeMap.get(link[3])
        if (targetNode?.type !== 'pymss_save_audio' || !utilityId) return
        const outputDir = readStringWidget(targetNode, 1, '')
        draft.saveTargets = [
          ...draft.saveTargets.filter(item => item.source !== `utility:${utilityId}`),
          {
            source: `utility:${utilityId}`,
            outputDir: outputDir && outputDir.toLowerCase() !== 'default'
              ? outputDir
              : safeWorkflowStemDir(node.type),
          },
        ]
        const savePos = readNodePosition(targetNode, utilityPos.x + 242, utilityPos.y + 48)
        saveXValues.push(savePos.x)
        saveYValues.push(savePos.y)
        const format = readStringWidget(targetNode, 0, '')
        if (format) defaultFormat = format
      })
    })
  })
  if (listSeparateNodes.length) {
    const leftMost = orderedSeparateNodes[0] ? readNodePosition(orderedSeparateNodes[0], 384, 118) : { x: 384, y: 118 }
    addImportNote(
      draft,
      leftMost.x - 48,
      leftMost.y - 180,
      'List 工作流已折叠导入',
      '检测到 comfy-mss 的 List 工作流。当前已尽量转为桌面端普通多 stem 工作流，列表批处理与逐项展开语义未完整保留。',
      'blue',
    )
  }

  return {
    definition: buildWorkflowDefinition(draft),
    warnings,
  }
}

export function exportComfyMssWorkflow(
  definition: Record<string, unknown>,
  options?: { models?: ModelEntry[] },
): Record<string, unknown> {
  const draft = hydrateWorkflowDefinition(definition)
  const models = options?.models || []
  const consumedStemSet = buildWorkflowConsumedStemSet(draft.steps)
  const consumedValueSet = buildWorkflowConsumedValueSetForDraft(draft.steps, draft.utilityNodes)

  const nodes: ExportNode[] = []
  const nodesById = new Map<number, ExportNode>()
  const links: ComfyLinkTuple[] = []
  let nextNodeId = 1
  const utilityNodeIds = new Map<string, number>()

  const createNode = (node: ExportNode) => {
    nodes.push(node)
    nodesById.set(node.id, node)
    return node
  }

  const inputPos = draft.ui.nodes.input || { x: 72, y: 210 }
  const loadNode = createNode({
    id: nextNodeId++,
    type: 'pymss_load_audio',
    pos: [inputPos.x, inputPos.y],
    size: [260, 102],
    flags: {},
    order: nodes.length,
    mode: 0,
    inputs: toComfyInputs([
      { name: 'audio', type: 'COMBO' },
    ]),
    outputs: toComfyOutputs([
      { name: 'audio', type: 'AUDIO' },
      { name: 'audio_name', type: 'STRING' },
    ]),
    properties: { 'Node name for S&R': 'pymss_load_audio' },
    widgets_values: ['input.wav', null],
  })

  draft.utilityNodes.forEach((node) => {
    if (node.kind === 'load_audio_batch') {
      const exportNode = createNode({
        id: nextNodeId++,
        type: 'pymss_load_audio_batch',
        pos: [node.x, node.y],
        size: [260, 126],
        flags: {},
        order: nodes.length,
        mode: 0,
        inputs: toComfyInputs([
          { name: 'folder', type: 'STRING', label: 'folder' },
          { name: 'recursive', type: 'BOOLEAN', label: 'recursive' },
          { name: 'sort_files', type: 'BOOLEAN', label: 'sort_files' },
        ]),
        outputs: toComfyOutputs([
          { name: 'audio', type: 'AUDIO' },
          { name: 'audio_name', type: 'STRING' },
        ]),
        properties: { 'Node name for S&R': 'pymss_load_audio_batch' },
        widgets_values: [
          String(node.data.folder || ''),
          Boolean(node.data.recursive),
          node.data.sortFiles === undefined ? true : Boolean(node.data.sortFiles),
        ],
      })
      utilityNodeIds.set(node.id, exportNode.id)
      return
    }
    if (node.kind === 'audio_ensemble') {
      const inputCount = Math.max(2, Math.min(10, Number(node.data.inputCount) || 2))
      const rawWeights = Array.isArray(node.data.weights) ? node.data.weights : []
      const weights = Array.from({ length: 10 }, (_, index) => {
        const value = Number(rawWeights[index])
        return Number.isFinite(value) ? value : 1
      })
      const exportNode = createNode({
        id: nextNodeId++,
        type: 'pymss_audio_ensemble',
        pos: [node.x, node.y],
        size: [260, 150],
        flags: {},
        order: nodes.length,
        mode: 0,
        inputs: toComfyInputs(Array.from({ length: inputCount }, (_value, index) => ({
          name: `audio_${index + 1}`,
          type: 'AUDIO',
          label: `audio_${index + 1}`,
          shape: 7,
        }))),
        outputs: toComfyOutputs([
          { name: 'audio', type: 'AUDIO' },
        ]),
        properties: { 'Node name for S&R': 'pymss_audio_ensemble' },
        widgets_values: [
          String(inputCount),
          String(node.data.ensembleType || 'avg_wave'),
          ...weights.map(value => String(value)),
        ],
      })
      utilityNodeIds.set(node.id, exportNode.id)
      return
    }
    if (node.kind === 'audio_invert_phase') {
      const exportNode = createNode({
        id: nextNodeId++,
        type: 'pymss_audio_invert_phase',
        pos: [node.x, node.y],
        size: [200, 26],
        flags: {},
        order: nodes.length,
        mode: 0,
        inputs: toComfyInputs([{ name: 'a', type: 'AUDIO', label: 'a' }]),
        outputs: toComfyOutputs([{ name: '-a', type: 'AUDIO' }]),
        properties: { 'Node name for S&R': 'pymss_audio_invert_phase' },
        widgets_values: [],
      })
      utilityNodeIds.set(node.id, exportNode.id)
      return
    }
    if (node.kind === 'audio_normalize') {
      const exportNode = createNode({
        id: nextNodeId++,
        type: 'pymss_audio_normalize',
        pos: [node.x, node.y],
        size: [200, 26],
        flags: {},
        order: nodes.length,
        mode: 0,
        inputs: toComfyInputs([{ name: 'audio', type: 'AUDIO', label: 'audio' }]),
        outputs: toComfyOutputs([{ name: 'audio', type: 'AUDIO' }]),
        properties: { 'Node name for S&R': 'pymss_audio_normalize' },
        widgets_values: [],
      })
      utilityNodeIds.set(node.id, exportNode.id)
    }
  })

  const stepNodeIds = new Map<string, number>()
  const stepStemNames = new Map<string, string[]>()

  draft.steps.forEach((step, index) => {
    const position = draft.ui.nodes[step.id] || { x: 384 + index * 318, y: 118 + (index % 2) * 96 }
    const kind = inferStepKind(step, models)
    const paramsNodeType = kind === 'vr' ? 'pymss_vr_params' : 'pymss_mss_params'
    const paramsNodeId = nextNodeId++
    const separateNodeId = nextNodeId++

    // Round-trip: if this step was imported from comfy-mss, restore the original
    // params widgets and patch only the fields pymss-studio manages.
    const defaultParamsWidgets: unknown[] = kind === 'vr'
      ? [1, 512, 5, false, false, false, 0.2, Boolean(draft.defaultNormalize)]
      : [
          1,
          step.overlapSize == null ? 'Default' : String(step.overlapSize),
          'Default',
          Boolean(draft.defaultNormalize),
          false,
          false,
        ]
    const paramsMeta = readComfyMetaSection(step, 'params')
    const paramsMetaWidgets = readComfyMetaWidgets(paramsMeta)
    const paramsMetaMatchesKind = paramsMeta
      ? String(paramsMeta.type || '') === paramsNodeType
      : false
    const paramsWidgets = paramsMetaWidgets && paramsMetaMatchesKind
      ? patchWidgets(paramsMetaWidgets, kind === 'vr'
          ? { 7: Boolean(draft.defaultNormalize) }
          : {
              1: step.overlapSize == null ? 'Default' : String(step.overlapSize),
              3: Boolean(draft.defaultNormalize),
            })
      : defaultParamsWidgets

    const paramsNode = createNode({
      id: paramsNodeId,
      type: paramsNodeType,
      pos: [position.x - 320, position.y + 162],
      size: [260, kind === 'vr' ? 220 : 178],
      flags: {},
      order: nodes.length,
      mode: 0,
      inputs: toComfyInputs(kind === 'vr'
        ? [
            { name: 'batch_size', type: 'INT' },
            { name: 'window_size', type: 'INT' },
            { name: 'aggression', type: 'INT' },
            { name: 'enable_tta', type: 'BOOLEAN' },
            { name: 'high_end_process', type: 'BOOLEAN' },
            { name: 'enable_post_process', type: 'BOOLEAN' },
            { name: 'post_process_threshold', type: 'FLOAT' },
            { name: 'normalize', type: 'BOOLEAN' },
          ]
        : [
            { name: 'batch_size', type: 'INT' },
            { name: 'overlap_size', type: 'STRING' },
            { name: 'chunk_size', type: 'STRING' },
            { name: 'normalize', type: 'BOOLEAN' },
            { name: 'enable_tta', type: 'BOOLEAN' },
            { name: 'standardize', type: 'BOOLEAN' },
          ]),
      outputs: toComfyOutputs([
        { name: kind === 'vr' ? 'vr_params' : 'mss_params', type: kind === 'vr' ? 'PYMSS_VR_PARAMS' : 'PYMSS_MSS_PARAMS' },
      ]),
      properties: { 'Node name for S&R': paramsNodeType },
      widgets_values: paramsWidgets,
    })

    const separateNodeType = kind === 'vr'
      ? 'vr_separate'
      : kind === 'custom'
        ? 'custom_mss_separate'
        : 'mss_separate'

    const outputs = step.stems.flatMap((stem) => ([
      { name: `${stem} (Audio)`, type: 'AUDIO', label: `${stem} (Audio)` },
      { name: `${stem} (String)`, type: 'STRING', label: `${stem} (String)` },
    ]))

    // Round-trip: restore original separate widgets and patch managed fields
    // (model name, model type for custom, device).
    const defaultSeparateWidgets: unknown[] = kind === 'custom'
      ? [step.model, customModelTypeFor(step, models), draft.defaultDevice || 'auto', '0', '0', false]
      : [step.model, draft.defaultDevice || 'auto', true, 'modelscope', '0', '0', false]
    const separateMeta = readComfyMetaSection(step, 'separate')
    const separateMetaWidgets = readComfyMetaWidgets(separateMeta)
    const separateMetaMatchesKind = separateMeta
      ? String(separateMeta.type || '') === separateNodeType
      : false
    const separateWidgets = separateMetaWidgets && separateMetaMatchesKind
      ? patchWidgets(separateMetaWidgets, kind === 'custom'
          ? { 0: step.model, 1: customModelTypeFor(step, models), 2: draft.defaultDevice || 'auto' }
          : { 0: step.model, 1: draft.defaultDevice || 'auto' })
      : defaultSeparateWidgets

    const separateNode = createNode({
      id: separateNodeId,
      type: separateNodeType,
      pos: [position.x, position.y],
      size: [420, Math.max(220, 158 + step.stems.length * 28)],
      flags: {},
      order: nodes.length,
      mode: 0,
      inputs: toComfyInputs(kind === 'custom'
        ? [
            { name: 'audio', type: 'AUDIO', label: 'audio' },
            { name: 'params', type: 'PYMSS_MSS_PARAMS', label: 'params', shape: 7 },
            { name: 'model_name', type: 'COMBO', label: 'model_name' },
            { name: 'model_type', type: 'COMBO', label: 'model_type' },
            { name: 'device', type: 'COMBO', label: 'device' },
            { name: 'device_ids', type: 'STRING', label: 'device_ids', shape: 7 },
            { name: 'debug', type: 'BOOLEAN', label: 'debug', shape: 7 },
          ]
        : [
            { name: 'audio', type: 'AUDIO', label: 'audio' },
            { name: 'params', type: kind === 'vr' ? 'PYMSS_VR_PARAMS' : 'PYMSS_MSS_PARAMS', label: 'params', shape: 7 },
            { name: 'model_name', type: 'COMBO', label: 'model_name' },
            { name: 'device', type: 'COMBO', label: 'device' },
            { name: 'download_missing', type: 'BOOLEAN', label: 'download_missing' },
            { name: 'source', type: 'COMBO', label: 'source' },
            { name: 'device_ids', type: 'STRING', label: 'device_ids', shape: 7 },
            { name: 'debug', type: 'BOOLEAN', label: 'debug', shape: 7 },
          ]),
      outputs: toComfyOutputs(outputs),
      properties: { 'Node name for S&R': separateNodeType },
      widgets_values: separateWidgets,
    })

    stepNodeIds.set(step.id, separateNodeId)
    stepStemNames.set(step.id, [...step.stems])

    addLink(
      links,
      nodesById,
      paramsNode.id,
      0,
      separateNode.id,
      1,
      kind === 'vr' ? 'PYMSS_VR_PARAMS' : 'PYMSS_MSS_PARAMS',
    )

    const source = workflowValueToComfySource(
      String(step.input || 'input'),
      loadNode.id,
      stepNodeIds,
      stepStemNames,
      utilityNodeIds,
    )
    if (source) addLink(links, nodesById, source.nodeId, source.slot, separateNode.id, 0, source.type)
  })

  draft.utilityNodes.forEach((node) => {
    const targetNodeId = utilityNodeIds.get(node.id)
    if (!targetNodeId) return
    if (node.kind === 'audio_ensemble') {
      const inputCount = Math.max(2, Math.min(10, Number(node.data.inputCount) || 2))
      const rawInputs = Array.isArray(node.data.inputs) ? node.data.inputs : []
      for (let index = 0; index < inputCount; index += 1) {
        const source = workflowValueToComfySource(
          String(rawInputs[index] || ''),
          loadNode.id,
          stepNodeIds,
          stepStemNames,
          utilityNodeIds,
        )
        if (source) addLink(links, nodesById, source.nodeId, source.slot, targetNodeId, index, source.type)
      }
      return
    }
    if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
      const source = workflowValueToComfySource(
        String(node.data.input || ''),
        loadNode.id,
        stepNodeIds,
        stepStemNames,
        utilityNodeIds,
      )
      if (source) addLink(links, nodesById, source.nodeId, source.slot, targetNodeId, 0, source.type)
    }
  })

  draft.steps.forEach((step) => {
    const separateNodeId = stepNodeIds.get(step.id)
    const stems = stepStemNames.get(step.id) || []
    if (!separateNodeId) return

    step.stems
      .filter(stem => !consumedStemSet.has(`${step.id}.${stem}`))
      .forEach((stem, index) => {
        const stemAudioSlot = outputSlotIndexForStem(stems, stem, 'audio')
        const stemStringSlot = outputSlotIndexForStem(stems, stem, 'string')
        if (stemAudioSlot < 0 || stemStringSlot < 0) return

        const baseX = (draft.ui.nodes[step.id]?.x || 384) + 430
        const baseY = (draft.ui.nodes[step.id]?.y || 118) + index * 138
        const concatNode = createNode({
          id: nextNodeId++,
          type: 'StringConcatenate',
          pos: [baseX, baseY + 48],
          size: [400, 200],
          flags: { collapsed: true },
          order: nodes.length,
          mode: 0,
          inputs: toComfyInputs([
            { name: 'string_a', type: 'STRING' },
            { name: 'string_b', type: 'STRING' },
            { name: 'delimiter', type: 'STRING' },
          ]),
          outputs: toComfyOutputs([
            { name: 'STRING', type: 'STRING' },
          ]),
          properties: { 'Node name for S&R': 'StringConcatenate' },
          widgets_values: ['', '', '_'],
        })

        const saveNode = createNode({
          id: nextNodeId++,
          type: 'pymss_save_audio',
          pos: [baseX + 242, baseY],
          size: [260, 150],
          flags: {},
          order: nodes.length,
          mode: 0,
          inputs: toComfyInputs([
            { name: 'audio', type: 'AUDIO', label: 'audio' },
            { name: 'filename', type: 'STRING', label: 'filename', shape: 7 },
            { name: 'output_format', type: 'COMBO', label: 'output_format' },
            { name: 'output_folder', type: 'STRING', label: 'output_folder' },
            { name: 'sample_rate', type: 'COMBO', label: 'sample_rate' },
            { name: 'wav_bit_depth', type: 'COMBO', label: 'wav_bit_depth' },
            { name: 'flac_bit_depth', type: 'COMBO', label: 'flac_bit_depth' },
            { name: 'mp3_bit_rate', type: 'COMBO', label: 'mp3_bit_rate' },
          ]),
          outputs: [],
          properties: { 'Node name for S&R': 'pymss_save_audio' },
          widgets_values: (() => {
            const managed = {
              0: draft.defaultFormat || 'wav',
              1: step.save?.[stem] || safeWorkflowStemDir(stem),
            }
            const saveMetaSection = readComfyMetaSection(step, 'save')
            const stemMeta = saveMetaSection && isRecord(saveMetaSection[stem]) ? saveMetaSection[stem] as Record<string, unknown> : null
            const stemWidgets = stemMeta && Array.isArray(stemMeta.widgets) ? stemMeta.widgets : null
            return stemWidgets
              ? patchWidgets(stemWidgets, managed)
              : [managed[0], managed[1], '44100', 'FLOAT', 'PCM_24', '320k']
          })(),
        })

        addLink(links, nodesById, loadNode.id, 1, concatNode.id, 0, 'STRING')
        addLink(links, nodesById, separateNodeId, stemStringSlot, concatNode.id, 1, 'STRING')
        addLink(links, nodesById, separateNodeId, stemAudioSlot, saveNode.id, 0, 'AUDIO')
        addLink(links, nodesById, concatNode.id, 0, saveNode.id, 1, 'STRING')
      })
  })

  draft.utilityNodes
    .filter(node => !consumedValueSet.has(`utility:${node.id}`))
    .forEach((node, index) => {
      const sourceNodeId = utilityNodeIds.get(node.id)
      if (!sourceNodeId) return
      const outputDir = draft.saveTargets.find(item => item.source === `utility:${node.id}`)?.outputDir
        || safeWorkflowStemDir(node.kind)
      const baseX = (node.x || 384) + 242
      const baseY = (node.y || 118) + 36 + index * 42
      const saveNode = createNode({
        id: nextNodeId++,
        type: 'pymss_save_audio',
        pos: [baseX, baseY],
        size: [260, 150],
        flags: {},
        order: nodes.length,
        mode: 0,
        inputs: toComfyInputs([
          { name: 'audio', type: 'AUDIO', label: 'audio' },
          { name: 'filename', type: 'STRING', label: 'filename', shape: 7 },
          { name: 'output_format', type: 'COMBO', label: 'output_format' },
          { name: 'output_folder', type: 'STRING', label: 'output_folder' },
          { name: 'sample_rate', type: 'COMBO', label: 'sample_rate' },
          { name: 'wav_bit_depth', type: 'COMBO', label: 'wav_bit_depth' },
          { name: 'flac_bit_depth', type: 'COMBO', label: 'flac_bit_depth' },
          { name: 'mp3_bit_rate', type: 'COMBO', label: 'mp3_bit_rate' },
        ]),
        outputs: [],
        properties: { 'Node name for S&R': 'pymss_save_audio' },
        widgets_values: [
          draft.defaultFormat || 'wav',
          outputDir,
          '44100',
          'FLOAT',
          'PCM_24',
          '320k',
        ],
      })
      addLink(links, nodesById, sourceNodeId, 0, saveNode.id, 0, 'AUDIO')
    })

  const viewport = draft.ui.viewport || { x: 0, y: 0, k: 1 }
  const workflow: ComfyWorkflow = {
    id: createUuidLike(),
    revision: 0,
    last_node_id: Math.max(0, ...nodes.map(node => node.id)),
    last_link_id: Math.max(0, ...links.map(link => link[0])),
    nodes,
    links,
    groups: [],
    config: {},
    extra: {
      ds: {
        scale: viewport.k || 1,
        offset: [viewport.x || 0, viewport.y || 0],
      },
    },
    version: 0.4,
  }

  return workflow as Record<string, unknown>
}
