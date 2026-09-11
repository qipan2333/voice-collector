import { describe, expect, it } from 'vitest'
import { alignTranscript, encodePcmWav, normalizeReadingText, segmentReadingText } from './followAlong'

describe('follow-along text processing', () => {
  const text = '春天来了，花儿开放。我们一起走进公园，听见小鸟歌唱。最后回到教室。'
  const phrases = segmentReadingText(text)

  it('normalizes punctuation, spacing and full-width characters', () => {
    expect(normalizeReadingText('Ａ B，春天！')).toBe('ab春天')
  })

  it('segments text on punctuation while preserving display text', () => {
    expect(phrases.map((phrase) => phrase.text).join('')).toBe(text)
    expect(phrases.length).toBeGreaterThan(3)
  })

  it('advances with minor recognition errors and never moves backward', () => {
    const first = alignTranscript(phrases, 0, '春天来啦花儿开放')
    expect(first).toBeGreaterThan(0)
    expect(alignTranscript(phrases, first, '完全无关的随机内容')).toBe(first)
    expect(alignTranscript(phrases, first, '我们一起走进公园听见小鸟唱歌')).toBeGreaterThanOrEqual(first)
  })

  it('encodes 16 kHz mono PCM WAV', async () => {
    const blob = encodePcmWav([new Float32Array(48000).fill(0.1)], 48000)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16000)
    expect(blob.size).toBe(32044)
  })
})
