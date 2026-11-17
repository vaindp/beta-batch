import React from 'react';
import { Trash2 } from 'lucide-react';
import type { BatchController } from './useBatchController';

export function BatchHistoryActions({ controller }: { controller: BatchController }) {
  const { active, anyBusy, canDeleteActiveHistory, deletableFinishedRuns, pendingDeletion,
    requestHistoryDeletion, confirmHistoryDeletion, cancelHistoryDeletion } = controller;
  return <div className="batch-history-actions">
    <div className="batch-actions">
      <button type="button" className="btn btn-secondary text-danger"
        disabled={anyBusy || !canDeleteActiveHistory}
        onClick={() => active && requestHistoryDeletion([active.id])}>
        <Trash2 size={14} /> Xóa lịch sử job đang chọn
      </button>
      <button type="button" className="btn btn-secondary text-danger"
        disabled={anyBusy || !deletableFinishedRuns.length}
        onClick={() => requestHistoryDeletion(deletableFinishedRuns.map(run => run.id))}>
        Xóa các job đã kết thúc ({deletableFinishedRuns.length})
      </button>
    </div>
    {active && !canDeleteActiveHistory && <p className="batch-muted">Cần cập nhật hoặc hủy job và chờ job kết thúc trước khi xóa lịch sử.</p>}
    {!!pendingDeletion.length && <div className="batch-warning" role="group" aria-label="Xác nhận xóa lịch sử job">
      <p>Xóa {pendingDeletion.length} bản ghi lịch sử đã chọn? Thao tác chỉ xóa dữ liệu job trên trình duyệt, không xóa bản biên tập hoặc dữ liệu Google Cloud. Hãy sao lưu job nếu muốn khôi phục sau này.</p>
      {pendingDeletion.length === 1 && <p className="batch-id">{controller.runs.find(run => run.id === pendingDeletion[0])?.title || 'Truyện'} · {pendingDeletion[0]}</p>}
      <div className="batch-actions">
        <button type="button" className="btn btn-secondary" disabled={anyBusy} onClick={cancelHistoryDeletion}>Giữ lại</button>
        <button type="button" className="btn btn-secondary text-danger" disabled={anyBusy}
          onClick={() => void confirmHistoryDeletion()}>Xác nhận xóa lịch sử</button>
      </div>
    </div>}
  </div>;
}
