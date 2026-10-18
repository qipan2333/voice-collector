import { describe, expect, it, vi } from 'vitest'
import { keepScreenAwake } from './screenWakeLock'

function setup() {
  let visible = true
  let listener = () => {}
  const releaseListeners: Array<() => void> = []
  const lock = { released: false, release: vi.fn(async () => {}), addEventListener: vi.fn((_type: string, callback: () => void) => releaseListeners.push(callback)) }
  const request = vi.fn(async () => lock)
  const remove = vi.fn()
  const env = { request, visible: () => visible, listen: (callback: () => void) => { listener = callback; return remove } }
  return { lock, request, env, remove, hide: () => { visible = false; listener() }, show: () => { visible = true; listener() }, systemRelease: () => releaseListeners.forEach((callback) => callback()) }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('recording screen wake lock', () => {
  it('acquires and releases on recording end, removing listeners', async () => {
    const h = setup(); const status = vi.fn()
    const stop = keepScreenAwake(status, h.env)
    await flush()
    expect(status).toHaveBeenLastCalledWith('active')
    stop()
    expect(h.lock.release).toHaveBeenCalledOnce()
    expect(h.remove).toHaveBeenCalledOnce()
    h.show()
    expect(h.request).toHaveBeenCalledOnce()
  })
  it('releases when hidden and reacquires on return', async () => {
    const h = setup(); const status = vi.fn()
    const stop = keepScreenAwake(status, h.env)
    await flush(); h.hide()
    expect(status).toHaveBeenLastCalledWith('released')
    await flush(); h.show(); await flush()
    expect(h.request).toHaveBeenCalledTimes(2)
    expect(status).toHaveBeenLastCalledWith('active')
    stop()
  })
  it('reports unsupported browsers and permission failures without throwing', async () => {
    const h = setup(); const status = vi.fn()
    keepScreenAwake(status, { ...h.env, request: undefined })()
    expect(status).toHaveBeenLastCalledWith('unavailable')
    h.request.mockRejectedValueOnce(new Error('denied'))
    const stop = keepScreenAwake(status, h.env)
    await flush()
    expect(status).toHaveBeenLastCalledWith('unavailable')
    stop()
  })
  it('releases late results after recording ends without updating UI', async () => {
    const h = setup(); const status = vi.fn()
    let resolve!: (value: typeof h.lock) => void
    const request = () => new Promise<typeof h.lock>((done) => { resolve = done })
    const stop = keepScreenAwake(status, { ...h.env, request })
    stop(); status.mockClear(); resolve(h.lock); await flush()
    expect(h.lock.release).toHaveBeenCalledOnce()
    expect(status).not.toHaveBeenCalled()
  })
  it('reports system release without repeatedly requesting a denied lock', async () => {
    const h = setup(); const status = vi.fn()
    const stop = keepScreenAwake(status, h.env)
    await flush(); h.systemRelease()
    expect(status).toHaveBeenLastCalledWith('released')
    expect(h.request).toHaveBeenCalledOnce()
    stop()
  })
})
