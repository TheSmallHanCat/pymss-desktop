type CategoryLikeModel = {
  category?: string
  categoryCn?: string
  primaryCategory?: string
  primaryCategoryCn?: string
}

export function getModelCategoryLabel(model: CategoryLikeModel | null | undefined, locale: string, fallback = '—') {
  if (!model) return fallback
  return locale === 'zh-CN'
    ? (model.primaryCategoryCn || model.categoryCn || model.primaryCategory || model.category || fallback)
    : (model.primaryCategory || model.category || model.primaryCategoryCn || model.categoryCn || fallback)
}

export function buildModelCategoryOptionsFromModels(
  models: CategoryLikeModel[],
  locale: string,
) {
  const seen = new Set<string>()
  const options: Array<{ label: string; value: string }> = []
  models.forEach((model) => {
    const value = String(model.primaryCategory || model.category || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    options.push({
      label: getModelCategoryLabel(model, locale, value),
      value,
    })
  })
  return options.sort((a, b) => a.label.localeCompare(b.label, locale === 'zh-CN' ? 'zh-CN' : 'en'))
}

export function buildModelCategoryOptionsFromPairs(
  categories: string[],
  categoriesCn: string[],
  locale: string,
  allLabel?: string,
) {
  const seen = new Set<string>()
  const items = categories
    .map((cat, i) => ({
      label: locale === 'zh-CN' && categoriesCn[i] ? categoriesCn[i] : cat,
      value: cat,
    }))
    .filter((item) => {
      if (!item.value || seen.has(item.value)) return false
      seen.add(item.value)
      return true
    })
  return allLabel ? [{ label: allLabel, value: '' }, ...items] : items
}
