/**
 * DrawioEditor.tsx — In-browser draw.io visual editor for ADA diagram tabs.
 *
 * Flow:
 *   1. Parent passes mermaidSource (current tab's Mermaid text)
 *   2. Pyodide converts Mermaid → draw.io XML (in-browser, no backend)
 *   3. draw.io iframe loads with that XML
 *   4. Architect edits visually
 *   5. On Save, iframe posts XML back via postMessage
 *   6. Pyodide converts XML → Mermaid (in-browser)
 *   7. onSave(updatedMermaid) fires — parent stores and optionally writes to GitHub
 *
 * Exports:
 *   - DrawioEditor     — the modal editor component
 *   - useDrawioEditor  — hook managing open/close/save state
 *   - ImportDrawio     — file import button (.drawio or .vsdx)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  mermaidToDrawio,
  drawioToMermaid,
  vsdxToMermaid,
} from '../utils/pyodideConverter';

// ── Types ────────────────────────────────────────────────────────────────────

interface DrawioEditorProps {
  /** Current Mermaid source for this tab */
  mermaidSource: string;
  /** Pre-saved draw.io XML (if exists). When provided, loads directly — skips Mermaid→Pyodide. */
  savedDrawioXml?: string;
  /** Tab label shown in the editor header */
  tabLabel?: string;
  /** Called with updated Mermaid text and raw draw.io XML after architect saves */
  onSave: (updatedMermaid: string, drawioXml: string) => void;
  /** Called when editor is dismissed without saving */
  onClose: () => void;
  /** draw.io embed URL */
  drawioEmbedUrl?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DRAWIO_URL =
  'https://embed.diagrams.net/?embed=1&proto=json&spin=1&libraries=1&saveAndExit=1&noSaveBtn=0&noExitBtn=0';

function buildEmptyDrawio(): string {
  return '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
}

// ── postMessage protocol ─────────────────────────────────────────────────────

