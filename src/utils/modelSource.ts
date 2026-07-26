/** Which half of the model library to show. */
export type ModelSourceFilter = 'all' | 'catalog' | 'user'

type SourceLikeModel = {
  /** Absent on entries restored from a cache written before imported models existed. */
  source?: 'catalog' | 'user' | string
}

/**
 * Whether a model passes the source filter.
 *
 * 'catalog' is defined as "not imported" rather than `source === 'catalog'` on purpose: the
 * persisted model cache predates the field, so restored entries carry no source at all. Testing
 * for equality would make every cached model vanish from the catalog view until the next refetch.
 */
export function matchesModelSource(model: SourceLikeModel | null | undefined, filter: ModelSourceFilter) {
  if (filter === 'all') return true
  const imported = model?.source === 'user'
  return filter === 'user' ? imported : !imported
}
