const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export type Study = {
  id: string;
  title: string;
  text: string;
  text_version: string;
  instructions: string;
  status: string;
  expected_seconds: number;
  min_seconds: number;
  max_seconds: number;
  consent_version: string;
  created_at: string;
  updated_at: string;
};

export type Attempt = {
  id: string;
  attempt_no: number;
  state: string;
  qc_status: string;
  auto_quality_status: string;
  review_status: "pending" | "approved" | "rejected";
  review_note?: string;
  reviewed_at?: string;
  original_mime?: string;
  original_size?: number;
  duration_seconds?: number;
  client_duration_seconds?: number;
  sample_rate?: number;
  channels?: number;
  qc_metrics?: Record<string, unknown>;
  error_message?: string;
  created_at: string;
  submitted_at?: string;
};

export type StudyStats = {
  invites_total: number;
  participants_submitted: number;
  recordings_total: number;
  processing: number;
  quality_high: number;
  quality_review: number;
  quality_reject: number;
  review_pending: number;
  review_approved: number;
  review_rejected: number;
};

export type AdminStudy = { study: Study; stats: StudyStats };

export type AdminRecording = {
  participant_code: string;
  invite_id: string;
  invite_status: string;
  invite_attempt_count: number;
  attempt: Attempt;
  reviewer_username?: string;
  quality_reasons: string[];
  audio_variants: Array<"original" | "normalized">;
};

export type Context = {
  participant_code: string;
  study: Study;
  consent_confirmed: boolean;
  follow_along_enabled: boolean;
  follow_along_interval_seconds: number;
  attempts: Attempt[];
};

type ApiErrorDetail =
  | string
  | Array<{ loc?: Array<string | number>; msg?: string }>
  | { message?: string; msg?: string };

