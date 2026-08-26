/**
 * useLiveAnnouncer — single-instance screen-reader live region announcer.
 *
 * Writes text into two visually-hidden `aria-live` regions managed by
 * `A11yProvider`:
 *   - polite  (announced when the reader is idle)
 *   - assertive (announced immediately, interrupts)
 *
 * Throttling rules:
 *   - Identical text within `DEDUP_MS` (500ms) is suppressed.
 *   - Progress-style messages (opt in via `progress: true`) are rate-limited to
 *     once per `PROGRESS_INTERVAL_MS` (1s) regardless of content.
 *
 * The regions themselves are created once in `A11yProvider.vue`; this module
 * caches references to them so any composable can announce without props.
 */

const POLITE_REGION_ID = 'a11y-live-polite'
const ASSERTIVE_REGION_ID = 'a11y-live-assertive'
const DEDUP_MS = 500
const PROGRESS_INTERVAL_MS = 1000

export type LivePoliteness = 'polite' | 'assertive'

export interface AnnounceOptions {
  /** Assertive announcements interrupt the screen reader; polite waits. */
  assertive?: boolean
  /**
   * Mark progress updates (percentages, "downloading…") so they are throttled
   * to at most once per second regardless of how often they fire.
   */
  progress?: boolean
}

interface LiveAnnouncer {
  announce: (text: string, options?: AnnounceOptions) => void
  announcePolite: (text: string, options?: Omit<AnnounceOptions, 'assertive'>) => void
  announceAssertive: (text: string, options?: Omit<AnnounceOptions, 'assertive'>) => void
}

function getRegion(id: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.getElementById(id)
}

/**
 * The live region must be cleared and re-set for some screen readers to
 * re-announce identical or near-identical text. We toggle the textContent
 * through an empty string on a microtask to force a re-announcement.
 */
function writeRegion(region: HTMLElement | null, text: string) {
  if (!region) return
  region.textContent = ''
  // Force the empty state to be observed before setting the new text.
  requestAnimationFrame(() => {
    if (region) region.textContent = text
  })
}

function createAnnouncer(): LiveAnnouncer {
  let lastText = ''
  let lastAt = 0
  let lastProgressAt = 0

  function announce(text: string, options: AnnounceOptions = {}) {
    const trimmed = (text || '').trim()
    if (!trimmed) return
    const now = Date.now()

    if (options.progress) {
      if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return
      lastProgressAt = now
    } else if (trimmed === lastText && now - lastAt < DEDUP_MS) {
      return
    }

    lastText = trimmed
    lastAt = now

    const region = getRegion(options.assertive ? ASSERTIVE_REGION_ID : POLITE_REGION_ID)
    writeRegion(region, trimmed)
  }

  return {
    announce,
    announcePolite: (text, options = {}) => announce(text, { ...options, assertive: false }),
    announceAssertive: (text, options = {}) => announce(text, { ...options, assertive: true }),
  }
}

// Singleton: one announcer for the whole app. The live regions live in the DOM
// (mounted by A11yProvider), so a module-level instance is safe.
let singleton: LiveAnnouncer | null = null

function getAnnouncer(): LiveAnnouncer {
  if (!singleton) singleton = createAnnouncer()
  return singleton
}

/** Public composable. Returns the singleton announcer. */
export function useLiveAnnouncer(): LiveAnnouncer {
  return getAnnouncer()
}

/** IDs used by A11yProvider to mount the live regions. Exported for symmetry. */
export const LIVE_REGION_IDS = {
  polite: POLITE_REGION_ID,
  assertive: ASSERTIVE_REGION_ID,
} as const
