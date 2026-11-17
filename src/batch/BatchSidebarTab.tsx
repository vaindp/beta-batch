import React from 'react';
import {
  Layers,
  RefreshCw,
  Download,
  CheckCircle2,
  AlertCircle,
  Clock,
  Maximize2,
  Play,
  FileDown,
  Trash2,
  StopCircle,
} from 'lucide-react';
import {
  BATCH_MODEL,
  batchRunModel,
  toJSONL,
  type BatchChapter,
  type BatchRules,
  type BatchRun,
  type ThinkingLevel,
} from './batch-core';
import type { BatchController } from './useBatchController';
import { BatchModelSettings } from './BatchModelSettings';
import { BatchHistoryActions } from './BatchHistoryActions';

interface Props {
  controller: BatchController;
  chapters: BatchChapter[];
  rules: BatchRules;
  title: string;
  credentials: string;
  promptFor: (text: string) => string;
  onImport: (run: BatchRun) => void;
  onOpenModal: () => void;
  onSettings: () => void;
}

const stateNames: Record<string, { label: string; color: string }> = {
  JOB_STATE_PENDING: { label: 'Đang chờ Google', color: 'var(--warning-color)' },
  JOB_STATE_QUEUED: { label: 'Trong hàng đợi', color: 'var(--warning-color)' },
  JOB_STATE_RUNNING: { label: 'Đang xử lý', color: 'var(--primary-color)' },
  JOB_STATE_SUCCEEDED: { label: 'Đã hoàn tất', color: 'var(--success-color)' },
  JOB_STATE_PARTIALLY_SUCCEEDED: { label: 'Hoàn tất một phần', color: 'var(--warning-color)' },
  JOB_STATE_FAILED: { label: 'Thất bại', color: 'var(--error-color)' },
  JOB_STATE_CANCELLED: { label: 'Đã hủy', color: 'var(--text-color-muted)' },
  JOB_STATE_CANCELLING: { label: 'Đang hủy', color: 'var(--text-color-muted)' },
  JOB_STATE_EXPIRED: { label: 'Hết hạn', color: 'var(--error-color)' },
};

