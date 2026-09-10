import { useState } from 'react';
import { downloadAuthenticated } from './downloadFile';

export default function ShiftRosterUploadModal({ token, onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [templateError, setTemplateError] = useState('');

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  async function handleDownloadTemplate() {
    setTemplateError('');
    try {
      await downloadAuthenticated('/api/shifts/roster/template', token, 'shift-roster-template.xlsx');
    } catch (err) {
      setTemplateError(err.message || 'Could not download the template.');
    }
  }

  async function handleUpload() {
    if (!file) return;

    setUploading(true);
    setError('');
    setResult(null);

    try {
      const res = await fetch('/api/shifts/roster/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }, // browser sets Content-Type from the File object itself
        body: file
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Upload failed');

      setResult(body);
      onUploaded?.();
    } catch (err) {
      setError(err.message || 'Could not upload the roster. Try again.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="roster-modal-backdrop" onClick={handleBackdropClick} role="presentation">
      <div className="roster-modal" role="dialog" aria-modal="true" aria-labelledby="roster-modal-title">
        <div className="roster-modal__header">
          <div id="roster-modal-title" className="roster-modal__title">Upload shift roster</div>
          <button className="roster-modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="roster-modal__body">
          <p className="roster-modal__hint">
            Upload the system roster template (.xlsx) with one row per worker per
            scheduled shift date. This becomes the source of truth for who was
            expected on which shift — enabling no-show detection and flagging
            when a worker's actual punches don't match what was rostered.
          </p>

          <button className="roster-modal__template-link" onClick={handleDownloadTemplate}>
            ⬇ Download the template
          </button>
          {templateError && <div className="roster-modal__error" role="alert">{templateError}</div>}

          <div className="roster-modal__upload-row">
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); setError(''); }}
            />
            <button
              className="roster-modal__upload-btn"
              onClick={handleUpload}
              disabled={!file || uploading}
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>

          {error && <div className="roster-modal__error" role="alert">{error}</div>}

          {result && (
            <div className="roster-modal__result">
              <div className="roster-modal__result-line">
                ✓ {result.imported} assignment{result.imported === 1 ? '' : 's'} imported
                {result.skipped > 0 && `, ${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped`}.
              </div>
              {result.dateRange && (
                <div className="roster-modal__result-line roster-modal__result-line--muted">
                  Summaries recomputed for {result.dateRange.from} to {result.dateRange.to}.
                </div>
              )}
              {result.errors?.length > 0 && (
                <ul className="roster-modal__errors">
                  {result.errors.map((e, i) => (
                    <li key={i}>{e.row ? `Row ${e.row}: ` : ''}{e.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <style>{`
        .roster-modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(15, 27, 44, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          z-index: 1000;
          font-family: 'IBM Plex Sans', system-ui, sans-serif;
        }
        .roster-modal {
          width: 100%;
          max-width: 480px;
          max-height: 85vh;
          overflow-y: auto;
          background: #16243A;
          border: 1px solid #24354F;
          color: #E8EDF2;
        }
        .roster-modal__header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 20px 24px;
          border-bottom: 1px solid #24354F;
        }
        .roster-modal__title {
          font-size: 17px;
          font-weight: 600;
        }
        .roster-modal__close {
          background: none;
          border: none;
          color: #8A99AC;
          font-size: 22px;
          line-height: 1;
          cursor: pointer;
          padding: 0;
        }
        .roster-modal__close:hover {
          color: #E8EDF2;
        }
        .roster-modal__body {
          padding: 20px 24px 24px;
        }
        .roster-modal__hint {
          font-size: 13px;
          color: #8A99AC;
          line-height: 1.5;
          margin: 0 0 16px;
        }
        .roster-modal__template-link {
          background: none;
          border: 1px solid #3E8E7E;
          color: #3E8E7E;
          font-size: 13px;
          padding: 8px 14px;
          cursor: pointer;
          font-family: inherit;
          margin-bottom: 20px;
        }
        .roster-modal__template-link:hover {
          background: rgba(62, 142, 126, 0.12);
        }
        .roster-modal__upload-row {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
          padding-top: 16px;
          border-top: 1px solid #1B2A40;
        }
        .roster-modal__upload-row input[type="file"] {
          flex: 1;
          min-width: 0;
          color: #E8EDF2;
          font-size: 12px;
        }
        .roster-modal__upload-btn {
          border: 1px solid #24354F;
          background: transparent;
          color: #E8EDF2;
          padding: 8px 14px;
          font-size: 13px;
          cursor: pointer;
          font-family: inherit;
        }
        .roster-modal__upload-btn:hover:not(:disabled) {
          background: #0F1B2C;
        }
        .roster-modal__upload-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .roster-modal__error {
          color: #C9535A;
          font-size: 13px;
          margin-top: 14px;
        }
        .roster-modal__result {
          margin-top: 16px;
          font-size: 13px;
        }
        .roster-modal__result-line {
          color: #3E8E7E;
          margin-bottom: 4px;
        }
        .roster-modal__result-line--muted {
          color: #8A99AC;
        }
        .roster-modal__errors {
          margin: 10px 0 0;
          padding-left: 18px;
          color: #C9A227;
          max-height: 160px;
          overflow-y: auto;
        }
        .roster-modal__errors li {
          margin-bottom: 4px;
        }
      `}</style>
    </div>
  );
}
