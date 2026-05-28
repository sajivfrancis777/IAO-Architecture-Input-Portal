/**
 * FileUpload.tsx — Upload manual data files directly to ADA-Artifacts repo.
 *
 * Commits files to data/smartsheet/manual/ in the ADA-Artifacts GitHub repo
 * via the GitHub Contents API. Once committed, the deploy-pages workflow
 * triggers automatically and fresh data propagates to the live site.
 *
 * Supported upload targets:
 *   - Object Tracker (XLSX/CSV) → data/smartsheet/manual/object_trackers/
 *   - Transport Objects (CSV)   → data/smartsheet/manual/object_trackers/
 *   - RAID Log (CSV/XLSX)       → data/smartsheet/manual/raid/
 *   - Request Console (XLSX)    → data/smartsheet/manual/request_console/
 */

import { useCallback, useRef, useState } from 'react';

/* ── Config ──────────────────────────────────────────────────── */

const REPO_OWNER = 'sajivfrancis777';
const REPO_NAME = 'ADA-Artifacts';
const BRANCH = 'main';

interface UploadTarget {
  id: string;
  label: string;
  description: string;
  repoPath: string; // directory in ADA-Artifacts
  accept: string;   // file input accept attribute
  maxSizeMB: number;
}

const UPLOAD_TARGETS: UploadTarget[] = [
  {
    id: 'object-tracker',
    label: 'Object Tracker',
    description: 'S4 R3 Object Tracker (XLSX or CSV)',
    repoPath: 'data/smartsheet/manual/object_trackers',
    accept: '.xlsx,.csv',
    maxSizeMB: 10,
  },
  {
    id: 'transport-objects',
    label: 'Transport Objects',
    description: 'Transport objects all systems (CSV)',
    repoPath: 'data/smartsheet/manual/object_trackers',
    accept: '.csv',
    maxSizeMB: 15,
  },
  {
    id: 'raid-log',
    label: 'RAID Log',
    description: 'Master RAID log (CSV or XLSX)',
    repoPath: 'data/smartsheet/manual/raid',
    accept: '.csv,.xlsx',
    maxSizeMB: 5,
  },
  {
    id: 'request-console',
    label: 'RICEFW Request Console',
    description: 'Intel IDM 2.0 RICEFW Request Console (XLSX)',
    repoPath: 'data/smartsheet/manual/request_console',
    accept: '.xlsx',
    maxSizeMB: 10,
  },
];

/* ── Types ───────────────────────────────────────────────────── */

type UploadStatus = 'idle' | 'reading' | 'uploading' | 'success' | 'error';

interface UploadState {
  status: UploadStatus;
  message: string;
  fileName: string;
}

/* ── GitHub API helper ───────────────────────────────────────── */

function getGitHubToken(): string {
  return localStorage.getItem('github_token')
    || (import.meta.env.VITE_GITHUB_TOKEN as string)
    || '';
}

async function getFileSha(token: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${BRANCH}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (res.ok) {
      const data = await res.json();
      return data.sha || null;
    }
    return null;
  } catch {
    return null;
  }
}