function formatClockTime(isoString?: string): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function downloadFile(name: string, contents: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function BatchSidebarTab(props: Props) {
  const {
    modelSelection, runs, activeId, setActiveId, active, bucket, setBucket,
    thinking, setThinking, selected, setSelected, busy, error, message, setMessage,
    elapsedTimeStr, lockedIds, available, selectedChapters, anyBusy,
    ready: readyToImport, isTerminal, isRunning, perform, client, refresh, submit, readOutputs,
  } = props.controller;

  return (
    <div className="batch-sidebar-tab">
      {/* Header bar */}
      <div className="batch-sidebar-header">
        <div className="batch-sidebar-title-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Layers size={16} color="var(--primary-color)" />
            <span style={{ fontWeight: 700, fontSize: '0.8438rem' }}>Batch API</span>
          </div>
          <button
            className="btn-action-ghost"
            onClick={props.onOpenModal}
            title="Mở bảng điều khiển Batch toàn màn hình"
            style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
          >
            <Maximize2 size={13} />
            <span>Phóng to</span>
          </button>
        </div>
        <p style={{ fontSize: '11px', color: 'var(--text-color-muted)', margin: '4px 0 0 0', lineHeight: 1.4 }}>
          Xử lý hàng loạt chương qua Google Cloud Storage với mức giá rẻ hơn 50%.
        </p>
      </div>

      {!props.credentials && (
        <div className="batch-warning" style={{ margin: '8px 0', fontSize: '12px' }}>
          <span>Cần file Service Account JSON cho Vertex Batch.</span>
          <button
            className="btn btn-secondary btn-small"
            style={{ marginTop: '6px', width: '100%', justifyContent: 'center' }}
            onClick={props.onSettings}
          >
            Mở Cài đặt để nạp JSON
          </button>
        </div>
      )}

      {/* SECTION 1: Cấu hình & Gửi */}
      <div className="batch-sidebar-section">
        <span className="batch-section-title">1. Chuẩn bị gửi Job</span>

        <div className="input-group">
          <label htmlFor="sidebar-bucket">Tên Bucket Cloud Storage</label>
          <input
            id="sidebar-bucket"
            className="styled-input"
            value={bucket}
            placeholder="ten-bucket (không kèm gs://)"
            onChange={e => setBucket(e.target.value)}
            disabled={anyBusy}
          />
        </div>

        <BatchModelSettings selection={modelSelection} disabled={anyBusy} />
        {modelSelection.model === BATCH_MODEL && <div className="input-group">
          <label htmlFor="sidebar-thinking">Mức Thinking</label>
          <select
            id="sidebar-thinking"
            className="styled-input styled-select"
            value={thinking}
            onChange={e => setThinking(e.target.value as ThinkingLevel)}
            disabled={anyBusy}
          >
            <option value="LOW">Low (Nhanh)</option>
            <option value="MEDIUM">Medium (Cân bằng, khuyến nghị)</option>
            <option value="HIGH">High (Sâu)</option>
          </select>
        </div>}

        <div style={{ marginTop: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600 }}>
              Chọn chương ({selectedChapters.length}/{available.length})
            </span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                type="button"
                className="btn-action-ghost"
                style={{ fontSize: '11px' }}
                disabled={anyBusy}
                onClick={() => setSelected(available.filter(c => c.status !== 'done').map(c => c.id))}
              >
                Chưa xong
              </button>
              <button
                type="button"
                className="btn-action-ghost"
                style={{ fontSize: '11px' }}
                disabled={anyBusy}
                onClick={() => setSelected(available.map(c => c.id))}
              >
                Tất cả
              </button>
              <button
                type="button"
                className="btn-action-ghost text-muted"
                style={{ fontSize: '11px' }}
                disabled={anyBusy}
                onClick={() => setSelected([])}
              >
                Bỏ
              </button>
            </div>
          </div>

          <div className="batch-sidebar-chapters-list">
            {!props.chapters.length ? (
              <div style={{ padding: '12px', fontSize: '11px', color: 'var(--text-color-muted)', textAlign: 'center' }}>
                Chưa có chương nào được tải vào dự án.
              </div>
            ) : (
              props.chapters.map(chapter => {
                const isLocked = lockedIds.has(chapter.id);
                const isChecked = selected.includes(chapter.id) && !isLocked;
                return (
                  <label
                    key={chapter.id}
                    className={`batch-sidebar-chapter-item ${isLocked ? 'locked' : ''}`}
                    title={isLocked ? 'Đang trong job chưa hoàn tất' : chapter.title}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={anyBusy || isLocked || chapter.status === 'editing'}
                      onChange={e =>
                        setSelected(prev => (e.target.checked ? [...prev, chapter.id] : prev.filter(id => id !== chapter.id)))
                      }
                    />
                    <span className="chapter-item-name">{chapter.title}</span>
                    <span className={`chapter-item-badge status-${chapter.status}`}>
                      {isLocked ? 'Đang khóa' : chapter.status === 'done' ? 'Đã xong' : 'Chưa'}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>

        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }}
          disabled={anyBusy || !props.credentials || !bucket.trim() || !modelSelection.model || !selectedChapters.length}
          onClick={() => void perform('Đang lưu và gửi job lên Google…', submit)}
        >
          <Play size={14} />
          <span>Gửi Batch ({selectedChapters.length} chương)</span>
        </button>
      </div>

      {/* SECTION 2: Theo dõi & Bộ đếm thời gian */}
      <div className="batch-sidebar-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="batch-section-title">2. Lịch sử & Tiến trình</span>
          {active?.job && (
            <button
              className="btn-action-ghost"
              style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '3px' }}
              disabled={anyBusy || !props.credentials}
              onClick={() => void perform('Đang cập nhật…', () => refresh(active))}
              title="Cập nhật trạng thái mới nhất từ Google"
            >
              <RefreshCw size={11} className={busy ? 'icon-spin' : ''} />
              <span>Cập nhật</span>
            </button>
          )}
        </div>

        <div className="input-group">
          <select
            className="styled-input styled-select"
            value={activeId}
            onChange={e => setActiveId(e.target.value)}
            disabled={anyBusy}
          >
            {!runs.length && <option value="">(Chưa có job nào)</option>}
            {runs.map(run => (
              <option key={run.id} value={run.id}>
                {new Date(run.createdAt).toLocaleString('vi-VN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {run.rows.length} chương · {batchRunModel(run)} {run.job ? `· ${run.job.state.replace('JOB_STATE_', '')}` : ''}
              </option>
            ))}
          </select>
        </div>

        <BatchHistoryActions controller={props.controller} />
        {active && (
          <div className="batch-active-card">
            <p className="batch-muted">Model của job: <strong>{batchRunModel(active)}</strong></p>
            {/* Status & Name */}
            <div className="batch-status-row">
              <span
                className="batch-state-pill"
                style={{
                  backgroundColor: active.job && stateNames[active.job.state]
                    ? `color-mix(in srgb, ${stateNames[active.job.state].color} 15%, transparent)`
                    : 'var(--chip-bg)',
                  color: active.job && stateNames[active.job.state]
                    ? stateNames[active.job.state].color
                    : 'var(--text-color)',
                  borderColor: active.job && stateNames[active.job.state]
                    ? stateNames[active.job.state].color
                    : 'var(--border-color)',
                }}
              >
                {active.job
                  ? stateNames[active.job.state]?.label || active.job.state
                  : ['unknown', 'submitting'].includes(active.phase)
                  ? 'Đang gửi...'
                  : 'Chưa gửi'}
              </span>
              <span className="batch-job-count">{active.rows.length} chương</span>
            </div>

            {/* BỘ ĐẾM THỜI GIAN THEO NHẬT KÝ (Execution Timer) */}
            <div className="batch-timer-box">
              <div className="batch-timer-header">
                <Clock size={13} color="var(--primary-color)" />
                <span className="batch-timer-title">
                  {isTerminal
                    ? 'Thời gian thực thi hoàn tất'
                    : isRunning
                    ? 'Thời gian đang chạy (theo nhật ký)'
                    : 'Thời gian thực thi'}
                </span>
              </div>
              <div className="batch-timer-value">
                {elapsedTimeStr || '0 giây'}
                {isRunning && <span className="batch-timer-pulsing-dot" />}
              </div>
              <div className="batch-timer-timestamps">
                <div>
                  Bắt đầu: <strong>{formatClockTime(active.startedAt || active.createdAt) || '—'}</strong>
                </div>
                {active.completedAt && (
                  <div>
                    Hoàn tất: <strong>{formatClockTime(active.completedAt)}</strong>
                  </div>
                )}
              </div>
            </div>

            {/* Google completion stats if any */}
            {active.job?.completionStats && (
              <div style={{ fontSize: '11px', color: 'var(--text-color-muted)', marginTop: '6px' }}>
                Google báo:{' '}
                <span style={{ color: 'var(--success-color)' }}>
                  {active.job.completionStats.successfulCount || 0} thành công
                </span>
                {Number(active.job.completionStats.failedCount || 0) > 0 && (
                  <span style={{ color: 'var(--error-color)', marginLeft: '6px' }}>
                    · {active.job.completionStats.failedCount} lỗi
                  </span>
                )}
              </div>
            )}

            {/* Error message */}
            {active.job?.error?.message && (
              <div className="batch-error-inline" style={{ marginTop: '6px', fontSize: '11px' }}>
                {active.job.error.message}
              </div>
            )}

            {/* Action buttons */}
            <div className="batch-sidebar-actions" style={{ marginTop: '10px' }}>
              {active.job && isTerminal && (
                <button
                  className="btn btn-primary btn-small"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={anyBusy || !props.credentials}
                  onClick={() => void perform('Đang tải kết quả từ bucket…', () => readOutputs(active))}
                >
                  <FileDown size={14} />
                  <span>Lấy kết quả từ Google Cloud</span>
                </button>
              )}

              {active.job && isRunning && (
                <button
                  className="btn btn-secondary btn-small text-danger"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={anyBusy || !props.credentials}
                  onClick={() =>
                    void perform('Đang yêu cầu hủy job…', async () => {
                      await client().cancel(active.job!.name);
                      await refresh(active);
                      setMessage('Đã gửi lệnh hủy.');
                    })
                  }
                >
                  <StopCircle size={14} />
                  <span>Hủy Job</span>
                </button>
              )}

              {readyToImport.length > 0 && (
                <button
                  className="btn btn-primary btn-small"
                  style={{ width: '100%', justifyContent: 'center', backgroundColor: 'var(--success-color)' }}
                  disabled={anyBusy}
                  onClick={() => {
                    props.onImport(active);
                    setMessage(`Đã nhập thành công ${readyToImport.length} chương vào truyện!`);
                  }}
                >
                  <CheckCircle2 size={14} />
                  <span>Nhập {readyToImport.length} chương hợp lệ</span>
                </button>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', width: '100%', marginTop: '6px' }}>
                <button
                  className="btn btn-secondary btn-small"
                  style={{ justifyContent: 'center', fontSize: '11px' }}
                  onClick={() => downloadFile(`${active.id}.jsonl`, toJSONL(active), 'application/jsonl')}
                  title="Tải tệp JSONL chứa danh sách prompt gửi lên Google"
                >
                  <Download size={12} />
                  <span>Tải JSONL</span>
                </button>

                <button
                  className="btn btn-secondary btn-small"
                  style={{ justifyContent: 'center', fontSize: '11px' }}
                  onClick={() => downloadFile(`${active.id}.batch-backup.json`, JSON.stringify(active, null, 2))}
                  title="Sao lưu toàn bộ thông số job"
                >
                  <Download size={12} />
                  <span>Sao lưu Job</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {busy && (
        <div className="batch-status-note" style={{ color: 'var(--primary-color)' }}>
          <div className="loader-small-status" />
          <span>{busy}</span>
        </div>
      )}

      {message && (
        <div className="batch-status-note" style={{ color: 'var(--success-color)' }}>
          <CheckCircle2 size={14} />
          <span>{message}</span>
        </div>
      )}

      {error && (
        <div className="batch-status-note" style={{ color: 'var(--error-color)' }}>
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
