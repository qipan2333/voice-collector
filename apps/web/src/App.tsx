import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, Context } from './api'
import { AdminApp as AdminWorkbench } from './AdminApp'
import { FollowAudioBuffer, FollowProgressTracker, alignTranscript, encodePcmWav, segmentReadingText } from './followAlong'
import { detectHostApp } from './hostApp'

type Screen = 'loading' | 'token' | 'student' | 'admin' | 'unsupported'
type RecorderState = 'idle' | 'checking' | 'ready' | 'recording' | 'review' | 'uploading' | 'processing' | 'submitted' | 'error'

function tokenFromHash() {
  const match = window.location.hash.match(/^#\/join\/(.+)$/)
  return match?.[1] ?? ''
}

function formatSeconds(seconds = 0) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const rest = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${rest}`
}

const RECORDER_MIME_TYPES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
]

function supportedRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined
  for (const mimeType of RECORDER_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(mimeType)) return mimeType
    } catch {
      // Some older WebKit builds throw for an unknown MIME string.
    }
  }
  return undefined
}

function mediaErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (!window.isSecureContext) return '当前地址不是 HTTPS 安全页面，浏览器不会开放麦克风。请使用 HTTPS 地址。'
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝。请在浏览器网站设置中允许麦克风，然后重新加载页面。'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用麦克风，请检查手机权限和系统输入设备。'
  if (name === 'NotReadableError' || name === 'TrackStartError') return '麦克风正在被其他应用占用，请关闭通话、相机或录音应用后重试。'
  if (name === 'OverconstrainedError') return '当前设备不接受录音参数，正在使用兼容模式，请重新点击开始录音。'
  if (error instanceof Error) return error.message
  return '无法访问麦克风，请检查浏览器权限后重试。'
}

type LegacyNavigator = Navigator & {
  webkitGetUserMedia?: (constraints: MediaStreamConstraints, success: (stream: MediaStream) => void, failure: (error: unknown) => void) => void
  mozGetUserMedia?: (constraints: MediaStreamConstraints, success: (stream: MediaStream) => void, failure: (error: unknown) => void) => void
}

function requestMicrophone(): Promise<MediaStream> {
  if (navigator.mediaDevices?.getUserMedia) return navigator.mediaDevices.getUserMedia({ audio: true })
  const legacy = navigator as LegacyNavigator
  const legacyGetUserMedia = legacy.webkitGetUserMedia ?? legacy.mozGetUserMedia
  if (!legacyGetUserMedia) return Promise.reject(new Error('当前微信或手机 QQ 版本没有提供麦克风接口，请升级应用后重试。'))
  return new Promise((resolve, reject) => legacyGetUserMedia.call(navigator, { audio: true }, resolve, reject))
}

type PcmCapture = {
  context: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  mute: GainNode
  chunks: Int16Array[]
}

function encodeWav(chunks: Int16Array[], sampleRate: number): Blob {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const buffer = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    for (const sample of chunk) {
      view.setInt16(offset, sample, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

function Shell({ children, eyebrow = 'VOICE COLLECTOR' }: { children: ReactNode; eyebrow?: string }) {
  return <main className="shell"><div className="brand"><span className="brand-mark">◉</span><span>{eyebrow}</span></div>{children}<footer>研究录音采集工具 · 学生端请在微信或手机 QQ 内打开</footer></main>
}

function UnsupportedBrowser() {
  const copyLink = () => navigator.clipboard?.writeText(window.location.href).catch(() => undefined)
  return <Shell><section className="hero-card narrow"><div className="status-icon warning">!</div><div className="eyebrow">浏览器不受支持</div><h1>请在微信或手机 QQ 中打开</h1><p className="muted">复制当前邀请链接，发送到微信或手机 QQ 后，在应用内点击链接继续。</p><button className="primary" onClick={copyLink}>复制邀请链接</button></section></Shell>
}

function TokenEntry({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('')
  return <Shell><section className="hero-card narrow"><div className="eyebrow">参与朗读任务</div><h1>准备好后，开始你的录音。</h1><p className="muted">请打开研究人员发给你的邀请链接。如果你是手动进入，也可以在这里粘贴邀请码。</p><label>邀请码或链接<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="粘贴邀请 token" /></label><button className="primary" disabled={!value.trim()} onClick={() => onSubmit(value.trim().split('/').pop() ?? value.trim())}>继续</button></section></Shell>
}

function StudentApp({ context, onRefresh }: { context: Context; onRefresh: () => Promise<void> }) {
  const [consent, setConsent] = useState(context.consent_confirmed)
  const [recorderState, setRecorderState] = useState<RecorderState>(context.invite_status !== 'reopened' && context.attempts.some((item) => item.state === 'ready' || item.state === 'processing' || item.state === 'queued') ? 'submitted' : 'idle')
  const [message, setMessage] = useState('')
  const [followMessage, setFollowMessage] = useState('')
  const [activePhrase, setActivePhrase] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [progress, setProgress] = useState(0)
  const phrases = useMemo(() => segmentReadingText(context.study.text), [context.study.text])
  const followInterval = Math.max(2, context.follow_along_interval_seconds || 8)
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | undefined>(undefined)
  const audioContext = useRef<AudioContext | null>(null)
  const pcmCapture = useRef<PcmCapture | null>(null)
  const recorderSettings = useRef<Record<string, unknown>>({})
  const reader = useRef<HTMLElement | null>(null)
  const phraseElements = useRef<Array<HTMLSpanElement | null>>([])
  const manualScrollUntil = useRef(0)
  const activePhraseRef = useRef(0)
  const confirmedPhraseRef = useRef(0)
  const followProgress = useRef(new FollowProgressTracker(phrases, context.study.expected_seconds))
  const followAudio = useRef(new FollowAudioBuffer(followInterval + 1))
  const followInFlight = useRef(false)
  const followSequence = useRef(0)
  const followSessionId = useRef('')
  const followActive = useRef(false)
  const followSpeaking = useRef(false)

  const currentAttempt = useMemo(() => context.attempts[context.attempts.length - 1], [context.attempts])

  const scrollToPhrase = (index: number) => {
    if (Date.now() < manualScrollUntil.current) return
    const container = reader.current
    const element = phraseElements.current[index]
    if (!container || !element) return
    const top = element.offsetTop - container.clientHeight * 0.42
    container.scrollTo({ top: Math.max(0, top), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  const resetFollowAlong = () => {
    activePhraseRef.current = 0
    confirmedPhraseRef.current = 0
    setActivePhrase(0)
    setFollowMessage('跟读会根据你的朗读自动移动。')
    followProgress.current = new FollowProgressTracker(phrases, context.study.expected_seconds)
    followAudio.current = new FollowAudioBuffer(followInterval + 1)
    followInFlight.current = false
    followSequence.current = 0
    followActive.current = false
    followSpeaking.current = false
    followSessionId.current = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    reader.current?.scrollTo({ top: 0 })
  }

  const flushFollowChunk = async () => {
    if (!context.follow_along_enabled || !followActive.current || followInFlight.current) return
    const input = followAudio.current.takeReadyWindow(followInterval)
    if (!input) return
    const sequence = followSequence.current
    followSequence.current += 1
    followInFlight.current = true
    setFollowMessage('正在校准朗读位置…')
    try {
      const wav = encodePcmWav(input.chunks, input.sampleRate)
      const result = await api.transcribeChunk(followSessionId.current, sequence, wav)
      if (followActive.current && result.transcript) {
        const next = alignTranscript(phrases, confirmedPhraseRef.current, result.transcript)
        if (next > confirmedPhraseRef.current) {
          confirmedPhraseRef.current = next
          const snapshot = followProgress.current.confirmPhrase(next)
          if (snapshot.activePhrase > activePhraseRef.current) {
            activePhraseRef.current = snapshot.activePhrase
            setActivePhrase(snapshot.activePhrase)
            window.requestAnimationFrame(() => scrollToPhrase(snapshot.activePhrase))
          }
        }
        setFollowMessage('正在跟随朗读')
      }
    } catch (error) {
      if (followActive.current) setFollowMessage('正在本地跟随；云端校准暂时不可用。')
    } finally {
      followInFlight.current = false
      if (followActive.current && followAudio.current.isReady(followInterval)) void flushFollowChunk()
    }
  }

  const collectFollowFrame = (data: Float32Array, sampleRate: number, rms: number) => {
    if (!followActive.current) return
    const snapshot = followProgress.current.addFrame(rms, data.length / sampleRate)
    if (snapshot.activePhrase > activePhraseRef.current) {
      activePhraseRef.current = snapshot.activePhrase
      setActivePhrase(snapshot.activePhrase)
      window.requestAnimationFrame(() => scrollToPhrase(snapshot.activePhrase))
    }
    if (snapshot.speaking !== followSpeaking.current) {
      followSpeaking.current = snapshot.speaking
      setFollowMessage(snapshot.speaking ? '正在跟随朗读' : '等待继续朗读…')
    }
    if (!context.follow_along_enabled) return
    followAudio.current.push(data, sampleRate, snapshot.speaking)
    if (followAudio.current.isReady(followInterval)) void flushFollowChunk()
  }

  const stopStream = () => {
    if (pcmCapture.current) {
      pcmCapture.current.processor.onaudioprocess = null
      pcmCapture.current.source.disconnect()
      pcmCapture.current.processor.disconnect()
      pcmCapture.current.mute.disconnect()
      pcmCapture.current = null
    }
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    setLevel(0)
    if (audioContext.current) {
      void audioContext.current.close().catch(() => undefined)
      audioContext.current = null
    }
  }

  const cleanup = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current)
    followActive.current = false
    stopStream()
  }, [])

  useEffect(() => cleanup, [cleanup])

  const startAudioProcessing = async (input: MediaStream, collectFullRecording: boolean) => {
    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) throw new Error('当前浏览器没有可用的 Web Audio 录音接口。')
    const context = new AudioContextCtor()
    await context.resume().catch(() => undefined)
    if (!context.createScriptProcessor) throw new Error('当前浏览器没有可用的兼容录音接口。')
    const source = context.createMediaStreamSource(input)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const mute = context.createGain()
    const pcmChunks: Int16Array[] = []
    mute.gain.value = 0
    processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0)
      const pcmChunk = collectFullRecording ? new Int16Array(data.length) : null
      let energy = 0
      for (let index = 0; index < data.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, data[index]))
        energy += sample * sample
        if (pcmChunk) pcmChunk[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      if (pcmChunk) pcmChunks.push(pcmChunk)
      const rms = Math.sqrt(energy / data.length)
      setLevel(Math.min(1, rms * 3))
      collectFollowFrame(data, context.sampleRate, rms)
    }
    source.connect(processor)
    processor.connect(mute)
    mute.connect(context.destination)
    audioContext.current = context
    pcmCapture.current = { context, source, processor, mute, chunks: pcmChunks }
  }

  const startPcmFallback = async (input: MediaStream) => {
    await startAudioProcessing(input, true)
    const sampleRate = audioContext.current?.sampleRate ?? 48000
    recorderSettings.current = { mimeType: 'audio/wav', sampleRate, channelCount: 1, mode: 'web-audio-pcm' }
    setRecorderState('recording')
    setElapsed(0)
    setMessage('当前环境使用兼容录音模式，请按自然速度朗读。')
    timer.current = window.setInterval(() => setElapsed((value) => value + 1), 1000)
  }

  const finishPcmRecording = () => {
    const capture = pcmCapture.current
    if (!capture) return
    capture.processor.onaudioprocess = null
    const result = encodeWav(capture.chunks, capture.context.sampleRate)
    setBlob(result)
    setAudioUrl(URL.createObjectURL(result))
    setRecorderState('review')
    cleanup()
  }

  const beginRecording = async () => {
    if (!consent) return setMessage('请先确认已完成校外知情同意流程。')
    resetFollowAlong()
    setRecorderState('checking'); setMessage('正在请求麦克风权限…')
    try {
      if (!window.isSecureContext) throw new Error('当前地址不是 HTTPS 安全页面，浏览器不会开放麦克风。')
      const input = await requestMicrophone()
      stream.current = input
      followActive.current = true
      if (typeof MediaRecorder === 'undefined') {
        await startPcmFallback(input)
        return
      }
      const preferred = supportedRecorderMimeType()
      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(input, preferred ? { mimeType: preferred, audioBitsPerSecond: 128000 } : undefined)
      } catch {
        try {
          recorder = new MediaRecorder(input)
        } catch {
          await startPcmFallback(input)
          return
        }
      }
      mediaRecorder.current = recorder
      const trackSettings = input.getAudioTracks()[0]?.getSettings?.() ?? {}
      const { deviceId: _deviceId, groupId: _groupId, ...safeTrackSettings } = trackSettings
      recorderSettings.current = { ...safeTrackSettings, mimeType: recorder.mimeType || preferred || 'browser-default' }
      chunks.current = []
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data) }
      recorder.onerror = () => { setMessage('录音被浏览器中断，请重新尝试。'); setRecorderState('error'); cleanup() }
      recorder.onstop = () => {
        const result = new Blob(chunks.current, { type: recorder.mimeType || 'audio/webm' })
        setBlob(result); setAudioUrl(URL.createObjectURL(result)); setRecorderState('review'); cleanup()
      }
      try {
        recorder.start(1000)
      } catch {
        try {
          recorder.start()
        } catch {
          await startPcmFallback(input)
          return
        }
      }
      setRecorderState('recording'); setElapsed(0); setMessage('请按自然速度朗读屏幕上的文本。')
      timer.current = window.setInterval(() => setElapsed((value) => value + 1), 1000)
      try {
        await startAudioProcessing(input, false)
      } catch {
        setFollowMessage('当前环境无法启用跟读定位；录音仍可正常完成。')
      }
    } catch (error) {
      stopStream()
      setRecorderState('error')
      setMessage(mediaErrorMessage(error))
    }
  }

  const stopRecording = () => {
    followActive.current = false
    if (mediaRecorder.current?.state === 'recording') mediaRecorder.current.stop()
    else if (pcmCapture.current) finishPcmRecording()
  }

  const submit = async () => {
    if (!blob) return
    setRecorderState('uploading'); setProgress(0); setMessage('正在安全上传录音…')
    try {
      const attempt = await api.createAttempt({ client_duration_seconds: elapsed, browser_family: detectHostApp(navigator.userAgent), os_family: navigator.platform.slice(0, 100), recorder_settings: { ...recorderSettings.current, blobType: blob.type } })
      await api.uploadAttempt(attempt.id, blob, setProgress)
      await api.finalize(attempt.id)
      setRecorderState('processing'); setMessage('录音已收到，正在进行格式检查…')
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
        const result = await api.attemptStatus(attempt.id)
        if (result.state === 'ready') { setRecorderState('submitted'); setMessage('提交成功，感谢你的参与。'); await onRefresh(); return }
        if (result.state === 'failed') throw new Error(result.error_message ?? '服务器无法处理这段录音。')
      }
      setMessage('录音仍在后台处理，你可以稍后刷新页面查看结果。')
    } catch (error) {
      setRecorderState('error'); setMessage(error instanceof Error ? error.message : '提交失败，请重试。')
    }
  }

  if (recorderState === 'submitted' && currentAttempt) return <Shell><section className="hero-card"><div className="status-icon success">✓</div><div className="eyebrow">{context.participant_code}</div><h1>录音已提交</h1><p className="muted">你的录音正在研究人员后台保存。若需要重新录制，请联系研究人员重新开放邀请码。</p><div className="mini-summary"><span>状态</span><strong>{currentAttempt.state === 'ready' ? '已完成' : '处理中'}</strong></div></section></Shell>

  const showReadingProgress = recorderState === 'recording' || recorderState === 'review'
  const taskOpen = context.study.status === 'open'
  return <Shell><section className="hero-card recording-layout"><div className="topline"><span className="eyebrow">{context.participant_code}</span><span className="pill">{context.study.text_version}</span></div><h1>{context.study.title}</h1><p className="muted">{context.study.instructions}</p>{!taskOpen && <div className="notice error">任务已经关闭，无法开始新的录音。</div>}{context.follow_along_enabled && <div className="asr-disclosure">录音过程中，短音频片段会发送至小米 MiMo 用于实时定位；识别文字不会保存。</div>}{!consent && <label className="consent"><input type="checkbox" checked={consent} onChange={(event) => { setConsent(event.target.checked); if (event.target.checked) api.consent(context.study.consent_version).catch((error) => setMessage(error.message)) }} />我确认已完成研究人员要求的校外知情同意流程</label>}<article ref={reader} className={`reading-text ${showReadingProgress ? 'following' : ''}`} onTouchStart={() => { manualScrollUntil.current = Date.now() + 5000 }} onWheel={() => { manualScrollUntil.current = Date.now() + 5000 }}>{phrases.map((phrase, index) => <span ref={(element) => { phraseElements.current[index] = element }} className={`reading-phrase ${showReadingProgress && index < activePhrase ? 'completed' : ''} ${showReadingProgress && index === activePhrase ? 'active' : ''}`} key={phrase.id}>{phrase.text}</span>)}</article><div className="recorder-panel"><div className="timer">{formatSeconds(elapsed)}<small>/ 约 {formatSeconds(context.study.expected_seconds)}</small></div><div className="meter"><span style={{ transform: `scaleX(${Math.max(0.02, level)})` }} /></div>{followMessage && recorderState === 'recording' && <div className="follow-status">{followMessage}</div>}{message && <div className="notice">{message}</div>}{recorderState === 'review' && audioUrl && <audio controls src={audioUrl} className="audio-preview" />}{recorderState === 'uploading' && <div className="upload-progress"><span style={{ width: `${progress * 100}%` }} /></div>}<div className="actions">{recorderState === 'idle' || recorderState === 'error' ? <button className="primary" onClick={beginRecording} disabled={!consent || !taskOpen}>开始录音</button> : recorderState === 'recording' ? <button className="danger" onClick={stopRecording}>结束录音</button> : recorderState === 'review' ? <><button className="secondary" onClick={() => { setBlob(null); setAudioUrl(''); setElapsed(0); setRecorderState('idle'); resetFollowAlong() }}>重新录制</button><button className="primary" onClick={submit}>提交录音</button></> : recorderState === 'processing' ? <span className="muted">后台处理中…</span> : null}</div></div></section></Shell>
}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [context, setContext] = useState<Context | null>(null)
  const [error, setError] = useState('')

  const loadStudent = async () => { const result = await api.context(); setContext(result); setScreen('student') }
  useEffect(() => {
    if (window.location.hash.startsWith('#/admin')) return setScreen('admin')
    if (detectHostApp(navigator.userAgent) === 'unsupported') return setScreen('unsupported')
    if (window.location.hash === '#/student') {
      loadStudent().catch((err) => { setError(err instanceof Error ? err.message : '会话已失效'); setScreen('token') })
      return
    }
    const token = tokenFromHash()
    if (!token) return setScreen('token')
    api.exchange(token).then(() => { window.history.replaceState({}, '', `${window.location.pathname}#/student`); return loadStudent() }).catch((err) => { setError(err instanceof Error ? err.message : '邀请链接无效'); setScreen('token') })
  }, [])

  if (screen === 'loading') return <Shell><section className="hero-card narrow"><div className="spinner" /><p>正在准备页面…</p></section></Shell>
  if (screen === 'admin') return <AdminWorkbench />
  if (screen === 'unsupported') return <UnsupportedBrowser />
  if (screen === 'token') return <><TokenEntry onSubmit={(token) => { setScreen('loading'); api.exchange(token).then(loadStudent).catch((err) => { setError(err instanceof Error ? err.message : '邀请链接无效'); setScreen('token') }) }} />{error && <div className="floating-error">{error}</div>}</>
  return context ? <StudentApp context={context} onRefresh={loadStudent} /> : null
}
