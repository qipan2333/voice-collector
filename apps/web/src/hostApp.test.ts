import { describe, expect, it } from 'vitest'
import { detectHostApp } from './hostApp'

describe('detectHostApp', () => {
  it('accepts WeChat on iOS and Android', () => {
    expect(detectHostApp('Mozilla/5.0 iPhone MicroMessenger/8.0.58')).toBe('wechat')
    expect(detectHostApp('Mozilla/5.0 Linux Android MicroMessenger/8.0.58')).toBe('wechat')
  })

  it('accepts Mobile QQ but rejects standalone QQ Browser', () => {
    expect(detectHostApp('Mozilla/5.0 Mobile MQQBrowser/6.2 QQ/9.1.50')).toBe('mobile-qq')
    expect(detectHostApp('Mozilla/5.0 Mobile MQQBrowser/15.5')).toBe('unsupported')
  })

  it('rejects ordinary Safari and Chrome', () => {
    expect(detectHostApp('Mozilla/5.0 Version/18.0 Mobile Safari/604.1')).toBe('unsupported')
    expect(detectHostApp('Mozilla/5.0 Android Chrome/140.0 Mobile')).toBe('unsupported')
  })
})
