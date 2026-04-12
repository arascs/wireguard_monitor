export function formatBps(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1000) return `${n.toFixed(0)} B/s`;
  if (n < 1e6) return `${(n / 1000).toFixed(1)} KB/s`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB/s`;
  return `${(n / 1e9).toFixed(2)} GB/s`;
}

export function formatBytesPerInterval(bytes, sec) {
  if (bytes == null || sec == null || sec <= 0) return '—';
  return formatBps(bytes / sec);
}
