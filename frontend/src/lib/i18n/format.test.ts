import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../paraglide/runtime.js'
import { formatBytes, formatDate, formatDateTime, formatMonthDay, formatRelativeTime } from './format'

afterEach(() => {
  void setLocale('en', { reload: false })
})

const now = new Date('2026-11-08T12:00:00.000Z').getTime()
const older = '2026-10-01T12:00:00.000Z'

describe('localized formatting', () => {
  it('keeps the English relative-time thresholds and wording', () => {
    expect(formatRelativeTime('2026-11-08T11:58:00.000Z', now)).toBe('2 min ago')
    expect(formatRelativeTime('2026-11-08T09:00:00.000Z', now)).toBe('3 hr ago')
    expect(formatRelativeTime('2026-11-05T12:00:00.000Z', now)).toBe('3 days ago')
    expect(formatRelativeTime(older, now)).toBe(new Date(older).toLocaleDateString('en'))
  })

  it('formats recent and older updates in Chinese', () => {
    void setLocale('zh-CN', { reload: false })
    expect(formatRelativeTime('2026-11-08T11:59:30.000Z', now)).toBe('刚刚')
    expect(formatRelativeTime('2026-11-08T11:57:00.000Z', now)).toBe('3 分钟前')
    expect(formatRelativeTime('2026-11-08T10:00:00.000Z', now)).toBe('2 小时前')
    expect(formatRelativeTime('2026-11-07T12:00:00.000Z', now)).toBe('昨天')
    expect(formatRelativeTime('2026-11-05T12:00:00.000Z', now)).toBe('3 天前')
    expect(formatRelativeTime(older, now)).toBe(new Date(older).toLocaleDateString('zh-CN'))
  })

  it('uses Chinese date and time formats and localized missing byte sizes', () => {
    void setLocale('zh-CN', { reload: false })
    const date = new Date(2026, 9, 1, 12)
    expect(formatDate(date)).toBe('2026/10/1')
    expect(formatDateTime(date)).toBe('2026/10/1 12:00')
    expect(formatMonthDay(date)).toBe('10月1日')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(null)).toBe('不可用')
  })
})