interface DrawioMessage {
  event: 'init' | 'save' | 'exit' | 'load' | 'close';
  xml?: string;
  modified?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export function DrawioEditor({
  mermaidSource,
  savedDrawioXml,
  tabLabel = 'Diagram',
  onSave,
  onClose,
  drawioEmbedUrl = DEFAULT_DRAWIO_URL,
}: DrawioEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [drawioXml, setDrawioXml] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const initReceivedRef = useRef(false);

  // ── Step 1: Convert Mermaid → draw.io XML on mount (via Pyodide) ─────────
  // Track whether we've already loaded XML to avoid re-triggering on parent re-renders
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    // Once loaded successfully, don't re-run on prop changes (the editor is already open)
    if (hasLoadedRef.current) return;

    let cancelled = false;
    setStatus('loading');
    initReceivedRef.current = false;

    (async () => {
      try {
        let xml: string;
        if (savedDrawioXml) {
          // Use the persisted draw.io XML directly (preserves architect's layout edits)
          xml = savedDrawioXml;
          console.log('[DrawioEditor] Using saved draw.io XML, length:', xml.length);
        } else if (!mermaidSource.trim()) {
          // No mermaid source — give draw.io an empty canvas (architect draws from scratch)
          xml = buildEmptyDrawio();
          console.log('[DrawioEditor] Empty source → using blank canvas');
        } else {
          console.log('[DrawioEditor] Converting mermaid via Pyodide...');
          const result = await mermaidToDrawio(mermaidSource);
          xml = result.content || buildEmptyDrawio();
          console.log('[DrawioEditor] Pyodide conversion done, xml length:', xml.length);
        }
        if (!cancelled) {
          setDrawioXml(xml);
          hasLoadedRef.current = true;
        }
      } catch (err: unknown) {
        if (!cancelled) {
          console.error('[DrawioEditor] Pyodide conversion error:', err);
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      }
    })();

    // Timeout failsafe: if still loading after 15s, show actionable error
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setStatus(prev => {
          if (prev === 'loading') {
            console.warn('[DrawioEditor] Timeout — still loading after 15s');
            setErrorMsg('draw.io editor timed out. Check console for [DrawioEditor] logs.');
            return 'error';
          }
          return prev;
        });
      }
    }, 15000);

    return () => { cancelled = true; clearTimeout(timeout); };
  }, [mermaidSource, savedDrawioXml]);

  // ── Refs for stable message handler (avoids listener re-registration) ────
  const drawioXmlRef = useRef(drawioXml);
  drawioXmlRef.current = drawioXml;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  // ── Step 2: Handle postMessage from draw.io iframe ───────────────────────
  // Single stable listener registered once on mount — reads current state via refs
  useEffect(() => {
    const handleMessage = async (ev: MessageEvent) => {
      // Debug: log ALL messages to diagnose
      if (ev.origin.includes('diagrams.net') || ev.origin.includes('draw.io')) {
        console.log('[DrawioEditor] Message from draw.io:', typeof ev.data === 'string' ? ev.data.substring(0, 200) : ev.data);
      }

      // Origin check: allow diagrams.net, draw.io, or same origin
      if (!ev.origin.includes('diagrams.net') && !ev.origin.includes('draw.io')) {
        if (ev.origin !== window.location.origin) return;
      }

      let msg: DrawioMessage;
      try {
        msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      } catch {
        // With proto=json, draw.io shouldn't send raw strings, but handle gracefully
        if (typeof ev.data === 'string' && ev.data.trim().toLowerCase() === 'ready') {
          msg = { event: 'init' };
        } else {
          return;
        }
      }

      if (!msg || !msg.event) return;

      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;

      switch (msg.event) {
        case 'init': {
          initReceivedRef.current = true;
          const xml = drawioXmlRef.current.trim();
          console.log('[DrawioEditor] iframe sent init. drawioXml ready:', !!xml, 'length:', xml.length);
          if (xml) {
            // draw.io embed protocol: respond with JSON {action:'load', xml:'...'}
            const loadMsg = JSON.stringify({ action: 'load', autosave: 0, xml });
            iframe.contentWindow.postMessage(loadMsg, '*');
            setStatus('ready');
            console.log('[DrawioEditor] Sent JSON load action to iframe, status → ready');
          } else {
            console.log('[DrawioEditor] Waiting for Pyodide to finish...');
          }
          break;
        }

        case 'save': {
          if (!msg.xml) break;
          setStatus('saving');
          setIsDirty(false);

          // Save the raw XML immediately — Pyodide Mermaid conversion is best-effort only.
          // The XML IS the primary persistence artifact; Mermaid is secondary for the preview.
          let mermaidResult = '';
          try {
            const result = await drawioToMermaid(msg.xml);
            mermaidResult = result.content || '';
          } catch (err: unknown) {
            // Pyodide conversion failed — NOT fatal. XML is still saved.
            console.warn('[DrawioEditor] Pyodide XML→Mermaid conversion failed (non-fatal):', err);
          }

          // Always fire onSave with the raw XML (mermaid may be empty string if conversion failed)
          onSaveRef.current(mermaidResult, msg.xml);

          // ACK the save to draw.io so it knows we processed it
          iframe.contentWindow.postMessage(
            JSON.stringify({ action: 'status', message: 'Saved', modified: false }),
            '*'
          );
          setStatus('ready');
          break;
        }

        case 'exit':
        case 'close': {
          if (isDirtyRef.current) {
            const confirmed = window.confirm('You have unsaved changes. Close without saving?');
            if (!confirmed) return;
          }
          onCloseRef.current();
          break;
        }

        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    console.log('[DrawioEditor] Message listener registered');
    return () => {
      window.removeEventListener('message', handleMessage);
      console.log('[DrawioEditor] Message listener removed');
    };
  }, []); // stable — never re-registers

  // ── Push XML to iframe if init already arrived before Pyodide finished ───
  useEffect(() => {
    if (!drawioXml || !iframeRef.current?.contentWindow) return;
    if (initReceivedRef.current && status === 'loading') {
      const trimmed = drawioXml.trim();
      console.log('[DrawioEditor] useEffect: pushing JSON load after Pyodide done. xml length:', trimmed.length);
      // draw.io embed protocol: respond with JSON {action:'load', xml:'...'}
      const loadMsg = JSON.stringify({ action: 'load', autosave: 0, xml: trimmed });
      iframeRef.current.contentWindow.postMessage(loadMsg, '*');
      setStatus('ready');
    }
  }, [drawioXml, status]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        iframeRef.current?.contentWindow?.postMessage(
          JSON.stringify({ action: 'export', format: 'xml' }),
          '*'
        );
      }
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.headerTitle}>✏️ Edit: {tabLabel}</span>
            {isDirty && <span style={styles.dirtyBadge}>unsaved</span>}
          </div>
          <div style={styles.headerRight}>
            <span style={styles.hint}>Ctrl+S to save · Esc to close</span>
            <StatusBadge status={status} />
            <button style={styles.closeBtn} onClick={onClose} title="Close editor">
              ✕
            </button>
          </div>
        </div>

        {/* Error banner */}
        {status === 'error' && (
          <div style={styles.errorBanner}>
            ⚠ {errorMsg}
            <button style={styles.retryBtn} onClick={() => setStatus('loading')}>
              Retry
            </button>
          </div>
        )}

        {/* Loading overlay */}
        {status === 'loading' && (
          <div style={styles.loadingOverlay}>
            <div style={styles.spinner} />
            <span>Loading Pyodide + converting diagram…</span>
          </div>
        )}

        {/* draw.io iframe */}
        <iframe
          ref={iframeRef}
          src={drawioEmbedUrl}
          style={{
            ...styles.iframe,
            opacity: status === 'loading' ? 0 : 1,
          }}
          title={`draw.io editor — ${tabLabel}`}
          allow="clipboard-read; clipboard-write"
        />

        {/* Footer */}
        <div style={styles.footer}>
          <span style={styles.footerNote}>
            Visual edits save as Mermaid (.mmd) · Excel input is the data source of truth · .mmd feeds document generation
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    loading: { label: 'Loading…', color: '#f59e0b' },
    ready:   { label: 'Ready',    color: '#10b981' },
    saving:  { label: 'Saving…',  color: '#3b82f6' },
    error:   { label: 'Error',    color: '#ef4444' },
  };
  const { label, color } = map[status] ?? map.ready;
  return (
    <span style={{ ...styles.statusBadge, backgroundColor: color }}>
      {label}
    </span>
  );
}

