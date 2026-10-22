import { getVertexBatchAuth } from './vertex-browser';
import {
  createJobBody, inputObject, outputPrefix, toJSONL, validateJobName,
  type BatchRun, type RemoteJob,
} from './batch-core';

export type BatchAuth = () => Promise<{ projectId: string; token: string }>;
export const authFromJSON = (json: string): BatchAuth => () => getVertexBatchAuth(json);
const API = 'https://aiplatform.googleapis.com/v1/';
const STORAGE = 'https://storage.googleapis.com';
export class GoogleBatchError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export class VertexBatchClient {
  constructor(private auth: BatchAuth, private fetcher: typeof fetch = fetch) {}
  async projectId() { return (await this.auth()).projectId; }
  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const { token } = await this.auth();
    // Bound reads and mutations so a stalled connection does not freeze the interface forever.
    const response = await this.fetcher(url, {
      ...init, signal: AbortSignal.timeout(120_000),
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      let message = `Google trả lỗi HTTP ${response.status}.`;
      try { const body = await response.json(); message = body.error?.message || message; } catch {}
      throw new GoogleBatchError(message, response.status);
    }
    return response;
  }
  private collection(projectId: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(projectId)) throw new Error('Project ID không hợp lệ.');
    return `${API}projects/${projectId}/locations/global/batchPredictionJobs`;
  }
  async upload(run: BatchRun): Promise<void> {
    const query = new URLSearchParams({ uploadType: 'media', name: inputObject(run), ifGenerationMatch: '0' });
    await this.call(`${STORAGE}/upload/storage/v1/b/${encodeURIComponent(run.bucket)}/o?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/jsonl; charset=utf-8' }, body: toJSONL(run),
    });
  }
  async create(run: BatchRun): Promise<RemoteJob> {
    // Intentionally no automatic POST retry: an ambiguous network failure may already have created a paid job.
    const res = await this.call(this.collection(run.projectId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createJobBody(run)),
    });
    const job = await res.json();
    validateJobName(job.name);
    return job;
  }
  async get(name: string): Promise<RemoteJob> {
    return (await this.call(API + validateJobName(name))).json();
  }
  async cancel(name: string): Promise<void> {
    await this.call(API + validateJobName(name) + ':cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }
  async recover(run: BatchRun): Promise<RemoteJob[]> {
    const jobs: RemoteJob[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ filter: `displayName="${run.id}"`, pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const body = await (await this.call(`${this.collection(run.projectId)}?${params}`)).json();
      jobs.push(...(body.batchPredictionJobs || []));
      pageToken = body.nextPageToken || '';
    } while (pageToken);
    return jobs;
  }
  async downloadOutputs(run: BatchRun): Promise<string[]> {
    const names: string[] = [];
    let pageToken = '';
    // Restrict reads to this run's prefix, even if a restored backup contains a different outputInfo.
    do {
      const query = new URLSearchParams({ prefix: outputPrefix(run), maxResults: '1000' });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await (await this.call(`${STORAGE}/storage/v1/b/${encodeURIComponent(run.bucket)}/o?${query}`)).json();
      names.push(...(data.items || []).map((item: { name: string }) => item.name).filter((n: string) => n.endsWith('.jsonl')));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    if (!names.length) throw new Error('Chưa thấy file kết quả JSONL trong bucket. Thử lại sau hoặc nhập file tải từ Google Cloud.');
    const files: string[] = [];
    for (const name of names) {
      files.push(await (await this.call(`${STORAGE}/storage/v1/b/${encodeURIComponent(run.bucket)}/o/${encodeURIComponent(name)}?alt=media`)).text());
    }
    return files;
  }
}
