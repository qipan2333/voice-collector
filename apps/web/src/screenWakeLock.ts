export type ScreenWakeStatus = 'requesting' | 'active' | 'unavailable' | 'released'

type ScreenLock = {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

type Environment = {
  request?: () => Promise<ScreenLock>
  visible: () => boolean
  listen: (listener: () => void) => () => void
}

// A recording owns its lock. Late requests are released even after unmount.
export function keepScreenAwake(onStatus: (status: ScreenWakeStatus) => void, env: Environment): () => void {
  let disposed = false
  let pending = false
  let lock: ScreenLock | null = null
  const release = (value: ScreenLock) => { void value.release().catch(() => undefined) }
  const acquire = async () => {
    if (disposed || pending || lock || !env.visible()) return
    if (!env.request) { onStatus('unavailable'); return }
    pending = true
    onStatus('requesting')
    try {
      const acquired = await env.request()
      if (disposed || !env.visible()) { release(acquired); return }
      if (acquired.released) { onStatus('released'); return }
      lock = acquired
      acquired.addEventListener('release', () => {
        if (lock !== acquired) return
        lock = null
        if (!disposed) onStatus('released')
      })
      onStatus('active')
    } catch {
      if (!disposed) onStatus('unavailable')
    } finally {
      pending = false
    }
  }
  const unlisten = env.listen(() => {
    if (env.visible()) { void acquire(); return }
    const previous = lock
    lock = null
    if (previous) release(previous)
    if (!disposed) onStatus('released')
  })
  void acquire()
  return () => {
    disposed = true
    unlisten()
    if (lock) release(lock)
    lock = null
  }
}

export function browserWakeEnvironment(): Environment {
  return {
    request: navigator.wakeLock?.request ? () => navigator.wakeLock.request('screen') : undefined,
    visible: () => document.visibilityState === 'visible',
    listen: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  }
}
