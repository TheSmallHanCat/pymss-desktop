/**
 * Download rate, always in MB/s.
 *
 * Fixed to one unit on purpose: a rate that switches between KB/s and MB/s as the connection
 * fluctuates makes the number jump around and is harder to read than a steady 0.4 MB/s.
 * Returns '' when there is nothing meaningful to show, so callers can omit the row entirely.
 */
export function formatSpeedMBps(bytesPerSecond?: number | null): string {
  if (!bytesPerSecond || bytesPerSecond <= 0 || !Number.isFinite(bytesPerSecond)) return ''
  const mb = bytesPerSecond / (1024 * 1024)
  // Below 0.1 MB/s one decimal would read as a stalled 0.0, so borrow a digit.
  return `${mb.toFixed(mb >= 0.1 ? 1 : 2)} MB/s`
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}
