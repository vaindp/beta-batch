import React, { useEffect, useRef, useState } from 'react';
import { X, Layers, Download, RefreshCw, Clock } from 'lucide-react';
import {
  BATCH_MODEL, formatDuration, importDisposition, parseOutputs, prepareRun, terminalState, toJSONL, validateBackup,
  type BatchChapter, type BatchRules, type BatchRun, type ThinkingLevel,
} from './batch-core';
import { VertexBatchClient, GoogleBatchError, authFromJSON } from './vertex-batch';
import { loadRuns, saveRun } from './batch-store';
import './batch.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onSettings: () => void;
  chapters: BatchChapter[];
  rules: BatchRules;
  title: string;
  credentials: string;
  promptFor: (text: string) => string;
  onImport: (run: BatchRun) => void;
}
const stateNames: Record<string, string> = {
  JOB_STATE_PENDING: 'Đang chờ Google', JOB_STATE_QUEUED: 'Trong hàng đợi',
  JOB_STATE_RUNNING: 'Đang biên tập', JOB_STATE_SUCCEEDED: 'Job đã hoàn tất',
  JOB_STATE_PARTIALLY_SUCCEEDED: 'Hoàn tất một phần', JOB_STATE_FAILED: 'Job thất bại',
  JOB_STATE_CANCELLED: 'Đã hủy', JOB_STATE_CANCELLING: 'Đang hủy',
  JOB_STATE_EXPIRED: 'Hết thời gian', JOB_STATE_PAUSED: 'Tạm dừng',
};
function download(name: string, contents: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export function BatchPanel(props: Props) {
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
  const [elapsedTimeStr, setElapsedTimeStr] = useState('');
  const busyRef = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const selectedOnce = useRef(false);
  const active = runs.find(run => run.id === activeId);
  const client = () => {
    if (!props.credentials) throw new Error('Mở Cài đặt và nạp file Service Account JSON để dùng Batch API.');
    return new VertexBatchClient(authFromJSON(props.credentials));
  };
  const lockedIds = new Set(runs.filter(run =>
    ['submitting', 'unknown'].includes(run.phase) || (run.job && !terminalState(run.job.state)),
  ).flatMap(run => run.rows.map(row => row.chapter.id)));
  const available = props.chapters.filter(c => c.status !== 'editing' && !lockedIds.has(c.id));
  const selectedChapters = available.filter(c => selected.includes(c.id));

  useEffect(() => {
    loadRuns().then(saved => { setRuns(saved); setActiveId(saved[0]?.id || ''); setLoaded(true); })
      .catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    if (props.open && loaded && !selectedOnce.current && props.chapters.length) {
      setSelected(available.filter(c => c.status !== 'done').map(c => c.id));
      selectedOnce.current = true;
    }
  }, [props.open, loaded, props.chapters]);
  useEffect(() => {
    if (!props.open) return;
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      if (e.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') || [])]
        .filter(el => el.getClientRects().length);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); before?.focus(); };
  }, [props.open]);

  async function persist(run: BatchRun) {
    setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)]);
    setActiveId(run.id);
    await saveRun(run);
  }
  async function perform(label: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(''); setMessage('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busyRef.current = false; setBusy(''); }
  }
  async function refresh(run: BatchRun) {
    if (!run.job) return;
    const job = await client().get(run.job.name);
    const isDone = terminalState(job.state);
    await persist({
      ...run,
      phase: 'submitted',
      job,
      completedAt: isDone && !run.completedAt ? new Date().toISOString() : run.completedAt,
    });
  }
  useEffect(() => {
    if (!props.credentials || !active?.job || terminalState(active.job.state)) return;
    const timer = window.setInterval(() => {
      if (!busyRef.current) void perform('Đang cập nhật job…', () => refresh(active));
    }, 20_000);
    return () => clearInterval(timer);
  }, [active, props.credentials]);

  // Real-time execution timer effect
  useEffect(() => {
    if (!active) {
      setElapsedTimeStr('');
      return;
    }
    const update = () => {
      const startTime = active.startedAt || active.createdAt;
      if (!startTime) {
        setElapsedTimeStr('');
        return;
      }
      const startMs = new Date(startTime).getTime();
      if (active.completedAt) {
        setElapsedTimeStr(formatDuration(Math.max(0, new Date(active.completedAt).getTime() - startMs)));
      } else if (active.job && terminalState(active.job.state)) {
        setElapsedTimeStr(formatDuration(Math.max(0, Date.now() - startMs)));
        if (!active.completedAt) {
          void persist({ ...active, completedAt: new Date().toISOString() });
        }
      } else {
        setElapsedTimeStr(formatDuration(Math.max(0, Date.now() - startMs)));
      }
    };
    update();
    const interval = window.setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [active?.id, active?.startedAt, active?.completedAt, active?.job?.state]);

  async function submit() {
    if (!navigator.locks) throw new Error('Cần trình duyệt hỗ trợ Web Locks (Chrome/Edge/Firefox mới) để tránh gửi job trùng giữa các tab.');
    await navigator.locks.request('beta-batch-submit', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Một tab khác đang gửi Batch. Chờ gửi xong rồi cập nhật trang này.');
      const stored = await loadRuns();
      const idsInFlight = new Set(stored.filter(run =>
        ['unknown', 'submitting'].includes(run.phase) || (run.job && !terminalState(run.job.state)),
      ).flatMap(run => run.rows.map(row => row.chapter.id)));
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
      chapters: selectedChapters, rules: props.rules, title: props.title,
      projectId: await api.projectId(), bucket, thinking, promptFor: props.promptFor,
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
      submitted = { ...submitting, phase: 'submitted', job, startedAt: submitting.startedAt || nowIso };
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
    setMessage('Đã gửi job. Google tiếp tục xử lý khi đóng web. Tải bản sao job để phòng mất dữ liệu trình duyệt.');
  }
  async function readOutputs(run: BatchRun, files?: string[]) {
    const parsed = await parseOutputs(run, files || await client().downloadOutputs(run));
    await persist({ ...run, results: parsed.results, outputWarnings: parsed.warnings });
    setMessage('Đã đọc kết quả. Kiểm tra danh sách bên dưới rồi bấm nhập các chương hợp lệ.');
  }
  const ready = active?.results?.filter(result => result.text && active.rows.some(row =>
    row.chapter.id === result.chapterId && importDisposition(active, row, props.chapters.find(c => c.id === result.chapterId), props.rules) === 'ready',
  )) || [];
  const anyBusy = !!busy || !loaded;
  if (!props.open) return null;

  return <div className="modal-overlay batch-overlay" onClick={props.onClose}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="batch-title"
      className="modal-content batch-dialog" onClick={e => e.stopPropagation()}>
      <div className="modal-header">
        <div><h2 id="batch-title"><Layers size={21} /> Biên tập bằng Batch API</h2><p className="batch-subtitle">Gemini 4 Argon · Mỗi chương là một yêu cầu độc lập</p></div>
        <button className="btn-icon" aria-label="Đóng Batch" onClick={props.onClose}><X size={20} /></button>
      </div>
      <div className="batch-body">
        <p className="batch-note">Gửi nhiều chương một lượt và nhận kết quả sau. Mức giá Batch giúp giảm chi phí dù không có cache hit. Thời gian hoàn tất phụ thuộc hàng đợi Google.</p>
        <details className="batch-note">
          <summary>Chưa có bucket? Thiết lập một lần trong Google Cloud Console</summary>
          <ol>
            <li>Mở <a href="https://console.cloud.google.com/storage/browser" target="_blank" rel="noopener noreferrer">Cloud Storage → Buckets</a>, chọn đúng project đang dùng Argon.</li>
            <li>Bấm Create, đặt tên bucket duy nhất; dùng Standard, chọn vùng phù hợp. Giữ bucket riêng tư với Uniform access và Public access prevention. Phần lưu trữ có thể phát sinh phí.</li>
            <li>Trong Permissions của bucket, cấp <strong>Storage Object User</strong> cho email service account trong file JSON. Tài khoản này cũng cần <strong>Vertex AI User</strong> trên project.</li>
            <li>Nếu bucket thuộc project khác, cấp quyền đọc/ghi đối tượng cho <strong>Vertex AI Service Agent</strong> của project chạy job: service-PROJECT_NUMBER@gcp-sa-aiplatform.iam.gserviceaccount.com.</li>
            <li>Chép tên bucket vào ô bên dưới. Web không cần quyền liệt kê tất cả bucket, chỉ cần quyền đối với bucket bạn nhập.</li>
          </ol>
        </details>
        {!props.credentials && <div className="batch-warning">Cần file Service Account JSON cho Batch API. <button className="btn btn-secondary" onClick={() => { props.onClose(); props.onSettings(); }}>Mở Cài đặt</button></div>}
        <div className="batch-grid">
          <section className="batch-card">
            <h3>1. Chuẩn bị chương</h3>
            <label className="batch-field">Bucket Cloud Storage có sẵn
              <input value={bucket} placeholder="ten-bucket hoặc gs://ten-bucket" onChange={e => setBucket(e.target.value)} disabled={anyBusy} />
            </label>
            <label className="batch-field">Mức thinking
              <select value={thinking} onChange={e => setThinking(e.target.value as ThinkingLevel)} disabled={anyBusy}>
                <option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option>
              </select>
            </label>
            <p className="batch-muted">Giữ toàn bộ prompt và quy tắc đang có trong trình biên tập. Không cần văn bản mẫu. Model cố định: {BATCH_MODEL}.</p>
            <div className="batch-actions">
              <button className="btn btn-secondary" disabled={anyBusy} onClick={() => setSelected(available.filter(c => c.status !== 'done').map(c => c.id))}>Chọn chương chưa xong</button>
              <button className="btn btn-secondary" disabled={anyBusy} onClick={() => setSelected([])}>Bỏ chọn</button>
            </div>
            <div className="batch-chapters">
              {!props.chapters.length && <p>Tải file truyện .txt trong màn hình biên tập trước.</p>}
              {props.chapters.map(chapter => <label key={chapter.id} className="batch-chapter">
                <input type="checkbox" checked={selected.includes(chapter.id) && !lockedIds.has(chapter.id)}
                  disabled={anyBusy || lockedIds.has(chapter.id) || chapter.status === 'editing'}
                  onChange={e => setSelected(previous => e.target.checked ? [...previous, chapter.id] : previous.filter(id => id !== chapter.id))} />
                <span>{chapter.title}<small>{lockedIds.has(chapter.id) ? 'Đang thuộc một job chưa hoàn tất' : chapter.status === 'done' ? 'Đã xong · chọn lại sẽ tạo yêu cầu mới có phí' : 'Chưa biên tập'}</small></span>
              </label>)}
            </div>
            <button className="btn btn-primary batch-submit" disabled={anyBusy || !props.credentials || !bucket.trim() || !selectedChapters.length}
              onClick={() => void perform('Đang lưu và gửi job lên Google…', submit)}>
              Gửi Batch · {selectedChapters.length} chương (có phí)
            </button>
          </section>
          <section className="batch-card">
            <h3>2. Theo dõi và nhận bản biên tập</h3>
            <label className="batch-field">Lịch sử job
              <select value={activeId} onChange={e => setActiveId(e.target.value)} disabled={anyBusy}>
                {!runs.length && <option value="">Chưa có job</option>}
                {runs.map(run => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString('vi-VN')} · {run.title || 'Truyện'} · {run.rows.length} chương</option>)}
              </select>
            </label>
            <label className="btn btn-secondary batch-file">Khôi phục bản sao job
              <input type="file" accept=".json" disabled={anyBusy} onChange={e => {
                const file = e.target.files?.[0]; e.target.value = '';
                if (file) void perform('Đang khôi phục…', async () => {
                  const restored = await validateBackup(JSON.parse(await file.text()));
                  const existing = runs.find(r => r.id === restored.id);
                  if (existing) { setActiveId(existing.id); setMessage('Job này đã có trong lịch sử; giữ dữ liệu mới nhất.'); }
                  else await persist(restored);
                });
              }} />
            </label>
            {active && <>
              <div className="batch-status">{active.job ? stateNames[active.job.state] || active.job.state
                : ['unknown', 'submitting'].includes(active.phase) ? 'Cần tìm lại job đã gửi' : 'Chưa gửi thành công'}</div>
              <p className="batch-muted batch-id">{active.job?.name || active.id}</p>
              {active.job?.error?.message && <p className="batch-error">{active.job.error.message}</p>}
              <div className="batch-timer-box" style={{ margin: '10px 0' }}>
                <div className="batch-timer-header">
                  <Clock size={13} color="var(--primary-color)" />
                  <span className="batch-timer-title">
                    {active.job && terminalState(active.job.state)
                      ? 'Thời gian thực thi hoàn tất'
                      : 'Thời gian đang chạy (theo nhật ký)'}
                  </span>
                </div>
                <div className="batch-timer-value">
                  {elapsedTimeStr || '0 giây'}
                  {active.job && !terminalState(active.job.state) && <span className="batch-timer-pulsing-dot" />}
                </div>
                <div className="batch-timer-timestamps">
                  <span>Bắt đầu: <strong>{new Date(active.startedAt || active.createdAt).toLocaleTimeString('vi-VN')}</strong></span>
                  {active.completedAt && <span>Hoàn tất: <strong>{new Date(active.completedAt).toLocaleTimeString('vi-VN')}</strong></span>}
                </div>
              </div>
              <div className="batch-actions">
                <button className="btn btn-secondary" onClick={() => download(`${active.id}.batch-backup.json`, JSON.stringify(active, null, 2))}><Download size={14} /> Sao lưu job</button>
                <button className="btn btn-secondary" onClick={() => download(`${active.id}.jsonl`, toJSONL(active), 'application/jsonl')}>Tải yêu cầu JSONL</button>
                {active.job && <button className="btn btn-secondary" disabled={anyBusy || !props.credentials} onClick={() => void perform('Đang cập nhật…', () => refresh(active))}><RefreshCw size={14} /> Cập nhật</button>}
                {active.job && !terminalState(active.job.state) && <button className="btn btn-secondary" disabled={anyBusy || !props.credentials}
                  onClick={() => void perform('Đang yêu cầu hủy…', async () => {
                    await client().cancel(active.job!.name); await refresh(active);
                    setMessage('Đã yêu cầu hủy. Google vẫn tính phí các yêu cầu đã xử lý.');
                  })}>Hủy job</button>}
                {active.job && terminalState(active.job.state) && <button className="btn btn-primary" disabled={anyBusy || !props.credentials}
                  onClick={() => void perform('Đang tải kết quả từ bucket…', () => readOutputs(active))}>Lấy kết quả từ Google</button>}
              </div>
              {!active.job && ['unknown', 'submitting'].includes(active.phase) && <div className="batch-warning">
                <p>Mạng có thể đã ngắt sau khi Google nhận job. Tìm lại để tránh gửi trùng có phí.</p>
                <button className="btn btn-secondary" disabled={anyBusy || !props.credentials} onClick={() => void perform('Đang tìm job đã gửi…', async () => {
                  const found = await client().recover(active);
                  if (found.length !== 1) throw new Error(found.length ? 'Có nhiều job trùng tên. Kiểm tra Google Cloud và nhập tên job bên dưới.' : 'Chưa tìm thấy job. Chờ rồi thử lại; hoặc kiểm tra trên Google Cloud.');
                  await persist({ ...active, phase: 'submitted', job: found[0] });
                })}>Tìm job đã gửi</button>
                <label className="batch-field">Hoặc dán tên tài nguyên job từ Google Cloud
                  <input value={manualName} onChange={e => setManualName(e.target.value)} placeholder="projects/…/locations/global/batchPredictionJobs/…" />
                </label>
                <button className="btn btn-secondary" disabled={anyBusy || !props.credentials || !manualName} onClick={() => void perform('Đang kiểm tra job…', async () => {
                  const job = await client().get(manualName.trim());
                  if (job.displayName !== active.id) throw new Error('Job này không khớp mã gửi. Không gắn vào bản truyện hiện tại.');
                  await persist({ ...active, phase: 'submitted', job });
                })}>Gắn lại job</button>
              </div>}
              <label className="btn btn-secondary batch-file">Nhập file kết quả JSONL từ Google Cloud
                <input type="file" accept=".jsonl,.json" multiple disabled={anyBusy} onChange={e => {
                  const files = Array.from(e.target.files || []) as File[]; e.target.value = '';
                  if (files.length) void perform('Đang đối chiếu kết quả…', async () => readOutputs(active, await Promise.all(files.map(file => file.text()))));
                }} />
              </label>
              <p className="batch-muted">Job đang chọn được cập nhật mỗi 30 giây khi có khóa. Đóng web không hủy job. Có thể tải kết quả thủ công và nhập ở đây.</p>
            </>}
          </section>
        </div>
        {busy && <div className="batch-note" role="status">{busy}</div>}
        {error && <div className="batch-error" role="alert">{error}</div>}
        {message && <div className="batch-note" role="status">{message}</div>}
        {!!active?.results && <section className="batch-card batch-results">
          <h3>3. Kiểm tra kết quả</h3>
          <p className="batch-muted">Chương hoặc quy tắc đã thay đổi trong lúc chờ sẽ không bị ghi đè. Kết quả lỗi, trống hoặc hết giới hạn đầu ra không được đánh dấu hoàn tất.</p>
          <div className="batch-actions">
            <button className="btn btn-primary" disabled={anyBusy || !ready.length} onClick={() => {
              props.onImport(active); setMessage('Đã nhập các chương hợp lệ vào trình biên tập. Các mục xung đột được giữ lại để xem riêng.');
            }}>Nhập {ready.length} chương hợp lệ</button>
            <button className="btn btn-secondary" onClick={() => download(`${active.id}-ket-qua.txt`, active.results!.filter(r => r.text).map(r =>
              `${active.rows.find(row => row.chapter.id === r.chapterId)?.chapter.title}\n\n${r.text}`,
            ).join('\n\n'), 'text/plain;charset=utf-8')}>Tải toàn bộ kết quả hợp lệ (.txt)</button>
          </div>
          <div className="batch-table-wrap"><table><thead><tr><th>Chương</th><th>Kết quả</th><th>Token vào / ra / thinking / cache</th></tr></thead><tbody>
            {active.results.map(result => {
              const row = active.rows.find(row => row.chapter.id === result.chapterId)!;
              const disposition = importDisposition(active, row, props.chapters.find(c => c.id === result.chapterId), props.rules);
              return <tr key={result.chapterId}><td>{row.chapter.title}</td><td>
                {result.error || (disposition === 'imported' ? 'Đã nhập' : disposition === 'conflict' ? 'Đã thay đổi · xem riêng' : 'Sẵn sàng nhập')}
                {result.text && <details><summary>Xem bản biên tập</summary><pre>{result.text}</pre></details>}
              </td><td>{[result.usage?.promptTokenCount, result.usage?.candidatesTokenCount, result.usage?.thoughtsTokenCount, result.usage?.cachedContentTokenCount].map(n => n ?? '—').join(' / ')}</td></tr>;
            })}
          </tbody></table></div>
          <p className="batch-muted">“—” nghĩa là Google không trả số liệu. Chi phí Batch xem trong Google Cloud Billing; bảng giá Standard ở trình biên tập chỉ dành cho lượt biên tập trực tiếp.</p>
          {active.outputWarnings?.map((warning, i) => <p className="batch-warning" key={i}>{warning}</p>)}
        </section>}
      </div>
    </div>
  </div>;
}
