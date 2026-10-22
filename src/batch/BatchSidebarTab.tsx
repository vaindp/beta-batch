import React, { useEffect, useRef, useState } from 'react';
import {
  Layers,
  RefreshCw,
  Download,
  CheckCircle2,
  AlertCircle,
  Clock,
  Maximize2,
  Play,
  FileDown,
  Trash2,
  StopCircle,
} from 'lucide-react';
import {
  BATCH_MODEL,
  formatDuration,
  importDisposition,
  parseOutputs,
  prepareRun,
  terminalState,
  toJSONL,
  type BatchChapter,
  type BatchRules,
  type BatchRun,
  type ThinkingLevel,
} from './batch-core';
import { VertexBatchClient, GoogleBatchError, authFromJSON } from './vertex-batch';
import { loadRuns, saveRun } from './batch-store';

interface Props {
  chapters: BatchChapter[];
  rules: BatchRules;
  title: string;
  credentials: string;
  promptFor: (text: string) => string;
  onImport: (run: BatchRun) => void;
  onOpenModal: () => void;
  onSettings: () => void;
}

const stateNames: Record<string, { label: string; color: string }> = {
  JOB_STATE_PENDING: { label: 'Đang chờ Google', color: 'var(--warning-color)' },
  JOB_STATE_QUEUED: { label: 'Trong hàng đợi', color: 'var(--warning-color)' },
  JOB_STATE_RUNNING: { label: 'Đang xử lý', color: 'var(--primary-color)' },
  JOB_STATE_SUCCEEDED: { label: 'Đã hoàn tất', color: 'var(--success-color)' },
  JOB_STATE_PARTIALLY_SUCCEEDED: { label: 'Hoàn tất một phần', color: 'var(--warning-color)' },
  JOB_STATE_FAILED: { label: 'Thất bại', color: 'var(--error-color)' },
  JOB_STATE_CANCELLED: { label: 'Đã hủy', color: 'var(--text-color-muted)' },
  JOB_STATE_CANCELLING: { label: 'Đang hủy', color: 'var(--text-color-muted)' },
  JOB_STATE_EXPIRED: { label: 'Hết hạn', color: 'var(--error-color)' },
};

