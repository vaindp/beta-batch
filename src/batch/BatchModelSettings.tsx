import React, { useSyncExternalStore } from 'react';
import { BATCH_MODEL, BATCH_MODELS } from './batch-core';

const changeEvent = 'beta-batch-model-changed';
function subscribe(notify: () => void) {
  window.addEventListener(changeEvent, notify);
  window.addEventListener('storage', notify);
  return () => {
    window.removeEventListener(changeEvent, notify);
    window.removeEventListener('storage', notify);
  };
}
function save(key: string, value: string) {
  localStorage.setItem(key, value);
  window.dispatchEvent(new Event(changeEvent));
}
const readChoice = () => localStorage.getItem('beta-batch-model') || BATCH_MODEL;
const readCustom = () => localStorage.getItem('beta-batch-custom-model') || '';

// Both mounted Batch views and other tabs read the same persisted selection.
export function useBatchModel() {
  const savedChoice = useSyncExternalStore(subscribe, readChoice, () => BATCH_MODEL);
  const customModel = useSyncExternalStore(subscribe, readCustom, () => '');
  const choice = savedChoice === 'custom' || BATCH_MODELS.some(item => item.id === savedChoice)
    ? savedChoice : BATCH_MODEL;
  return {
    choice,
    customModel,
    model: choice === 'custom' ? customModel.trim() : choice,
    setChoice: (value: string) => save('beta-batch-model', value),
    setCustomModel: (value: string) => save('beta-batch-custom-model', value),
  };
}

export function BatchModelSettings({ selection, disabled }: {
  selection: ReturnType<typeof useBatchModel>;
  disabled: boolean;
}) {
  return <>
    <label className="batch-field">Model cho job mới
      <select className="styled-input styled-select" value={selection.choice}
        onChange={event => selection.setChoice(event.target.value)} disabled={disabled}>
        {BATCH_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        <option value="custom">Model ID tùy chỉnh…</option>
      </select>
    </label>
    {selection.choice === 'custom' && <label className="batch-field">Model ID Gemini
      <input className="styled-input" value={selection.customModel} placeholder="gemini-…" spellCheck={false}
        onChange={event => selection.setCustomModel(event.target.value)} disabled={disabled} />
    </label>}
    <p className="batch-muted">Model cần hỗ trợ Vertex AI Batch tại global và được cấp quyền trong project. Chỉ áp dụng cho job mới.</p>
    {selection.model !== BATCH_MODEL && <p className="batch-muted">Dùng mức thinking và giới hạn đầu ra mặc định của model.</p>}
  </>;
}
