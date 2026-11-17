import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { BatchPanel } from '../src/batch/BatchPanel';
import { BatchSidebarTab } from '../src/batch/BatchSidebarTab';
import { useBatchController, type BatchController } from '../src/batch/useBatchController';
import { restoreBatchModel } from '../src/batch/BatchModelSettings';
import { BATCH_MODELS, prepareRun, type BatchRun } from '../src/batch/batch-core';
import { VertexBatchClient } from '../src/batch/vertex-batch';

const chapters = ['1', '2'].map(id => ({ id, title: `Chương ${id}`, originalContent: 'Bản gốc', editedContent: '', status: 'ready' }));
const rules = { pronounRules: '', addressingRules: '' };
const jobName = 'projects/test-project/locations/global/batchPredictionJobs/123';

async function setup(t: any, savedRuns: BatchRun[] = [], fetcher?: typeof fetch, deletionFailure = false) {
  const keys = ['window', 'document', 'localStorage', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', 'clearInterval'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const storage = new Map<string, string>();
  const timers = new Map<any, { delay: number; callback: () => void }>();
  const nativeClear = globalThis.clearInterval;
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  define('window', { setInterval: (callback: () => void, delay: number) => {
    const handle = setInterval(() => {}, 1_000_000); handle.unref();
    timers.set(handle, { delay, callback }); return handle;
  } });
  define('clearInterval', (handle: any) => { timers.delete(handle); nativeClear(handle); });
  define('document', { activeElement: null, addEventListener() {}, removeEventListener() {} });
  define('navigator', { locks: { request: async (_name: string, _options: unknown, callback: any) => callback({}) } });
  let stored = structuredClone(savedRuns);
  let latest!: BatchController;
  let root: any;
  const requests: string[] = [];
  const client = new VertexBatchClient(async () => ({ projectId: 'test-project', token: 'test-token' }), async (url, init) => {
    requests.push(String(url));
    if (fetcher) return fetcher(url, init);
    return Response.json({ name: jobName, state: 'JOB_STATE_PENDING' });
  });
  const services = {
    loadRuns: async () => structuredClone(stored),
    saveRun: async (run: BatchRun) => { stored = [structuredClone(run), ...stored.filter(item => item.id !== run.id)]; },
    deleteRunHistory: async (ids: string[]) => {
      if (deletionFailure) throw new Error('Test storage failure');
      stored = stored.filter(run => !ids.includes(run.id));
    },
    createClient: () => client,
  };
  const common = { chapters, rules, title: 'Truyện thử', credentials: 'fake-credentials', promptFor: (text: string) => text };
  function Harness({ open = true, sidebar = true }: { open?: boolean; sidebar?: boolean }) {
    latest = useBatchController(common, services);
    const props = { ...common, controller: latest, onImport() {}, onSettings() {} };
    return <>
      <BatchPanel {...props} open={open} onClose={() => {}} />
      {sidebar && <BatchSidebarTab {...props} onOpenModal={() => {}} />}
    </>;
  }
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    for (const handle of timers.keys()) nativeClear(handle);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  });
  await act(async () => { root = create(<Harness />); });
  const views = () => [root.root.findByType(BatchPanel), root.root.findByType(BatchSidebarTab)];
  const modelPickers = () => views().map(view => view.findAllByType('select').find((select: any) =>
    select.findAllByType('option').some((option: any) => option.props.value === 'gemini-3.8-flash'))!);
  return {
    root, views, modelPickers, requests, timers, storage,
    controller: () => latest,
    stored: () => stored,
    rerender: async (open: boolean, sidebar: boolean) => { await act(async () => root.update(<Harness open={open} sidebar={sidebar} />)); },
  };
}

test('both real Batch views share model catalog, configuration, selection and remount state', async t => {
  const h = await setup(t);
  for (const picker of h.modelPickers()) {
    assert.deepEqual(picker.findAllByType('option').map((option: any) => option.props.value), BATCH_MODELS.map(model => model.id));
  }
  await act(async () => h.modelPickers()[1].props.onChange({ target: { value: 'gemini-3.8-flash' } }));
  assert.ok(h.modelPickers().every(picker => picker.props.value === 'gemini-3.8-flash'));
  assert.equal(h.storage.get('beta-batch-model'), 'gemini-3.8-flash');
  assert.equal(h.root.root.findAllByType('input').filter((input: any) => input.props.placeholder === 'gemini-…').length, 0);
  await act(async () => {
    const bucket = h.views()[1].findAllByType('input').find((input: any) => input.props.id === 'sidebar-bucket')!;
    bucket.props.onChange({ target: { value: 'shared-bucket' } });
    h.modelPickers()[0].props.onChange({ target: { value: 'gemini-4-argon' } });
  });
  assert.ok(h.views().every(view => view.findAllByType('input').some((input: any) => input.props.value === 'shared-bucket')));
  const thinking = h.views()[0].findAllByType('select').find((select: any) => select.props.value === 'MEDIUM')!;
  await act(async () => thinking.props.onChange({ target: { value: 'HIGH' } }));
  assert.ok(h.views().every(view => view.findAllByType('select').some((select: any) => select.props.value === 'HIGH')));
  await act(async () => h.views()[1].findAllByType('input').find((input: any) => input.props.type === 'checkbox')!.props.onChange({ target: { checked: false } }));
  assert.deepEqual(h.controller().selected, ['2']);
  assert.ok(h.views().every(view => view.findAllByType('input').filter((input: any) => input.props.type === 'checkbox').map((input: any) => input.props.checked).join(',') === 'false,true'));
  await h.rerender(false, false);
  await h.rerender(true, true);
  assert.equal(h.controller().bucket, 'shared-bucket');
  assert.equal(h.controller().thinking, 'HIGH');
  assert.deepEqual(h.controller().selected, ['2']);
});

