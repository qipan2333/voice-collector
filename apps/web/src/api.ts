const API_BASE = import.meta.env.VITE_API_BASE ?? ''

export type Study = {
  id: string
  title: string
  text: string
  text_version: string
  instructions: string
  status: string
  expected_seconds: number
  min_seconds: number
  max_seconds: number
  consent_version: string
}

export type Attempt = {
  id: string
  attempt_no: number
  state: string
  qc_status: string
  original_mime?: string
  original_size?: number
  duration_seconds?: number
  client_duration_seconds?: number
  sample_rate?: number
  channels?: number
  qc_metrics?: Record<string, unknown>
  error_message?: string
  created_at: string
  submitted_at?: string
}

export type Context = {
  participant_code: string
  study: Study
  consent_confirmed: boolean
  follow_along_enabled: boolean
  attempts: Attempt[]
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `请求失败 (${response.status})`)
  }
  return response.json() as Promise<T>
}

export const api = {
  exchange: (token: string) => request<{ participant_code: string }>('/api/v1/participant/exchange', { method: 'POST', body: JSON.stringify({ token }) }),
  context: () => request<Context>('/api/v1/participant/context'),
  consent: (policy_version: string) => request<{ confirmed: boolean }>('/api/v1/participant/consent', { method: 'POST', body: JSON.stringify({ confirmed: true, policy_version }) }),
  createAttempt: (metadata: Record<string, unknown>) => request<Attempt>('/api/v1/participant/attempts', { method: 'POST', body: JSON.stringify(metadata) }),
  uploadAttempt: async (id: string, blob: Blob, onProgress?: (value: number) => void) => {
    const xhr = new XMLHttpRequest()
    await new Promise<void>((resolve, reject) => {
      xhr.open('PUT', `${API_BASE}/api/v1/participant/attempts/${id}/content`)
      xhr.withCredentials = true
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream')
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total)
      }
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`上传失败 (${xhr.status})`))
      xhr.onerror = () => reject(new Error('网络连接中断'))
      xhr.send(blob)
    })
  },
  finalize: (id: string) => request<Attempt>(`/api/v1/participant/attempts/${id}/finalize`, { method: 'POST' }),
  attemptStatus: (id: string) => request<Attempt>(`/api/v1/participant/attempts/${id}/status`),
  transcribeChunk: async (sessionId: string, sequence: number, blob: Blob) => {
    const response = await fetch(`${API_BASE}/api/v1/participant/asr/chunks`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'audio/wav',
        'X-ASR-Session-Id': sessionId,
        'X-ASR-Sequence': String(sequence),
      },
      body: blob,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { detail?: string }
      throw new Error(body.detail ?? `跟读识别失败 (${response.status})`)
    }
    return response.json() as Promise<{ sequence: number; transcript: string; latency_ms: number }>
  },
  adminLogin: (username: string, password: string, otp: string) => request<{ username: string }>('/api/v1/admin/login', { method: 'POST', body: JSON.stringify({ username, password, otp: otp || undefined }) }),
  adminDashboard: () => request<{ study: Study | null; total: number; submitted: number; processing: number }>('/api/v1/admin/dashboard'),
  createStudy: (body: Record<string, unknown>) => request<Study>('/api/v1/admin/studies', { method: 'POST', body: JSON.stringify(body) }),
  openStudy: (id: string) => request<Study>(`/api/v1/admin/studies/${id}/open`, { method: 'POST' }),
  createInvites: (study_id: string, count: number) => request<Array<{ participant_code: string; url: string }>>('/api/v1/admin/invites/bulk', { method: 'POST', body: JSON.stringify({ study_id, count }) }),
  recordings: () => request<{ items: Array<{ participant_code: string; attempt: Attempt }> }>('/api/v1/admin/recordings'),
  updateQc: (id: string, qc_status: string) => request<Attempt>(`/api/v1/admin/recordings/${id}/qc`, { method: 'PATCH', body: JSON.stringify({ qc_status }) }),
  createExport: (study_id: string, variant = 'both') => request<{ id: string; state: string; variant: string }>('/api/v1/admin/exports', { method: 'POST', body: JSON.stringify({ study_id, variant }) }),
  exportStatus: (id: string) => request<{ id: string; state: string; download_url?: string; error_message?: string }>(`/api/v1/admin/exports/${id}`),
}