export function formatApiError(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const payload = body as { detail?: ApiErrorDetail; message?: string };
  const detail = payload.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        const location = item.loc?.filter((part) => part !== "body").join(".");
        return [location, item.msg].filter(Boolean).join(": ");
      })
      .filter(Boolean);
    if (messages.length) return messages.join("；");
  }
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    if (typeof detail.message === "string") return detail.message;
    if (typeof detail.msg === "string") return detail.msg;
  }
  return typeof payload.message === "string" ? payload.message : fallback;
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = await response.json().catch(() => ({}));
  return formatApiError(body, fallback);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(
      await responseError(response, `请求失败 (${response.status})`),
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  exchange: (token: string) =>
    request<{ participant_code: string }>("/api/v1/participant/exchange", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  context: () => request<Context>("/api/v1/participant/context"),
  consent: (policy_version: string) =>
    request<{ confirmed: boolean }>("/api/v1/participant/consent", {
      method: "POST",
      body: JSON.stringify({ confirmed: true, policy_version }),
    }),
  createAttempt: (metadata: Record<string, unknown>) =>
    request<Attempt>("/api/v1/participant/attempts", {
      method: "POST",
      body: JSON.stringify(metadata),
    }),
  uploadAttempt: async (
    id: string,
    blob: Blob,
    onProgress?: (value: number) => void,
  ) => {
    const xhr = new XMLHttpRequest();
    await new Promise<void>((resolve, reject) => {
      xhr.open("PUT", `${API_BASE}/api/v1/participant/attempts/${id}/content`);
      xhr.withCredentials = true;
      xhr.setRequestHeader(
        "Content-Type",
        blob.type || "application/octet-stream",
      );
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let body: unknown = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* Use the status fallback for non-JSON responses. */
        }
        reject(new Error(formatApiError(body, `上传失败 (${xhr.status})`)));
      };
      xhr.onerror = () => reject(new Error("网络连接中断"));
      xhr.send(blob);
    });
  },
  finalize: (id: string) =>
    request<Attempt>(`/api/v1/participant/attempts/${id}/finalize`, {
      method: "POST",
    }),
  attemptStatus: (id: string) =>
    request<Attempt>(`/api/v1/participant/attempts/${id}/status`),
  transcribeChunk: async (sessionId: string, sequence: number, blob: Blob) => {
    const response = await fetch(`${API_BASE}/api/v1/participant/asr/chunks`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "audio/wav",
        "X-ASR-Session-Id": sessionId,
        "X-ASR-Sequence": String(sequence),
      },
      body: blob,
    });
    if (!response.ok) {
      throw new Error(
        await responseError(response, `跟读识别失败 (${response.status})`),
      );
    }
    return response.json() as Promise<{
      sequence: number;
      transcript: string;
      latency_ms: number;
    }>;
  },
  adminLogin: (username: string, password: string, otp: string) =>
    request<{ username: string }>("/api/v1/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password, otp: otp || undefined }),
    }),
  adminSession: () => request<{ username: string }>("/api/v1/admin/session"),
  adminLogout: () =>
    request<void>("/api/v1/admin/session", { method: "DELETE" }),
  adminDashboard: () =>
    request<{
      study: Study | null;
      total: number;
      submitted: number;
      processing: number;
    }>("/api/v1/admin/dashboard"),
  studies: (params = "") =>
    request<{ items: AdminStudy[]; total: number }>(
      `/api/v1/admin/studies${params ? `?${params}` : ""}`,
    ),
  study: (id: string) => request<AdminStudy>(`/api/v1/admin/studies/${id}`),
  createStudy: (body: Record<string, unknown>) =>
    request<Study>("/api/v1/admin/studies", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateStudy: (id: string, body: Record<string, unknown>) =>
    request<Study>(`/api/v1/admin/studies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  openStudy: (id: string) =>
    request<Study>(`/api/v1/admin/studies/${id}/open`, { method: "POST" }),
  closeStudy: (id: string) =>
    request<Study>(`/api/v1/admin/studies/${id}/close`, { method: "POST" }),
  archiveStudy: (id: string) =>
    request<Study>(`/api/v1/admin/studies/${id}/archive`, { method: "POST" }),
  restoreStudy: (id: string) =>
    request<Study>(`/api/v1/admin/studies/${id}/restore`, { method: "POST" }),
  createInvites: (study_id: string, count: number) =>
    request<Array<{ participant_code: string; url: string }>>(
      "/api/v1/admin/invites/bulk",
      { method: "POST", body: JSON.stringify({ study_id, count }) },
    ),
  recordings: () =>
    request<{ items: Array<{ participant_code: string; attempt: Attempt }> }>(
      "/api/v1/admin/recordings",
    ),
  studyRecordings: (id: string, params = "") =>
    request<{ items: AdminRecording[]; total: number }>(
      `/api/v1/admin/studies/${id}/recordings${params ? `?${params}` : ""}`,
    ),
  updateQc: (id: string, qc_status: string) =>
    request<Attempt>(`/api/v1/admin/recordings/${id}/qc`, {
      method: "PATCH",
      body: JSON.stringify({ qc_status }),
    }),
  updateReview: (id: string, review_status: string, note?: string) =>
    request<Attempt>(`/api/v1/admin/recordings/${id}/review`, {
      method: "PATCH",
      body: JSON.stringify({ review_status, note }),
    }),
  bulkReview: (attempt_ids: string[], review_status: string, note?: string) =>
    request<{ updated: number }>("/api/v1/admin/recordings/review/bulk", {
      method: "PATCH",
      body: JSON.stringify({ attempt_ids, review_status, note }),
    }),
  reopenInvite: (id: string) =>
    request<{ status: string }>(`/api/v1/admin/invites/${id}/reopen`, {
      method: "POST",
    }),
  audioUrl: (id: string, variant: "original" | "normalized") =>
    `${API_BASE}/api/v1/admin/recordings/${id}/audio?variant=${variant}`,
  createExport: (study_id: string, variant = "both") =>
    request<{ id: string; state: string; variant: string }>(
      "/api/v1/admin/exports",
      { method: "POST", body: JSON.stringify({ study_id, variant }) },
    ),
  exportStatus: (id: string) =>
    request<{
      id: string;
      state: string;
      download_url?: string;
      error_message?: string;
    }>(`/api/v1/admin/exports/${id}`),
};
