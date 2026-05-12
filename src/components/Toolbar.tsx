/**
 * Toolbar — Two-row layout:
 *   Row 1 (Data):      Load XLSX, Save, Push to GitHub, Download XLSX, GitHub settings
 *   Row 2 (Diagrams):  Download Template, Upload Diagram, status messages
 */
import { useRef, useState } from 'react';
import { CAPABILITIES } from '../data/towerRegistry';
import { generateScopedDrawioTemplate } from '../utils/templateGenerator';
import { generateScopedVisioTemplate } from '../utils/visioTemplateGenerator';

const TEMPLATES: { label: string; file: string; ext: string }[] = [
  { label: 'Draw.io Template (.drawio)', file: 'integration-flows-template.drawio', ext: '.drawio' },
  { label: 'ArchiMate Template (.xml)', file: 'integration-flows-template.archimate.xml', ext: '.archimate.xml' },
  { label: 'Visio Template (.vsdx)', file: 'integration-flows-template.vsdx', ext: '.vsdx' },
  { label: 'Template Guide (README)', file: 'README.md', ext: '.md' },
];

interface ToolbarProps {
  tower: string;
  cap: string;
  release: string;
  state: string;
  hasData: boolean;
  dirty: boolean;
  saveStatus: 'idle' | 'saving' | 'saved';
  githubStatus: 'idle' | 'pushing' | 'pushed' | 'error';
  githubMessage?: string;
  hasGitHubToken: boolean;
  lastSaved?: string | null;
  diagramStatus?: 'idle' | 'parsing' | 'uploading' | 'done' | 'error';
  diagramMessage?: string;
  onLoadFile: (data: ArrayBuffer) => void;
  onSave: () => void;
  onPushToGitHub: () => void;
  onDownload: () => void;
  onOpenTokenSettings: () => void;
  onUploadDiagram?: (file: File) => void;
}

