import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeRuntimeEnvironment,
  detectRuntimePlatform,
  isKnownRuntimeBackend,
  preferredInstalledRuntimeBackend,
  recommendedRuntimeBackend,
  runtimeAcceleratorReady,
  runtimeBackendLabel,
  runtimeCoreUpdateAvailable,
  runtimeEnvironmentForBackend,
  runtimeManifestStatus,
  runtimeSizeHint,
} from '../src/utils/runtime.ts'

test('platform detection prefers the worker report over navigator', () => {
  // WKWebView pins navigator.platform to "MacIntel" even on Apple Silicon, so the worker's
  // platform.machine() is the only thing that can identify an arm64 Mac.
  assert.deepEqual(
    detectRuntimePlatform({ platform: 'darwin', machine: 'arm64' }),
    { isMac: true, isAppleSilicon: true },
  )
  assert.deepEqual(
    detectRuntimePlatform({ platform: 'darwin', machine: 'x86_64' }),
    { isMac: true, isAppleSilicon: false },
  )
  assert.deepEqual(
    detectRuntimePlatform({ platform: 'win32', machine: 'AMD64' }),
    { isMac: false, isAppleSilicon: false },
  )
})

test('platform detection accepts aarch64 as Apple Silicon', () => {
  assert.equal(detectRuntimePlatform({ platform: 'darwin', machine: 'aarch64' }).isAppleSilicon, true)
})

test('platform detection falls back to navigator before the worker has reported', () => {
  const original = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Win32' }, configurable: true })
  try {
    assert.deepEqual(detectRuntimePlatform(null), { isMac: false, isAppleSilicon: false })
    assert.deepEqual(detectRuntimePlatform({}), { isMac: false, isAppleSilicon: false })
  } finally {
    if (original === undefined) delete (globalThis as { navigator?: unknown }).navigator
    else Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
  }
})

test('accelerator readiness judges MLX by its package, not by CUDA availability', () => {
  // The worker fills acceleratorAvailable from torch.cuda.is_available(), which is always
  // false on macOS — MLX would otherwise always render as unavailable.
  assert.equal(runtimeAcceleratorReady({ acceleratorAvailable: false, packages: { mlx: true } }, 'mlx'), true)
  assert.equal(runtimeAcceleratorReady({ acceleratorAvailable: false, packages: { mlx: false } }, 'mlx'), false)
  assert.equal(runtimeAcceleratorReady({ acceleratorAvailable: false }, 'mlx'), false)
})

test('accelerator readiness uses the reported flag for non-MLX backends', () => {
  assert.equal(runtimeAcceleratorReady({ acceleratorAvailable: true }, 'cuda'), true)
  assert.equal(runtimeAcceleratorReady({ acceleratorAvailable: false }, 'cuda'), false)
  // A backend with no installed environment has no accelerator to report on.
  assert.equal(runtimeAcceleratorReady(undefined, 'cuda'), false)
})

test('active runtime environment follows active-runtime state', () => {
  const info = {
    installedBackend: 'cuda',
    installState: { backend: 'cuda', pythonPath: 'package/python.exe' },
    installedEnvironments: [
      { backend: 'cpu', pythonPath: 'user/cpu/python.exe' },
      { backend: 'cuda', pythonPath: 'package/python.exe', torchBackend: 'cuda' },
    ],
    torchBackend: 'cuda',
  }
  assert.equal(activeRuntimeEnvironment(info)?.backend, 'cuda')
  assert.equal(preferredInstalledRuntimeBackend(info), 'cuda')
})

test('preferred installed backend falls back to the only installed environment', () => {
  assert.equal(preferredInstalledRuntimeBackend({
    installedEnvironments: [{ backend: 'cpu', pythonPath: 'user/cpu/python.exe' }],
  }), 'cpu')
})

test('preferred installed backend avoids guessing when several inactive environments exist', () => {
  assert.equal(preferredInstalledRuntimeBackend({
    installedEnvironments: [
      { backend: 'cpu', pythonPath: 'user/cpu/python.exe' },
      { backend: 'cuda', pythonPath: 'user/cuda/python.exe' },
    ],
  }), null)
})

test('runtime environment lookup prefers the active source when backend appears twice', () => {
  const info = {
    installedBackend: 'cuda',
    installState: { backend: 'cuda', pythonPath: 'package/python.exe' },
    installedEnvironments: [
      { backend: 'cuda', pythonPath: 'user/python.exe' },
      { backend: 'cuda', pythonPath: 'package/python.exe' },
    ],
  }
  assert.equal(runtimeEnvironmentForBackend(info, 'cuda')?.pythonPath, 'package/python.exe')
})

test('runtime core update is available when pymss-core alone is behind', () => {
  assert.equal(runtimeCoreUpdateAvailable({ pymssVersion: '2.0.19', pymssCoreVersion: '0.1.4' }, '2.0.19', '0.1.6'), true)
})

