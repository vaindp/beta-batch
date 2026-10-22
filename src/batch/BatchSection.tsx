import React, { useEffect, useRef, useState } from 'react';
import {
  Layers,
  Download,
  RefreshCw,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Play,
  RotateCcw,
  FileText,
  Check,
  Search,
  ExternalLink,
} from 'lucide-react';
import {
  BATCH_MODEL, importDisposition, parseOutputs, prepareRun, terminalState, toJSONL, validateBackup,
  formatDuration, type BatchChapter, type BatchRules, type BatchRun, type ThinkingLevel,
} from './batch-core';
import { VertexBatchClient, GoogleBatchError, authFromJSON } from './vertex-batch';
import { loadRuns, saveRun } from './batch-store';
import './batch.css';

interface Props {
  chapters: BatchChapter[];
  rules: BatchRules;
  title: string;
  credentials: string;
  promptFor: (text: string) => string;
  onImport: (run: BatchRun) => void;
  onSettings?: () => void;
  isSidebar?: boolean;
}

const stateNames: Record<string, string> = {
  JOB_STATE_PENDING: 'Đang chờ Google',
  JOB_STATE_QUEUED: 'Trong hàng đợi',
  JOB_STATE_RUNNING: 'Đang biên tập',
  JOB_STATE_SUCCEEDED: 'Job đã hoàn tất',
  JOB_STATE_PARTIALLY_SUCCEEDED: 'Hoàn tất một phần',
  JOB_STATE_FAILED: 'Job thất bại',
  JOB_STATE_CANCELLED: 'Đã hủy',
  JOB_STATE_CANCELLING: 'Đang hủy',
  JOB_STATE_EXPIRED: 'Hết thời gian',
  JOB_STATE_PAUSED: 'Tạm dừng',
};

