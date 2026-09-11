export type ReadingPhrase = {
  id: number
  text: string
  normalized: string
}

export type FollowProgressSnapshot = {
  activePhrase: number
  speaking: boolean
  voicedSeconds: number
}

const BREAK_AFTER = /[，。！？；：,.!?;:\n]/

export function normalizeReadingText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

export function segmentReadingText(text: string, maxNormalizedLength = 15): ReadingPhrase[] {
  const phrases: ReadingPhrase[] = []
  let buffer = ''

  const pushBuffer = () => {
    if (!buffer) return
    let part = ''
    let normalizedLength = 0
    for (const character of buffer) {
      part += character
      if (normalizeReadingText(character)) normalizedLength += 1
      if (normalizedLength >= maxNormalizedLength) {
        phrases.push({ id: phrases.length, text: part, normalized: normalizeReadingText(part) })
        part = ''
        normalizedLength = 0
      }
    }
    if (part) phrases.push({ id: phrases.length, text: part, normalized: normalizeReadingText(part) })
    buffer = ''
  }

  for (const character of text) {
    buffer += character
    if (BREAK_AFTER.test(character)) pushBuffer()
  }
  pushBuffer()
  return phrases.filter((phrase) => phrase.text.length > 0)
}

function levenshteinSimilarity(left: string, right: string): number {
  if (!left || !right) return 0
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const current = new Array<number>(right.length + 1)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index]
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length)
}

export function alignTranscript(phrases: ReadingPhrase[], currentIndex: number, transcript: string): number {
  const recognized = normalizeReadingText(transcript)
  if (recognized.length < 4 || phrases.length === 0) return currentIndex

  const startFloor = Math.max(0, currentIndex - 2)
  const startCeiling = Math.min(phrases.length - 1, currentIndex + 20)
  let best = { score: 0, start: currentIndex, end: currentIndex }

  for (let start = startFloor; start <= startCeiling; start += 1) {
    let candidate = ''
    for (let end = start; end < Math.min(phrases.length, start + 10); end += 1) {
      candidate += phrases[end].normalized
      if (!candidate) continue
      const similarity = levenshteinSimilarity(recognized, candidate)
      const lengthBalance = Math.min(recognized.length, candidate.length) / Math.max(recognized.length, candidate.length)
      const score = similarity * 0.8 + lengthBalance * 0.2
      if (score > best.score) best = { score, start, end }
    }
  }

  const jump = best.end - currentIndex
  const requiredScore = jump > 8 ? 0.72 : 0.58
  return best.score >= requiredScore && best.end >= currentIndex ? best.end : currentIndex
}

export class FollowProgressTracker {
  private readonly phraseEnds: number[]
  private readonly totalCharacters: number
  private readonly baseRate: number
  private rate: number
  private voicedSeconds = 0
  private anchorVoicedSeconds = 0
  private anchorCharacters = 0
  private displayCharacters = 0
  private confirmedPhrase = 0
  private speaking = false
  private silenceSeconds = 0

  constructor(private readonly phrases: ReadingPhrase[], expectedSeconds: number) {
    let total = 0
    this.phraseEnds = phrases.map((phrase) => {
      total += Math.max(1, phrase.normalized.length)
      return total
    })
    this.totalCharacters = total
    this.baseRate = total / Math.max(1, expectedSeconds)
    this.rate = this.baseRate
  }

  addFrame(rms: number, durationSeconds: number): FollowProgressSnapshot {
    const startsSpeaking = rms >= 0.018
    const staysSpeaking = rms >= 0.012
    if (startsSpeaking) {
      this.speaking = true
      this.silenceSeconds = 0
    } else if (this.speaking && staysSpeaking) {
      this.silenceSeconds = 0
    } else if (this.speaking) {
      this.silenceSeconds += durationSeconds
      if (this.silenceSeconds >= 0.6) this.speaking = false
    }

    if (this.speaking) this.voicedSeconds += durationSeconds
    const estimated = this.anchorCharacters + (this.voicedSeconds - this.anchorVoicedSeconds) * this.rate
    this.displayCharacters = Math.min(this.totalCharacters, Math.max(this.displayCharacters, estimated))
    return this.snapshot()
  }

