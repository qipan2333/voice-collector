import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Check,
  Download,
  FileDown,
  LogOut,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Upload,
  X,
} from "lucide-react";
import { api, type AdminRecording, type AdminStudy, type Study } from "./api";

type AdminTab = "overview" | "recordings" | "distribution";
type StudyForm = Pick<
  Study,
  | "title"
  | "text"
  | "instructions"
  | "expected_seconds"
  | "min_seconds"
  | "max_seconds"
  | "consent_version"
>;

const EMPTY_FORM: StudyForm = {
  title: "学生朗读录音任务",
  text: "",
  instructions: "请在安静环境中使用手机完成录音，并保持手机位置稳定。",
  expected_seconds: 180,
  min_seconds: 30,
  max_seconds: 480,
  consent_version: "consent-v2-mimo-asr",
};

const STUDY_STATUS: Record<string, string> = {
  draft: "草稿",
  open: "开放中",
  closed: "已关闭",
  archived: "已归档",
};
const QUALITY_STATUS: Record<string, string> = {
  pending: "待处理",
  pass: "质量高",
  review: "需复核",
  reject: "不合格",
};
const REVIEW_STATUS: Record<string, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
};

function formatSeconds(seconds?: number) {
  if (seconds == null) return "待处理";
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const rest = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatDate(value?: string) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
}