test('submit through sidebar locks both views and updates shared history and timer once', async t => {
  let unblock!: () => void;
  const uploading = new Promise<void>(resolve => { unblock = resolve; });
  let creates = 0;
  const h = await setup(t, [], async (url, init) => {
    if (String(url).includes('upload/storage')) { await uploading; return Response.json({}); }
    if (init?.method === 'POST') creates++;
    return Response.json({ name: jobName, state: 'JOB_STATE_PENDING' });
  });
  await act(async () => { h.controller().setBucket('test-bucket'); h.controller().modelSelection.setChoice('gemini-3.8-flash'); });
  const submitButtons = () => h.views().map(view => view.findAllByType('button').find((button: any) =>
    button.props.className === 'btn btn-primary batch-submit' ||
    button.findAll(node => typeof node === 'object' && node.type === 'span' && String(node.children.join('')).startsWith('Gửi Batch')).length > 0)!);
  await act(async () => { submitButtons()[1].props.onClick(); });
  assert.equal(h.controller().anyBusy, true);
  assert.ok(submitButtons().every(button => button.props.disabled));
  let duplicate = false;
  await act(async () => { await h.controller().perform('duplicate', async () => { duplicate = true; }); });
  assert.equal(duplicate, false);
  await act(async () => { unblock(); await uploading; await new Promise(resolve => setImmediate(resolve)); });
  assert.equal(creates, 1);
  assert.equal(h.controller().active?.model, 'gemini-3.8-flash');
  assert.equal(h.controller().active?.phase, 'submitted');
  assert.ok(h.controller().active?.startedAt);
  assert.equal(h.controller().runs.length, 1);
  assert.equal(h.controller().selected.length, 0);
  assert.equal(h.controller().lockedIds.size, 2);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 20_000).length, 1);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 1_000).length, 1);
  for (const view of h.views()) {
    assert.ok(view.findAllByType('select').some((select: any) => select.props.value === h.controller().activeId));
    assert.ok(view.findAllByType('div').some((div: any) => div.props.className === 'batch-timer-value'));
  }
});

