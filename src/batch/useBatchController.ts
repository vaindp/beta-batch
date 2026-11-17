import { useEffect, useRef, useState } from 'react';
import {
  formatDuration, importDisposition, parseOutputs, prepareRun, terminalState,
  type BatchChapter, type BatchRules, type BatchRun, type ThinkingLevel,
} from './batch-core';
import { VertexBatchClient, GoogleBatchError, authFromJSON } from './vertex-batch';
import { loadRuns, saveRun } from './batch-store';
import { useBatchModel } from './BatchModelSettings';

interface BatchControllerProps {
  chapters: BatchChapter[];
  rules: BatchRules;
  title: string;
  credentials: string;
  promptFor: (text: string) => string;
}
const defaultServices = {
  loadRuns, saveRun,
  createClient: (credentials: string) => new VertexBatchClient(authFromJSON(credentials)),
};

// Mounted once by App: both views share state, operation lock, polling and clock.
export function useBatchController(props: BatchControllerProps, services = defaultServices) {
  const modelSelection = useBatchModel();
  const [runs, setRuns] = useState<BatchRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [bucket, setBucket] = useState(() => localStorage.getItem('beta-batch-bucket') || '');
  const [thinking, setThinking] = useState<ThinkingLevel>(() => {
    const saved = localStorage.getItem('beta-batch-thinking');
    return saved === 'LOW' || saved === 'HIGH' ? saved : 'MEDIUM';
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [manualName, setManualName] = useState('');
  const [elapsedTimeStr, setElapsedTimeStr] = useState('');
  const busyRef = useRef(false);
  const selectedOnce = useRef(false);
  useEffect(() => { localStorage.setItem('beta-batch-bucket', bucket); }, [bucket]);
  useEffect(() => { localStorage.setItem('beta-batch-thinking', thinking); }, [thinking]);
  const active = runs.find(run => run.id === activeId);
  const client = () => {
    if (!props.credentials) throw new Error('Mở Cài đặt và nạp file Service Account JSON để dùng Batch API.');
    return services.createClient(props.credentials);
  };
  const lockedIds = new Set(runs.filter(run =>
    ['submitting', 'unknown'].includes(run.phase) || (run.job && !terminalState(run.job.state)),
  ).flatMap(run => run.rows.map(row => row.chapter.id)));
  const available = props.chapters.filter(c => c.status !== 'editing' && !lockedIds.has(c.id));
  const selectedChapters = available.filter(c => selected.includes(c.id));

  useEffect(() => {
    let cancelled = false;
    services.loadRuns().then(saved => {
      if (cancelled) return;
      setRuns(saved.map(withCompletionTime)); setActiveId(saved[0]?.id || ''); setLoaded(true);
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (loaded && !selectedOnce.current && props.chapters.length) {
      setSelected(available.filter(c => c.status !== 'done').map(c => c.id));
      selectedOnce.current = true;
    }
  }, [loaded, props.chapters]);

  function withCompletionTime(run: BatchRun): BatchRun {
    return run.job && terminalState(run.job.state) && !run.completedAt
      ? { ...run, completedAt: new Date().toISOString() } : run;
  }
  async function persist(value: BatchRun) {
    const run = withCompletionTime(value);
    setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)]);
    setActiveId(run.id);
    await services.saveRun(run);
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
      } else {
        setElapsedTimeStr(formatDuration(Math.max(0, Date.now() - startMs)));
      }
    };
    update();
    if (active.completedAt) return;
    const interval = window.setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [active?.id, active?.startedAt, active?.completedAt, active?.job?.state]);

  async function submit() {
    if (!navigator.locks) throw new Error('Cần trình duyệt hỗ trợ Web Locks (Chrome/Edge/Firefox mới) để tránh gửi job trùng giữa các tab.');
    await navigator.locks.request('beta-batch-submit', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Một tab khác đang gửi Batch. Chờ gửi xong rồi cập nhật trang này.');
      const stored = await services.loadRuns();
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
      projectId: await api.projectId(), bucket, model: modelSelection.model, thinking, promptFor: props.promptFor,
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
  const isTerminal = !!active?.job && terminalState(active.job.state);
  const isRunning = !!active && (active.job ? !isTerminal : ['submitting', 'unknown'].includes(active.phase));
  return {
    modelSelection, runs, loaded, activeId, setActiveId, active,
    bucket, setBucket, thinking, setThinking, selected, setSelected,
    busy, error, message, setMessage, manualName, setManualName, elapsedTimeStr,
    lockedIds, available, selectedChapters, anyBusy, ready, isTerminal, isRunning,
    persist, perform, client, refresh, submit, readOutputs,
  };
}
export type BatchController = ReturnType<typeof useBatchController>;
