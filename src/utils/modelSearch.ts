/**
 * Shared free-text matching for model pickers.
 *
 * The model library and the separation page each grew their own version of this, and they drifted:
 * one searched the user's note but not the config's target instrument, the other the reverse. A
 * single implementation is what keeps "I can find it here but not there" from coming back.
 */

type SearchableModel = {
  name?: string
  aliases?: string[]
  architecture?: string
  modelType?: string | null
  targetStem?: string
  configTargetInstrument?: string
  category?: string
  categoryCn?: string
  classificationBasis?: string
}

/**
 * Whether `model` matches `query`.
 *
 * `note` is passed in rather than read from the model because notes are a local preference kept
 * beside the catalog entry, not part of it.
 *
 * An empty query matches everything, so callers can pass the raw input box value.
 */
export function matchesModelQuery(
  model: SearchableModel | null | undefined,
  query: string,
  note = '',
) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return true
  if (!model) return false
  const haystacks: Array<string | null | undefined> = [
    model.name,
    model.architecture,
    model.modelType,
    model.targetStem,
    model.configTargetInstrument,
    model.category,
    model.categoryCn,
    model.classificationBasis,
    note,
    ...(model.aliases || []),
  ]
  return haystacks.some((value) => String(value || '').toLowerCase().includes(needle))
}
