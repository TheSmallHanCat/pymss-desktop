export type WindowCloseGuard = () => void | Promise<void>

const windowCloseGuards = new Map<WindowCloseGuard, number>()

export function registerWindowCloseGuard(guard: WindowCloseGuard, priority = 0) {
  windowCloseGuards.set(guard, priority)
  return () => windowCloseGuards.delete(guard)
}

export async function runWindowCloseGuards() {
  const guards = [...windowCloseGuards.entries()]
    .sort((left, right) => right[1] - left[1])
  for (const [guard] of guards) await guard()
}
