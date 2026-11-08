export function relativeTime(value: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(value).getTime()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`
  if (seconds < 172800) return 'yesterday'
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`
  return new Date(value).toLocaleDateString()
}
