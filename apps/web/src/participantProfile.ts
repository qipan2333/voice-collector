import type { ParticipantInfo } from './api'

const CACHE_KEY = 'voice-collector:participant-profile:v1'
const FIELDS = ['name', 'school', 'grade', 'class_name', 'phone', 'student_number'] as const

export function readProfile(): ParticipantInfo {
  const profile: ParticipantInfo = { name: '', school: '', grade: '', class_name: '', phone: '', student_number: '' }
  try {
    const cached: unknown = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? 'null')
    if (cached && typeof cached === 'object') {
      for (const key of FIELDS) {
        const value = (cached as Record<string, unknown>)[key]
        if (typeof value === 'string') profile[key] = value
      }
    }
  } catch {
    // Private browsing and malformed cache must not block participation.
  }
  return profile
}

export function cacheProfile(profile: ParticipantInfo): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(profile))
  } catch {
    // Continue normally when local storage is unavailable or full.
  }
}
