import { onBeforeUnmount, watch, type Ref } from 'vue'
import type { useEditorStore } from '@/stores/editor'

type EditorStore = ReturnType<typeof useEditorStore>

type UseEditorMixerViewOptions = {
  editor: EditorStore
  trackHeaderWidth: number
  scrollEl: Ref<HTMLElement | null>
  playbackLoop: Ref<boolean>
}

export function useEditorMixerView(options: UseEditorMixerViewOptions) {
  const { editor, trackHeaderWidth, scrollEl, playbackLoop } = options
  let resizeObserver: ResizeObserver | null = null

  function minZoomForViewport() {
    const viewportWidth = scrollEl.value?.clientWidth || 0
    if (!viewportWidth || editor.duration <= 0) return 4
    const laneViewportWidth = Math.max(1, viewportWidth - trackHeaderWidth)
    return Math.max(4, laneViewportWidth / Math.max(editor.duration, 0.01))
  }

  function constrainZoom(value: number) {
    const minZoom = minZoomForViewport()
    return Math.min(240, Math.max(minZoom, value))
  }

  function ensureMinimumZoom() {
    if (editor.duration <= 0) return
    const minZoom = minZoomForViewport()
    if (editor.pixelsPerSecond < minZoom) {
      editor.setZoom(minZoom)
    }
  }

  function zoomFit() {
    if (editor.duration <= 0) return
    editor.setZoom(constrainZoom(minZoomForViewport()))
  }

  function zoomAt(payload: { direction?: 'in' | 'out'; anchorRatio: number; deltaY?: number }) {
    const element = scrollEl.value
    const currentZoom = editor.pixelsPerSecond
    const wheelDelta = payload.deltaY ?? (payload.direction === 'in' ? -120 : 120)
    const zoomFactor = Math.exp(-wheelDelta * 0.0016)
    const nextZoom = constrainZoom(currentZoom * zoomFactor)

    if (!element) {
      editor.setZoom(nextZoom)
      return
    }

    const anchorX = element.scrollLeft + element.clientWidth * payload.anchorRatio - trackHeaderWidth
    const anchorTime = Math.max(0, anchorX / Math.max(1, currentZoom))
    editor.setZoom(nextZoom)
    requestAnimationFrame(() => {
      element.scrollLeft = Math.max(
        0,
        trackHeaderWidth + anchorTime * editor.pixelsPerSecond - element.clientWidth * payload.anchorRatio,
      )
    })
  }

  function updatePlaybackLoop(value: boolean) {
    playbackLoop.value = value
  }

  function handleMixerScrollReady(element: HTMLElement) {
    scrollEl.value = element
  }

  watch(
    () => scrollEl.value,
    (element, previous) => {
      if (resizeObserver && previous) {
        resizeObserver.unobserve(previous)
      }
      if (!element || typeof ResizeObserver === 'undefined') return
      resizeObserver = new ResizeObserver(() => {
        ensureMinimumZoom()
      })
      resizeObserver.observe(element)
      ensureMinimumZoom()
    },
    { immediate: true },
  )

  watch(
    () => editor.duration,
    () => {
      ensureMinimumZoom()
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  return {
    zoomFit,
    zoomAt,
    ensureMinimumZoom,
    zoomIn: () => editor.setZoom(constrainZoom(editor.pixelsPerSecond * 1.18)),
    zoomOut: () => editor.setZoom(constrainZoom(editor.pixelsPerSecond / 1.18)),
    updatePlaybackLoop,
    handleMixerScrollReady,
  }
}
