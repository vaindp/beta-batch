import type { BatchRun } from './batch-core';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('beta-batch-jobs-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('jobs', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Không mở được bộ nhớ trình duyệt. Hãy cho phép lưu dữ liệu trang web.'));
  });
}

export async function saveRun(run: BatchRun): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('jobs', 'readwrite');
      tx.objectStore('jobs').put(run);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('Không lưu được job vào trình duyệt (có thể đã đầy bộ nhớ). Hãy tải bản sao job.'));
    });
  } finally { db.close(); }
}

export async function loadRuns(): Promise<BatchRun[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction('jobs').objectStore('jobs').getAll();
      req.onsuccess = () => resolve((req.result as BatchRun[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