export default function Toolbar({
  tower, cap, release, state, hasData, dirty,
  saveStatus, githubStatus, githubMessage, hasGitHubToken,
  lastSaved, diagramStatus, diagramMessage,
  onLoadFile, onSave, onPushToGitHub, onDownload, onOpenTokenSettings, onUploadDiagram,
}: ToolbarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const diagramRef = useRef<HTMLInputElement>(null);
  const [templateOpen, setTemplateOpen] = useState(false);

  const handleDownloadTemplate = async (t: typeof TEMPLATES[number]) => {
    const capInfo = CAPABILITIES[tower]?.find(c => c.id === cap);
    const capLabel = capInfo
      ? capInfo.name.split(/\s+/).slice(1).join('-')
      : cap;
    const prefix = release === 'All' ? '' : `${release}_`;
    const filename = t.ext !== '.md'
      ? `${tower}_${cap}_${capLabel}_${prefix}${state}_Integration-Flows${t.ext}`
      : t.file;

    // For .drawio templates, generate a scoped version (Instructions + matching tab only)
    if (t.ext === '.drawio') {
      try {
        const scopedXml = await generateScopedDrawioTemplate(
          release, state, import.meta.env.BASE_URL,
        );
        const blob = new Blob([scopedXml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
        setTemplateOpen(false);
        return;
      } catch {
        // Fallback to static file if scoping fails
      }
    }

    // Static file download (ArchiMate, README — or .drawio/.vsdx fallback)
    // For .vsdx templates, generate a scoped version (Instructions + matching tab only)
    if (t.ext === '.vsdx') {
      try {
        const scopedData = await generateScopedVisioTemplate(
          release, state, import.meta.env.BASE_URL,
        );
        const blob = new Blob([scopedData], { type: 'application/vnd.ms-visio.drawing' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
        setTemplateOpen(false);
        return;
      } catch {
        // Fallback to static file if scoping fails
      }
    }

    // Static file download (ArchiMate, README — or fallback)
    const link = document.createElement('a');
    link.href = `${import.meta.env.BASE_URL}templates/${t.file}`;
    link.download = filename;
    link.click();
    setTemplateOpen(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        onLoadFile(reader.result);
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const handleDiagramChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (onUploadDiagram) onUploadDiagram(file);
    e.target.value = '';
  };

  const prefix = release === 'All' ? '' : `${release}_`;
  const filename = `${prefix}${state}Flows.xlsx`;

  const saveLabel = saveStatus === 'saving' ? 'Saving…'
    : saveStatus === 'saved' ? '✓ Saved' : 'Save';

  const ghLabel = githubStatus === 'pushing' ? 'Pushing…'
    : githubStatus === 'pushed' ? '✓ Pushed' : 'Push to GitHub';

  const lastSavedLabel = lastSaved
    ? `Last saved: ${new Date(lastSaved).toLocaleTimeString()}`
    : '';

  return (
    <div className="toolbar-stack">
      {/* ─── Row 1: Data Operations ─── */}
      <div className="toolbar toolbar-data">
        <div className="toolbar-left">
          <span className="toolbar-label">📊 Data</span>
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
            Load XLSX
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <button
            className={`btn ${dirty ? 'btn-save-dirty' : 'btn-save'}`}
            onClick={onSave}
            disabled={saveStatus === 'saving'}
            title={lastSavedLabel || 'Save changes locally (browser storage)'}
          >
            {saveLabel}
          </button>
          <button
            className={`btn ${githubStatus === 'pushed' ? 'btn-save' : githubStatus === 'error' ? 'btn-error' : 'btn-github'}`}
            onClick={onPushToGitHub}
            disabled={!hasData || githubStatus === 'pushing' || !hasGitHubToken}
            title={hasGitHubToken
              ? (githubMessage || 'Commit data to the ADA-Artifacts GitHub repo')
              : 'Set up GitHub token first (click ⚙)'}
          >
            {ghLabel}
          </button>
          <button
            className="btn btn-icon"
            onClick={onOpenTokenSettings}
            title="GitHub token settings"
          >
            ⚙
          </button>
          <button
            className="btn btn-success"
            onClick={onDownload}
            disabled={!hasData}
          >
            Download XLSX
          </button>
        </div>
        <div className="toolbar-right">
          {githubMessage && githubStatus === 'error' && (
            <span className="github-error" title={githubMessage}>⚠ {githubMessage}</span>
          )}
          {lastSavedLabel && <span className="save-timestamp">{lastSavedLabel}</span>}
          <span className="file-info">{tower} / {cap}</span>
          <span className="file-badge">{filename}</span>
        </div>
      </div>

      {/* ─── Row 2: Diagrams & Templates ─── */}
      <div className="toolbar toolbar-diagrams">
        <div className="toolbar-left">
          <span className="toolbar-label">📐 Diagrams</span>
          <div className="template-dropdown-wrap">
            <button
              className="btn btn-template"
              onClick={() => setTemplateOpen(!templateOpen)}
              title={`Download a diagram template scoped to ${release === 'All' ? '' : release + ' '}${state} — use the tab matching your selection`}
            >
              📋 Template ({release === 'All' ? state : `${release} ${state}`}) ▾
            </button>
            {templateOpen && (
              <ul className="template-dropdown">
                {TEMPLATES.map(t => (
                  <li key={t.file}>
                    <button onClick={() => handleDownloadTemplate(t)}>{t.label}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            className="btn btn-diagram"
            onClick={() => diagramRef.current?.click()}
            disabled={diagramStatus === 'parsing' || diagramStatus === 'uploading'}
            title="Upload a diagram (.drawio, .bpmn, .xml, .vsdx, .vsd) to extract integration hops into the Flows grid"
          >
            {diagramStatus === 'parsing' ? '⏳ Parsing…'
              : diagramStatus === 'uploading' ? '⏳ Uploading…'
              : '📐 Upload Diagram'}
          </button>
          <input
            ref={diagramRef}
            type="file"
            accept=".drawio,.bpmn,.xml,.vsdx,.vsd"
            onChange={handleDiagramChange}
            style={{ display: 'none' }}
          />
        </div>
        <div className="toolbar-right">
          {diagramMessage && diagramStatus === 'done' && (
            <span className="diagram-success" title={diagramMessage}>✓ {diagramMessage}</span>
          )}
          {diagramMessage && diagramStatus === 'error' && (
            <span className="diagram-error" title={diagramMessage}>⚠ {diagramMessage}</span>
          )}
        </div>
      </div>
    </div>
  );
}