// ── useDrawioEditor hook ─────────────────────────────────────────────────────

interface UseDrawioEditorOptions {
  mermaidSource: string;
  savedDrawioXml?: string;
  tabLabel: string;
  onSave: (mmd: string, drawioXml: string) => void;
}

export function useDrawioEditor({ mermaidSource, savedDrawioXml, tabLabel, onSave }: UseDrawioEditorOptions) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const handleSave = useCallback(
    (mmd: string, drawioXml: string) => {
      onSave(mmd, drawioXml);
      setIsOpen(false);
    },
    [onSave]
  );

  const editorProps: DrawioEditorProps | null = isOpen
    ? { mermaidSource, savedDrawioXml, tabLabel, onSave: handleSave, onClose: close }
    : null;

  return { open, close, isOpen, editorProps };
}

// ── ImportDrawio component ───────────────────────────────────────────────────

interface ImportDrawioProps {
  tabLabel?: string;
  onImport: (mermaid: string) => void;
}

export function ImportDrawio({ tabLabel = 'Diagram', onImport }: ImportDrawioProps) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setImporting(true);
    setError('');
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();

      if (ext === 'drawio' || ext === 'xml') {
        const text = await file.text();
        const result = await drawioToMermaid(text);
        if (!result.content) throw new Error('Converter returned empty Mermaid');
        onImport(result.content);
      } else if (ext === 'vsdx') {
        // .vsdx is binary — read as ArrayBuffer
        const buffer = await file.arrayBuffer();
        const result = await vsdxToMermaid(buffer);
        if (!result.content) throw new Error('Converter returned empty Mermaid');
        onImport(result.content);
      } else {
        throw new Error(`Unsupported file type: .${ext}. Use .drawio or .vsdx`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div style={styles.importWrapper}>
      <input
        ref={inputRef}
        type="file"
        accept=".drawio,.xml,.vsdx"
        style={{ display: 'none' }}
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
      <button
        style={styles.importBtn}
        disabled={importing}
        onClick={() => inputRef.current?.click()}
        title={`Import .drawio or .vsdx into ${tabLabel} tab`}
      >
        {importing ? '⏳ Importing…' : '⬆ Import .drawio / .vsdx'}
      </button>
      {error && <span style={styles.importError}>⚠ {error}</span>}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modal: {
    display: 'flex',
    flexDirection: 'column',
    width: '95vw',
    height: '92vh',
    background: '#ffffff',
    borderRadius: '8px',
    overflow: 'hidden',
    boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    background: '#1e293b',
    color: '#f1f5f9',
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: '14px',
  },
  dirtyBadge: {
    fontSize: '11px',
    background: '#f59e0b',
    color: '#1e293b',
    borderRadius: '4px',
    padding: '2px 6px',
    fontWeight: 600,
  },
  hint: {
    fontSize: '12px',
    color: '#94a3b8',
  },
  statusBadge: {
    fontSize: '11px',
    color: '#ffffff',
    borderRadius: '4px',
    padding: '2px 8px',
    fontWeight: 600,
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#94a3b8',
    fontSize: '18px',
    cursor: 'pointer',
    lineHeight: 1,
    padding: '0 4px',
  },
  errorBanner: {
    background: '#fee2e2',
    color: '#991b1b',
    padding: '8px 16px',
    fontSize: '13px',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexShrink: 0,
  },
  retryBtn: {
    background: '#ef4444',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    padding: '2px 10px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  loadingOverlay: {
    position: 'absolute',
    inset: '48px 0 32px 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    color: '#64748b',
    fontSize: '14px',
    zIndex: 10,
    background: 'rgba(255,255,255,0.85)',
  },
  spinner: {
    width: '32px',
    height: '32px',
    border: '3px solid #e2e8f0',
    borderTop: '3px solid #3b82f6',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  iframe: {
    flex: 1,
    border: 'none',
    width: '100%',
    transition: 'opacity 0.2s ease',
  },
  footer: {
    padding: '6px 16px',
    background: '#f8fafc',
    borderTop: '1px solid #e2e8f0',
    flexShrink: 0,
  },
  footerNote: {
    fontSize: '11px',
    color: '#94a3b8',
  },
  importWrapper: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  importBtn: {
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  },
  importError: {
    fontSize: '12px',
    color: '#ef4444',
  },
};
