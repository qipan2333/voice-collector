import { afterEach, describe, expect, it, vi } from 'vitest'
import { cacheProfile, readProfile } from './participantProfile'

afterEach(() => vi.unstubAllGlobals())

describe('participant profile cache', () => {
  it('prefills personal details on the next visit without storing recording progress', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } })
    const profile = { ...readProfile(), name: '同学甲', school: '测试学校', phone: '13800138000', student_number: '00123' }
    cacheProfile(profile)
    expect(readProfile()).toEqual(profile)
    expect(readProfile().student_number).toBe('00123')
    expect([...values.values()]).toEqual([JSON.stringify(profile)])
  })

  it('ignores malformed and unavailable storage', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => '{broken' } })
    expect(readProfile().name).toBe('')
    vi.stubGlobal('window', { get localStorage() { throw new Error('Blocked') } })
    expect(readProfile().name).toBe('')
    expect(() => cacheProfile(readProfile())).not.toThrow()
  })

  it('only restores text from known profile fields', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => JSON.stringify({ name: 123, school: '学校', student_number: '0001', attempts: ['old'] }) } })
    expect(readProfile()).toEqual({ name: '', school: '学校', grade: '', class_name: '', phone: '', student_number: '0001' })
  })
})
