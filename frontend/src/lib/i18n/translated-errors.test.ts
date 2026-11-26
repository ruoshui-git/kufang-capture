import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cameraPermissionMessage } from '../camera/stream'
import { createRepo, getCaptureDb } from '../db'
import { exportFromDevice } from '../export/device'
import { setLocale } from '../paraglide/runtime.js'
import { createClients } from '../sync/clients'
import { displaySyncError } from '../sync/errors'
import { entryDisplayTitle, entryExportTitle } from '../types'

beforeEach(() => {
  void setLocale('zh-CN', { reload: false })
})

afterEach(() => {
  void setLocale('en', { reload: false })
})

describe('Chinese library messages', () => {
  it('translates the untitled display label and keeps exports English', () => {
    const entry = { title: '  ', sequence_number: 42 }
    expect(entryDisplayTitle(entry)).toBe('条目 #0042')
    expect(entryExportTitle(entry)).toBe('Entry #0042')
    const named = { ...entry, title: '  Blue boxes  ' }
    expect(entryDisplayTitle(named)).toBe('Blue boxes')
    expect(entryExportTitle(named)).toBe('Blue boxes')
  })

  it('translates repository and export errors for a missing collection', async () => {
    const databaseName = 'i18n-missing-collection'
    const repo = createRepo({ databaseName })
    try {
      await expect(repo.createEntry('missing')).rejects.toThrow('找不到清点单')
      await expect(exportFromDevice(['missing'], {}, { repo })).rejects.toThrow('找不到清点单，无法导出。')
    } finally {
      await getCaptureDb(databaseName).delete()
    }
  })

  it('translates camera permission and handles unlocalized browser failures', () => {
    expect(cameraPermissionMessage(new DOMException('permission denied', 'NotAllowedError'))).toBe(
      '请前往“设置”→“Safari”→“相机”允许访问，然后轻点继续。',
    )
    expect(cameraPermissionMessage(new Error('browser-specific message'))).toBe('无法启动相机。')
  })

  it('translates sign-in failures and both locales select the right retry variant', async () => {
    const denied = createClients(async () => new Response(null, { status: 401 })).authClient
    await expect(denied.login('wrong')).rejects.toThrow('密码不正确。')
    const throttled = createClients(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
    ).authClient
    await expect(throttled.login('wrong')).rejects.toThrow('尝试次数过多，请在 2 分钟后重试。')
    void setLocale('en', { reload: false })
    await expect(throttled.login('wrong')).rejects.toThrow('Too many attempts. Try again in 2 minutes.')
  })

  it('translates old English photo retry text when it reaches the UI', () => {
    expect(displaySyncError('Photo upload failed (413).')).toBe('照片上传失败（413）。')
    expect(displaySyncError('The original photo is missing from this device.')).toBe('本设备上缺少照片原件。')
    expect(displaySyncError('A browser-specific error')).toBe('同步失败，请重试。')
  })
})