function downloadCsv(lines: string[]) {
  const blob = new Blob([`${lines.join("\n")}\n`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "voice-collector-invites.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function taskIdFromHash() {
  return window.location.hash.match(/^#\/admin\/studies\/([^/]+)/)?.[1] ?? "";
}

function TaskEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: StudyForm;
  onCancel: () => void;
  onSave: (form: StudyForm) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof StudyForm>(key: K, value: StudyForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <div className="admin-modal-backdrop" role="presentation">
      <section
        className="admin-modal"
        role="dialog"
        aria-modal="true"
        aria-label="任务编辑"
      >
        <header>
          <div>
            <span className="admin-kicker">任务设置</span>
            <h2>{initial.text ? "编辑草稿任务" : "新建任务"}</h2>
          </div>
          <button className="icon-button" onClick={onCancel} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="task-form-grid">
          <label>
            任务名称
            <input
              value={form.title}
              onChange={(event) => set("title", event.target.value)}
            />
          </label>
          <label className="wide">
            朗读文本
            <textarea
              rows={10}
              value={form.text}
              onChange={(event) => set("text", event.target.value)}
            />
          </label>
          <label className="wide">
            参与说明
            <textarea
              rows={3}
              value={form.instructions}
              onChange={(event) => set("instructions", event.target.value)}
            />
          </label>
          <label>
            预计时长（秒）
            <input
              type="number"
              value={form.expected_seconds}
              onChange={(event) =>
                set("expected_seconds", Number(event.target.value))
              }
            />
          </label>
          <label>
            最短时长（秒）
            <input
              type="number"
              value={form.min_seconds}
              onChange={(event) =>
                set("min_seconds", Number(event.target.value))
              }
            />
          </label>
          <label>
            最长时长（秒）
            <input
              type="number"
              value={form.max_seconds}
              onChange={(event) =>
                set("max_seconds", Number(event.target.value))
              }
            />
          </label>
          <label>
            知情同意版本
            <input
              value={form.consent_version}
              onChange={(event) => set("consent_version", event.target.value)}
            />
          </label>
        </div>
        {error && <div className="notice error">{error}</div>}
        <footer className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            取消
          </button>
          <button
            className="primary"
            disabled={saving || !form.title.trim() || !form.text.trim()}
            onClick={async () => {
              setSaving(true);
              setError("");
              try {
                await onSave(form);
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "保存失败");
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "保存中…" : "保存任务"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function AdminApp() {
  const [authState, setAuthState] = useState<"checking" | "login" | "ready">(
    "checking",
  );
  const [username, setUsername] = useState("researcher");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [tasks, setTasks] = useState<AdminStudy[]>([]);
  const [selectedId, setSelectedId] = useState(taskIdFromHash());
  const [detail, setDetail] = useState<AdminStudy | null>(null);
  const [tab, setTab] = useState<AdminTab>("overview");
  const [showArchived, setShowArchived] = useState(false);
  const [taskQuery, setTaskQuery] = useState("");
  const [editor, setEditor] = useState<"create" | "edit" | null>(null);
  const [recordings, setRecordings] = useState<AdminRecording[]>([]);
  const [recordingTotal, setRecordingTotal] = useState(0);
  const [recordingPage, setRecordingPage] = useState(0);
  const [participantFilter, setParticipantFilter] = useState("");
  const [qualityFilter, setQualityFilter] = useState("");
  const [reviewFilter, setReviewFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [selectedAttempts, setSelectedAttempts] = useState<string[]>([]);
  const [playingId, setPlayingId] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [inviteCount, setInviteCount] = useState(100);
  const [exportMessage, setExportMessage] = useState("");

  const loadTasks = useCallback(
    async (preferredId?: string) => {
      const params = new URLSearchParams();
      params.set(
        "status_filter",
        showArchived ? "archived" : "draft,open,closed",
      );
      if (taskQuery.trim()) params.set("query", taskQuery.trim());
      const result = await api.studies(params.toString());
      setTasks(result.items);
      const targetId = preferredId ?? selectedId;
      const preferred =
        targetId && result.items.some((item) => item.study.id === targetId)
          ? targetId
          : (result.items[0]?.study.id ?? "");
      if (preferred !== selectedId) selectTask(preferred);
    },
    [selectedId, showArchived, taskQuery],
  );

  const loadDetail = useCallback(async (id: string) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setDetail(await api.study(id));
  }, []);

  const loadRecordings = useCallback(
    async (id: string) => {
      if (!id) return;
      const params = new URLSearchParams({
        limit: "50",
        offset: String(recordingPage * 50),
      });
      if (participantFilter.trim())
        params.set("participant", participantFilter.trim());
      if (qualityFilter) params.set("auto_quality_status", qualityFilter);
      if (reviewFilter) params.set("review_status", reviewFilter);
      if (stateFilter) params.set("state", stateFilter);
      const result = await api.studyRecordings(id, params.toString());
      setRecordings(result.items);
      setRecordingTotal(result.total);
      setSelectedAttempts([]);
    },
    [
      participantFilter,
      qualityFilter,
      recordingPage,
      reviewFilter,
      stateFilter,
    ],
  );

  const refreshSelected = useCallback(async () => {
    if (!selectedId) return;
    await Promise.all([
      loadDetail(selectedId),
      loadRecordings(selectedId),
      loadTasks(),
    ]);
  }, [loadDetail, loadRecordings, loadTasks, selectedId]);

  useEffect(() => {
    api
      .adminSession()
      .then((session) => {
        setUsername(session.username);
        setAuthState("ready");
      })
      .catch(() => setAuthState("login"));
  }, []);
  useEffect(() => {
    if (authState === "ready")
      loadTasks().catch((reason) => setError(reason.message));
  }, [authState, loadTasks]);
  useEffect(() => {
    if (authState === "ready" && selectedId)
      loadDetail(selectedId).catch((reason) => setError(reason.message));
  }, [authState, loadDetail, selectedId]);
  useEffect(() => {
    if (authState === "ready" && selectedId)
      loadRecordings(selectedId).catch((reason) => setError(reason.message));
  }, [authState, loadRecordings, selectedId]);

  function selectTask(id: string) {
    setSelectedId(id);
    setRecordingPage(0);
    setPlayingId("");
    if (id)
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}#/admin/studies/${id}`,
      );
    else
      window.history.replaceState({}, "", `${window.location.pathname}#/admin`);
  }

  async function runTaskAction(action: () => Promise<Study>) {
    setError("");
    try {
      await action();
      await refreshSelected();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    }
  }

  async function review(
    ids: string[],
    status: "pending" | "approved" | "rejected",
  ) {
    if (!ids.length) return;
    setError("");
    try {
      if (ids.length === 1)
        await api.updateReview(ids[0], status, reviewNotes[ids[0]]);
      else await api.bulkReview(ids, status);
      await refreshSelected();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审核失败");
    }
  }

  const allVisibleSelected =
    recordings.length > 0 &&
    recordings.every((item) => selectedAttempts.includes(item.attempt.id));
  const activeAudio = useMemo(
    () => recordings.find((item) => item.attempt.id === playingId),
    [playingId, recordings],
  );

  if (authState === "checking")
    return (
      <main className="admin-login">
        <div className="spinner" />
        <p>正在恢复管理员会话…</p>
      </main>
    );
  if (authState === "login")
    return (
      <main className="admin-login">
        <section>
          <span className="admin-kicker">VOICE COLLECTOR / ADMIN</span>
          <h1>管理控制台</h1>
          <label>
            用户名
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            验证码（如已配置）
            <input
              value={otp}
              onChange={(event) => setOtp(event.target.value)}
            />
          </label>
          {error && <div className="notice error">{error}</div>}
          <button
            className="primary"
            onClick={async () => {
              setError("");
              try {
                await api.adminLogin(username, password, otp);
                setPassword("");
                setAuthState("ready");
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "登录失败");
              }
            }}
          >
            登录
          </button>
        </section>
      </main>
    );

  return (
    <main className="admin-workbench">
      <header className="admin-global-header">
        <div>
          <span className="admin-kicker">VOICE COLLECTOR</span>
          <strong>录音任务管理</strong>
        </div>
        <div className="admin-header-actions">
          <span>{username}</span>
          <button
            className="icon-button"
            title="刷新"
            onClick={() =>
              refreshSelected().catch((reason) => setError(reason.message))
            }
          >
            <RefreshCw size={18} />
          </button>
          <button
            className="icon-button"
            title="退出登录"
            onClick={async () => {
              await api.adminLogout().catch(() => undefined);
              setAuthState("login");
            }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <aside className="task-sidebar">
        <div className="sidebar-heading">
          <h2>任务</h2>
          <button
            className="icon-button primary-icon"
            title="新建任务"
            onClick={() => setEditor("create")}
          >
            <Plus size={18} />
          </button>
        </div>
        <div className="task-search">
          <Search size={16} />
          <input
            aria-label="搜索任务"
            placeholder="搜索任务"
            value={taskQuery}
            onChange={(event) => setTaskQuery(event.target.value)}
          />
        </div>
        <div className="segmented">
          <button
            className={!showArchived ? "active" : ""}
            onClick={() => setShowArchived(false)}
          >
            进行中
          </button>
          <button
            className={showArchived ? "active" : ""}
            onClick={() => setShowArchived(true)}
          >
            已归档
          </button>
        </div>
        <nav className="task-list">
          {tasks.length === 0 ? (
            <p className="empty-inline">没有匹配的任务</p>
          ) : (
            tasks.map((item) => (
              <button
                key={item.study.id}
                className={
                  selectedId === item.study.id
                    ? "task-item active"
                    : "task-item"
                }
                onClick={() => selectTask(item.study.id)}
              >
                <span>
                  <strong>{item.study.title}</strong>
                  <small>
                    {STUDY_STATUS[item.study.status]} ·{" "}
                    {item.stats.participants_submitted}/
                    {item.stats.invites_total} 人提交
                  </small>
                </span>
                <span className="task-count">
                  {item.stats.recordings_total}
                </span>
              </button>
            ))
          )}
        </nav>
      </aside>
      <section className="admin-content">
        {error && (
          <div className="admin-error">
            <span>{error}</span>
            <button onClick={() => setError("")} title="关闭">
              <X size={16} />
            </button>
          </div>
        )}
        {!detail ? (
          <div className="admin-empty">
            <h2>选择或创建任务</h2>
            <p>任务的录音、统计和邀请码将在这里集中管理。</p>
            <button className="primary" onClick={() => setEditor("create")}>
              <Plus size={17} />
              新建任务
            </button>
          </div>
        ) : (
          <>
            <header className="study-header">
              <div>
                <div className="study-title-line">
                  <span className={`status-badge ${detail.study.status}`}>
                    {STUDY_STATUS[detail.study.status]}
                  </span>
                  <h1>{detail.study.title}</h1>
                </div>
                <p>更新于 {formatDate(detail.study.updated_at)}</p>
              </div>
              <div className="study-actions">
                {detail.study.status === "draft" && (
                  <>
                    <button
                      className="secondary"
                      onClick={() => setEditor("edit")}
                    >
                      <Pencil size={16} />
                      编辑
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        runTaskAction(() => api.archiveStudy(detail.study.id))
                      }
                    >
                      <Archive size={16} />
                      归档
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        runTaskAction(() => api.openStudy(detail.study.id))
                      }
                    >
                      <Play size={16} />
                      开放任务
                    </button>
                  </>
                )}
                {detail.study.status === "open" && (
                  <button
                    className="secondary"
                    onClick={() =>
                      runTaskAction(() => api.closeStudy(detail.study.id))
                    }
                  >
                    <Square size={16} />
                    关闭任务
                  </button>
                )}
                {detail.study.status === "closed" && (
                  <>
                    <button
                      className="secondary"
                      onClick={() =>
                        runTaskAction(() => api.openStudy(detail.study.id))
                      }
                    >
                      <Play size={16} />
                      重新开放
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        runTaskAction(() => api.archiveStudy(detail.study.id))
                      }
                    >
                      <Archive size={16} />
                      归档
                    </button>
                  </>
                )}
                {detail.study.status === "archived" && (
                  <button
                    className="secondary"
                    onClick={() =>
                      runTaskAction(() => api.restoreStudy(detail.study.id))
                    }
                  >
                    <RotateCcw size={16} />
                    恢复
                  </button>
                )}
              </div>
            </header>
            <div className="admin-tabs">
              <button
                className={tab === "overview" ? "active" : ""}
                onClick={() => setTab("overview")}
              >
                概览
              </button>
              <button
                className={tab === "recordings" ? "active" : ""}
                onClick={() => setTab("recordings")}
              >
                录音 <span>{detail.stats.recordings_total}</span>
              </button>
              <button
                className={tab === "distribution" ? "active" : ""}
                onClick={() => setTab("distribution")}
              >
                邀请码与导出
              </button>
            </div>
            {tab === "overview" && (
              <div className="overview-layout">
                <div className="metrics-grid">
                  <div>
                    <span>已提交录音</span>
                    <strong>{detail.stats.recordings_total}</strong>
                  </div>
                  <div>
                    <span>已提交参与者</span>
                    <strong>{detail.stats.participants_submitted}</strong>
                    <small>/ {detail.stats.invites_total} 个邀请码</small>
                  </div>
                  <div className="good">
                    <span>自动质量高</span>
                    <strong>{detail.stats.quality_high}</strong>
                  </div>
                  <div className="warning">
                    <span>自动需复核</span>
                    <strong>{detail.stats.quality_review}</strong>
                  </div>
                  <div>
                    <span>人工待审核</span>
                    <strong>{detail.stats.review_pending}</strong>
                  </div>
                  <div className="good">
                    <span>人工已通过</span>
                    <strong>{detail.stats.review_approved}</strong>
                  </div>
                  <div className="danger">
                    <span>人工已拒绝</span>
                    <strong>{detail.stats.review_rejected}</strong>
                  </div>
                  <div>
                    <span>处理中</span>
                    <strong>{detail.stats.processing}</strong>
                  </div>
                </div>
                <section className="study-information">
                  <div>
                    <h2>朗读文本</h2>
                    <p className="reading-copy">{detail.study.text}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>参与说明</dt>
                      <dd>{detail.study.instructions}</dd>
                    </div>
                    <div>
                      <dt>预计时长</dt>
                      <dd>{formatSeconds(detail.study.expected_seconds)}</dd>
                    </div>
                    <div>
                      <dt>自动质检范围</dt>
                      <dd>
                        {formatSeconds(detail.study.min_seconds)} –{" "}
                        {formatSeconds(detail.study.max_seconds)}
                      </dd>
                    </div>
                    <div>
                      <dt>知情同意版本</dt>
                      <dd>{detail.study.consent_version}</dd>
                    </div>
                  </dl>
                </section>
              </div>
            )}
            {tab === "recordings" && (
              <section className="recordings-view">
                <div className="recording-filters">
                  <div className="task-search">
                    <Search size={16} />
                    <input
                      placeholder="参与者编号"
                      value={participantFilter}
                      onChange={(event) => {
                        setParticipantFilter(event.target.value);
                        setRecordingPage(0);
                      }}
                    />
                  </div>
                  <select
                    value={qualityFilter}
                    onChange={(event) => {
                      setQualityFilter(event.target.value);
                      setRecordingPage(0);
                    }}
                  >
                    <option value="">全部自动质量</option>
                    <option value="pass">质量高</option>
                    <option value="review">需复核</option>
                    <option value="reject">不合格</option>
                  </select>
                  <select
                    value={reviewFilter}
                    onChange={(event) => {
                      setReviewFilter(event.target.value);
                      setRecordingPage(0);
                    }}
                  >
                    <option value="">全部人工状态</option>
                    <option value="pending">待审核</option>
                    <option value="approved">已通过</option>
                    <option value="rejected">已拒绝</option>
                  </select>
                  <select
                    value={stateFilter}
                    onChange={(event) => {
                      setStateFilter(event.target.value);
                      setRecordingPage(0);
                    }}
                  >
                    <option value="">全部处理状态</option>
                    <option value="queued,processing">处理中</option>
                    <option value="ready">已就绪</option>
                    <option value="failed">处理失败</option>
                  </select>
                  <button
                    className="icon-button"
                    title="刷新录音"
                    onClick={() =>
                      loadRecordings(detail.study.id).catch((reason) =>
                        setError(reason.message),
                      )
                    }
                  >
                    <RefreshCw size={17} />
                  </button>
                </div>
                {selectedAttempts.length > 0 && (
                  <div className="bulk-toolbar">
                    <strong>已选择 {selectedAttempts.length} 条</strong>
                    <button
                      onClick={() => review(selectedAttempts, "approved")}
                    >
                      <Check size={16} />
                      批量通过
                    </button>
                    <button
                      onClick={() => review(selectedAttempts, "rejected")}
                    >
                      <X size={16} />
                      批量拒绝
                    </button>
                    <button onClick={() => review(selectedAttempts, "pending")}>
                      <RotateCcw size={16} />
                      重置待审核
                    </button>
                  </div>
                )}
                <div className="recording-table-wrap">
                  <table className="recording-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            checked={allVisibleSelected}
                            onChange={() =>
                              setSelectedAttempts(
                                allVisibleSelected
                                  ? []
                                  : recordings.map((item) => item.attempt.id),
                              )
                            }
                          />
                        </th>
                        <th>参与者</th>
                        <th>时长</th>
                        <th>自动质量</th>
                        <th>人工审核</th>
                        <th>提交时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recordings.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="table-empty">
                            没有符合条件的录音
                          </td>
                        </tr>
                      ) : (
                        recordings.map((item) => {
                          const attempt = item.attempt;
                          const playable = item.audio_variants.length > 0;
                          const expanded = playingId === attempt.id;
                          const variant = item.audio_variants.includes(
                            "normalized",
                          )
                            ? "normalized"
                            : "original";
                          return (
                            <Fragment key={attempt.id}>
                              <tr>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={selectedAttempts.includes(
                                      attempt.id,
                                    )}
                                    onChange={() =>
                                      setSelectedAttempts((current) =>
                                        current.includes(attempt.id)
                                          ? current.filter(
                                              (id) => id !== attempt.id,
                                            )
                                          : [...current, attempt.id],
                                      )
                                    }
                                  />
                                </td>
                                <td>
                                  <strong>{item.participant_code}</strong>
                                  <small>
                                    第 {attempt.attempt_no} 次 · {attempt.state}
                                  </small>
                                </td>
                                <td>
                                  {formatSeconds(
                                    attempt.duration_seconds ??
                                      attempt.client_duration_seconds,
                                  )}
                                </td>
                                <td>
                                  <span
                                    className={`quality-badge ${attempt.auto_quality_status}`}
                                  >
                                    {
                                      QUALITY_STATUS[
                                        attempt.auto_quality_status
                                      ]
                                    }
                                  </span>
                                  {item.quality_reasons.length > 0 && (
                                    <small>
                                      {item.quality_reasons.join("、")}
                                    </small>
                                  )}
                                </td>
                                <td>
                                  <span
                                    className={`review-badge ${attempt.review_status}`}
                                  >
                                    {REVIEW_STATUS[attempt.review_status]}
                                  </span>
                                  {item.reviewer_username && (
                                    <small>{item.reviewer_username}</small>
                                  )}
                                </td>
                                <td>
                                  {formatDate(
                                    attempt.submitted_at ?? attempt.created_at,
                                  )}
                                </td>
                                <td>
                                  <div className="row-actions">
                                    <button
                                      className="icon-button"
                                      disabled={!playable}
                                      title="播放录音"
                                      onClick={() =>
                                        setPlayingId(expanded ? "" : attempt.id)
                                      }
                                    >
                                      <Play size={17} />
                                    </button>
                                    <button
                                      className="icon-button approve"
                                      title="审核通过"
                                      onClick={() =>
                                        review([attempt.id], "approved")
                                      }
                                    >
                                      <Check size={17} />
                                    </button>
                                    <button
                                      className="icon-button reject"
                                      title="审核拒绝"
                                      onClick={() =>
                                        review([attempt.id], "rejected")
                                      }
                                    >
                                      <X size={17} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                              {expanded && activeAudio && (
                                <tr className="player-row">
                                  <td colSpan={7}>
                                    <div className="inline-player">
                                      <audio
                                        controls
                                        preload="none"
                                        src={api.audioUrl(attempt.id, variant)}
                                      />
                                      <input
                                        placeholder="审核备注（可选）"
                                        value={
                                          reviewNotes[attempt.id] ??
                                          attempt.review_note ??
                                          ""
                                        }
                                        onChange={(event) =>
                                          setReviewNotes((current) => ({
                                            ...current,
                                            [attempt.id]: event.target.value,
                                          }))
                                        }
                                      />
                                      <div>
                                        {item.audio_variants.includes(
                                          "original",
                                        ) && (
                                          <a
                                            href={api.audioUrl(
                                              attempt.id,
                                              "original",
                                            )}
                                            download
                                          >
                                            <Download size={16} />
                                            下载原始录音
                                          </a>
                                        )}
                                        <button
                                          onClick={() =>
                                            review([attempt.id], "approved")
                                          }
                                        >
                                          <Check size={16} />
                                          通过
                                        </button>
                                        <button
                                          onClick={() =>
                                            review([attempt.id], "rejected")
                                          }
                                        >
                                          <X size={16} />
                                          拒绝
                                        </button>
                                      </div>
                                      {attempt.error_message && (
                                        <p className="notice error">
                                          {attempt.error_message}
                                        </p>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <footer className="pagination">
                  <span>共 {recordingTotal} 条</span>
                  <div>
                    <button
                      disabled={recordingPage === 0}
                      onClick={() => setRecordingPage((value) => value - 1)}
                    >
                      上一页
                    </button>
                    <span>第 {recordingPage + 1} 页</span>
                    <button
                      disabled={(recordingPage + 1) * 50 >= recordingTotal}
                      onClick={() => setRecordingPage((value) => value + 1)}
                    >
                      下一页
                    </button>
                  </div>
                </footer>
              </section>
            )}
            {tab === "distribution" && (
              <div className="distribution-grid">
                <section>
                  <h2>生成邀请码</h2>
                  <p>为当前任务生成新的独立参与链接，生成后立即下载 CSV。</p>
                  <label>
                    生成数量
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={inviteCount}
                      onChange={(event) =>
                        setInviteCount(Number(event.target.value))
                      }
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={detail.study.status !== "open"}
                    onClick={async () => {
                      setError("");
                      try {
                        const links = await api.createInvites(
                          detail.study.id,
                          inviteCount,
                        );
                        downloadCsv([
                          "participant_code,url",
                          ...links.map(
                            (item) => `${item.participant_code},${item.url}`,
                          ),
                        ]);
                        await refreshSelected();
                      } catch (reason) {
                        setError(
                          reason instanceof Error ? reason.message : "生成失败",
                        );
                      }
                    }}
                  >
                    <Upload size={17} />
                    生成并下载 CSV
                  </button>
                  {detail.study.status !== "open" && (
                    <p className="hint">开放任务后才能生成邀请码。</p>
                  )}
                </section>
                <section>
                  <h2>导出录音</h2>
                  <p>
                    生成包含任务信息、清单、校验值、原始录音和标准化 WAV 的
                    ZIP。
                  </p>
                  <button
                    className="secondary"
                    onClick={async () => {
                      setExportMessage("正在生成导出包…");
                      try {
                        const job = await api.createExport(detail.study.id);
                        for (let index = 0; index < 60; index += 1) {
                          await new Promise((resolve) =>
                            window.setTimeout(resolve, 1000),
                          );
                          const result = await api.exportStatus(job.id);
                          if (result.state === "done" && result.download_url) {
                            setExportMessage("");
                            window.location.href = result.download_url;
                            return;
                          }
                          if (result.state === "failed")
                            throw new Error(result.error_message ?? "导出失败");
                        }
                        setExportMessage("导出仍在后台进行，请稍后重试。");
                      } catch (reason) {
                        setExportMessage(
                          reason instanceof Error ? reason.message : "导出失败",
                        );
                      }
                    }}
                  >
                    <FileDown size={17} />
                    生成并下载录音包
                  </button>
                  {exportMessage && <p className="hint">{exportMessage}</p>}
                </section>
              </div>
            )}
          </>
        )}
      </section>
      {editor && (
        <TaskEditor
          initial={
            editor === "edit" && detail
              ? {
                  title: detail.study.title,
                  text: detail.study.text,
                  instructions: detail.study.instructions,
                  expected_seconds: detail.study.expected_seconds,
                  min_seconds: detail.study.min_seconds,
                  max_seconds: detail.study.max_seconds,
                  consent_version: detail.study.consent_version,
                }
              : EMPTY_FORM
          }
          onCancel={() => setEditor(null)}
          onSave={async (form) => {
            const study =
              editor === "edit" && detail
                ? await api.updateStudy(detail.study.id, form)
                : await api.createStudy(form);
            setEditor(null);
            selectTask(study.id);
            await loadTasks(study.id);
            await loadDetail(study.id);
          }}
        />
      )}
    </main>
  );
}
