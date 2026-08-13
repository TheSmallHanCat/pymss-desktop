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

/** Legacy: simple-mode incompatibility reasons. Now always empty since simple
 * workflows are stored as pymss YAML (the source format). Kept for callers. */
export type SimpleWorkflowReasonCode =
  | 'utility_nodes'
  | 'unsupported_nodes'
  | 'custom_model_type'
  | 'comfy_metadata'
  | 'invalid_graph'
  | 'custom_save_behavior'

export type PymssYamlStep = {
  id: string
  model: string
  input: string
  stems: string[]
  save: Record<string, string>
  inference_params?: Record<string, unknown>
  model_type?: string
  model_path?: string
  config_path?: string
  device?: string
  output_format?: string
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
      stems: Array.isArray(raw.stems) ? raw.stems.map(s => String(s)) : [],
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

/** A simple workflow is always "editable" in simple mode now — it IS the source
 * format. Kept for callers that still ask. */
export function analyzeSimpleWorkflow(_definition: unknown): { editable: boolean; reasonCodes: SimpleWorkflowReasonCode[] } {
  return { editable: true, reasonCodes: [] }
}

export function resolveWorkflowOpenMode(_definition: unknown): 'simple' | 'advanced' {
  return 'simple'
}