test('history selection, results, terminal timestamps and errors propagate to both views', async t => {
  const first = await prepareRun({ chapters, rules, title: 'A', projectId: 'test-project', bucket: 'test-bucket', thinking: 'LOW', promptFor: text => text });
  const second = { ...structuredClone(first), id: 'beta-00000000-0000-0000-0000-000000000001', title: 'B' };
  first.phase = 'submitted'; first.startedAt = '2026-11-18T00:00:00.000Z';
  first.job = { name: jobName, state: 'JOB_STATE_RUNNING' };
  const h = await setup(t, [first, second], async () => Response.json({ name: jobName, state: 'JOB_STATE_SUCCEEDED' }));
  await act(async () => {
    const history = h.views()[1].findAllByType('select').find((select: any) => select.props.value === first.id)!;
    history.props.onChange({ target: { value: second.id } });
  });
  assert.ok(h.views().every(view => view.findAllByType('select').some((select: any) => select.props.value === second.id)));
  await act(async () => h.controller().setActiveId(first.id));
  await act(async () => { await h.controller().perform('refresh', () => h.controller().refresh(h.controller().active!)); });
  assert.equal(h.controller().active?.job?.state, 'JOB_STATE_SUCCEEDED');
  const completedAt = h.controller().active?.completedAt;
  assert.ok(completedAt);
  const jsonl = first.rows.map(row => JSON.stringify({ request: row.request, response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Bản đã sửa' }] } }] } })).join('\n');
  await act(async () => { await h.controller().perform('outputs', () => h.controller().readOutputs(h.controller().active!, [jsonl])); });
  assert.equal(h.controller().ready.length, 2);
  assert.equal(h.controller().active?.completedAt, completedAt);
  assert.equal(h.stored().find(run => run.id === first.id)?.results?.length, 2);
  assert.equal(h.controller().lockedIds.size, 0);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 20_000).length, 0);
  const textOf = (node: any): string => typeof node === 'string' ? node : (node.children || []).map(textOf).join('');
  assert.ok(h.views().every(view => view.findAllByType('button').some((button: any) => textOf(button).includes('chương hợp lệ'))));
  await act(async () => { await h.controller().perform('failure', async () => { throw new Error('Test shared failure'); }); });
  assert.equal(h.controller().error, 'Test shared failure');
  assert.ok(h.views().every(view => view.findAll(node => node.children.includes('Test shared failure')).length > 0));
});

test('old custom selections migrate only to known models', () => {
  assert.equal(restoreBatchModel('custom', 'gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(restoreBatchModel('custom', 'gemini-misspelled'), 'gemini-4-argon');
  assert.equal(restoreBatchModel('gemini-2.5-flash', null), 'gemini-2.5-flash');
});

async function historyFixture() {
  const run = await prepareRun({ chapters, rules, title: 'Job đã kết thúc', projectId: 'test-project', bucket: 'test-bucket', thinking: 'LOW', promptFor: text => text });
  run.phase = 'submitted';
  run.job = { name: jobName, state: 'JOB_STATE_FAILED' };
  return run;
}
const textOf = (node: any): string => typeof node === 'string' ? node : (node.children || []).map(textOf).join('');
const buttonNamed = (view: any, text: string) => view.findAllByType('button').find((button: any) => textOf(button).trim() === text)!;

test('delete history requires confirmation, cancels cleanly, then synchronizes both views and storage', async t => {
  const done = await historyFixture();
  const h = await setup(t, [done]);
  await act(async () => buttonNamed(h.views()[1], 'Xóa lịch sử job đang chọn').props.onClick());
  assert.equal(h.controller().runs.length, 1);
  assert.equal(h.stored().length, 1);
  assert.ok(h.views().every(view => buttonNamed(view, 'Xác nhận xóa lịch sử')));
  await act(async () => buttonNamed(h.views()[0], 'Giữ lại').props.onClick());
  assert.equal(h.controller().pendingDeletion.length, 0);
  assert.equal(h.stored().length, 1);
  await act(async () => buttonNamed(h.views()[0], 'Xóa lịch sử job đang chọn').props.onClick());
  await act(async () => buttonNamed(h.views()[1], 'Xác nhận xóa lịch sử').props.onClick());
  assert.equal(h.stored().length, 0);
  assert.equal(h.controller().runs.length, 0);
  assert.equal(h.controller().activeId, '');
  assert.equal(h.controller().active, undefined);
  assert.ok(h.views().every(view => buttonNamed(view, 'Xóa lịch sử job đang chọn').props.disabled));
  assert.equal(h.requests.length, 0, 'history deletion must not call Google APIs');
  await h.rerender(false, false); await h.rerender(true, true);
  assert.equal(h.controller().runs.length, 0);
});

test('bulk cleanup keeps running and ambiguous jobs, and selects a remaining job', async t => {
  const done = await historyFixture();
  const running = { ...await historyFixture(), job: { name: jobName, state: 'JOB_STATE_RUNNING' } };
  const unknown = { ...await historyFixture(), phase: 'unknown' as const, job: undefined };
  const h = await setup(t, [done, running, unknown]);
  await act(async () => h.controller().requestHistoryDeletion([running.id]));
  assert.equal(h.controller().pendingDeletion.length, 0);
  await act(async () => h.controller().requestHistoryDeletion([unknown.id]));
  assert.equal(h.controller().pendingDeletion.length, 0);
  await act(async () => buttonNamed(h.views()[1], 'Xóa các job đã kết thúc (1)').props.onClick());
  await act(async () => h.controller().confirmHistoryDeletion());
  assert.deepEqual(h.stored().map(run => run.id), [running.id, unknown.id]);
  assert.equal(h.controller().activeId, running.id);
  assert.ok(h.views().every(view => buttonNamed(view, 'Xóa lịch sử job đang chọn').props.disabled));
  assert.equal(h.controller().lockedIds.size, chapters.length);
});

test('failed history deletion preserves the job, confirmation and both views', async t => {
  const done = await historyFixture();
  const h = await setup(t, [done], undefined, true);
  await act(async () => h.controller().requestHistoryDeletion([done.id]));
  await act(async () => h.controller().confirmHistoryDeletion());
  assert.equal(h.stored().length, 1);
  assert.equal(h.controller().activeId, done.id);
  assert.deepEqual(h.controller().pendingDeletion, [done.id]);
  assert.equal(h.controller().error, 'Test storage failure');
  assert.ok(h.views().every(view => buttonNamed(view, 'Xác nhận xóa lịch sử')));
});
