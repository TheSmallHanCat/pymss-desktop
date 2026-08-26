import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/**
 * useRovingTabindex — roving tabindex keyboard navigation for a container of
 * sibling items (toolbars, tab lists, track rows, tree views).
 *
 * Exactly one item carries `tabindex="0"` (the "active" one, reachable with a
 * single Tab from outside the container); every other item gets `tabindex="-1"`
 * and is reachable only via arrow/Home/End keys while the container has focus.
 *
 * This implements the WAI-ARIA patterns for:
 *   - horizontal (Left/Right)
 *   - vertical (Up/Down)
 *   - grid (all four arrows)
 *
 * Usage:
 *   const items = ref<HTMLElement[]>([])
 *   const rove = useRovingTabindex(items, { orientation: 'vertical' })
 *   // bind: :tabindex="rove.tabindexOf(el)"  @keydown="rove.onKeydown"
 *   rove.activate(2) // move roving focus to index 2
 */

export type RovingOrientation = 'horizontal' | 'vertical' | 'grid'

export interface RovingTabindexOptions {
  orientation?: RovingOrientation
  /** Whether to wrap arrow navigation from last→first and vice versa. Default true. */
  wrap?: boolean
  /** Called with the new active index whenever it changes (e.g. to sync selection). */
  onActivate?: (index: number) => void
}

export interface RovingTabindexHandle {
  /** Index of the item that currently holds tabindex=0. */
  activeIndex: Ref<number>
  /** Set tabindex for an item: 0 for the active one, -1 otherwise. */
  tabindexOf: (index: number) => 0 | -1
  /** Move the roving focus to `index` and focus the element. */
  activate: (index: number) => void
  /** Move focus by a delta (clamped/wrapped). */
  move: (delta: number) => void
  /** Keydown handler to attach to each item (or the container). */
  onKeydown: (event: KeyboardEvent, index: number) => void
}

function clampWrap(index: number, count: number, wrap: boolean): number {
  if (count === 0) return 0
  if (wrap) {
    return ((index % count) + count) % count
  }
  return Math.max(0, Math.min(index, count - 1))
}

export function useRovingTabindex(
  items: Ref<HTMLElement[] | ReadonlyArray<HTMLElement>>,
  options: RovingTabindexOptions = {},
): RovingTabindexHandle {
  const { orientation = 'horizontal', wrap = true, onActivate } = options
  const activeIndex = ref(0)

  function count() {
    return items.value.length
  }

  function focusIndex(index: number) {
    const list = items.value
    const clamped = clampWrap(index, count(), wrap)
    activeIndex.value = clamped
    const el = list[clamped]
    if (el && typeof el.focus === 'function') {
      el.focus()
    }
    onActivate?.(clamped)
  }

  function tabindexOf(index: number): 0 | -1 {
    return index === activeIndex.value ? 0 : -1
  }

  function activate(index: number) {
    focusIndex(index)
  }

  function move(delta: number) {
    focusIndex(activeIndex.value + delta)
  }

  function onKeydown(event: KeyboardEvent, index: number) {
    const isHorizontal = orientation === 'horizontal' || orientation === 'grid'
    const isVertical = orientation === 'vertical' || orientation === 'grid'
    const count2 = count()
    if (count2 === 0) return

    let handled = false
    switch (event.key) {
      case 'ArrowRight':
        if (isHorizontal) { move(1); handled = true }
        break
      case 'ArrowLeft':
        if (isHorizontal) { move(-1); handled = true }
        break
      case 'ArrowDown':
        if (isVertical) { move(1); handled = true }
        break
      case 'ArrowUp':
        if (isVertical) { move(-1); handled = true }
        break
      case 'Home':
        focusIndex(0); handled = true
        break
      case 'End':
        focusIndex(count2 - 1); handled = true
        break
      default:
        break
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // Keep activeIndex inside bounds when the item list shrinks.
  watch(() => items.value.length, (len) => {
    if (activeIndex.value >= len && len > 0) {
      activeIndex.value = len - 1
    } else if (len === 0) {
      activeIndex.value = 0
    }
  })

  onBeforeUnmount(() => {
    activeIndex.value = 0
  })

  return {
    activeIndex,
    tabindexOf,
    activate,
    move,
    onKeydown,
  }
}

/** Convenience: a plain array of tabindex values for a known item count. */
export function rovingTabindexList(activeIndex: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i === activeIndex ? 0 : -1))
}
