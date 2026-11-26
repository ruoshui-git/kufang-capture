import { m } from '../paraglide/messages.js'
import { getLocale } from '../paraglide/runtime.js'

type DateValue = Date | string | number

export function formatDate(value: DateValue): string {
  return new Intl.DateTimeFormat(getLocale()).format(new Date(value))
}

export function formatDateTime(value: DateValue): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  )
}

export function formatMonthDay(value: DateValue): string {
  return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric' }).format(new Date(value))
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(value).getTime()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 60) return m.core_time_now()
  if (seconds < 3600) return m.core_time_minutes({ count: Math.floor(seconds / 60) })
  if (seconds < 86400) return m.core_time_hours({ count: Math.floor(seconds / 3600) })
  if (seconds < 172800) return m.core_time_yesterday()
  if (seconds < 604800) return m.core_time_days({ count: Math.floor(seconds / 86400) })
  return formatDate(value)
}

const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(value: number | null | undefined): string {
  if (value == null) return m.core_unavailable()
  let size = value
  let unit = 0
  while (size >= 1024 && unit < byteUnits.length - 1) {
    size /= 1024
    unit++
  }
  const fractionDigits = unit > 0 && size < 10 ? 1 : 0
  const amount = new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(size)
  return `${amount} ${byteUnits[unit]}`
}
