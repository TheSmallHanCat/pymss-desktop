import { getCurrentWebview } from '@tauri-apps/api/webview'

export const DEFAULT_SCALE_FACTOR = 1
export const SCALE_FACTOR_MIN = 0.75
export const SCALE_FACTOR_MAX = 1.5
export const SCALE_FACTOR_STEP = 0.05

export function normalizeScaleFactor(value: unknown, fallback = DEFAULT_SCALE_FACTOR) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized)) return fallback
  return Math.min(SCALE_FACTOR_MAX, Math.max(SCALE_FACTOR_MIN, normalized))
}

export async function applyScaleFactor(value: number) {
  await getCurrentWebview().setZoom(normalizeScaleFactor(value))
}
