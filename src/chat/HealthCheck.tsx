import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type CheckResult,
  type CheckStatus,
  type HealthReport,
  STATUS_ICON,
  runHealthChecks,
} from './healthCheckUtils';
import FileUpload from './FileUpload';

/* ── FAB colour by overall status ────────────────────────────── */

const FAB_COLOUR: Record<CheckStatus, string> = {
  pass: '#1b5e20',
  fail: '#b71c1c',
  warn: '#e65100',
  running: '#0071C5',
  idle: '#1a1a2e',
};

/* ── Component ───────────────────────────────────────────────── */

export default function HealthCheck() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'health' | 'upload'>('health');
  const [results, setResults] = useState<CheckResult[]>([]);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [running, setRunning] = useState(false);
  const mountedRef = useRef(true);
  const runningRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    runningRef.current = false;  // reset on StrictMode remount
    return () => { mountedRef.current = false; };
  }, []);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setResults([]);
    setReport(null);

    try {
      const r = await runHealthChecks((partial) => {
        if (mountedRef.current) setResults([...partial]);
      });
      if (mountedRef.current) {
        setResults(r.results);
        setReport(r);
      }
    } catch (e) {
      console.error('[HealthCheck] run failed:', e);
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  }, []);

  // Auto-run on first open
  const handleOpen = () => {
    setOpen(true);
    if (results.length === 0 && !running) run();
  };

  // Run once at mount to set FAB colour
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const overall = report?.overallStatus ?? 'idle';

  return (
    <>
      {/* FAB button — bottom-left */}
      <button
        onClick={handleOpen}
        title="System Health Check"
        style={{
          position: 'fixed',
          bottom: 80,
          left: 18,
          zIndex: 9998,
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: 'none',
          background: FAB_COLOUR[overall],
          color: '#fff',
          fontSize: 18,
          cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,.3)',
          transition: 'background 0.2s',
        }}
      >
        ♥
      </button>

      {/* Overlay + Panel */}
      {open && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0,0,0,.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div className="health-check-panel" style={{
            background: '#1a1a2e',
            color: '#e0e0e0',
            borderRadius: 12,
            padding: 20,
            minWidth: 360,
            maxWidth: 520,
            width: '90vw',
            maxHeight: '80vh',
            boxShadow: '0 8px 32px rgba(0,0,0,.4)',
            display: 'flex',
            flexDirection: 'column',
          }}>
            {/* Header */}
            <div className="hc-header">
              <h3 style={{ color: '#e0e0e0' }}>♥ System Health &amp; Data</h3>
              <button
                onClick={() => setOpen(false)}
                style={{ background: 'none', border: 'none', color: '#e0e0e0', fontSize: 20, cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            {/* Tabs */}
            <div className="hc-tabs">
              <button
                className={`hc-tab ${activeTab === 'health' ? 'active' : ''}`}
                onClick={() => setActiveTab('health')}
              >
                ♥ Health
              </button>
              <button
                className={`hc-tab ${activeTab === 'upload' ? 'active' : ''}`}
                onClick={() => setActiveTab('upload')}
              >
                ⬆ Upload Data
              </button>
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              {activeTab === 'health' ? (
                <>
                  {/* Progress bar */}
                  {running && (
                    <div className="hc-progress-bar">
                      <div
                        className="hc-progress-fill"
                        style={{ width: `${Math.round((results.length / 8) * 100)}%` }}
                      />
                    </div>
                  )}

                  {/* Results */}
                  <div className="hc-check-list" style={{ marginTop: 12 }}>
                    {results.map((r) => (
                      <div key={r.id} className={`hc-check-item ${r.status}`}>
                        <span className="hc-check-icon">{STATUS_ICON[r.status]}</span>
                        <div className="hc-check-body">
                          <div className="hc-check-name">{r.label}</div>
                          <div className="hc-check-detail">{r.detail}</div>
                          {r.fix && r.status !== 'pass' && (
                            <div className="hc-check-fix">💡 {r.fix}</div>
                          )}
                        </div>
                        {r.durationMs > 0 && (
                          <span className="hc-check-latency">{r.durationMs}ms</span>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Overall + timestamp */}
                  {report && (
                    <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className={`hc-status-badge ${report.overallStatus}`}>
                        {STATUS_ICON[report.overallStatus]} {report.overallStatus.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 11, color: '#777' }}>
                        {new Date(report.ranAt).toLocaleTimeString()}
                      </span>
                    </div>
                  )}

                  {/* Re-run button */}
                  <button
                    className="hc-run-btn"
                    onClick={run}
                    disabled={running}
                    style={{ marginTop: 12 }}
                  >
                    {running ? <><span className="hc-spinning">◌</span> Running…</> : 'Re-run Checks'}
                  </button>
                </>
              ) : (
                <FileUpload />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
