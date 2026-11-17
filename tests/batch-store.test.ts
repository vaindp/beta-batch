import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { saveRun, loadRuns, deleteRunHistory } from '../src/batch/batch-store';
import { prepareRun, canDeleteRunHistory } from '../src/batch/batch-core';

async function fixture() {
  return prepareRun({ chapters: [{ id: '1', title: 'Chương 1', originalContent: 'Bản gốc', editedContent: '', status: 'ready' }],
    rules: { pronounRules: '', addressingRules: '' }, title: 'Test', projectId: 'test-project', bucket: 'test-bucket', thinking: 'LOW', promptFor: text => text });
}
test('IndexedDB deletion persists, tolerates missing IDs and preserves unrelated jobs', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  const first = await fixture(), second = await fixture();
  await saveRun(first); await saveRun(second);
  await deleteRunHistory([first.id, first.id, 'already-deleted']);
  assert.deepEqual((await loadRuns()).map(run => run.id), [second.id]);
  await deleteRunHistory([second.id]);
  assert.deepEqual(await loadRuns(), []);
});
test('IndexedDB rechecks latest job status and rolls back the entire deletion on conflict', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  const first = await fixture(), second = await fixture();
  await saveRun(first); await saveRun(second);
  // Simulate another tab starting a job after the user opened the confirmation.
  await saveRun({ ...second, phase: 'submitting' });
  await assert.rejects(deleteRunHistory([first.id, second.id]), /đang chạy/);
  assert.equal((await loadRuns()).length, 2, 'the earlier deletion in the same transaction must roll back');
});
test('history deletion permits only terminal jobs and unsent preparations', async () => {
  const run = await fixture();
  assert.equal(canDeleteRunHistory(run), true);
  assert.equal(canDeleteRunHistory({ ...run, phase: 'submitting' }), false);
  assert.equal(canDeleteRunHistory({ ...run, phase: 'unknown' }), false);
  for (const state of ['PENDING', 'QUEUED', 'RUNNING', 'CANCELLING', 'PAUSED']) {
    assert.equal(canDeleteRunHistory({ ...run, phase: 'submitted', job: { name: 'job', state: `JOB_STATE_${state}` } }), false);
  }
  for (const state of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'PARTIALLY_SUCCEEDED']) {
    assert.equal(canDeleteRunHistory({ ...run, phase: 'submitted', job: { name: 'job', state: `JOB_STATE_${state}` } }), true);
  }
});
