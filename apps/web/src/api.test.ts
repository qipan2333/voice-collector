import { describe, expect, it } from 'vitest'
import { formatApiError } from './api'

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