function formatClockTime(isoString?: string): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function downloadFile(name: string, contents: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function BatchSidebarTab(props: Props) {
  const [runs, setRuns] = useState<BatchRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [bucket, setBucket] = useState(() => localStorage.getItem('beta-batch-bucket') || '');
  const [thinking, setThinking] = useState<ThinkingLevel>('MEDIUM');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [elapsedTimeStr, setElapsedTimeStr] = useState('');
  const busyRef = useRef(false);
  const selectedOnce = useRef(false);

  const active = runs.find(run => run.id === activeId);

  const client = () => {
    if (!props.credentials) {
      throw new Error('Vui lòng mở Cài đặt và nạp file Service Account JSON để dùng Batch API.');
    }
    return new VertexBatchClient(authFromJSON(props.credentials));
  };

  const lockedIds = new Set(
    runs
      .filter(run => ['submitting', 'unknown'].includes(run.phase) || (run.job && !terminalState(run.job.state)))
      .flatMap(run => run.rows.map(row => row.chapter.id))
  );

  const available = props.chapters.filter(c => c.status !== 'editing' && !lockedIds.has(c.id));
  const selectedChapters = available.filter(c => selected.includes(c.id));

  // Load runs on mount
  useEffect(() => {
    loadRuns()
      .then(saved => {
        setRuns(saved);
        setActiveId(saved[0]?.id || '');
        setLoaded(true);
      })
      .catch(e => setError(e.message));
  }, []);

  // Auto-select pending chapters once loaded
  useEffect(() => {
    if (loaded && !selectedOnce.current && props.chapters.length) {
      setSelected(available.filter(c => c.status !== 'done').map(c => c.id));
      selectedOnce.current = true;
    }
  }, [loaded, props.chapters]);

  // Persist run helper
  async function persist(run: BatchRun) {
    setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)]);
    setActiveId(run.id);
    await saveRun(run);
  }

  // Wrap action with busy and error handling
  async function perform(label: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy('');
    }
  }

  // Refresh job state and save completedAt
  async function refresh(run: BatchRun) {
    if (!run.job) return;
    const job = await client().get(run.job.name);
    const isDone = terminalState(job.state);
    const updated: BatchRun = {
      ...run,
      phase: 'submitted',
      job,
      completedAt: isDone && !run.completedAt ? new Date().toISOString() : run.completedAt,
    };
    await persist(updated);
  }

  // Auto-refresh running job every 20 seconds
  useEffect(() => {
    if (!props.credentials || !active?.job || terminalState(active.job.state)) return;
    const interval = window.setInterval(() => {
      if (!busyRef.current) void perform('Đang cập nhật job…', () => refresh(active));
    }, 20_000);
    return () => clearInterval(interval);
  }, [active?.id, active?.job?.state, props.credentials]);

  // Real-time Execution Timer (Calculated client-side from start until completion)
  useEffect(() => {
    if (!active) {
      setElapsedTimeStr('');
      return;
    }

    const updateTimer = () => {
      const startTime = active.startedAt || active.createdAt;
      if (!startTime) {
        setElapsedTimeStr('');
        return;
      }
      const startMs = new Date(startTime).getTime();

      // If job is already marked completed
      if (active.completedAt) {
        const completedMs = new Date(active.completedAt).getTime();
        const durationMs = Math.max(0, completedMs - startMs);
        setElapsedTimeStr(formatDuration(durationMs));
        return;
      }

      // If job is in terminal state but completedAt not yet written
      if (active.job && terminalState(active.job.state)) {
        const now = Date.now();
        const durationMs = Math.max(0, now - startMs);
        setElapsedTimeStr(formatDuration(durationMs));
        // Also persist completedAt
        if (!active.completedAt) {
          void persist({ ...active, completedAt: new Date().toISOString() });
        }
        return;
      }

      // Job is currently running: count up live
      const now = Date.now();
      const elapsedMs = Math.max(0, now - startMs);
      setElapsedTimeStr(formatDuration(elapsedMs));
    };

    updateTimer();
    const timerId = window.setInterval(updateTimer, 1000);
    return () => clearInterval(timerId);
  }, [active?.id, active?.startedAt, active?.completedAt, active?.job?.state]);

  // Submit job
  async function submit() {
    if (!navigator.locks) {
      throw new Error('Trình duyệt cần hỗ trợ Web Locks để đảm bảo không gửi trùng.');
    }
    await navigator.locks.request('beta-batch-submit', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Một tab khác đang gửi Batch. Hãy đợi hoàn tất.');
      const stored = await loadRuns();
      const idsInFlight = new Set(
        stored
          .filter(run => ['unknown', 'submitting'].includes(run.phase) || (run.job && !terminalState(run.job.state)))
          .flatMap(run => run.rows.map(row => row.chapter.id))
      );
      if (selectedChapters.some(c => idsInFlight.has(c.id))) {
        setRuns(stored);
        throw new Error('Có chương đang được gửi từ tiến trình khác.');
      }
      await submitLocked();
    });
  }

  async function submitLocked() {
    const api = client();
    const run = await prepareRun({
      chapters: selectedChapters,
      rules: props.rules,
      title: props.title,
      projectId: await api.projectId(),
      bucket,
      thinking,
      promptFor: props.promptFor,
    });
    localStorage.setItem('beta-batch-bucket', run.bucket);
    await persist(run);
    await api.upload(run);

    const nowIso = new Date().toISOString();
    const submitting: BatchRun = { ...run, phase: 'submitting', startedAt: nowIso };
    await persist(submitting);

    let submitted: BatchRun;
    try {
      const job = await api.create(submitting);
      submitted = {
        ...submitting,
        phase: 'submitted',
        job,
        startedAt: submitting.startedAt || nowIso,
      };
    } catch (e) {
      if (e instanceof GoogleBatchError && [400, 401, 403, 404, 422].includes(e.status)) {
        await persist({ ...submitting, phase: 'prepared' });
        throw new Error(`Google từ chối tạo job: ${e.message}`);
      }
      await persist({ ...submitting, phase: 'unknown' });
      throw new Error(`Không xác định được trạng thái job: ${e instanceof Error ? e.message : e}`);
    }
    await persist(submitted);
    setSelected([]);
    setMessage('Đã gửi job thành công! Google đang xử lý ngầm.');
  }

  async function readOutputs(run: BatchRun, files?: string[]) {
    const parsed = await parseOutputs(run, files || (await client().downloadOutputs(run)));
    const updated: BatchRun = {
      ...run,
      results: parsed.results,
      outputWarnings: parsed.warnings,
      completedAt: run.completedAt || new Date().toISOString(),
    };
    await persist(updated);
    setMessage(`Đã tải kết quả (${parsed.results.length} chương). Sẵn sàng nhập vào truyện.`);
  }

  const isTerminal = active?.job ? terminalState(active.job.state) : false;
  const isRunning = active?.job ? !isTerminal : ['submitting', 'prepared'].includes(active?.phase || '');

  const readyToImport =
    active?.results?.filter(
      result =>
        result.text &&
        active.rows.some(
          row =>
            row.chapter.id === result.chapterId &&
            importDisposition(
              active,
              row,
              props.chapters.find(c => c.id === result.chapterId),
              props.rules
            ) === 'ready'
        )
    ) || [];

  const anyBusy = !!busy || !loaded;

  return (
    <div className="batch-sidebar-tab">
      {/* Header bar */}
      <div className="batch-sidebar-header">
        <div className="batch-sidebar-title-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Layers size={16} color="var(--primary-color)" />
            <span style={{ fontWeight: 700, fontSize: '0.8438rem' }}>Batch API ({BATCH_MODEL})</span>
          </div>
          <button
            className="btn-action-ghost"
            onClick={props.onOpenModal}
            title="Mở bảng điều khiển Batch toàn màn hình"
            style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
          >
            <Maximize2 size={13} />
            <span>Phóng to</span>
          </button>
        </div>
        <p style={{ fontSize: '11px', color: 'var(--text-color-muted)', margin: '4px 0 0 0', lineHeight: 1.4 }}>
          Xử lý hàng loạt chương qua Google Cloud Storage với mức giá rẻ hơn 50%.
        </p>
      </div>

      {!props.credentials && (
        <div className="batch-warning" style={{ margin: '8px 0', fontSize: '12px' }}>
          <span>Cần file Service Account JSON cho Vertex Batch.</span>
          <button
            className="btn btn-secondary btn-small"
            style={{ marginTop: '6px', width: '100%', justifyContent: 'center' }}
            onClick={props.onSettings}
          >
            Mở Cài đặt để nạp JSON
          </button>
        </div>
      )}

      {/* SECTION 1: Cấu hình & Gửi */}
      <div className="batch-sidebar-section">
        <span className="batch-section-title">1. Chuẩn bị gửi Job</span>

        <div className="input-group">
          <label htmlFor="sidebar-bucket">Tên Bucket Cloud Storage</label>
          <input
            id="sidebar-bucket"
            className="styled-input"
            value={bucket}
            placeholder="ten-bucket (không kèm gs://)"
            onChange={e => setBucket(e.target.value)}
            disabled={anyBusy}
          />
        </div>

        <div className="input-group">
          <label htmlFor="sidebar-thinking">Mức Thinking</label>
          <select
            id="sidebar-thinking"
            className="styled-input styled-select"
            value={thinking}
            onChange={e => setThinking(e.target.value as ThinkingLevel)}
            disabled={anyBusy}
          >
            <option value="LOW">Low (Nhanh)</option>
            <option value="MEDIUM">Medium (Cân bằng, khuyến nghị)</option>
            <option value="HIGH">High (Sâu)</option>
          </select>
        </div>

        <div style={{ marginTop: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600 }}>
              Chọn chương ({selectedChapters.length}/{available.length})
            </span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                type="button"
                className="btn-action-ghost"
                style={{ fontSize: '11px' }}
                disabled={anyBusy}
                onClick={() => setSelected(available.filter(c => c.status !== 'done').map(c => c.id))}
              >
                Chưa xong
              </button>
              <button
                type="button"
                className="btn-action-ghost"
                style={{ fontSize: '11px' }}
                disabled={anyBusy}
                onClick={() => setSelected(available.map(c => c.id))}
              >
                Tất cả
              </button>
              <button
                type="button"
                className="btn-action-ghost text-muted"
                style={{ fontSize: '11px' }}
                disabled={anyBusy}
                onClick={() => setSelected([])}
              >
                Bỏ
              </button>
            </div>
          </div>

          <div className="batch-sidebar-chapters-list">
            {!props.chapters.length ? (
              <div style={{ padding: '12px', fontSize: '11px', color: 'var(--text-color-muted)', textAlign: 'center' }}>
                Chưa có chương nào được tải vào dự án.
              </div>
            ) : (
              props.chapters.map(chapter => {
                const isLocked = lockedIds.has(chapter.id);
                const isChecked = selected.includes(chapter.id) && !isLocked;
                return (
                  <label
                    key={chapter.id}
                    className={`batch-sidebar-chapter-item ${isLocked ? 'locked' : ''}`}
                    title={isLocked ? 'Đang trong job chưa hoàn tất' : chapter.title}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={anyBusy || isLocked || chapter.status === 'editing'}
                      onChange={e =>
                        setSelected(prev => (e.target.checked ? [...prev, chapter.id] : prev.filter(id => id !== chapter.id)))
                      }
                    />
                    <span className="chapter-item-name">{chapter.title}</span>
                    <span className={`chapter-item-badge status-${chapter.status}`}>
                      {isLocked ? 'Đang khóa' : chapter.status === 'done' ? 'Đã xong' : 'Chưa'}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>

        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }}
          disabled={anyBusy || !props.credentials || !bucket.trim() || !selectedChapters.length}
          onClick={() => void perform('Đang lưu và gửi job lên Google…', submit)}
        >
          <Play size={14} />
          <span>Gửi Batch ({selectedChapters.length} chương)</span>
        </button>
      </div>

      {/* SECTION 2: Theo dõi & Bộ đếm thời gian */}
      <div className="batch-sidebar-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="batch-section-title">2. Lịch sử & Tiến trình</span>
          {active?.job && (
            <button
              className="btn-action-ghost"
              style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '3px' }}
              disabled={anyBusy || !props.credentials}
              onClick={() => void perform('Đang cập nhật…', () => refresh(active))}
              title="Cập nhật trạng thái mới nhất từ Google"
            >
              <RefreshCw size={11} className={busy ? 'icon-spin' : ''} />
              <span>Cập nhật</span>
            </button>
          )}
        </div>

        <div className="input-group">
          <select
            className="styled-input styled-select"
            value={activeId}
            onChange={e => setActiveId(e.target.value)}
            disabled={anyBusy}
          >
            {!runs.length && <option value="">(Chưa có job nào)</option>}
            {runs.map(run => (
              <option key={run.id} value={run.id}>
                {new Date(run.createdAt).toLocaleString('vi-VN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {run.rows.length} chương {run.job ? `· ${run.job.state.replace('JOB_STATE_', '')}` : ''}
              </option>
            ))}
          </select>
        </div>

        {active && (
          <div className="batch-active-card">
            {/* Status & Name */}
            <div className="batch-status-row">
              <span
                className="batch-state-pill"
                style={{
                  backgroundColor: active.job && stateNames[active.job.state]
                    ? `color-mix(in srgb, ${stateNames[active.job.state].color} 15%, transparent)`
                    : 'var(--chip-bg)',
                  color: active.job && stateNames[active.job.state]
                    ? stateNames[active.job.state].color
                    : 'var(--text-color)',
                  borderColor: active.job && stateNames[active.job.state]
                    ? stateNames[active.job.state].color
                    : 'var(--border-color)',
                }}
              >
                {active.job
                  ? stateNames[active.job.state]?.label || active.job.state
                  : ['unknown', 'submitting'].includes(active.phase)
                  ? 'Đang gửi...'
                  : 'Chưa gửi'}
              </span>
              <span className="batch-job-count">{active.rows.length} chương</span>
            </div>

            {/* BỘ ĐẾM THỜI GIAN THEO NHẬT KÝ (Execution Timer) */}
            <div className="batch-timer-box">
              <div className="batch-timer-header">
                <Clock size={13} color="var(--primary-color)" />
                <span className="batch-timer-title">
                  {isTerminal
                    ? 'Thời gian thực thi hoàn tất'
                    : isRunning
                    ? 'Thời gian đang chạy (theo nhật ký)'
                    : 'Thời gian thực thi'}
                </span>
              </div>
              <div className="batch-timer-value">
                {elapsedTimeStr || '0 giây'}
                {isRunning && <span className="batch-timer-pulsing-dot" />}
              </div>
              <div className="batch-timer-timestamps">
                <div>
                  Bắt đầu: <strong>{formatClockTime(active.startedAt || active.createdAt) || '—'}</strong>
                </div>
                {active.completedAt && (
                  <div>
                    Hoàn tất: <strong>{formatClockTime(active.completedAt)}</strong>
                  </div>
                )}
              </div>
            </div>

            {/* Google completion stats if any */}
            {active.job?.completionStats && (
              <div style={{ fontSize: '11px', color: 'var(--text-color-muted)', marginTop: '6px' }}>
                Google báo:{' '}
                <span style={{ color: 'var(--success-color)' }}>
                  {active.job.completionStats.successfulCount || 0} thành công
                </span>
                {Number(active.job.completionStats.failedCount || 0) > 0 && (
                  <span style={{ color: 'var(--error-color)', marginLeft: '6px' }}>
                    · {active.job.completionStats.failedCount} lỗi
                  </span>
                )}
              </div>
            )}

            {/* Error message */}
            {active.job?.error?.message && (
              <div className="batch-error-inline" style={{ marginTop: '6px', fontSize: '11px' }}>
                {active.job.error.message}
              </div>
            )}

            {/* Action buttons */}
            <div className="batch-sidebar-actions" style={{ marginTop: '10px' }}>
              {active.job && isTerminal && (
                <button
                  className="btn btn-primary btn-small"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={anyBusy || !props.credentials}
                  onClick={() => void perform('Đang tải kết quả từ bucket…', () => readOutputs(active))}
                >
                  <FileDown size={14} />
                  <span>Lấy kết quả từ Google Cloud</span>
                </button>
              )}

              {active.job && isRunning && (
                <button
                  className="btn btn-secondary btn-small text-danger"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={anyBusy || !props.credentials}
                  onClick={() =>
                    void perform('Đang yêu cầu hủy job…', async () => {
                      await client().cancel(active.job!.name);
                      await refresh(active);
                      setMessage('Đã gửi lệnh hủy.');
                    })
                  }
                >
                  <StopCircle size={14} />
                  <span>Hủy Job</span>
                </button>
              )}

              {readyToImport.length > 0 && (
                <button
                  className="btn btn-primary btn-small"
                  style={{ width: '100%', justifyContent: 'center', backgroundColor: 'var(--success-color)' }}
                  disabled={anyBusy}
                  onClick={() => {
                    props.onImport(active);
                    setMessage(`Đã nhập thành công ${readyToImport.length} chương vào truyện!`);
                  }}
                >
                  <CheckCircle2 size={14} />
                  <span>Nhập {readyToImport.length} chương hợp lệ</span>
                </button>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', width: '100%', marginTop: '6px' }}>
                <button
                  className="btn btn-secondary btn-small"
                  style={{ justifyContent: 'center', fontSize: '11px' }}
                  onClick={() => downloadFile(`${active.id}.jsonl`, toJSONL(active), 'application/jsonl')}
                  title="Tải tệp JSONL chứa danh sách prompt gửi lên Google"
                >
                  <Download size={12} />
                  <span>Tải JSONL</span>
                </button>

                <button
                  className="btn btn-secondary btn-small"
                  style={{ justifyContent: 'center', fontSize: '11px' }}
                  onClick={() => downloadFile(`${active.id}.batch-backup.json`, JSON.stringify(active, null, 2))}
                  title="Sao lưu toàn bộ thông số job"
                >
                  <Download size={12} />
                  <span>Sao lưu Job</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {busy && (
        <div className="batch-status-note" style={{ color: 'var(--primary-color)' }}>
          <div className="loader-small-status" />
          <span>{busy}</span>
        </div>
      )}

      {message && (
        <div className="batch-status-note" style={{ color: 'var(--success-color)' }}>
          <CheckCircle2 size={14} />
          <span>{message}</span>
        </div>
      )}

      {error && (
        <div className="batch-status-note" style={{ color: 'var(--error-color)' }}>
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
