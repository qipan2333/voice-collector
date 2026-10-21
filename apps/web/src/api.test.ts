import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, formatApiError } from './api'

describe('formatApiError', () => {
  it('returns string details unchanged', () => {
    expect(formatApiError({ detail: '邀请码无效' }, '请求失败')).toBe('邀请码无效')
  })

  it('formats FastAPI validation details instead of object strings', () => {
    const body = { detail: [{ loc: ['body', 'browser_family'], msg: 'String should have at most 100 characters' }] }
    expect(formatApiError(body, '请求失败')).toBe('browser_family: String should have at most 100 characters')
  })

  it('uses a fallback for unknown response bodies', () => {
    expect(formatApiError({}, '上传失败 (502)')).toBe('上传失败 (502)')
  })
})


afterEach(() => vi.unstubAllGlobals())

it('fetches fresh participant context after exchanging a link', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
  vi.stubGlobal('fetch', fetchMock)
  await api.context()
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/participant/context', expect.objectContaining({ cache: 'no-store', credentials: 'include' }))
})
