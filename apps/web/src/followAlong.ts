export type ReadingPhrase = {
  id: number
  text: string
  normalized: string
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
