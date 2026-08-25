import { onBeforeUnmount, ref, type Ref } from 'vue'

/**
 * useFocusTrap — keyboard focus containment for hand-written overlays.
 *
 * Naive UI's `n-modal` already traps focus correctly; this composable is for
 * the custom `role="dialog"` blocks scattered across the app that render
 * outside of `n-modal`. It records the element that had focus when `trap()`
 * was called, confines Tab/Shift+Tab to the container's focusable descendants,
 * fires an Esc callback, and restores focus to the trigger on `release()`.
 *
 * Usage:
 *   const overlayRef = ref<HTMLElement | null>(null)
 *   const trap = useFocusTrap(overlayRef, { onEsc: () => (open.value = false) })
 *   watch(open, (v) => v ? trap.trap() : trap.release())
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
].join(',')

export interface FocusTrapOptions {
  /** Called when the user presses Escape inside the trap. */
  onEsc?: () => void
  /**
   * Selector for the element to focus when the trap activates. Defaults to the
   * first focusable descendant of the container (or the container itself when
   * it has tabindex >= 0).
   */
  initialFocusSelector?: string
  /** When true, focus is restored to the pre-trap element on release. Default true. */
  restoreFocus?: boolean
}

export interface FocusTrapHandle {
  /** Activate the trap on the bound container. Safe to call repeatedly. */
  trap: () => void
  /** Deactivate the trap and (by default) return focus to the trigger. */
  release: () => void
  /** Whether the trap is currently active. */
  active: Ref<boolean>
}

function getFocusable(root: HTMLElement): HTMLElement[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  // Filter out elements that are not actually reachable: hidden, or inside a
  // closed details/inert subtree. A lightweight visibility check is enough for
  // the hand-written dialogs in this app.
  return nodes.filter((el) => {
    if (el.hasAttribute('inert')) return false
    if (el.closest('[inert]')) return false
    return el.offsetParent !== null || el === document.activeElement
      || getComputedStyle(el).position === 'fixed'
  })
}

export function useFocusTrap(
  target: Ref<HTMLElement | null>,
  options: FocusTrapOptions = {},
): FocusTrapHandle {
  const { onEsc, initialFocusSelector, restoreFocus = true } = options
  const active = ref(false)
  let previouslyFocused: HTMLElement | null = null
  let container: HTMLElement | null = null

  function onKeydown(event: KeyboardEvent) {
    if (!active.value || !container) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      onEsc?.()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = getFocusable(container)
    if (focusable.length === 0) {
      // Nothing to cycle to — keep focus on the container itself.
      event.preventDefault()
      container.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement as HTMLElement | null
    if (event.shiftKey) {
      if (current === first || !container.contains(current)) {
        event.preventDefault()
        last.focus()
      }
    } else {
      if (current === last || !container.contains(current)) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  function trap() {
    const el = target.value
    if (!el || active.value) return
    container = el
    active.value = true
    previouslyFocused = document.activeElement as HTMLElement | null

    // Make the container programmatically focusable so it can receive focus
    // even when it has no focusable children.
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '-1')
    }

    document.addEventListener('keydown', onKeydown, true)

    // Defer the initial focus to the next frame so any teleported content
    // (Naive UI portals) has a chance to mount.
    requestAnimationFrame(() => {
      if (!container) return
      let target2: HTMLElement | null = null
      if (initialFocusSelector) {
        target2 = container.querySelector<HTMLElement>(initialFocusSelector)
      }
      if (!target2) {
        const focusable = getFocusable(container)
        target2 = focusable[0] || container
      }
      target2.focus()
    })
  }

  function release() {
    if (!active.value) return
    active.value = false
    document.removeEventListener('keydown', onKeydown, true)
    if (restoreFocus && previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus()
    }
    previouslyFocused = null
    container = null
  }

  onBeforeUnmount(() => {
    release()
  })

  return {
    trap,
    release,
    active,
  }
}
