export function sortStemOutputsByOrder<T extends { stem: string }>(
  outputs: readonly T[],
  configuredOrder: readonly string[],
) {
  const ranks = new Map<string, number>()
  configuredOrder.forEach((stem, index) => {
    const key = stem.trim().toLowerCase()
    if (key && !ranks.has(key)) ranks.set(key, index)
  })
  if (!ranks.size) return [...outputs]

  return outputs
    .map((output, index) => ({ output, index }))
    .sort((left, right) => {
      const leftRank = ranks.get(left.output.stem.trim().toLowerCase())
      const rightRank = ranks.get(right.output.stem.trim().toLowerCase())
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank
      if (leftRank !== undefined) return -1
      if (rightRank !== undefined) return 1
      return left.index - right.index
    })
    .map(({ output }) => output)
}
