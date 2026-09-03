export type WorkflowFormat = 'simple' | 'graph' | 'unknown'

export const WORKFLOW_FORMAT_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Detect the editor format from the persisted definition. Existing workflow
 * records predate explicit format metadata, so the definition remains the
 * authoritative migration source.
 */
export function detectWorkflowFormat(definition: unknown): WorkflowFormat {
  if (!isRecord(definition)) return 'unknown'
  const hasSteps = Array.isArray(definition.steps)
  // pymss accepts graph definitions without a `links` field (or with null)
  // and treats them as graphs without connections.
  const hasNodes = Array.isArray(definition.nodes)
    && (definition.links == null || Array.isArray(definition.links))
  if (hasSteps === hasNodes) return 'unknown'
  return hasSteps ? 'simple' : 'graph'
}

export function isSimpleWorkflowDefinition(definition: unknown): definition is Record<string, unknown> {
  return detectWorkflowFormat(definition) === 'simple'
}

export function isGraphWorkflowDefinition(definition: unknown): definition is Record<string, unknown> {
  return detectWorkflowFormat(definition) === 'graph'
}

/**
 * Validate the structural parts shared by the simple editor and runtime.
 * Format detection guarantees a `steps` array, while this check keeps malformed
 * imported values from reaching hydration or the worker with a misleading
 * "no outputs" error (for example `defaults: "cuda"`).
 */
export function hasInvalidSimpleStructure(definition: Record<string, unknown>): boolean {
  if (!Array.isArray(definition.steps)) return true
  if (definition.studio != null && !isRecord(definition.studio)) return true
  if (isRecord(definition.studio)) {
    if (definition.studio.editor !== 'simple') return true
    if (definition.studio.viewport != null && !isRecord(definition.studio.viewport)) return true
    if (definition.studio.nodes != null && !isRecord(definition.studio.nodes)) return true
  }
  if (definition.defaults != null && !isRecord(definition.defaults)) return true
  const defaults = isRecord(definition.defaults) ? definition.defaults : {}
  if (defaults.inference_params != null && !isRecord(defaults.inference_params)) return true
  const hasInvalidStep = (definition.steps as unknown[]).some((value) => {
    if (!isRecord(value)) return true
    if (value.inference_params != null && !isRecord(value.inference_params)) return true
    if (value.save != null && !isRecord(value.save)) return true
    return false
  })
  if (hasInvalidStep) return true
  // The pymss YAML parser accepts exactly version 1. Rejecting unsupported
  // versions here prevents the simple editor from rewriting a newer schema
  // as version 1 on save and gives the run screen a deterministic error.
  return definition.steps.length > 0 && definition.version !== WORKFLOW_FORMAT_VERSION
}

export function isWorkflowSeparationNodeType(value: unknown): boolean {
  const type = String(value || '').toLowerCase()
  return type.endsWith('_separate') || type.endsWith('_separate_list')
}

const WORKFLOW_SAVE_NODE_TYPES = new Set([
  'pymss_save_audio',
  'SaveAudio',
  'SaveAudioMP3',
  'SaveAudioOpus',
  'SaveAudioAdvanced',
])

export function isWorkflowSaveNodeType(value: unknown): boolean {
  return WORKFLOW_SAVE_NODE_TYPES.has(String(value || ''))
}

const LEGACY_SIMPLE_SAVE_FILENAME = /\.(?:wav|flac|mp3|m4a)$/iu
const DEFAULT_SIMPLE_OUTPUT_NAME = '%filename%_%stem%_%model%'

/**
 * Early Studio builds labelled the YAML save-map value as a filename even
 * though pymss defines it as an output subdirectory. Migrate generated values
 * to the current flat-file representation while leaving ordinary folder
 * names (which do not have an audio suffix) untouched.
 */
export function normalizeSimpleWorkflowDefinition(
  definition: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(definition.steps)) return definition
  let changed = false
  const base = { ...definition }
  if (Object.prototype.hasOwnProperty.call(base, 'save_intermediate')) {
    // Saving is represented by explicit links to the save node. Drop the
    // retired global switch when an older definition is loaded.
    delete base.save_intermediate
    changed = true
  }
  const defaults = isRecord(base.defaults) ? base.defaults : {}
  const outputFormat = typeof defaults.output_format === 'string' && defaults.output_format.trim()
    ? defaults.output_format.trim().toLowerCase()
    : 'wav'
  const steps = (definition.steps as unknown[]).map((value) => {
    if (!isRecord(value) || !isRecord(value.save)) return value
    let saveChanged = false
    const outputNames = isRecord(value.output_names) ? { ...value.output_names } : {}
    const save = Object.fromEntries(Object.entries(value.save).map(([stem, target]) => {
      if (typeof target !== 'string') return [stem, target]
      const trimmed = target.trim()
      if (LEGACY_SIMPLE_SAVE_FILENAME.test(trimmed)) {
        saveChanged = true
        outputNames[stem] = trimmed
        return [stem, 'Default']
      }
      // The current creator used the stem itself as the directory name. Treat
      // that generated convention as a flat output and preserve custom names.
      if (trimmed.localeCompare(stem, undefined, { sensitivity: 'accent' }) === 0) {
        saveChanged = true
        outputNames[stem] = outputNames[stem] || `${DEFAULT_SIMPLE_OUTPUT_NAME}.${outputFormat}`
        return [stem, 'Default']
      }
      return [stem, target]
    }))
    if (!saveChanged) return value
    changed = true
    return { ...value, save, output_names: outputNames }
  })
  return changed ? { ...base, steps } : definition
}

/**
 * Upgrade graph details whose serialized widget layout changed between pymss
 * versions. The returned definition is a copy only when a migration is needed.
 */
export function normalizeGraphWorkflowDefinition(
  definition: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(definition.nodes)) return definition

  let changed = false
  const nodes = definition.nodes.map((value) => {
    if (!isRecord(value)) return value
    const type = String(value.type || '')
    if (type !== 'custom_mss_separate' && type !== 'custom_mss_separate_list') return value

    const widgets = value.widgets_values
    if (!Array.isArray(widgets)) return value
    const hasLegacyDownloadFields = typeof widgets[3] === 'boolean'
      && typeof widgets[4] === 'string'
    if (!hasLegacyDownloadFields) return value

    changed = true
    return {
      ...value,
      // Legacy layout:
      // [model, model_type, device, download_missing, source, device_ids, debug]
      // Current layout:
      // [model, model_type, device, device_ids, debug]
      widgets_values: [widgets[0], widgets[1], widgets[2], widgets[5], widgets[6] ?? false],
    }
  })

  return changed ? { ...definition, nodes } : definition
}
