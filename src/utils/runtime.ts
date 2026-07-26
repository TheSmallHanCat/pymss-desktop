import type { InstalledRuntime, RuntimeBackend, RuntimeInfo } from '@/stores/app'

/** Approximate download size of each backend's dependency set, shown before installing. */
const RUNTIME_SIZE_HINTS: Record<RuntimeBackend, string> = {
  cpu: '~800 MB',
  cuda: '~3 GB',
  rocm: '~5 GB',
  mlx: '~600 MB',
}

export function runtimeSizeHint(backend: RuntimeBackend | string) {
  return RUNTIME_SIZE_HINTS[backend as RuntimeBackend] || '~1 GB'
}

const RUNTIME_BACKEND_LABELS: Record<RuntimeBackend, string> = {
  cpu: 'CPU',
  cuda: 'NVIDIA CUDA',
  rocm: 'AMD ROCm',
  mlx: 'Apple MLX',
}

export function isKnownRuntimeBackend(backend: string): backend is RuntimeBackend {
  return Object.prototype.hasOwnProperty.call(RUNTIME_BACKEND_LABELS, backend)
}

export function runtimeBackendLabel(backend: RuntimeBackend | string | null | undefined) {
  const key = String(backend || '')
  return isKnownRuntimeBackend(key) ? RUNTIME_BACKEND_LABELS[key] : key.toUpperCase()
}

/**
 * Whether the environment's accelerator is usable.
 * The worker reports `acceleratorAvailable` from `torch.cuda.is_available()`, which is always
 * false on macOS, so MLX has to be judged by its package instead (matching the worker's own
 * readiness check in worker_bootstrap.py).
 */
export function runtimeAcceleratorReady(env: InstalledRuntime | undefined, backend: RuntimeBackend | string) {
  if (!env) return false
  if (backend === 'mlx') return Boolean(env.packages?.mlx)
  return Boolean(env.acceleratorAvailable)
}

/**
 * Which backends this machine can run.
 * Prefers what the worker reports (`sys.platform` / `platform.machine()`): WKWebView pins
 * `navigator.platform` to "MacIntel" even on Apple Silicon, so the browser can never identify
 * an arm64 Mac and MLX would stay invisible. navigator is only a pre-detection fallback.
 */
export function detectRuntimePlatform(info: RuntimeInfo | null | undefined) {
  const reported = String(info?.platform || '')
  if (reported) {
    const machine = String(info?.machine || '').toLowerCase()
    const isMac = reported === 'darwin'
    return { isMac, isAppleSilicon: isMac && (machine.includes('arm') || machine.includes('aarch64')) }
  }
  const isMac = /Mac/i.test(navigator.platform)
  return { isMac, isAppleSilicon: isMac && /arm/i.test(navigator.platform) }
}

/**
 * The backend this machine should be running, from GPU vendor plus platform.
 *
 * Returns null when nothing can be recommended — callers must treat that as "no opinion" and
 * still offer every backend. Detection can miss a card, and hiding options on a false negative
 * would leave a user unable to install the backend they actually need.
 */
export function recommendedRuntimeBackend(info: RuntimeInfo | null | undefined): RuntimeBackend | null {
  const { isMac, isAppleSilicon } = detectRuntimePlatform(info)
  if (isMac) return isAppleSilicon ? 'mlx' : 'cpu'
  const vendors = info?.gpuVendors
  if (!vendors?.length) return null
  // A discrete NVIDIA card wins over an AMD integrated one when both are present.
  if (vendors.includes('nvidia')) return 'cuda'
  // ROCm is Windows-only in the manifest; recommending it elsewhere would fail at install time.
  if (vendors.includes('amd')) return String(info?.platform || '') === 'win32' ? 'rocm' : 'cpu'
  return 'cpu'
}

export type RuntimeManifestStatus = 'current' | 'outdated' | 'unknown'

/**
 * Whether an environment was built from the dependency manifest the app ships today.
 *
 * Reports a plain mismatch rather than trying to order the versions: after an app downgrade
 * the environment can legitimately be newer, and "reinstall to match" is the right advice
 * either way. 'unknown' covers environments that never recorded a version — the bootstrap
 * interpreter, mainly — where no honest claim can be made.
 */
export function runtimeManifestStatus(
  env: InstalledRuntime | undefined,
  currentManifestVersion: string | undefined,
): RuntimeManifestStatus {
  const expected = String(currentManifestVersion || '')
  const actual = String(env?.manifestVersion || '')
  if (!expected || !actual) return 'unknown'
  return actual === expected ? 'current' : 'outdated'
}

/** True when the active environment ships with the app and there is nothing useful to switch to. */
export function isBuiltInRuntimeSource(source: string | undefined) {
  return source === 'bundled' || source === 'preinstalled'
}
