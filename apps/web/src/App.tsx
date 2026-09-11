import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, Attempt, Context, Study } from './api'
import { alignTranscript, encodePcmWav, segmentReadingText } from './followAlong'
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

function downloadCsv(lines: string[]) {
  const blob = new Blob([`${lines.join('\\n')}\\n`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'voice-collector-invites.csv'
  anchor.click()
  URL.revokeObjectURL(url)
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
  const [recorderState, setRecorderState] = useState<RecorderState>(context.attempts.some((item) => item.state === 'ready' || item.state === 'processing' || item.state === 'queued') ? 'submitted' : 'idle')
  const [message, setMessage] = useState('')
  const [followMessage, setFollowMessage] = useState('')
  const [activePhrase, setActivePhrase] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [progress, setProgress] = useState(0)
  const phrases = useMemo(() => segmentReadingText(context.study.text), [context.study.text])
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
  const followChunks = useRef<Float32Array[]>([])
  const followSampleCount = useRef(0)
  const followSampleRate = useRef(0)
  const followSilenceMs = useRef(0)
  const followInFlight = useRef(false)
  const followSequence = useRef(0)
  const followSessionId = useRef('')

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
    setActivePhrase(0)
    setFollowMessage(context.follow_along_enabled ? '跟读定位会在开始朗读后自动更新。' : '')
    followChunks.current = []
    followSampleCount.current = 0
    followSampleRate.current = 0
    followSilenceMs.current = 0
    followInFlight.current = false
    followSequence.current = 0
    followSessionId.current = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    reader.current?.scrollTo({ top: 0 })
  }

  const retainTail = (input: Float32Array[], sampleCount: number): Float32Array[] => {
    const result: Float32Array[] = []
    let remaining = sampleCount
    for (let index = input.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = input[index]
      const take = Math.min(remaining, chunk.length)
      result.unshift(chunk.slice(chunk.length - take))
      remaining -= take
    }
    return result
  }

  const flushFollowChunk = async (final = false) => {
    if (!context.follow_along_enabled || followInFlight.current || !followSampleRate.current) return
    const duration = followSampleCount.current / followSampleRate.current
    if (duration < (final ? 1 : 12)) return
    const input = followChunks.current
    const sequence = followSequence.current
    const tailSamples = final ? 0 : Math.min(followSampleRate.current, followSampleCount.current)
    followChunks.current = tailSamples ? retainTail(input, tailSamples) : []
    followSampleCount.current = tailSamples
    followSilenceMs.current = 0
    followSequence.current += 1
    followInFlight.current = true
    setFollowMessage('正在根据朗读内容定位…')
    try {
      const wav = encodePcmWav(input, followSampleRate.current)
      const result = await api.transcribeChunk(followSessionId.current, sequence, wav)
      if (result.transcript) {
        const next = alignTranscript(phrases, activePhraseRef.current, result.transcript)
        if (next > activePhraseRef.current) {
          activePhraseRef.current = next
          setActivePhrase(next)
          window.requestAnimationFrame(() => scrollToPhrase(next))
        }
        setFollowMessage(next > 0 ? '跟读定位中' : '正在识别开头内容…')
      }
    } catch (error) {
      setFollowMessage(`${error instanceof Error ? error.message : '跟读识别暂时不可用'}；录音仍在继续。`)
    } finally {
      followInFlight.current = false
    }
  }

  const collectFollowFrame = (data: Float32Array, sampleRate: number, rms: number) => {
    if (!context.follow_along_enabled) return
    const copy = new Float32Array(data)
    followChunks.current.push(copy)
    followSampleCount.current += copy.length
    followSampleRate.current = sampleRate
    const frameMs = copy.length / sampleRate * 1000
    followSilenceMs.current = rms < 0.018 ? followSilenceMs.current + frameMs : 0
    const duration = followSampleCount.current / sampleRate
    if (duration >= 15 || (duration >= 12 && followSilenceMs.current >= 450)) void flushFollowChunk()
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
    void flushFollowChunk(true)
    if (mediaRecorder.current?.state === 'recording') mediaRecorder.current.stop()
    else if (pcmCapture.current) finishPcmRecording()
  }

  const submit = async () => {
    if (!blob) return
    setRecorderState('uploading'); setProgress(0); setMessage('正在安全上传录音…')
    try {
      const attempt = await api.createAttempt({ client_duration_seconds: elapsed, browser_family: navigator.userAgent.slice(0, 120), os_family: navigator.platform, recorder_settings: { ...recorderSettings.current, blobType: blob.type } })
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
  return <Shell><section className="hero-card recording-layout"><div className="topline"><span className="eyebrow">{context.participant_code}</span><span className="pill">{context.study.text_version}</span></div><h1>{context.study.title}</h1><p className="muted">{context.study.instructions}</p>{context.follow_along_enabled && <div className="asr-disclosure">录音过程中，短音频片段会发送至小米 MiMo 用于实时定位；识别文字不会保存。</div>}{!consent && <label className="consent"><input type="checkbox" checked={consent} onChange={(event) => { setConsent(event.target.checked); if (event.target.checked) api.consent(context.study.consent_version).catch((error) => setMessage(error.message)) }} />我确认已完成研究人员要求的校外知情同意流程</label>}<article ref={reader} className={`reading-text ${showReadingProgress ? 'following' : ''}`} onTouchStart={() => { manualScrollUntil.current = Date.now() + 5000 }} onWheel={() => { manualScrollUntil.current = Date.now() + 5000 }}>{phrases.map((phrase, index) => <span ref={(element) => { phraseElements.current[index] = element }} className={`reading-phrase ${showReadingProgress && index < activePhrase ? 'completed' : ''} ${showReadingProgress && index === activePhrase ? 'active' : ''}`} key={phrase.id}>{phrase.text}</span>)}</article><div className="recorder-panel"><div className="timer">{formatSeconds(elapsed)}<small>/ 约 {formatSeconds(context.study.expected_seconds)}</small></div><div className="meter"><span style={{ transform: `scaleX(${Math.max(0.02, level)})` }} /></div>{followMessage && recorderState === 'recording' && <div className="follow-status">{followMessage}</div>}{message && <div className="notice">{message}</div>}{recorderState === 'review' && audioUrl && <audio controls src={audioUrl} className="audio-preview" />}{recorderState === 'uploading' && <div className="upload-progress"><span style={{ width: `${progress * 100}%` }} /></div>}<div className="actions">{recorderState === 'idle' || recorderState === 'error' ? <button className="primary" onClick={beginRecording} disabled={!consent}>开始录音</button> : recorderState === 'recording' ? <button className="danger" onClick={stopRecording}>结束录音</button> : recorderState === 'review' ? <><button className="secondary" onClick={() => { setBlob(null); setAudioUrl(''); setElapsed(0); setRecorderState('idle'); resetFollowAlong() }}>重新录制</button><button className="primary" onClick={submit}>提交录音</button></> : recorderState === 'processing' ? <span className="muted">后台处理中…</span> : null}</div></div></section></Shell>
}

function AdminApp() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [username, setUsername] = useState('researcher')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [dashboard, setDashboard] = useState<{ study: Study | null; total: number; submitted: number; processing: number } | null>(null)
  const [recordings, setRecordings] = useState<Array<{ participant_code: string; attempt: Attempt }>>([])
  const [error, setError] = useState('')
  const [studyForm, setStudyForm] = useState({ title: '学生朗读录音任务', text: '', instructions: '请在安静环境中使用手机完成录音，并保持手机位置稳定。', consent_version: 'consent-v2-mimo-asr' })
  const [inviteLinks, setInviteLinks] = useState<string[]>([])
  const [exportMessage, setExportMessage] = useState('')
  const [exportLink, setExportLink] = useState('')

  const refresh = async () => { const [summary, list] = await Promise.all([api.adminDashboard(), api.recordings()]); setDashboard(summary); setRecordings(list.items) }
  const login = async () => { try { await api.adminLogin(username, password, otp); setLoggedIn(true); await refresh() } catch (err) { setError(err instanceof Error ? err.message : '登录失败') } }
  if (!loggedIn) return <Shell eyebrow="VOICE COLLECTOR / ADMIN"><section className="hero-card narrow"><div className="eyebrow">研究人员后台</div><h1>登录管理控制台</h1><label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>验证码（如已配置）<input value={otp} onChange={(event) => setOtp(event.target.value)} /></label>{error && <div className="notice error">{error}</div>}<button className="primary" onClick={login}>登录</button></section></Shell>
  return <Shell eyebrow="VOICE COLLECTOR / ADMIN"><section className="admin-header"><div><div className="eyebrow">研究控制台</div><h1>录音采集进度</h1></div><button className="secondary" onClick={() => refresh().catch((err) => setError(err.message))}>刷新</button></section>{dashboard && <div className="stats"><div><span>邀请码</span><strong>{dashboard.total}</strong></div><div><span>已提交</span><strong>{dashboard.submitted}</strong></div><div><span>处理中</span><strong>{dashboard.processing}</strong></div></div>}<div className="admin-grid"><section className="panel"><h2>创建任务</h2><label>标题<input value={studyForm.title} onChange={(event) => setStudyForm({ ...studyForm, title: event.target.value })} /></label><label>固定文本<textarea rows={8} value={studyForm.text} onChange={(event) => setStudyForm({ ...studyForm, text: event.target.value })} /></label><label>说明<textarea rows={3} value={studyForm.instructions} onChange={(event) => setStudyForm({ ...studyForm, instructions: event.target.value })} /></label><label>知情同意版本<input value={studyForm.consent_version} onChange={(event) => setStudyForm({ ...studyForm, consent_version: event.target.value })} /></label><div className="actions"><button className="primary" onClick={async () => { try { const study = await api.createStudy({ ...studyForm }); await api.openStudy(study.id); const links = await api.createInvites(study.id, 100); setInviteLinks(links.map((item) => `${item.participant_code},${item.url}`)); await refresh() } catch (err) { setError(err instanceof Error ? err.message : '创建失败') } }}>创建并生成 100 个邀请码</button></div>{inviteLinks.length > 0 && <div className="invite-output"><p>邀请码已生成，可下载完整 CSV：</p><textarea readOnly rows={6} value={inviteLinks.slice(0, 10).join('\n')} /><button className="secondary" onClick={() => downloadCsv(['participant_code,url', ...inviteLinks])}>下载全部 100 个邀请码 CSV</button></div>}{dashboard?.study && <div className="actions export-actions"><button className="secondary" onClick={async () => { try { const job = await api.createExport(dashboard.study!.id); setExportMessage(`导出任务已创建：${job.id.slice(0, 8)}，正在生成…`); for (let index = 0; index < 30; index += 1) { await new Promise((resolve) => window.setTimeout(resolve, 1000)); const result = await api.exportStatus(job.id); if (result.state === 'done' && result.download_url) { setExportLink(result.download_url); setExportMessage('导出包已准备好。'); break } if (result.state === 'failed') throw new Error(result.error_message ?? '导出失败') } } catch (err) { setExportMessage(err instanceof Error ? err.message : '导出失败') } }}>生成全部录音导出包</button>{exportMessage && <span className="muted">{exportMessage}</span>}{exportLink && <a className="secondary export-link" href={exportLink}>下载 ZIP</a>}</div>}</section><section className="panel"><h2>最近录音</h2>{error && <div className="notice error">{error}</div>}<div className="recording-list">{recordings.length === 0 ? <p className="muted">还没有录音。</p> : recordings.map(({ participant_code, attempt }) => <div className="recording-row" key={attempt.id}><div><strong>{participant_code}</strong><span>{attempt.state} · {attempt.qc_status} · {attempt.duration_seconds ? formatSeconds(attempt.duration_seconds) : '待处理'}</span></div><select value={attempt.qc_status} onChange={async (event) => { await api.updateQc(attempt.id, event.target.value); await refresh() }}><option value="pending">待审核</option><option value="pass">通过</option><option value="review">复核</option><option value="reject">拒绝</option></select></div>)}</div></section></div></Shell>
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
  if (screen === 'admin') return <AdminApp />
  if (screen === 'unsupported') return <UnsupportedBrowser />
  if (screen === 'token') return <><TokenEntry onSubmit={(token) => { setScreen('loading'); api.exchange(token).then(loadStudent).catch((err) => { setError(err instanceof Error ? err.message : '邀请链接无效'); setScreen('token') }) }} />{error && <div className="floating-error">{error}</div>}</>
  return context ? <StudentApp context={context} onRefresh={loadStudent} /> : null
}
