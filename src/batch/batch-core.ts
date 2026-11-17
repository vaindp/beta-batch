export const BATCH_MODEL = 'gemini-4-argon';
export const BATCH_MODELS = [
  { id: BATCH_MODEL, label: 'Gemini 4 Argon' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
];
export function normalizeBatchModel(value: unknown): string {
  if (typeof value !== 'string' || !/^gemini-[a-z0-9][a-z0-9._-]*$/.test(value.trim())) {
    throw new Error('Model ID không hợp lệ. Nhập ID Gemini, ví dụ gemini-4-argon, không nhập URL hoặc đường dẫn.');
  }
  return value.trim();
}
// Jobs created before model selection always used Argon.
export const batchRunModel = (run: { model?: string }): string =>
  normalizeBatchModel(run.model === undefined ? BATCH_MODEL : run.model);
export type ThinkingLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export interface BatchChapter {
  id: string;
  title: string;
  originalContent: string;
  editedContent: string;
  status: string;
  batchResultId?: string;
}
export interface BatchRules { pronounRules: string; addressingRules: string }
export interface BatchRow {
  chapter: BatchChapter;
  promptHash: string;
  request: {
    contents: { role: string; parts: { text: string }[] }[];
    generationConfig: { thinkingConfig?: { thinkingLevel: ThinkingLevel }; maxOutputTokens?: number };
  };
}
export interface BatchResult {
  chapterId: string;
  text?: string;
  error?: string;
  usage?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}
export interface RemoteJob {
  name: string;
  displayName?: string;
  state: string;
  completionStats?: { successfulCount?: string; failedCount?: string; incompleteCount?: string };
  outputInfo?: { gcsOutputDirectory?: string };
  error?: { message?: string };
}
export interface BatchRun {
  version: 1;
  model?: string;
  id: string;
  createdAt: string;
  projectId: string;
  bucket: string;
  title: string;
  rules: BatchRules;
  rows: BatchRow[];
  phase: 'prepared' | 'submitting' | 'unknown' | 'submitted';
  job?: RemoteJob;
  results?: BatchResult[];
  outputWarnings?: string[];
  startedAt?: string;
  completedAt?: string;
}

export function formatDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return '0 giây';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours} giờ ${minutes} phút ${seconds} giây`;
  }
  if (minutes > 0) {
    return `${minutes} phút ${seconds} giây`;
  }
  return `${seconds} giây`;
}
export function normalizeBucket(value: string): string {
  const bucket = value.trim().replace(/^gs:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    throw new Error('Nhập tên bucket có sẵn, ví dụ ten-bucket; không thêm đường dẫn thư mục.');
  }
  return bucket;
}
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function prepareRun(args: {
  chapters: BatchChapter[];
  rules: BatchRules;
  title: string;
  projectId: string;
  bucket: string;
  thinking: ThinkingLevel;
  model?: string;
  promptFor: (text: string) => string;
}): Promise<BatchRun> {
  if (!args.chapters.length) throw new Error('Chọn ít nhất một chương.');
  if (args.chapters.length > 200_000) throw new Error('Một job tối đa 200.000 chương.');
  const model = batchRunModel(args);
  const id = `beta-${crypto.randomUUID()}`;
  const rows = await Promise.all(args.chapters.map(async chapter => {
    // Unique trailing marker disambiguates identical chapters without changing the shared prefix.
    const prompt = `${args.promptFor(chapter.originalContent)}\n\n[Mã đối chiếu: ${id}/${chapter.id}. Không đưa mã này vào bản biên tập.]`;
    return {
      chapter: { ...chapter },
      promptHash: await sha256(prompt),
      request: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // Use model defaults when Argon's thinking configuration is not applicable.
        generationConfig: model === BATCH_MODEL
          ? { thinkingConfig: { thinkingLevel: args.thinking }, maxOutputTokens: 65_536 }
          : {},
      },
    };
  }));
  const run: BatchRun = {
    version: 1, model, id, createdAt: new Date().toISOString(), title: args.title,
    projectId: args.projectId, bucket: normalizeBucket(args.bucket),
    rules: { ...args.rules }, rows, phase: 'prepared',
  };
  if (new TextEncoder().encode(toJSONL(run)).length >= 1_000_000_000) {
    throw new Error('File yêu cầu phải nhỏ hơn 1 GB. Chọn ít chương hơn.');
  }
  return run;
}
export function toJSONL(run: BatchRun): string {
  return run.rows.map(row => JSON.stringify({ request: row.request })).join('\n') + '\n';
}
export function inputObject(run: BatchRun): string { return `beta-batch/${run.id}/input.jsonl`; }
export function outputPrefix(run: BatchRun): string { return `beta-batch/${run.id}/output/`; }
export function createJobBody(run: BatchRun) {
  return {
    displayName: run.id,
    model: `publishers/google/models/${batchRunModel(run)}`,
    inputConfig: { instancesFormat: 'jsonl', gcsSource: { uris: [`gs://${run.bucket}/${inputObject(run)}`] } },
    outputConfig: { predictionsFormat: 'jsonl', gcsDestination: { outputUriPrefix: `gs://${run.bucket}/${outputPrefix(run)}` } },
  };
}
export const terminalState = (state?: string) =>
  !!state && ['JOB_STATE_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED', 'JOB_STATE_PARTIALLY_SUCCEEDED'].includes(state);