function download(name: string, contents: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function BatchSection({
  chapters,
  rules,
  title,
  credentials,
  promptFor,
  onImport,
  onSettings,
  isSidebar = true,
}: Props) {
  const [runs, setRuns] = useState<BatchRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [bucket, setBucket] = useState(() => localStorage.getItem('beta-batch-bucket') || '');
  const [thinking, setThinking] = useState<ThinkingLevel>('MEDIUM');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [manualName, setManualName] = useState('');
  const [now, setNow] = useState(Date.now());

  const busyRef = useRef(false);
  const selectedOnce = useRef(false);

  const active = runs.find(run => run.id === activeId);

  const client = () => {
    if (!credentials) throw new Error('Mở Cài đặt và nạp file Service Account JSON để dùng Batch API.');
    return new VertexBatchClient(authFromJSON(credentials));
  };

  const lockedIds = new Set(
    runs
      .filter(run => ['submitting', 'unknown'].includes(run.phase) || (run.job && !terminalState(run.job.state)))
      .flatMap(run => run.rows.map(row => row.chapter.id))
  );

  const available = chapters.filter(c => c.status !== 'editing' && !lockedIds.has(c.id));
  const selectedChapters = available.filter(c => selected.includes(c.id));

  // Load saved runs from IndexedDB
  useEffect(() => {
    loadRuns()
      .then(saved => {
        setRuns(saved);
        setActiveId(saved[0]?.id || '');
        setLoaded(true);
      })
      .catch(e => setError(e.message));
  }, []);

  // Pre-select pending chapters on first load
  useEffect(() => {
    if (loaded && !selectedOnce.current && chapters.length) {
      setSelected(available.filter(c => c.status !== 'done').map(c => c.id));
      selectedOnce.current = true;
    }
  }, [loaded, chapters, available]);

  // Live timer tick every 1 second when active run is running
  const isActiveRunning =
    active &&
    (active.phase === 'submitting' ||
      active.phase === 'unknown' ||
      (active.job && !terminalState(active.job.state)));

  useEffect(() => {
    if (!isActiveRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isActiveRunning]);

  async function persist(run: BatchRun) {
    setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)]);
    setActiveId(run.id);
    await saveRun(run);
  }

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

  async function refresh(run: BatchRun) {
    if (!run.job) return;
    const job = await client().get(run.job.name);
    const isFinished = terminalState(job.state);
    const completedAt = isFinished ? run.completedAt || new Date().toISOString() : undefined;
    await persist({
      ...run,
      phase: 'submitted',
      job,
      completedAt: completedAt || run.completedAt,
    });
  }

  // Poll Google every 30 seconds if active run is running
  useEffect(() => {
    if (!credentials || !active?.job || terminalState(active.job.state)) return;
    const timer = window.setInterval(() => {
      if (!busyRef.current) void perform('Đang cập nhật job…', () => refresh(active));
    }, 30_000);
    return () => clearInterval(timer);
  }, [active, credentials]);

  async function submit() {
    if (!navigator.locks) {
      throw new Error('Cần trình duyệt hỗ trợ Web Locks để tránh gửi job trùng giữa các tab.');
    }
    await navigator.locks.request('beta-batch-submit', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Một tab khác đang gửi Batch. Chờ gửi xong rồi cập nhật trang này.');
      const stored = await loadRuns();
      const idsInFlight = new Set(
        stored
          .filter(run => ['unknown', 'submitting'].includes(run.phase) || (run.job && !terminalState(run.job.state)))
          .flatMap(run => run.rows.map(row => row.chapter.id))
      );
      if (selectedChapters.some(chapter => idsInFlight.has(chapter.id))) {
        setRuns(stored);
        throw new Error('Có chương vừa được gửi từ tab khác. Đã cập nhật lịch sử; chọn lại chương cần gửi.');
      }
      await submitLocked();
    });
  }

  async function submitLocked() {
    const api = client();
    const run = await prepareRun({
      chapters: selectedChapters,
      rules,
      title,
      projectId: await api.projectId(),
      bucket,
      thinking,
      promptFor,
    });

    localStorage.setItem('beta-batch-bucket', run.bucket);
    await persist(run);
    await api.upload(run);

    const startTime = new Date().toISOString();
    const submitting: BatchRun = {
      ...run,
      phase: 'submitting',
      startedAt: startTime,
    };
    await persist(submitting);

    let submitted: BatchRun;
    try {
      const createdJob = await api.create(submitting);
      submitted = {
        ...submitting,
        phase: 'submitted',
        job: createdJob,
      };
    } catch (e) {
      if (e instanceof GoogleBatchError && [400, 401, 403, 404, 422].includes(e.status)) {
        await persist({ ...submitting, phase: 'prepared' });
        throw new Error(`Google từ chối tạo job: ${e.message} Sửa cấu hình rồi gửi lại.`);
      }
      await persist({ ...submitting, phase: 'unknown' });
      throw new Error(`Chưa xác định Google đã tạo job hay chưa. Dùng “Tìm job đã gửi”, không gửi lặp lại. ${e instanceof Error ? e.message : e}`);
    }

    await persist(submitted);
    setSelected([]);
    setMessage('Đã gửi job thành công! Google bắt đầu xử lý.');
  }

  async function readOutputs(run: BatchRun, files?: string[]) {
    const parsed = await parseOutputs(run, files || (await client().downloadOutputs(run)));
    const finishTime = run.completedAt || new Date().toISOString();
    await persist({
      ...run,
      results: parsed.results,
      outputWarnings: parsed.warnings,
      completedAt: finishTime,
    });
    setMessage('Đã đọc kết quả. Kiểm tra danh sách bên dưới rồi bấm nhập các chương hợp lệ.');
  }

  const ready =
    active?.results?.filter(
      result =>
        result.text &&
        active.rows.some(
          row =>
            row.chapter.id === result.chapterId &&
            importDisposition(active, row, chapters.find(c => c.id === result.chapterId), rules) === 'ready'
        )
    ) || [];

  const anyBusy = !!busy || !loaded;

  // --- Calculate Timer Information ---
  let timerInfo: { status: 'running' | 'completed' | 'idle'; text: string; subText?: string } | null = null;
  if (active) {
    const startTs = active.startedAt ? new Date(active.startedAt).getTime() : new Date(active.createdAt).getTime();
    const startTimeStr = new Date(startTs).toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    if (active.completedAt) {
      const endTs = new Date(active.completedAt).getTime();
      const durationMs = Math.max(0, endTs - startTs);
      const endTimeStr = new Date(endTs).toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      timerInfo = {
        status: 'completed',
        text: `Hoàn tất trong: ${formatDuration(durationMs)}`,
        subText: `Bắt đầu: ${startTimeStr} → Xong: ${endTimeStr}`,
      };
    } else if (isActiveRunning) {
      const elapsedMs = Math.max(0, now - startTs);
      timerInfo = {
        status: 'running',
        text: `Đang chạy: ${formatDuration(elapsedMs)}`,
        subText: `Bắt đầu gửi lúc: ${startTimeStr}`,
      };
    } else if (active.job && terminalState(active.job.state)) {
      timerInfo = {
        status: 'completed',
        text: `Đã kết thúc job`,
        subText: `Bắt đầu lúc: ${startTimeStr}`,
      };
    }
  }

  return (
    <div className={`batch-container ${isSidebar ? 'batch-sidebar-mode' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {!credentials && (
        <div className="batch-warning" style={{ fontSize: '12px', margin: 0 }}>
          <span>Cần file Service Account JSON cho Batch API.</span>
          {onSettings && (
            <button className="btn btn-secondary btn-small" style={{ marginTop: '6px' }} onClick={onSettings}>
              Mở Cài đặt
            </button>
          )}
        </div>
      )}

      {/* SECTION 1: PREPARATION */}
      <section className="batch-card" style={{ padding: isSidebar ? '12px' : '16px' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Layers size={15} color="var(--primary-color)" />
          1. Chuẩn bị & Gửi Batch
        </h3>

        <label className="batch-field" style={{ margin: '8px 0' }}>
          Tên Bucket Cloud Storage
          <input
            className="styled-input"
            value={bucket}
            placeholder="ten-bucket (không gs://)"
            onChange={e => setBucket(e.target.value)}
            disabled={anyBusy}
          />
        </label>

        <label className="batch-field" style={{ margin: '8px 0' }}>
          Mức suy luận (Thinking Level)
          <select
            className="styled-input styled-select"
            value={thinking}
            onChange={e => setThinking(e.target.value as ThinkingLevel)}
            disabled={anyBusy}
          >
            <option value="LOW">Low (Nhanh & Tiết kiệm)</option>
            <option value="MEDIUM">Medium (Khuyên dùng)</option>
            <option value="HIGH">High (Suy luận chuyên sâu)</option>
          </select>
        </label>

        <div style={{ display: 'flex', gap: '6px', margin: '8px 0' }}>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={anyBusy}
            onClick={() => setSelected(available.filter(c => c.status !== 'done').map(c => c.id))}
          >
            Chọn chưa xong
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={anyBusy}
            onClick={() => setSelected([])}
          >
            Bỏ chọn
          </button>
        </div>

        <div className="batch-chapters" style={{ maxHeight: isSidebar ? '160px' : '220px', margin: '8px 0' }}>
          {!chapters.length && <p style={{ fontSize: '12px', color: 'var(--text-color-muted)' }}>Chưa có chương nào.</p>}
          {chapters.map(chapter => (
            <label key={chapter.id} className="batch-chapter" style={{ padding: '6px 4px' }}>
              <input
                type="checkbox"
                checked={selected.includes(chapter.id) && !lockedIds.has(chapter.id)}
                disabled={anyBusy || lockedIds.has(chapter.id) || chapter.status === 'editing'}
                onChange={e =>
                  setSelected(previous =>
                    e.target.checked ? [...previous, chapter.id] : previous.filter(id => id !== chapter.id)
                  )
                }
              />
              <span style={{ fontSize: '12px' }}>
                {chapter.title}
                <small style={{ fontSize: '10px' }}>
                  {lockedIds.has(chapter.id)
                    ? 'Đang có job chạy'
                    : chapter.status === 'done'
                    ? 'Đã xong'
                    : 'Chưa biên tập'}
                </small>
              </span>
            </label>
          ))}
        </div>

        <button
          type="button"
          className="btn btn-primary btn-large"
          disabled={anyBusy || !credentials || !bucket.trim() || !selectedChapters.length}
          onClick={() => void perform('Đang gửi job lên Google…', submit)}
          style={{ width: '100%', justifyContent: 'center', marginTop: '6px' }}
        >
          <Play size={15} />
          <span>Gửi Batch ({selectedChapters.length} chương)</span>
        </button>
      </section>

      {/* SECTION 2: JOB MONITOR & LIVE TIMER */}
      <section className="batch-card" style={{ padding: isSidebar ? '12px' : '16px' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Clock size={15} color="var(--primary-color)" />
          2. Tiến trình & Bộ đếm thời gian
        </h3>

        <label className="batch-field" style={{ margin: '6px 0' }}>
          Chọn Job lịch sử
          <select
            className="styled-input styled-select"
            value={activeId}
            onChange={e => setActiveId(e.target.value)}
            disabled={anyBusy}
          >
            {!runs.length && <option value="">Chưa có job nào</option>}
            {runs.map(run => (
              <option key={run.id} value={run.id}>
                {new Date(run.createdAt).toLocaleString('vi-VN')} · {run.rows.length} chương
              </option>
            ))}
          </select>
        </label>

        {active && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
            {/* TIMER DISPLAY WIDGET */}
            {timerInfo && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid',
                  backgroundColor:
                    timerInfo.status === 'running'
                      ? 'rgba(99, 102, 241, 0.12)'
                      : 'rgba(55, 208, 122, 0.12)',
                  borderColor:
                    timerInfo.status === 'running'
                      ? 'rgba(99, 102, 241, 0.35)'
                      : 'rgba(55, 208, 122, 0.35)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Clock
                    size={15}
                    color={timerInfo.status === 'running' ? 'var(--primary-color)' : 'var(--success-color)'}
                    className={timerInfo.status === 'running' ? 'icon-spin' : ''}
                  />
                  <strong
                    style={{
                      fontSize: '13px',
                      color: timerInfo.status === 'running' ? 'var(--primary-color)' : 'var(--success-color)',
                    }}
                  >
                    {timerInfo.text}
                  </strong>
                </div>
                {timerInfo.subText && (
                  <span style={{ fontSize: '11px', color: 'var(--text-color-muted)', paddingLeft: '21px' }}>
                    {timerInfo.subText}
                  </span>
                )}
              </div>
            )}

            {/* STATUS BADGE */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '12px',
                padding: '8px 10px',
                backgroundColor: 'var(--chip-bg)',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
              }}
            >
              <span style={{ fontWeight: 600 }}>Trạng thái:</span>
              <span
                style={{
                  fontWeight: 700,
                  color:
                    active.job?.state === 'JOB_STATE_SUCCEEDED'
                      ? 'var(--success-color)'
                      : active.job?.state?.includes('FAILED')
                      ? 'var(--error-color)'
                      : 'var(--warning-color)',
                }}
              >
                {active.job ? stateNames[active.job.state] || active.job.state : 'Chưa gửi / Đang chuẩn bị'}
              </span>
            </div>

            {active.job?.completionStats && (
              <div style={{ fontSize: '11px', color: 'var(--text-color-muted)' }}>
                Google báo: {active.job.completionStats.successfulCount || 0} thành công ·{' '}
                {active.job.completionStats.failedCount || 0} lỗi ·{' '}
                {active.job.completionStats.incompleteCount || 0} chưa hoàn tất
              </div>
            )}

            {/* ACTION BUTTONS */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {active.job && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={anyBusy || !credentials}
                  onClick={() => void perform('Đang cập nhật…', () => refresh(active))}
                >
                  <RefreshCw size={13} /> Cập nhật
                </button>
              )}

              {active.job && terminalState(active.job.state) && (
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={anyBusy || !credentials}
                  onClick={() => void perform('Đang tải kết quả từ bucket…', () => readOutputs(active))}
                >
                  Lấy kết quả từ Google
                </button>
              )}

              {active.job && !terminalState(active.job.state) && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small text-danger"
                  disabled={anyBusy || !credentials}
                  onClick={() =>
                    void perform('Đang yêu cầu hủy…', async () => {
                      await client().cancel(active.job!.name);
                      await refresh(active);
                      setMessage('Đã gửi yêu cầu hủy.');
                    })
                  }
                >
                  Hủy job
                </button>
              )}

              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => download(`${active.id}.batch-backup.json`, JSON.stringify(active, null, 2))}
              >
                <Download size={13} /> Sao lưu job
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => download(`${active.id}.jsonl`, toJSONL(active), 'application/jsonl')}
              >
                Tải JSONL
              </button>
            </div>
          </div>
        )}
      </section>

      {/* FEEDBACK STATUS */}
      {busy && <div className="batch-note" style={{ margin: 0, fontSize: '12px' }}>{busy}</div>}
      {error && <div className="batch-error" style={{ margin: 0, fontSize: '12px' }}>{error}</div>}
      {message && <div className="batch-note" style={{ margin: 0, fontSize: '12px' }}>{message}</div>}

      {/* SECTION 3: RESULTS TABLE */}
      {!!active?.results && (
        <section className="batch-card" style={{ padding: isSidebar ? '12px' : '16px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px 0' }}>
            3. Kết quả ({active.results.length} chương)
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={anyBusy || !ready.length}
              onClick={() => {
                onImport(active);
                setMessage('Đã nhập các chương hợp lệ vào trình biên tập!');
              }}
              style={{ justifyContent: 'center' }}
            >
              <Check size={14} />
              <span>Nhập {ready.length} chương hợp lệ</span>
            </button>

            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() =>
                download(
                  `${active.id}-ket-qua.txt`,
                  active
                    .results!.filter(r => r.text)
                    .map(
                      r =>
                        `${active.rows.find(row => row.chapter.id === r.chapterId)?.chapter.title}\n\n${r.text}`
                    )
                    .join('\n\n'),
                  'text/plain;charset=utf-8'
                )
              }
              style={{ justifyContent: 'center' }}
            >
              <FileText size={14} />
              <span>Tải kết quả (.txt)</span>
            </button>
          </div>

          <div style={{ maxHeight: isSidebar ? '200px' : '300px', overflowY: 'auto' }}>
            {active.results.map(result => {
              const row = active.rows.find(r => r.chapter.id === result.chapterId);
              const disposition = row
                ? importDisposition(active, row, chapters.find(c => c.id === result.chapterId), rules)
                : 'conflict';

              return (
                <div
                  key={result.chapterId}
                  style={{
                    padding: '8px',
                    borderBottom: '1px solid var(--border-color)',
                    fontSize: '11px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                    <span>{row?.chapter.title || result.chapterId}</span>
                    <span
                      style={{
                        color:
                          disposition === 'ready'
                            ? 'var(--success-color)'
                            : disposition === 'imported'
                            ? 'var(--primary-color)'
                            : 'var(--text-color-muted)',
                      }}
                    >
                      {result.error
                        ? 'Lỗi'
                        : disposition === 'imported'
                        ? 'Đã nhập'
                        : disposition === 'conflict'
                        ? 'Có xung đột'
                        : 'Sẵn sàng'}
                    </span>
                  </div>
                  {result.error && <span style={{ color: 'var(--error-color)' }}>{result.error}</span>}
                  {result.text && (
                    <details>
                      <summary style={{ cursor: 'pointer', color: 'var(--primary-color)' }}>Xem bản dịch</summary>
                      <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '120px', overflow: 'auto', fontSize: '10px', marginTop: '4px' }}>
                        {result.text}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
