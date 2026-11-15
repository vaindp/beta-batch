import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  prepareRun, toJSONL, parseOutputs, importDisposition, createJobBody, normalizeBucket,
  validateBackup, terminalState, batchRunModel, BATCH_MODELS, type BatchRun, type BatchChapter,
} from '../batch-core';
import { VertexBatchClient, GoogleBatchError } from '../vertex-batch';

const rules = { pronounRules: 'Giữ tên nhân vật', addressingRules: 'Giữ xưng hô' };
const chapter = (id: string): BatchChapter => ({
  id, title: `Chương ${id}`, originalContent: 'Một câu chưa sửa.\nMột câu khác.', editedContent: '', status: 'ready',
});
const fixture = (model?: string) => prepareRun({
  chapters: [chapter('1'), chapter('2'), chapter('3')], title: 'Truyện thử', rules,
  projectId: 'test-project', bucket: 'gs://test-bucket/', thinking: 'MEDIUM', model,
  promptFor: text => `${rules.pronounRules}\n${rules.addressingRules}\n${text}`,
});
function output(run: BatchRun, index: number, overrides: Record<string, unknown> = {}) {
  return {
    request: run.rows[index].request,
    status: '',
    response: {
      candidates: [{ finishReason: 'STOP', content: { parts: [
        { thought: true, text: 'Không phải bản biên tập' }, { text: `Bản sửa ${index}.` },
      ] } }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30 },
    },
    ...overrides,
  };
}

