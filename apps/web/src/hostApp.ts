export type HostApp = 'wechat' | 'mobile-qq' | 'unsupported'

export function detectHostApp(userAgent: string): HostApp {
  if (/MicroMessenger\//i.test(userAgent)) return 'wechat'
  if (/(?:^|[\s;])QQ\/\d+(?:\.\d+)*/i.test(userAgent)) return 'mobile-qq'
  return 'unsupported'
}

export function hostAppLabel(hostApp: HostApp): string {
  if (hostApp === 'wechat') return '微信'
  if (hostApp === 'mobile-qq') return '手机 QQ'
  return '不支持的浏览器'
}