async function uploadFileToGitHub(
  token: string,
  filePath: string,
  content: string, // base64 encoded
  commitMessage: string,
): Promise<{ success: boolean; message: string; url?: string }> {
  // Check if file exists (need SHA for update)
  const existingSha = await getFileSha(token, filePath);

  const body: Record<string, string> = {
    message: commitMessage,
    content,
    branch: BRANCH,
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (res.ok) {
    const data = await res.json();
    return {
      success: true,
      message: existingSha ? 'File updated successfully' : 'File created successfully',
      url: data.content?.html_url,
    };
  }

  const err = await res.json().catch(() => ({}));
  return {
    success: false,
    message: `GitHub API error (${res.status}): ${err.message || res.statusText}`,
  };
}

/* ── Component ───────────────────────────────────────────────── */

export default function FileUpload() {
  const [selectedTarget, setSelectedTarget] = useState<UploadTarget>(UPLOAD_TARGETS[0]);
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle', message: '', fileName: '' });
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasToken = !!getGitHubToken();

  const handleFile = useCallback(async (file: File) => {
    const token = getGitHubToken();
    if (!token) {
      setUploadState({ status: 'error', message: 'No GitHub token configured. Set it in User Profile (bottom-right gear icon).', fileName: file.name });
      return;
    }

    // Validate file type
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    const allowedExts = selectedTarget.accept.split(',');
    if (!allowedExts.includes(ext)) {
      setUploadState({ status: 'error', message: `Invalid file type. Expected: ${selectedTarget.accept}`, fileName: file.name });
      return;
    }

    // Validate file size
    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > selectedTarget.maxSizeMB) {
      setUploadState({ status: 'error', message: `File too large (${sizeMB.toFixed(1)}MB). Max: ${selectedTarget.maxSizeMB}MB`, fileName: file.name });
      return;
    }

    // Read file as base64
    setUploadState({ status: 'reading', message: 'Reading file...', fileName: file.name });

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Strip the data URL prefix to get pure base64
          const b64 = result.split(',')[1];
          resolve(b64);
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });

      // Upload to GitHub
      setUploadState({ status: 'uploading', message: 'Uploading to ADA-Artifacts...', fileName: file.name });

      const filePath = `${selectedTarget.repoPath}/${file.name}`;
      const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const commitMessage = `data: upload ${file.name} via ADA Editor [${timestamp}]`;

      const result = await uploadFileToGitHub(token, filePath, base64, commitMessage);

      if (result.success) {
        setUploadState({
          status: 'success',
          message: `${result.message}. Pipeline will rebuild automatically.`,
          fileName: file.name,
        });
      } else {
        setUploadState({ status: 'error', message: result.message, fileName: file.name });
      }
    } catch (e) {
      setUploadState({ status: 'error', message: `Upload failed: ${(e as Error).message}`, fileName: file.name });
    }
  }, [selectedTarget]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setDragOver(false), []);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset input so same file can be re-selected
    e.target.value = '';
  }, [handleFile]);

  const statusColor: Record<UploadStatus, string> = {
    idle: '#888',
    reading: '#0071C5',
    uploading: '#0071C5',
    success: '#166534',
    error: '#b71c1c',
  };

  const statusIcon: Record<UploadStatus, string> = {
    idle: '📂',
    reading: '◌',
    uploading: '⬆️',
    success: '✓',
    error: '✗',
  };

  return (
    <div className="file-upload-container">
      {/* Token warning */}
      {!hasToken && (
        <div className="upload-warning">
          ⚠️ No GitHub token found. Configure it in User Profile (⚙️ gear icon) to enable uploads.
        </div>
      )}

      {/* Target selector */}
      <div className="upload-target-selector">
        <label className="upload-label">Upload Target:</label>
        <select
          value={selectedTarget.id}
          onChange={(e) => {
            const t = UPLOAD_TARGETS.find(t => t.id === e.target.value);
            if (t) setSelectedTarget(t);
            setUploadState({ status: 'idle', message: '', fileName: '' });
          }}
          className="upload-select"
        >
          {UPLOAD_TARGETS.map(t => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <div className="upload-target-desc">{selectedTarget.description}</div>
        <div className="upload-target-path">
          → <code>{selectedTarget.repoPath}/</code>
        </div>
      </div>

      {/* Drop zone */}
      <div
        className={`upload-dropzone ${dragOver ? 'drag-over' : ''} ${!hasToken ? 'disabled' : ''}`}
        onDrop={hasToken ? onDrop : undefined}
        onDragOver={hasToken ? onDragOver : undefined}
        onDragLeave={hasToken ? onDragLeave : undefined}
        onClick={() => hasToken && fileInputRef.current?.click()}
      >
        <div className="upload-dropzone-icon">
          {uploadState.status === 'idle' ? '📁' : statusIcon[uploadState.status]}
        </div>
        <div className="upload-dropzone-text">
          {uploadState.status === 'idle'
            ? 'Drop file here or click to browse'
            : uploadState.message
          }
        </div>
        {uploadState.fileName && uploadState.status !== 'idle' && (
          <div className="upload-filename">{uploadState.fileName}</div>
        )}
        <div className="upload-accepted">
          Accepted: {selectedTarget.accept} (max {selectedTarget.maxSizeMB}MB)
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={selectedTarget.accept}
          onChange={onFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      {/* Status */}
      {uploadState.status !== 'idle' && (
        <div className="upload-status" style={{ color: statusColor[uploadState.status] }}>
          <span className={uploadState.status === 'uploading' || uploadState.status === 'reading' ? 'hc-spinning' : ''}>
            {statusIcon[uploadState.status]}
          </span>
          {' '}{uploadState.message}
        </div>
      )}

      {/* Info */}
      <div className="upload-info">
        <strong>How it works:</strong> Files are committed directly to the ADA-Artifacts repository.
        The nightly pipeline (or immediate push trigger) rebuilds all documents, dashboards, and chat indexes from the updated data.
      </div>
    </div>
  );
}