test('one JSONL request per chapter, same rules prefix, unique correspondence even for identical originals', async () => {
  const run = await fixture();
  const lines = toJSONL(run).trim().split('\n').map(s => JSON.parse(s));
  assert.equal(lines.length, 3);
  assert.equal(new Set(run.rows.map(r => r.promptHash)).size, 3);
  assert.ok(lines.every(l => l.request.contents[0].parts[0].text.startsWith(rules.pronounRules)));
  assert.equal(lines[0].request.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM');
  assert.equal(lines[0].request.generationConfig.maxOutputTokens, 65_536);
  assert.deepEqual(Object.keys(lines[0]), ['request']);
  const body = createJobBody(run);
  assert.equal(body.model, 'publishers/google/models/gemini-4-argon');
  assert.equal(body.inputConfig.instancesFormat, 'jsonl');
  assert.equal(body.inputConfig.gcsSource.uris[0], `gs://test-bucket/beta-batch/${run.id}/input.jsonl`);
  assert.ok(!toJSONL(run).includes('private_key'));
});
test('selected and custom models survive backup restoration and reach the Google job request', async () => {
  for (const model of [...BATCH_MODELS.map(item => item.id), 'gemini-3.1-pro-preview']) {
    const run = await fixture(` ${model} `);
    assert.equal(run.model, model);
    const restored = await validateBackup(JSON.parse(JSON.stringify(run)));
    assert.equal(batchRunModel(restored), model);
    let submitted: any;
    const client = new VertexBatchClient(async () => ({ projectId: 'test-project', token: 'test-token' }),
      async (_url, init) => {
        submitted = JSON.parse(init!.body as string);
        return Response.json({ name: 'projects/test-project/locations/global/batchPredictionJobs/123', state: 'JOB_STATE_PENDING' });
      });
    await client.create(restored);
    assert.equal(submitted.model, `publishers/google/models/${model}`);
    const config = JSON.parse(toJSONL(restored).trim().split('\n')[0]).request.generationConfig;
    if (model !== 'gemini-4-argon') {
      assert.equal(config.thinkingConfig, undefined);
      assert.equal(config.maxOutputTokens, undefined);
    }
  }
});
test('legacy jobs keep Argon while new jobs can select a different model', async () => {
  const legacy = await fixture();
  delete legacy.model;
  const next = await fixture('gemini-2.5-flash');
  assert.equal(batchRunModel(legacy), 'gemini-4-argon');
  assert.equal((await validateBackup(JSON.parse(JSON.stringify(legacy)))).model, 'gemini-4-argon');
  assert.equal(createJobBody(legacy).model, 'publishers/google/models/gemini-4-argon');
  assert.equal(createJobBody(next).model, 'publishers/google/models/gemini-2.5-flash');
});
test('invalid model IDs cannot be prepared, restored, or submitted', async () => {
  const run = await fixture();
  for (const model of ['', ' ', '../gemini-4-argon', 'https://example.com', 'publishers/google/models/gemini-4-argon', 'gemini-test?key=value', null, 123]) {
    await assert.rejects(fixture(model as string), /Model ID/);
    await assert.rejects(validateBackup({ ...run, model }), /Model ID/);
    assert.throws(() => createJobBody({ ...run, model: model as string }), /Model ID/);
  }
});
test('unordered output and server-added request fields still match exact chapter; thoughts are excluded', async () => {
  const run = await fixture();
  const rows = [output(run, 2), output(run, 0), output(run, 1)];
  rows[0].request = { ...rows[0].request, contents: rows[0].request.contents.map(c => ({ ...c })) };
  const parsed = await parseOutputs(run, [rows.map(row => JSON.stringify(row)).join('\r\n')]);
  assert.equal(parsed.warnings.length, 0);
  assert.deepEqual(parsed.results.map(r => [r.chapterId, r.text]), [['1', 'Bản sửa 0.'], ['2', 'Bản sửa 1.'], ['3', 'Bản sửa 2.']]);
  assert.equal(parsed.results[0].usage?.cachedContentTokenCount, undefined);
});
test('failed, truncated and missing results cannot be imported as success', async () => {
  const run = await fixture();
  const data = [
    output(run, 0, { status: 'Bad Request: quota exhausted', response: {} }),
    output(run, 1, { response: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Dở dang' }] } }] } }),
  ];
  const parsed = await parseOutputs(run, [data.map(d => JSON.stringify(d)).join('\n')]);
  assert.ok(parsed.results.every(r => r.error && !r.text));
  assert.match(parsed.results[2].error!, /Chưa có kết quả/);
});
test('empty/blocked responses, duplicate rows, foreign rows and broken JSON are rejected', async () => {
  const run = await fixture();
  const data = [
    output(run, 0), output(run, 0),
    output(run, 1, { response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'thinking only' }] } }] } }),
    output(run, 2, { response: { promptFeedback: { blockReason: 'SAFETY' } } }),
    { request: { contents: [{ parts: [{ text: 'unrelated input' }] }] } },
  ];
  const parsed = await parseOutputs(run, [data.map(d => JSON.stringify(d)).join('\n') + '\n{broken']);
  assert.equal(parsed.warnings.length, 2);
  assert.ok(parsed.results.every(r => !!r.error && !r.text));
});
test('imports protect edited/deleted chapters, changed rules and in-flight direct editing; imports are idempotent', async () => {
  const run = await fixture(), row = run.rows[0];
  assert.equal(importDisposition(run, row, chapter('1'), rules), 'ready');
  assert.equal(importDisposition(run, row, undefined, rules), 'conflict');
  for (const change of [{ originalContent: 'new' }, { editedContent: 'hand edit' }, { title: 'new title' }, { status: 'editing' }]) {
    assert.equal(importDisposition(run, row, { ...chapter('1'), ...change }, rules), 'conflict');
  }
  assert.equal(importDisposition(run, row, chapter('1'), { ...rules, pronounRules: 'Changed' }), 'conflict');
  assert.equal(importDisposition(run, row, { ...chapter('1'), batchResultId: `${run.id}/1` }, rules), 'imported');
});
test('validate bucket and backups; do not trust injected results or arbitrary job URLs', async () => {
  assert.equal(normalizeBucket(' gs://my-bucket/ '), 'my-bucket');
  assert.throws(() => normalizeBucket('https://example.com/key'));
  assert.throws(() => normalizeBucket('gs://bucket/folder'));
  const run = await fixture();
  assert.equal((await validateBackup({ ...run, results: [{ chapterId: '1', text: 'Injected' }] })).results, undefined);
  await assert.rejects(validateBackup({ ...run, job: { name: 'https://example.com' } }));
  const tampered = structuredClone(run); tampered.rows[0].request.contents[0].parts[0].text = 'tampered';
  await assert.rejects(validateBackup(tampered));
});
test('API upload/create/get/cancel use Google endpoints, OAuth bearer and exact JSONL', async () => {
  const run = await fixture();
  const calls: { url: string; init: RequestInit }[] = [];
  const job = { name: 'projects/test-project/locations/global/batchPredictionJobs/123', state: 'JOB_STATE_PENDING' };
  const client = new VertexBatchClient(async () => ({ projectId: 'test-project', token: 'test-token' }),
    async (url, init) => { calls.push({ url: String(url), init: init! }); return Response.json(job); });
  await client.upload(run); await client.create(run); await client.get(job.name); await client.cancel(job.name);
  assert.match(calls[0].url, /upload\/storage\/v1\/b\/test-bucket\/o\?/);
  assert.equal(calls[0].init.body, toJSONL(run));
  assert.deepEqual(JSON.parse(calls[1].init.body as string), createJobBody(run));
  assert.ok(calls[3].url.endsWith('/123:cancel'));
  assert.ok(calls.every(c => (c.init.headers as any).Authorization === 'Bearer test-token'));
  await assert.rejects(client.get('https://evil.example'), /không hợp lệ/);
  assert.equal(calls.length, 4);
});
test('ambiguous create is not automatically retried; HTTP refusal preserves status', async () => {
  const run = await fixture();
  let attempts = 0;
  const client = new VertexBatchClient(async () => ({ projectId: 'test-project', token: 'token' }),
    async () => { attempts++; throw new TypeError('Failed to fetch'); });
  await assert.rejects(client.create(run));
  assert.equal(attempts, 1);
  const refused = new VertexBatchClient(async () => ({ projectId: 'test-project', token: 'token' }),
    async () => Response.json({ error: { message: 'Permission denied' } }, { status: 403 }));
  await assert.rejects(refused.create(run), (e: GoogleBatchError) => e.status === 403 && e.message === 'Permission denied');
});
test('output retrieval paginates and downloads all JSONL shards, excluding unrelated files', async () => {
  const run = await fixture();
  const calls: string[] = [];
  const prefix = `beta-batch/${run.id}/output/`;
  const client = new VertexBatchClient(async () => ({ projectId: 'test-project', token: 'token' }),
    async url => {
      const value = String(url); calls.push(value);
      if (value.includes('alt=media')) return new Response(value.includes('a.jsonl') ? 'first' : 'second');
      if (value.includes('pageToken=next')) return Response.json({ items: [{ name: `${prefix}b.jsonl` }] });
      return Response.json({ items: [{ name: `${prefix}a.jsonl` }, { name: `${prefix}metadata.json` }], nextPageToken: 'next' });
    });
  assert.deepEqual(await client.downloadOutputs(run), ['first', 'second']);
  assert.equal(calls.length, 4);
  assert.ok(calls[2].includes('%2F'));
});
test('recovery filters the unique display name; terminal partial jobs allow retrieving successes', async () => {
  const run = await fixture();
  const client = new VertexBatchClient(async () => ({ projectId: 'test-project', token: 'token' }),
    async url => {
      assert.equal(new URL(String(url)).searchParams.get('filter'), `displayName="${run.id}"`);
      return Response.json({ batchPredictionJobs: [{ name: 'projects/test/locations/global/batchPredictionJobs/1', state: 'JOB_STATE_PENDING' }] });
    });
  assert.equal((await client.recover(run)).length, 1);
  for (const state of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'PARTIALLY_SUCCEEDED']) assert.equal(terminalState(`JOB_STATE_${state}`), true);
  assert.equal(terminalState('JOB_STATE_CANCELLING'), false);
});
