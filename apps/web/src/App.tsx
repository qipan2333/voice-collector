import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, Context, type ParticipantInfo } from './api'
import { CONSENT_TEXT, MIN_RECORDING_SECONDS } from './experiment'
import { AdminApp as AdminWorkbench } from './AdminApp'
import { detectHostApp } from './hostApp'
import { browserWakeEnvironment, keepScreenAwake, type ScreenWakeStatus } from './screenWakeLock'
import { cacheProfile, readProfile } from './participantProfile'

type Screen = 'loading' | 'token' | 'student' | 'admin' | 'unsupported'
type RecorderState = 'idle' | 'checking' | 'recording' | 'review' | 'uploading' | 'processing' | 'error'

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
  return <Shell><section className="hero-card narrow"><div className="status-icon warning">!</div><div className="eyebrow">浏览器不受支持</div><h1>请在微信或手机 QQ 中打开</h1><p className="muted">复制当前任务链接，发送到微信或手机 QQ 后，在应用内点击链接继续。</p><button className="primary" onClick={copyLink}>复制任务链接</button></section></Shell>
}

function TokenEntry({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('')
  return <Shell><section className="hero-card narrow"><div className="eyebrow">参与语音任务</div><h1>准备好后，开始你的录音。</h1><p className="muted">请打开研究人员发给你的任务链接。如果你是手动进入，也可以在这里粘贴任务链接。</p><label>任务链接或代码<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="粘贴任务链接或代码" /></label><button className="primary" disabled={!value.trim()} onClick={() => onSubmit(value.trim().split('/').pop() ?? value.trim())}>继续</button></section></Shell>
}

export function StudentApp({ context, onRefresh }: { context: Context; onRefresh: () => Promise<void> }) {
  const [agreed, setAgreed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(true)
  const [profile, setProfile] = useState<ParticipantInfo>(() => context.participant_info ?? readProfile())
  useEffect(() => { cacheProfile(profile) }, [profile])
  const attempts = context.attempts.filter((item) => item.recording_round === context.recording_round)
  const readingDone = attempts.some((item) => item.task_type === 'reading' && item.state === 'ready')
  const expressionDone = attempts.some((item) => item.task_type === 'self_expression' && item.state === 'ready')
  const taskType = readingDone ? 'self_expression' : 'reading'
  const pending = attempts.find((item) => item.task_type === taskType && ['queued', 'processing'].includes(item.state))
  const failed = attempts.filter((item) => item.task_type === taskType && item.state === 'failed').at(-1)
  useEffect(() => {
    if (!pending) return
    const interval = window.setInterval(() => { void onRefresh().catch(() => setError('状态更新失败，请检查网络或稍后重试。')) }, 3000)
    return () => window.clearInterval(interval)
  }, [pending?.id, onRefresh])

  if (readingDone && expressionDone) return <Shell><section className="hero-card narrow"><div className="status-icon success">✓</div><h1>两道题均已提交</h1><p>朗读题和自我表述题已保存，感谢你的参与。</p><p className="muted">再次打开任务链接即可开始新的填写和录音。</p></section></Shell>
  if (!context.consent_confirmed) return <Shell><section className="hero-card narrow"><div className="eyebrow">第 1 / 4 步</div><h1>知情同意</h1><div className="consent-copy">{CONSENT_TEXT.split('\n\n').map((text) => <p key={text}>{text}</p>)}</div><label className="consent"><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />我已阅读并同意参加本次研究</label>{error && <div className="notice error" role="alert">{error}</div>}<button className="primary" disabled={!agreed || saving} onClick={async () => { setSaving(true); setError(''); try { await api.consent(context.study.consent_version); await onRefresh() } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试') } finally { setSaving(false) } }}>{saving ? '保存中…' : '同意并继续'}</button></section></Shell>
  if (!context.participant_info || editing) {
    const setField = (key: keyof ParticipantInfo, value: string) => setProfile((current) => ({ ...current, [key]: value }))
    return <Shell><section className="hero-card narrow"><div className="eyebrow">第 2 / 4 步</div><h1>填写个人信息</h1><p className="muted">请确认信息准确，填写完成后开始录音。</p><form onSubmit={async (event) => { event.preventDefault(); setSaving(true); setError(''); try { await api.saveProfile(profile); await onRefresh(); setEditing(false) } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试') } finally { setSaving(false) } }}>
      <label>你的名字<input required maxLength={100} autoComplete="name" value={profile.name} onChange={(event) => setField('name', event.target.value)} /></label>
      {([['school', '你的学校', 200], ['grade', '你的年级', 100], ['class_name', '你的班级', 100]] as const).map(([key, label, maxLength]) => <label key={key}>{label}<input required maxLength={maxLength} value={profile[key]} onChange={(event) => setField(key, event.target.value)} /></label>)}
      <label>你的手机号<input required type="tel" inputMode="tel" autoComplete="tel" pattern="1[0-9]{10}" maxLength={11} title="请输入11位手机号" value={profile.phone} onChange={(event) => setField('phone', event.target.value)} /></label>
      <label>你的学号<input required maxLength={100} value={profile.student_number} onChange={(event) => setField('student_number', event.target.value)} /></label>
      {error && <div className="notice error" role="alert">{error}</div>}<button className="primary" disabled={saving || context.study.status !== 'open'}>{saving ? '保存中…' : '保存并继续'}</button>
    </form></section></Shell>
  }
  if (pending) return <Shell><section className="hero-card narrow"><div className="spinner" /><h1>录音正在检查</h1><p>{taskType === 'reading' ? '朗读题处理完成后，将进入自我表述题。' : '自我表述题处理完成后，即完成本次任务。'}</p><p className="muted">录音已经收到，请留在此页面等待处理。</p>{error && <div className="notice error">{error}</div>}<button className="secondary" onClick={() => { void onRefresh().catch(() => setError('状态更新失败，请稍后重试')) }}>刷新状态</button></section></Shell>
  return <Recorder key={`${context.recording_round}-${taskType}`} context={context} taskType={taskType} onRefresh={onRefresh} onEditProfile={() => setEditing(true)} previousError={failed?.error_message} />
}

export function Recorder({ context, taskType, onRefresh, onEditProfile, previousError }: { context: Context; taskType: 'reading' | 'self_expression'; onRefresh: () => Promise<void>; onEditProfile: () => void; previousError?: string }) {
  const isReading = taskType === 'reading'
  const minimumSeconds = isReading ? 0 : MIN_RECORDING_SECONDS
  const [recorderState, setRecorderState] = useState<RecorderState>('idle')
  const [wakeStatus, setWakeStatus] = useState<ScreenWakeStatus>('requesting')
  const [wakeRetry, setWakeRetry] = useState(0)
  useEffect(() => {
    if (recorderState !== 'recording') return
    return keepScreenAwake(setWakeStatus, browserWakeEnvironment())
  }, [recorderState, wakeRetry])
  const [message, setMessage] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [progress, setProgress] = useState(0)
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | undefined>(undefined)
  const audioContext = useRef<AudioContext | null>(null)
  const pcmCapture = useRef<PcmCapture | null>(null)
  const recorderSettings = useRef<Record<string, unknown>>({})
  const startedAt = useRef(0)
  const submittedAttemptId = useRef<string | null>(null)
  const uploadComplete = useRef(false)

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl) }, [audioUrl])

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
    setMessage('当前环境使用兼容录音模式，请自然表述。')
    startedAt.current = performance.now()
    timer.current = window.setInterval(() => setElapsed(Math.floor((performance.now() - startedAt.current) / 1000)), 250)
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
    if (!context.consent_confirmed || !context.participant_info) return
    submittedAttemptId.current = null
    uploadComplete.current = false
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
      setRecorderState('recording'); setElapsed(0); setMessage(isReading ? '请按平常的语速、语调朗读。' : '请自由表述，尽可能多地介绍自己和生活。')
      startedAt.current = performance.now()
      timer.current = window.setInterval(() => setElapsed(Math.floor((performance.now() - startedAt.current) / 1000)), 250)
      try {
        await startAudioProcessing(input, false)
      } catch {
        // The level meter is optional; MediaRecorder continues recording.
      }
    } catch (error) {
      stopStream()
      setRecorderState('error')
      setMessage(mediaErrorMessage(error))
    }
  }

  const stopRecording = () => {
    if ((performance.now() - startedAt.current) / 1000 < minimumSeconds) return
    if (mediaRecorder.current?.state === 'recording') mediaRecorder.current.stop()
    else if (pcmCapture.current) finishPcmRecording()
  }

  const submit = async () => {
    if (!blob || elapsed < minimumSeconds) return
    setRecorderState('uploading'); setProgress(0); setMessage('正在安全上传录音…')
    try {
      if (!submittedAttemptId.current) {
        const attempt = await api.createAttempt({ task_type: taskType, client_duration_seconds: elapsed, browser_family: detectHostApp(navigator.userAgent), os_family: navigator.platform.slice(0, 100), recorder_settings: { ...recorderSettings.current, blobType: blob.type } })
        submittedAttemptId.current = attempt.id
      }
      if (!uploadComplete.current) {
        await api.uploadAttempt(submittedAttemptId.current, blob, setProgress)
        uploadComplete.current = true
      }
      await api.finalize(submittedAttemptId.current)
      setRecorderState('processing'); setMessage('录音已收到，正在进行格式检查…')
      await onRefresh()
    } catch (error) {
      setRecorderState('review'); setMessage(error instanceof Error ? error.message : '提交失败，请重试。')
    }
  }

  const taskOpen = context.study.status === 'open'
  return <Shell><section className="hero-card recording-layout">
    <div className="topline"><span className="eyebrow">第 {isReading ? '3' : '4'} / 4 步 · {context.participant_code}</span><span className="pill">{isReading ? '朗读题' : '自我表述题'}</span></div>
    <h1>{isReading ? '朗读题' : '自我表述题'}</h1>
    <p className="muted">{context.study.instructions}</p>
    {isReading && <p>请你按照平常朗读文字的语速、语调完成下方文字段落的朗读。</p>}
    <p className="notice">{isReading ? '朗读题不限时长，读完下方文字后即可点击“完成”。' : '请自由表述至少3分钟，尽可能多地介绍自己和生活。满3分钟后“完成”按钮将变绿。'}</p>
    <p className="muted">录音时请保持页面在前台，不要手动锁屏。开始后会尝试开启屏幕常亮。</p>
    <p className="muted">准备好后按“开始”进行表述，结束后按“完成”，试听确认后提交语音。</p>
    {!taskOpen && <div className="notice error">任务已经关闭，无法开始新的录音。</div>}
    {previousError && <div className="notice error">上一段录音处理失败：{previousError}。请重新录制。</div>}
    {isReading ? <article className="reading-text">{context.study.text}</article> : <article className="reading-text expression-prompt">{context.study.self_expression_prompt}</article>}
    <div className="recorder-panel"><div className="timer">{formatSeconds(elapsed)}<small>{isReading ? '读完即可完成' : '/ 至少 03:00'}</small></div><div className="meter"><span style={{ transform: `scaleX(${Math.max(0.02, level)})` }} /></div>
    {recorderState === 'recording' && <div className="notice" role="status">{wakeStatus === 'active' ? '屏幕常亮已开启，录音结束后自动恢复。' : wakeStatus === 'requesting' ? '正在请求屏幕常亮…' : <><span>当前未能保持屏幕常亮，请将手机自动锁屏时间调长或设为“永不”，并保持本页面在前台。</span><button className="secondary" onClick={() => setWakeRetry((value) => value + 1)}>重试屏幕常亮</button></>}</div>}
    {message && <div className="notice" role="status">{message}</div>}
    {recorderState === 'review' && elapsed < minimumSeconds && <div className="notice error">录音不足3分钟，请重新录制。</div>}
    {recorderState === 'review' && audioUrl && <audio controls src={audioUrl} className="audio-preview" />}
    {recorderState === 'uploading' && <div className="upload-progress"><span style={{ width: `${progress * 100}%` }} /></div>}
    <div className="actions">{recorderState === 'idle' || recorderState === 'error' ? <><button className="secondary" onClick={onEditProfile}>修改个人信息</button><button className="primary" onClick={beginRecording} disabled={!taskOpen}>开始</button></> : recorderState === 'recording' ? <button className="complete-recording" disabled={elapsed < minimumSeconds} onClick={stopRecording}>{elapsed < minimumSeconds ? `完成（还需 ${formatSeconds(minimumSeconds - elapsed)}）` : '完成'}</button> : recorderState === 'review' ? <><button className="secondary" onClick={() => { setBlob(null); setAudioUrl(''); setElapsed(0); setRecorderState('idle') }}>重新录制</button><button className="primary" disabled={elapsed < minimumSeconds} onClick={submit}>提交{isReading ? '朗读题' : '自我表述题'}</button></> : recorderState === 'processing' ? <span className="muted">后台处理中…</span> : null}</div></div>
  </section></Shell>

}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [context, setContext] = useState<Context | null>(null)
  const [error, setError] = useState('')
  const initialized = useRef(false)

  const loadStudent = useCallback(async () => { const result = await api.context(); setContext(result); setScreen('student') }, [])
  useEffect(() => {
    const openRoute = () => {
      if (window.location.hash.startsWith('#/admin')) return setScreen('admin')
      if (detectHostApp(navigator.userAgent) === 'unsupported') return setScreen('unsupported')
      if (window.location.hash === '#/student') {
        loadStudent().catch((err) => { setError(err instanceof Error ? err.message : '会话已失效'); setScreen('token') })
        return
      }
      const token = tokenFromHash()
      if (!token) return setScreen('token')
      setScreen('loading')
      setContext(null)
      setError('')
      api.exchange(token).then(() => { window.history.replaceState({}, '', `${window.location.pathname}#/student`); return loadStudent() }).catch((err) => { setError(err instanceof Error ? err.message : '任务链接无效'); setScreen('token') })
    }
    if (!initialized.current) {
      initialized.current = true
      openRoute()
    }
    window.addEventListener('hashchange', openRoute)
    return () => window.removeEventListener('hashchange', openRoute)
  }, [loadStudent])

  if (screen === 'loading') return <Shell><section className="hero-card narrow"><div className="spinner" /><p>正在准备页面…</p></section></Shell>
  if (screen === 'admin') return <AdminWorkbench />
  if (screen === 'unsupported') return <UnsupportedBrowser />
  if (screen === 'token') return <><TokenEntry onSubmit={(token) => { setScreen('loading'); api.exchange(token).then(() => { window.history.replaceState({}, '', `${window.location.pathname}#/student`); return loadStudent() }).catch((err) => { setError(err instanceof Error ? err.message : '任务链接无效'); setScreen('token') }) }} />{error && <div className="floating-error">{error}</div>}</>
  return context ? <StudentApp key={`${context.study.id}-${context.participant_code}`} context={context} onRefresh={loadStudent} /> : null
}
