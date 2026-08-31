export type StemOutput = { stem: string; path: string }

function fileName(path: string) {
  return String(path || '').split(/[/\\]/).pop() || ''
}

function stripExtension(value: string) {
  return value.replace(/\.[^/.\\]+$/, '')
}

/**
 * Resolve the display stem used by the result and separation pages.
 *
 * Graph SaveAudio nodes only return file paths, and their default names may
 * include the input basename (for example `song_vocals.wav`). Strip that
 * stable prefix when it is present while preserving custom workflow names.
 */
export function stemFromOutputPath(path: string, inputPath?: string) {
  let stem = stripExtension(fileName(path)).trim()
  const inputStem = stripExtension(fileName(inputPath || '')).trim()
  const prefix = inputStem ? `${inputStem}_` : ''
  if (prefix && stem.toLowerCase().startsWith(prefix.toLowerCase())) {
    stem = stem.slice(prefix.length).trim()
  }
  return stem || 'output'
}

/**
 * Normalize output metadata from both worker generations. Older workflow
 * workers returned `{ path, name }` without the `stem` field used by the
 * single-separation result contract.
 */
export function normalizeStemOutputs(value: unknown, inputPath?: string): StemOutput[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const raw = item as Record<string, unknown>
    const path = String(raw.path || '').trim()
    if (!path) return []
    const explicitStem = String(raw.stem || '').trim()
    const nameHint = String(raw.name || '').trim()
    return [{
      stem: explicitStem || stemFromOutputPath(nameHint || path, inputPath),
      path,
    }]
  })
}