test('runtime core update is hidden for non-updatable bootstrap runtimes', () => {
  assert.equal(runtimeCoreUpdateAvailable({ pymssVersion: '2.0.18', pymssCoreVersion: '0.1.4', coreUpdateSupported: false }, '2.0.19', '0.1.6'), false)
})

test('runtime core update is hidden when the installed version is newer than PyPI', () => {
  assert.equal(runtimeCoreUpdateAvailable({ pymssVersion: '2.0.20', pymssCoreVersion: '0.1.7' }, '2.0.19', '0.1.6'), false)
})

test('backend labels stay readable for unknown backends', () => {
  assert.equal(runtimeBackendLabel('mlx'), 'Apple MLX')
  assert.equal(runtimeBackendLabel('cuda'), 'NVIDIA CUDA')
  assert.equal(runtimeBackendLabel('rocm'), 'AMD ROCm')
  assert.equal(runtimeBackendLabel('cpu'), 'CPU')
  assert.equal(runtimeBackendLabel('something-else'), 'SOMETHING-ELSE')
  assert.equal(runtimeBackendLabel(null), '')
})

test('backend recognition does not leak Object.prototype keys', () => {
  assert.equal(isKnownRuntimeBackend('mlx'), true)
  assert.equal(isKnownRuntimeBackend('toString'), false)
  assert.equal(isKnownRuntimeBackend('constructor'), false)
})

test('GPU vendor decides the recommended backend', () => {
  assert.equal(recommendedRuntimeBackend({ platform: 'win32', gpuVendors: ['nvidia'] }), 'cuda')
  assert.equal(recommendedRuntimeBackend({ platform: 'win32', gpuVendors: ['amd'] }), 'rocm')
  assert.equal(recommendedRuntimeBackend({ platform: 'win32', gpuVendors: ['intel'] }), 'cpu')
})

test('a discrete NVIDIA card outranks an integrated AMD one', () => {
  assert.equal(recommendedRuntimeBackend({ platform: 'win32', gpuVendors: ['amd', 'nvidia'] }), 'cuda')
})

test('ROCm is never recommended off Windows', () => {
  // The manifest restricts rocm to win32; the installer rejects it anywhere else.
  assert.equal(recommendedRuntimeBackend({ platform: 'linux', gpuVendors: ['amd'] }), 'cpu')
  assert.equal(recommendedRuntimeBackend({ platform: 'linux', gpuVendors: ['nvidia'] }), 'cuda')
})

test('macOS is decided by architecture, not by GPU vendor', () => {
  assert.equal(recommendedRuntimeBackend({ platform: 'darwin', machine: 'arm64' }), 'mlx')
  assert.equal(recommendedRuntimeBackend({ platform: 'darwin', machine: 'x86_64' }), 'cpu')
})

test('undetectable hardware yields no recommendation at all', () => {
  // null means "no opinion" — the UI must keep offering every backend, because a missed
  // card would otherwise lock a user out of the backend they actually need.
  assert.equal(recommendedRuntimeBackend({ platform: 'win32', gpuVendors: [] }), null)
  assert.equal(recommendedRuntimeBackend({ platform: 'win32' }), null)
  assert.equal(recommendedRuntimeBackend(null), null)
})

test('manifest status compares the environment against the shipped manifest', () => {
  assert.equal(runtimeManifestStatus({ manifestVersion: '2026.07.1' }, '2026.07.1'), 'current')
  assert.equal(runtimeManifestStatus({ manifestVersion: '2026.06.2' }, '2026.07.1'), 'outdated')
})

test('a newer environment than the app also counts as a mismatch', () => {
  // After an app downgrade the environment can be ahead; "reinstall to match" is still right,
  // so the check reports a plain mismatch instead of pretending to order the versions.
  assert.equal(runtimeManifestStatus({ manifestVersion: '2026.09.1' }, '2026.07.1'), 'outdated')
})

test('manifest status is unknown when either side did not record a version', () => {
  // The bootstrap interpreter never records one — claiming it is outdated would be a lie.
  assert.equal(runtimeManifestStatus({}, '2026.07.1'), 'unknown')
  assert.equal(runtimeManifestStatus(undefined, '2026.07.1'), 'unknown')
  assert.equal(runtimeManifestStatus({ manifestVersion: '2026.07.1' }, undefined), 'unknown')
  assert.equal(runtimeManifestStatus({ manifestVersion: '' }, ''), 'unknown')
})

test('every shipped backend has its own download size hint', () => {
  const hints = ['cpu', 'cuda', 'rocm', 'mlx'].map(runtimeSizeHint)
  assert.equal(new Set(hints).size, hints.length)
  assert.equal(runtimeSizeHint('unknown-backend'), '~1 GB')
})
