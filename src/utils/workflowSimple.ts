import {
  detectWorkflowFormat,
  hasInvalidSimpleStructure,
  isWorkflowSaveNodeType,
  isWorkflowSeparationNodeType,
} from '@/workflows/formats'
import { analyzeWorkflowInputs } from '@/utils/workflowInputs'

/**
 * Simple creator <-> pymss YAML workflow adapter.
 *
 * The simple creator edits a linear list of steps (one model per step, each
 * step consumes `input` or a previous step's stem, and saves chosen stems).
 * We now store this directly as a pymss YAML workflow dict:
 *
 *   { version: 1, defaults: { device, output_format, inference_params },
 *     steps: [ { id, model, input, stems, save, inference_params, ... } ] }
 *
 * pymss.workflow.load_workflow_data parses this and compile_workflow_to_dag
 * builds the DAG that run_dag executes. No more v2 graph schema in between.
 */
export type SimpleWorkflowSavePayload = {
  id?: string
  name: string
  description: string
  definition: Record<string, unknown>
  expectedUpdatedAt?: number
}

export type SimpleWorkflowReasonCode =
  | 'graph_workflow'
  | 'advanced_parameters'
  | 'invalid_definition'

export type PymssYamlStep = {
  id: string
  model: string
  input: string
  stems: string[]
  save: Record<string, unknown>
  inference_params?: Record<string, unknown>
  model_type?: string
  model_path?: string
  config_path?: string
  model_dir?: string
  device?: string
  output_format?: string
  use_tta?: boolean
}

export type PymssYamlWorkflow = {
  version: number
  defaults: {
    device: string
    output_format: string
    model_dir?: string | null
    inference_params?: Record<string, unknown>
  }
  steps: PymssYamlStep[]
}

export type SimpleStepDraft = {
  id: string
  model: string
  input: string
  stems: string[]
  save: Record<string, string>
}

