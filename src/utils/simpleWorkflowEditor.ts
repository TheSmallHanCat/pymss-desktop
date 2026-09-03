import type { SimpleDraft } from '@/utils/workflowSimple'

export type SimpleConnectionSource = 'input' | `${string}.${string}`
export type SimpleConnectionTarget = `step:${string}` | `save` | `save:${string}.${string}`

export type SimpleConnectionCheck =
  | { ok: true }
  | { ok: false; reason: 'missing-source' | 'missing-target' | 'invalid-source' | 'forward-link' | 'self-link' | 'invalid-save-target' }

export function simpleStepInputTarget(stepId: string): `step:${string}` {
  return `step:${stepId}`
}

export function simpleSaveTarget(stepId: string, stem: string): `save:${string}.${string}` {
  return `save:${stepId}.${stem}`
}

export function simpleOutputRef(stepId: string, stem: string): `${string}.${string}` {
  return `${stepId}.${stem}`
}

export function simpleSourceStepId(source: string): string {
  const separator = source.lastIndexOf('.')
  return separator > 0 ? source.slice(0, separator) : ''
}

export function simpleSourceStem(source: string): string {
  const separator = source.lastIndexOf('.')
  return separator > 0 ? source.slice(separator + 1) : ''
}

function stepAndStem(draft: SimpleDraft, source: string) {
  if (source === 'input') return null
  const stepId = simpleSourceStepId(source)
  const stem = simpleSourceStem(source)
  const step = draft.steps.find(item => item.id === stepId)
  return step && stem && step.stems.some(item => item.toLowerCase() === stem.toLowerCase())
    ? { step, stem }
    : null
}

export function canConnectSimple(
  draft: SimpleDraft,
  source: string,
  target: SimpleConnectionTarget,
): SimpleConnectionCheck {
  const rawSource = source.trim()
  if (!rawSource) return { ok: false, reason: 'missing-source' }
  if (rawSource !== 'input' && !stepAndStem(draft, rawSource)) return { ok: false, reason: 'invalid-source' }

  if (target === 'step:') return { ok: false, reason: 'missing-target' }
  if (target.startsWith('step:')) {
    const targetId = target.slice('step:'.length)
    const targetIndex = draft.steps.findIndex(step => step.id === targetId)
    if (targetIndex < 0) return { ok: false, reason: 'missing-target' }
    if (rawSource === 'input') return { ok: true }
    const sourceId = simpleSourceStepId(rawSource)
    const sourceIndex = draft.steps.findIndex(step => step.id === sourceId)
    if (sourceIndex < 0) return { ok: false, reason: 'invalid-source' }
    if (sourceId === targetId) return { ok: false, reason: 'self-link' }
    if (sourceIndex >= targetIndex) return { ok: false, reason: 'forward-link' }
    return { ok: true }
  }

  if (target === 'save') {
    if (rawSource === 'input') return { ok: false, reason: 'invalid-save-target' }
    const sourceValue = stepAndStem(draft, rawSource)
    if (!sourceValue) return { ok: false, reason: 'invalid-save-target' }
    return { ok: true }
  }
  if (!target.startsWith('save:')) return { ok: false, reason: 'missing-target' }
  if (rawSource === 'input') return { ok: false, reason: 'invalid-save-target' }
  const value = target.slice('save:'.length)
  const targetStepId = simpleSourceStepId(value)
  const targetStem = simpleSourceStem(value)
  const sourceValue = stepAndStem(draft, rawSource)
  if (!sourceValue || targetStepId !== simpleSourceStepId(rawSource) || targetStem.toLowerCase() !== sourceValue.stem.toLowerCase()) {
    return { ok: false, reason: 'invalid-save-target' }
  }
  return { ok: true }
}

export function connectSimple(
  draft: SimpleDraft,
  source: string,
  target: SimpleConnectionTarget,
): SimpleConnectionCheck {
  const check = canConnectSimple(draft, source, target)
  if (!check.ok) return check
  if (target.startsWith('step:')) {
    const step = draft.steps.find(item => item.id === target.slice('step:'.length))
    if (step) step.input = source.trim()
    return check
  }
  const value = target === 'save' ? source.trim() : target.slice('save:'.length)
  const stepId = simpleSourceStepId(value)
  const stem = simpleSourceStem(value)
  const step = draft.steps.find(item => item.id === stepId)
  if (step) {
    step.save = { ...step.save, [stem]: step.save[stem] || 'Default' }
    step.outputNames = { ...step.outputNames, [stem]: step.outputNames[stem] || '%filename%_%stem%_%model%' }
  }
  return check
}

export function disconnectSimple(draft: SimpleDraft, target: SimpleConnectionTarget): boolean {
  if (target.startsWith('step:')) {
    const step = draft.steps.find(item => item.id === target.slice('step:'.length))
    if (!step) return false
    step.input = ''
    return true
  }
  if (!target.startsWith('save:')) return false
  const value = target.slice('save:'.length)
  const step = draft.steps.find(item => item.id === simpleSourceStepId(value))
  const stem = simpleSourceStem(value)
  if (!step || !stem || !(stem in step.save)) return false
  const nextSave = { ...step.save }
  delete nextSave[stem]
  step.save = nextSave
  return true
}

export function cleanupSimpleDraft(draft: SimpleDraft): void {
  const stepIndexes = new Map(draft.steps.map((step, index) => [step.id, index]))
  draft.steps.forEach((step, index) => {
    const input = step.input.trim()
    if (input !== 'input') {
      const sourceId = simpleSourceStepId(input)
      const sourceStem = simpleSourceStem(input)
      const sourceIndex = stepIndexes.get(sourceId)
      if (sourceIndex === undefined || sourceIndex >= index) step.input = ''
      else {
        const source = draft.steps[sourceIndex]
        if (!source.stems.some(stem => stem.toLowerCase() === sourceStem.toLowerCase())) step.input = ''
      }
    }
    const saveByStem = new Map(Object.entries(step.save || {}).map(([stem, value]) => [stem.toLowerCase(), value]))
    const nextSave: Record<string, string> = {}
    step.stems.forEach((stem) => {
      const value = saveByStem.get(stem.toLowerCase())
      if (value?.trim()) nextSave[stem] = value
    })
    step.save = nextSave
    const namesByStem = new Map(Object.entries(step.outputNames || {}).map(([stem, value]) => [stem.toLowerCase(), value]))
    const nextNames: Record<string, string> = {}
    step.stems.forEach((stem) => {
      const value = namesByStem.get(stem.toLowerCase())
      if (value?.trim()) nextNames[stem] = value
    })
    step.outputNames = nextNames
  })
}
