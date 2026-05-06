/**
 * MultiTabUploadDialog — shown when a diagram upload contains multiple
 * release/state tabs. Lets the architect choose which tabs to load.
 */
import { useState } from 'react';
import type { HopSheet } from '../utils/diagramParser';

interface MultiTabUploadDialogProps {
  sheets: HopSheet[];
  currentRelease: string;
  currentState: string;
  onLoadSelected: (sheets: HopSheet[]) => void;
  onCancel: () => void;
}

export default function MultiTabUploadDialog({
  sheets,
  currentRelease,
  currentState,
  onLoadSelected,
  onCancel,
}: MultiTabUploadDialogProps) {
  // Pre-check the tab matching current selection
  const [selected, setSelected] = useState<Set<number>>(() => {
    const matchIdx = sheets.findIndex(
      s => s.release === currentRelease && s.state === currentState
    );
    return new Set(matchIdx >= 0 ? [matchIdx] : [0]);
  });

  const toggleSheet = (idx: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(sheets.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());

  const handleLoad = () => {
    const chosen = sheets.filter((_, i) => selected.has(i));
    if (chosen.length > 0) onLoadSelected(chosen);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="multi-tab-dialog" onClick={e => e.stopPropagation()}>
        <h3>📐 Multiple Tabs Detected</h3>
        <p className="multi-tab-desc">
          This diagram contains <strong>{sheets.length} tabs</strong> with integration flows.
          Select which tabs to load into their respective release/state slots.
        </p>

        <div className="multi-tab-actions-top">
          <button className="btn btn-sm" onClick={selectAll}>Select All</button>
          <button className="btn btn-sm" onClick={selectNone}>Clear All</button>
        </div>

        <div className="multi-tab-list">
          {sheets.map((sheet, idx) => {
            const isCurrentMatch =
              sheet.release === currentRelease && sheet.state === currentState;
            return (
              <label
                key={idx}
                className={`multi-tab-item ${isCurrentMatch ? 'multi-tab-current' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(idx)}
                  onChange={() => toggleSheet(idx)}
                />
                <div className="multi-tab-info">
                  <span className="multi-tab-name">{sheet.tabName}</span>
                  <span className="multi-tab-meta">
                    {sheet.release} / {sheet.state} — {sheet.hops.length} hops
                  </span>
                </div>
                {isCurrentMatch && (
                  <span className="multi-tab-badge">← current</span>
                )}
              </label>
            );
          })}
        </div>

        <div className="multi-tab-actions">
          <button className="btn btn-primary" onClick={handleLoad} disabled={selected.size === 0}>
            Load {selected.size} Tab{selected.size !== 1 ? 's' : ''}
          </button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>

        <p className="multi-tab-hint">
          Each tab will be saved to its matching release/state slot.
          The tab matching your current selection will be shown in the grid.
        </p>
      </div>
    </div>
  );
}
