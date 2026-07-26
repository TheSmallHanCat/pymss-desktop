/**
 * Wraps an async producer so a caller never receives a result that was already in flight
 * when it asked.
 *
 * A call made while another run is active waits for that run to settle and then starts a
 * fresh one, so the value returned always reflects state at or after the moment of the call.
 * This matters for refreshes triggered by a mutation: returning the in-flight result would
 * hand back pre-change data and silently leave the UI stale.
 *
 * Runs are never concurrent — at most one is active at a time.
 */
export function createFreshRunner<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return async function runFresh(): Promise<T> {
    // Loop rather than branch: several callers can queue up behind the same run.
    while (inFlight) {
      await inFlight.catch(() => undefined)
    }
    const current = run()
    inFlight = current
    try {
      return await current
    } finally {
      // Guard the identity check so a later run's handle is never cleared by an earlier one.
      if (inFlight === current) inFlight = null
    }
  }
}
