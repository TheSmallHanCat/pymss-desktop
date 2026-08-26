import { useMessage } from 'naive-ui'
import { useLiveAnnouncer } from '@/composables/useLiveAnnouncer'

/**
 * useAnnouncedMessage — a drop-in replacement for Naive UI's `useMessage`
 * that also announces every toast to screen readers via the live region.
 *
 * Usage:
 *   const message = useAnnouncedMessage()
 *   message.success('Saved')  // shows a toast AND announces to SR
 *
 * New code should use this instead of `useMessage`. Existing call sites can
 * be migrated incrementally — the interface is identical.
 */
export function useAnnouncedMessage() {
  const raw = useMessage()
  const announcer = useLiveAnnouncer()

  function announce(text: string, assertive = false) {
    const content = String(text || '').replace(/<[^>]*>/g, '').trim()
    if (!content) return
    if (assertive) announcer.announceAssertive(content)
    else announcer.announcePolite(content)
  }

  // Wrap the primary methods so each call also announces to screen readers.
  function wrapMethod(methodName: 'success' | 'error' | 'warning' | 'info' | 'loading', assertive = false) {
    return function (...args: any[]) {
      const fn = (raw as any)[methodName] as Function
      const result = fn.apply(raw, args as any)
      if (typeof args[0] === 'string') announce(args[0], assertive)
      return result
    }
  }

  const wrapped = {
    success: wrapMethod('success'),
    error: wrapMethod('error', true),
    warning: wrapMethod('warning', true),
    info: wrapMethod('info'),
    loading: wrapMethod('loading'),
  }

  // Return a proxy that uses wrapped methods for the primary API and falls
  // back to the raw message instance for everything else (destroyAll, etc.).
  return new Proxy(wrapped, {
    get(target, prop, receiver) {
      if (prop in target) return (target as any)[prop]
      const value = (raw as any)[prop]
      return typeof value === 'function' ? value.bind(raw) : value
    },
  }) as typeof raw
}