export type SimpleDraft = {
  defaultDevice: string
  defaultFormat: string
  defaultNormalize: boolean
  steps: SimpleStepDraft[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

export type ComfyOverview = {
  nodeCount: number
  linkCount: number
  separateCount: number
  outputCount: number
  models: string[]
  inputSlots: string[]
}

/** Read-only overview of a comfy-mss graph for the workflows page: node /
 * separation / output counts, referenced models, and runtime input slots
 * (load nodes with an input_name widget — pymss >= 2.1.2 contract). */
export function analyzeComfyOverview(definition: unknown): ComfyOverview | null {
  if (!isRecord(definition) || !Array.isArray(definition.nodes)) return null
  const nodes = definition.nodes as any[]
  const stripPrefix = (raw: string) => raw.replace(/^\[[^\]]*\]\s*/, '').trim()
  const models: string[] = []
  let separateCount = 0
  let outputCount = 0
  for (const node of nodes) {
    const type = String(node?.type || '')
    if (isWorkflowSeparationNodeType(type)) {
      separateCount += 1
      const raw = String(node.widgets_values?.[0] || '').trim()
      const model = stripPrefix(raw)
      if (model && !models.includes(model)) models.push(model)
    }
    if (isWorkflowSaveNodeType(type)) outputCount += 1
  }
  return {
    nodeCount: nodes.length,
    linkCount: Array.isArray(definition.links) ? definition.links.length : 0,
    separateCount,
    outputCount,
    models,
    inputSlots: analyzeWorkflowInputs(definition).slots.map(slot => slot.name),
  }
}

/** Read a pymss YAML workflow dict into the editor's draft shape. */
export function hydrateSimpleWorkflow(definition: unknown): SimpleDraft {
  if (!isRecord(definition) || !Array.isArray(definition.steps)) {
    return { defaultDevice: 'auto', defaultFormat: 'wav', defaultNormalize: false, steps: [] }
  }
  const defaults = isRecord(definition.defaults) ? definition.defaults : {}
  const inference = isRecord(defaults.inference_params) ? defaults.inference_params : {}
  const steps = (definition.steps as any[])
    .filter(isRecord)
    .map((raw, index): SimpleStepDraft => ({
      id: String(raw.id || `step${index + 1}`),
      model: String(raw.model || ''),
      input: String(raw.input || 'input'),
      stems: raw.stems == null
        ? []
        : (Array.isArray(raw.stems) ? raw.stems : [raw.stems]).map(s => String(s)),
      save: isRecord(raw.save) ? Object.fromEntries(Object.entries(raw.save).map(([k, v]) => [k, String(v)])) : {},
    }))
  return {
    defaultDevice: String(defaults.device || 'auto'),
    defaultFormat: String(defaults.output_format || 'wav'),
    defaultNormalize: Boolean(inference.normalize),
    steps,
  }
}

/** Build a pymss YAML workflow dict from the editor draft. */
export function buildSimpleWorkflowDefinition(draft: SimpleDraft): PymssYamlWorkflow {
  return {
    version: 1,
    defaults: {
      device: draft.defaultDevice || 'auto',
      output_format: draft.defaultFormat || 'wav',
      inference_params: { normalize: Boolean(draft.defaultNormalize) },
    },
    steps: draft.steps.map((step, index) => ({
      id: step.id || `step${index + 1}`,
      model: step.model,
      input: step.input || 'input',
      stems: [...step.stems],
      save: { ...step.save },
    })),
  }
}

export function createStepDraft(index: number): SimpleStepDraft {
  return {
    id: `step${index + 1}`,
    model: '',
    input: index === 0 ? 'input' : '',
    stems: [],
    save: {},
  }
}

/** Split a catalog model's instruments/target stem into a deduped stem list. */
export function parseModelStems(value?: unknown): string[] {
  const seen = new Set<string>()
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\uFF0C;\uFF1B/|\n]+/)
  return rawItems
    .map(item => String(item || '').trim().replace(/^[\s"'\[\](){}]+|[\s"'\[\](){}]+$/g, ''))
    .filter((item) => {
      if (!item) return false
      const key = item.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** Stems offered for a model, derived from the catalog entry fields. */
export function configuredStemsFor(model?: ModelEntryLike): string[] {
  return parseModelStems(model?.configInstruments || model?.configTargetInstrument || model?.targetStem)
}

type ModelEntryLike = {
  configInstruments?: string
  configTargetInstrument?: string
  targetStem?: string
}

const SIMPLE_DEFINITION_FIELDS = new Set(['version', 'defaults', 'steps'])
const SIMPLE_DEFAULT_FIELDS = new Set(['device', 'output_format', 'inference_params'])
const SIMPLE_INFERENCE_FIELDS = new Set(['normalize'])
const SIMPLE_STEP_FIELDS = new Set(['id', 'model', 'input', 'stems', 'save'])

function hasUnsupportedFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).some(key => !allowed.has(key))
}

function usesAdvancedSimpleParameters(definition: Record<string, unknown>): boolean {
  if (hasUnsupportedFields(definition, SIMPLE_DEFINITION_FIELDS)) return true
  const defaults = isRecord(definition.defaults) ? definition.defaults : {}
  if (hasUnsupportedFields(defaults, SIMPLE_DEFAULT_FIELDS)) return true

  const inference = isRecord(defaults.inference_params) ? defaults.inference_params : {}
  if (hasUnsupportedFields(inference, SIMPLE_INFERENCE_FIELDS)) return true

  return (definition.steps as unknown[]).some((value) => {
    if (!isRecord(value) || hasUnsupportedFields(value, SIMPLE_STEP_FIELDS)) return true
    if (!isRecord(value.save)) return value.save != null
    return Object.values(value.save).some(target => typeof target !== 'string')
  })
}

/**
 * The simple creator deliberately edits only the compact subset represented by
 * {@link SimpleDraft}. Definitions with per-step overrides or custom model
 * paths must be promoted instead of being re-saved through a lossy form.
 */
export function analyzeSimpleWorkflow(definition: unknown): { editable: boolean; reasonCodes: SimpleWorkflowReasonCode[] } {
  const format = detectWorkflowFormat(definition)
  if (format === 'graph') return { editable: false, reasonCodes: ['graph_workflow'] }
  if (format !== 'simple' || !isRecord(definition)) {
    return { editable: false, reasonCodes: ['invalid_definition'] }
  }
  if (hasInvalidSimpleStructure(definition)) {
    return { editable: false, reasonCodes: ['invalid_definition'] }
  }
  if (usesAdvancedSimpleParameters(definition)) {
    return { editable: false, reasonCodes: ['advanced_parameters'] }
  }
  return { editable: true, reasonCodes: [] }
}

export function resolveWorkflowOpenMode(definition: unknown): 'simple' | 'advanced' {
  return analyzeSimpleWorkflow(definition).editable ? 'simple' : 'advanced'
}