/** Google may reorder output lines and augment echoed requests. Match only the exact input text. */
export async function parseOutputs(run: BatchRun, files: string[]): Promise<{ results: BatchResult[]; warnings: string[] }> {
  const byHash = new Map(run.rows.map(row => [row.promptHash, row]));
  const found = new Map<string, BatchResult>();
  const warnings: string[] = [];
  for (const file of files) {
    let lineNumber = 0;
    for (const line of file.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      lineNumber++;
      if (!line.trim()) continue;
      let data: any;
      try { data = JSON.parse(line); } catch {
        warnings.push(`Dòng ${lineNumber} không phải JSON hợp lệ.`); continue;
      }
      const text = data?.request?.contents?.[0]?.parts?.[0]?.text;
      const row = typeof text === 'string' ? byHash.get(await sha256(text)) : undefined;
      if (!row) { warnings.push(`Dòng ${lineNumber} không khớp chương của job này.`); continue; }
      const chapterId = row.chapter.id;
      if (found.has(chapterId)) {
        found.set(chapterId, { chapterId, error: 'Có nhiều kết quả cho cùng chương; cần kiểm tra thủ công.' });
        continue;
      }
      const candidate = data.response?.candidates?.[0];
      const answer = candidate?.content?.parts?.filter((p: any) => !p.thought && typeof p.text === 'string').map((p: any) => p.text).join('').trim();
      const status = data.status;
      const failedStatus = typeof status === 'string'
        ? !!status.trim() && status !== 'OK'
        : status && (status.code || status.message);
      let error: string | undefined;
      if (failedStatus) error = typeof status === 'string' ? status : JSON.stringify(status);
      else if (candidate?.finishReason !== 'STOP') error = `Kết quả chưa hoàn chỉnh: ${candidate?.finishReason || data.response?.promptFeedback?.blockReason || 'không có câu trả lời'}.`;
      else if (!answer) error = 'Kết quả trống.';
      found.set(chapterId, { chapterId, text: error ? undefined : answer, error, usage: data.response?.usageMetadata });
    }
  }
  return {
    results: run.rows.map(row => found.get(row.chapter.id) || { chapterId: row.chapter.id, error: 'Chưa có kết quả trong file đã nhận.' }),
    warnings,
  };
}
export function importDisposition(run: BatchRun, row: BatchRow, current: BatchChapter | undefined, rules: BatchRules): 'ready' | 'imported' | 'conflict' {
  if (current?.batchResultId === `${run.id}/${row.chapter.id}`) return 'imported';
  if (!current || current.status === 'editing'
    || current.title !== row.chapter.title
    || current.originalContent !== row.chapter.originalContent
    || current.editedContent !== row.chapter.editedContent
    || current.status !== row.chapter.status
    || rules.pronounRules !== run.rules.pronounRules
    || rules.addressingRules !== run.rules.addressingRules) return 'conflict';
  return 'ready';
}

export async function validateBackup(value: unknown): Promise<BatchRun> {
  const run = value as BatchRun;
  if (run?.version !== 1 || !/^beta-[0-9a-f-]{36}$/.test(run.id)
    || !/^[a-zA-Z0-9-]+$/.test(run.projectId) || normalizeBucket(run.bucket) !== run.bucket
    || !Array.isArray(run.rows) || !run.rows.length || run.rows.length > 200_000
    || typeof run.rules?.pronounRules !== 'string' || typeof run.rules?.addressingRules !== 'string'
    || !['prepared', 'submitting', 'unknown', 'submitted'].includes(run.phase)) throw new Error('Bản sao job không hợp lệ.');
  const ids = new Set<string>();
  for (const row of run.rows) {
    const c = row.chapter;
    if (!c || typeof c.id !== 'string' || ids.has(c.id)
      || ['title', 'originalContent', 'editedContent', 'status'].some(k => typeof (c as Record<string, any>)[k] !== 'string')
      || typeof row.request?.contents?.[0]?.parts?.[0]?.text !== 'string'
      || row.promptHash !== await sha256(row.request.contents[0].parts[0].text)) throw new Error('Dữ liệu chương trong bản sao không hợp lệ.');
    ids.add(c.id);
  }
  if (run.job) validateJobName(run.job.name);
  return { ...run, model: batchRunModel(run), results: undefined, outputWarnings: undefined };
}

export function validateJobName(name: string): string {
  if (!/^projects\/[a-zA-Z0-9-]+\/locations\/global\/batchPredictionJobs\/[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Mã job không hợp lệ hoặc không ở vùng global.');
  }
  return name;
}
