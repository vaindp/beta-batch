import React, { useEffect, useState } from 'react';
import { BATCH_MODEL, BATCH_MODELS } from './batch-core';
import { isSelectableModel } from '../ai/models';

export function restoreBatchModel(choice: string | null, custom: string | null): string {
  const model = (choice === 'custom' ? custom : choice)?.trim() || BATCH_MODEL;
  return isSelectableModel(model) ? model : BATCH_MODEL;
}

export function useBatchModel() {
  const [model, setModel] = useState(() => restoreBatchModel(
    localStorage.getItem('beta-batch-model'), localStorage.getItem('beta-batch-custom-model'),
  ));
  useEffect(() => { localStorage.setItem('beta-batch-model', model); }, [model]);
  return {
    model,
    setChoice: (value: string) => { if (isSelectableModel(value)) setModel(value); },
  };
}

export function BatchModelSettings({ selection, disabled }: {
  selection: ReturnType<typeof useBatchModel>;
  disabled: boolean;
}) {
  return <>
    <label className="batch-field">Model cho job mới
      <select className="styled-input styled-select" value={selection.model}
        onChange={event => selection.setChoice(event.target.value)} disabled={disabled}>
        {BATCH_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>
    <p className="batch-muted">Cùng danh sách model với biên tập thường. Chỉ áp dụng cho job mới.</p>
    {selection.model !== BATCH_MODEL && <p className="batch-muted">Dùng mức thinking và giới hạn đầu ra mặc định của model.</p>}
  </>;
}