  confirmPhrase(index: number): FollowProgressSnapshot {
    if (!this.phrases.length) return this.snapshot()
    const bounded = Math.max(this.confirmedPhrase, Math.min(index, this.phrases.length - 1))
    const confirmedCharacters = this.phraseEnds[bounded]
    const voiceDelta = this.voicedSeconds - this.anchorVoicedSeconds
    const characterDelta = confirmedCharacters - this.anchorCharacters
    if (voiceDelta >= 1 && characterDelta > 0) {
      const observedRate = characterDelta / voiceDelta
      const boundedRate = Math.min(this.baseRate * 2.2, Math.max(this.baseRate * 0.45, observedRate))
      this.rate = this.rate * 0.65 + boundedRate * 0.35
    }
    this.confirmedPhrase = bounded
    this.anchorCharacters = confirmedCharacters
    this.anchorVoicedSeconds = this.voicedSeconds
    this.displayCharacters = Math.max(this.displayCharacters, confirmedCharacters)
    return this.snapshot()
  }

  private snapshot(): FollowProgressSnapshot {
    let activePhrase = 0
    while (activePhrase < this.phraseEnds.length - 1 && this.displayCharacters >= this.phraseEnds[activePhrase]) activePhrase += 1
    return { activePhrase, speaking: this.speaking, voicedSeconds: this.voicedSeconds }
  }
}

export class FollowAudioBuffer {
  private chunks: Float32Array[] = []
  private sampleRate = 0
  private sampleCount = 0
  private newSampleCount = 0

  constructor(private readonly maxWindowSeconds: number) {}

  push(data: Float32Array, sampleRate: number, countTowardInterval = true): void {
    if (this.sampleRate && this.sampleRate !== sampleRate) this.clear()
    this.sampleRate = sampleRate
    const copy = new Float32Array(data)
    this.chunks.push(copy)
    this.sampleCount += copy.length
    if (countTowardInterval) this.newSampleCount += copy.length
    this.trimTo(Math.round(this.maxWindowSeconds * sampleRate))
  }

  takeReadyWindow(intervalSeconds: number): { chunks: Float32Array[]; sampleRate: number } | null {
    if (!this.sampleRate || this.newSampleCount / this.sampleRate < intervalSeconds) return null
    this.newSampleCount = 0
    return { chunks: [...this.chunks], sampleRate: this.sampleRate }
  }

  isReady(intervalSeconds: number): boolean {
    return Boolean(this.sampleRate && this.newSampleCount / this.sampleRate >= intervalSeconds)
  }

  clear(): void {
    this.chunks = []
    this.sampleRate = 0
    this.sampleCount = 0
    this.newSampleCount = 0
  }

  private trimTo(maxSamples: number): void {
    if (this.sampleCount <= maxSamples) return
    let remaining = maxSamples
    const retained: Float32Array[] = []
    for (let index = this.chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = this.chunks[index]
      const take = Math.min(remaining, chunk.length)
      retained.unshift(take === chunk.length ? chunk : chunk.slice(chunk.length - take))
      remaining -= take
    }
    this.chunks = retained
    this.sampleCount = maxSamples
  }
}

export function encodePcmWav(inputChunks: Float32Array[], sourceRate: number, targetRate = 16000): Blob {
  const sourceLength = inputChunks.reduce((total, chunk) => total + chunk.length, 0)
  const source = new Float32Array(sourceLength)
  let sourceOffset = 0
  for (const chunk of inputChunks) {
    source.set(chunk, sourceOffset)
    sourceOffset += chunk.length
  }
  const outputLength = Math.max(1, Math.round(source.length * targetRate / sourceRate))
  const output = new Int16Array(outputLength)
  const ratio = sourceRate / targetRate
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio
    const before = Math.min(source.length - 1, Math.floor(position))
    const after = Math.min(source.length - 1, before + 1)
    const fraction = position - before
    const sample = Math.max(-1, Math.min(1, source[before] + (source[after] - source[before]) * fraction))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }

  const buffer = new ArrayBuffer(44 + output.byteLength)
  const view = new DataView(buffer)
  const write = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  write(0, 'RIFF')
  view.setUint32(4, 36 + output.byteLength, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, targetRate, true)
  view.setUint32(28, targetRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, output.byteLength, true)
  new Int16Array(buffer, 44).set(output)
  return new Blob([buffer], { type: 'audio/wav' })
}
