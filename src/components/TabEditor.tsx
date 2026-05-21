/**
 * TabEditor — 6-tab ribbon editor using AG Grid Community.
 * Each tab maps to one XLSX worksheet with its own column definitions.
 * Excel-like UX: compact rows, row numbers, clipboard paste, visible grid lines,
 * checkbox multi-select, Ctrl+C/V/X/A/Delete support.
 */
import { useState, useCallback, useRef, useMemo, useEffect, useImperativeHandle, forwardRef, memo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz, colorSchemeLightCold } from 'ag-grid-community';
import { TAB_DEFINITIONS, defaultColDef } from '../grids/columnDefs';
import { useGridClipboard } from '../hooks/useGridClipboard';
import type { GridClipboardEvent } from '../hooks/useGridClipboard';
import type { WorkbookData } from '../utils/xlsxUtils';
import { enrichFlowPlatforms } from '../utils/platformLookup';
import type { ColDef, ColGroupDef, CellValueChangedEvent, GridReadyEvent } from 'ag-grid-community';
import DiagramPreview from './DiagramPreview';
import type { FlowRow } from '../utils/flowsToMermaid';

/** Custom Excel-like theme: compact rows, visible borders */
const excelTheme = themeQuartz.withPart(colorSchemeLightCold).withParams({
  rowHeight: 28,
  headerHeight: 32,
  fontSize: 13,
  borderColor: '#c8d6e5',
  headerBackgroundColor: '#dfe6ed',
  headerTextColor: '#2c3e50',
  oddRowBackgroundColor: '#ffffff',
  rowBorder: true,
  columnBorder: true,
  wrapperBorder: true,
  headerColumnBorder: true,
  cellHorizontalPadding: 6,
});

/** Number of pre-populated empty rows per tab (lets users paste directly). */
const DEFAULT_EMPTY_ROWS = 50;

/** Imperative handle so App can extract current grid data before save/download. */
export interface TabEditorHandle {
  /** Return the current grid data for ALL tabs (merges grid state into data). */
  flush: () => WorkbookData;
  /** Push new external data into the grid (upload, fetch, tower/cap change). */
  loadData: (newData: WorkbookData) => void;
}

interface TabEditorProps {
  /** Initial data — only used on first mount. After that, use loadData(). */
  initialData: WorkbookData;
  onDirty?: () => void;
  /** Current tower (for diagram save-back). */
  tower?: string;
  /** Current capability ID (for diagram save-back). */
  cap?: string;
}

const TabEditor = forwardRef<TabEditorHandle, TabEditorProps>(
  function TabEditor({ initialData, onDirty, tower, cap }, ref) {
  const [activeTab, setActiveTab] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const gridRef = useRef<AgGridReact>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const tab = TAB_DEFINITIONS[activeTab];
  const isFlowsTab = tab.name === 'Flows';

  // ── Diagram preview state ─────────────────────────────────
  const [showPreview, setShowPreview] = useState(false);
  const [flowRows, setFlowRows] = useState<FlowRow[]>([]);
  const [splitPercent, setSplitPercent] = useState(55); // grid gets this %, diagram gets rest
  const splitDragRef = useRef<{ dragging: boolean; startX: number; startPct: number; containerW: number }>({ dragging: false, startX: 0, startPct: 55, containerW: 0 });
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // ── Stable ref for onDirty ─────────────────────────────────
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;

  // ── Internal data cache — source of truth for all tabs ─────
  // This is completely independent of React state.  The grid reads
  // from and writes to this cache.  React never pushes data to the grid.
  const tabCache = useRef<WorkbookData>({ ...initialData });
  const gridApiReady = useRef(false);

  /** Build row array for a given tab, with empty rows if needed. */
  function makeRows(tabName: string, source: WorkbookData): Record<string, unknown>[] {
    const rows = source[tabName] ?? [];
    return rows.length > 0
      ? rows
      : Array.from({ length: DEFAULT_EMPTY_ROWS }, () => ({} as Record<string, unknown>));
  }

  /** Extract current rows from the live grid. */
  const extractGridRows = useCallback((): Record<string, unknown>[] => {
    const api = gridRef.current?.api;
    if (!api) return [];
    const rows: Record<string, unknown>[] = [];
    api.forEachNode(node => { if (node.data) rows.push({ ...node.data }); });
    return rows;
  }, []);

  /** Save current grid state into the cache for the current tab. */
  const saveCurrentTabToCache = useCallback(() => {
    if (!gridApiReady.current) return;
    tabCache.current[TAB_DEFINITIONS[activeTab].name] = extractGridRows();
  }, [activeTab, extractGridRows]);

  /** Push a tab's data from cache to the live grid. */
  const pushTabToGrid = useCallback((tabName: string) => {
    const api = gridRef.current?.api;
    if (!api) return;
    api.setGridOption('rowData', makeRows(tabName, tabCache.current));
    setTimeout(() => api.autoSizeAllColumns(), 0);
  }, []);

  // Track active tab name via ref (accessible in stable callbacks)
  const activeTabNameRef = useRef(tab.name);
  activeTabNameRef.current = tab.name;

  /** Sync grid rows to tabCache + diagram preview. */
  const syncCacheAndPreview = useCallback(() => {
    const api = gridRef.current?.api;
    if (api) {
      const rows: Record<string, unknown>[] = [];
      api.forEachNode(node => { if (node.data) rows.push({ ...node.data }); });
      tabCache.current[activeTabNameRef.current] = rows;
      if (activeTabNameRef.current === 'Flows') {
        setFlowRows(rows as FlowRow[]);
      }
    }
  }, []);

  // Cell edit callback — AG Grid has already committed the value to node.data
  // via onValueChange + getValue() before this fires.
  const handleCellValueChanged = useCallback((_e: CellValueChangedEvent) => {
    syncCacheAndPreview();
    if (onDirtyRef.current) onDirtyRef.current();
  }, [syncCacheAndPreview]);

  // ── Imperative handle ──────────────────────────────────────
  useImperativeHandle(ref, () => ({
    flush: (): WorkbookData => {
      // Save current visible tab from grid
      saveCurrentTabToCache();
      return { ...tabCache.current };
    },
    loadData: (newData: WorkbookData): void => {
      // Enrich Flows tab with canonical DB/Platform values on load
      if (newData['Flows'] && Array.isArray(newData['Flows'])) {
        const corrected = enrichFlowPlatforms(newData['Flows'] as Record<string, unknown>[]);
        if (corrected > 0) console.info(`[ADA] Enriched ${corrected} platform cells on load`);
      }
      // Replace entire cache and reload the visible tab
      tabCache.current = { ...newData };
      if (gridApiReady.current) {
        pushTabToGrid(TAB_DEFINITIONS[activeTab].name);
      }
      // Always sync diagram preview with new Flows data
      setFlowRows((newData['Flows'] ?? []) as FlowRow[]);
    },
  }), [saveCurrentTabToCache, pushTabToGrid, activeTab]);

  /** Row number column (pinned left, non-editable) + checkbox selection */
  const leadColumns: ColDef[] = useMemo(() => [
    {
      headerName: '',
      width: 42,
      minWidth: 42,
      maxWidth: 42,
      pinned: 'left',
      editable: false,
      sortable: false,
      filter: false,
      resizable: false,
      lockPosition: 'left',
      suppressMovable: true,
    },
    {
      headerName: '#',
      width: 52,
      minWidth: 52,
      maxWidth: 70,
      pinned: 'left',
      editable: false,
      sortable: false,
      filter: false,
      resizable: false,
      lockPosition: 'left',
      suppressMovable: true,
      valueGetter: (params) => (params.node?.rowIndex ?? 0) + 1,
      cellStyle: { color: '#999', textAlign: 'center', fontWeight: 500 },
    },
  ], []);

  const fullColumns = useMemo(() => [
    ...leadColumns,
    ...(tab.columns as (ColDef | ColGroupDef)[]),
  ], [leadColumns, tab.columns]);

  /** Notify parent of structural changes (add/delete/paste rows).
   *  Only marks dirty — does NOT push data back through React state. */
  const notifyParent = useCallback(() => {
    if (onDirtyRef.current) onDirtyRef.current();
  }, []);

  const showToast = useCallback((msg: string) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const handleClipboardEvent = useCallback((evt: GridClipboardEvent) => {
    const labels: Record<string, string> = {
      'copy': '📋 Copied', 'cut': '✂️ Cut', 'paste': '📥 Pasted',
      'delete': '🗑️ Cleared', 'select-all': '☑️ Selected',
    };
    const label = labels[evt.action] ?? evt.action;
    showToast(`${label} ${evt.rows} row${evt.rows !== 1 ? 's' : ''} × ${evt.cols} column${evt.cols !== 1 ? 's' : ''}`);
  }, [showToast]);

  // Wire up custom clipboard (Ctrl+C/V/X, Delete, Ctrl+A)
  useGridClipboard({
    api: gridRef.current?.api ?? null,
    containerRef,
    columns: tab.columns as (ColDef | ColGroupDef)[],
    onDataChanged: notifyParent,
    onClipboardEvent: handleClipboardEvent,
  });

  const addRow = useCallback(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    api.applyTransaction({ add: [{}] });
    notifyParent();
  }, [notifyParent]);

  const autoSizeColumns = useCallback(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    api.autoSizeAllColumns();
  }, []);

  const clearColumn = useCallback((field: string) => {
    const api = gridRef.current?.api;
    if (!api) return;
    let count = 0;
    api.forEachNode(node => {
      if (node.data && node.data[field] !== undefined && node.data[field] !== '') {
        node.data[field] = '';
        count++;
      }
    });
    if (count > 0) {
      api.refreshCells({ force: true });
      notifyParent();
    }
  }, [notifyParent]);

  // Note: getMainMenuItems removed — it requires ag-grid-enterprise.
  // Clear-column is still available via right-click context menu below.

  // Custom right-click context menu (AG Grid Community doesn't have built-in)
  // Also supports long-press on mobile (touch-hold ~500ms)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; field: string; rowIndex: number | null } | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openContextMenu = useCallback((x: number, y: number, target: HTMLElement) => {
    const cell = target.closest('.ag-cell');
    if (!cell) return;
    const colId = cell.getAttribute('col-id');
    if (!colId) return;
    const row = target.closest('.ag-row');
    const rowIdx = row ? parseInt(row.getAttribute('row-index') ?? '', 10) : null;
    setCtxMenu({ x, y, field: colId, rowIndex: Number.isFinite(rowIdx) ? rowIdx : null });
  }, []);

  const handleCellContextMenu = useCallback((e: React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest('.ag-cell');
    if (!cell) return;
    const colId = cell.getAttribute('col-id');
    if (!colId) return;
    const row = (e.target as HTMLElement).closest('.ag-row');
    const rowIdx = row ? parseInt(row.getAttribute('row-index') ?? '', 10) : null;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, field: colId, rowIndex: Number.isFinite(rowIdx) ? rowIdx : null });
  }, []);

  // Long-press handler for mobile touch devices
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    const target = e.target as HTMLElement;
    touchTimerRef.current = setTimeout(() => {
      openContextMenu(touch.clientX, touch.clientY, target);
    }, 500);
  }, [openContextMenu]);

  const handleTouchEnd = useCallback(() => {
    if (touchTimerRef.current) {
      clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    if (touchTimerRef.current) {
      clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
  }, []);

  // Close context menu on click anywhere
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  const deleteSelectedRows = useCallback(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    const selected = api.getSelectedRows();
    if (selected.length === 0) return;
    api.applyTransaction({ remove: selected });
    notifyParent();
  }, [notifyParent]);

  const insertRowAt = useCallback((rowIndex: number | null, offset: 0 | 1) => {
    const api = gridRef.current?.api;
    if (!api) return;
    const addIndex = rowIndex != null ? rowIndex + offset : undefined;
    api.applyTransaction({ add: [{}], addIndex });
    notifyParent();
  }, [notifyParent]);

  const onGridReady = useCallback((_e: GridReadyEvent) => {

    // Push initial data via cache — NOT via React state
    _e.api.setGridOption('rowData', makeRows(tab.name, tabCache.current));
    gridApiReady.current = true;
    setTimeout(() => _e.api.autoSizeAllColumns(), 0);
    // Seed diagram preview with initial Flows data
    if (tab.name === 'Flows') {
      setFlowRows((tabCache.current['Flows'] ?? []) as FlowRow[]);
    }
  }, [tab.name]);

  // When activeTab changes, save current tab to cache + load new tab from cache
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    if (prevTabRef.current !== activeTab && gridApiReady.current) {
      // Save the previous tab's grid state
      tabCache.current[TAB_DEFINITIONS[prevTabRef.current].name] = extractGridRows();
      // Load the new tab from cache
      pushTabToGrid(tab.name);
      // Sync diagram preview when switching to Flows
      if (tab.name === 'Flows') {
        setFlowRows((tabCache.current['Flows'] ?? []) as FlowRow[]);
      }
    }
    prevTabRef.current = activeTab;
  }, [activeTab, tab.name, extractGridRows, pushTabToGrid]);

  // Count real (non-empty) rows for display
  const realRowCount = (tabCache.current[tab.name] ?? []).length;

  // ── Split resize handler for grid/diagram ──
  const handleSplitResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    splitDragRef.current = {
      dragging: true,
      startX: e.clientX,
      startPct: splitPercent,
      containerW: container.clientWidth,
    };
    const onMove = (ev: MouseEvent) => {
      if (!splitDragRef.current.dragging) return;
      const delta = ev.clientX - splitDragRef.current.startX;
      const deltaPct = (delta / splitDragRef.current.containerW) * 100;
      const newPct = Math.min(Math.max(splitDragRef.current.startPct + deltaPct, 20), 80);
      setSplitPercent(newPct);
    };
    const onUp = () => {
      splitDragRef.current.dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [splitPercent]);

  return (
    <div className="tab-editor" ref={containerRef} tabIndex={0}>
      {/* Clipboard toast */}
      {toast && <div className="clipboard-toast">{toast}</div>}

      {/* Tab ribbon */}
      <div className="tab-ribbon">
        {TAB_DEFINITIONS.map((t, i) => (
          <button
            key={t.name}
            className={`tab-btn ${i === activeTab ? 'active' : ''}`}
            onClick={() => {
              if (i !== activeTab) {
                setActiveTab(i);
              }
            }}
          >
            {t.name}
            {(tabCache.current[t.name]?.length ?? 0) > 0 && (
              <span className="tab-count">{tabCache.current[t.name].length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Row actions toolbar */}
      <div className="row-toolbar">
        <button className="btn btn-add" onClick={addRow}>+ Add Row</button>
        <button className="btn btn-delete" onClick={deleteSelectedRows}>Delete Selected</button>
        <button className="btn btn-auto" onClick={autoSizeColumns} title="Auto-size all columns to fit content">↔ Auto-size Columns</button>
        {isFlowsTab && (
          <button
            className={`btn ${showPreview ? 'btn-active' : ''}`}
            onClick={() => {
              if (!showPreview) {
                // Sync flow rows when opening preview
                const api = gridRef.current?.api;
                if (api) {
                  const rows: Record<string, unknown>[] = [];
                  api.forEachNode(node => { if (node.data) rows.push({ ...node.data }); });
                  setFlowRows(rows as FlowRow[]);
                }
              }
              setShowPreview(v => !v);
            }}
            title="Toggle live diagram preview"
            style={showPreview ? { background: '#0071C5', color: '#fff', borderColor: '#0071C5' } : undefined}
          >
            {showPreview ? '✕ Close Preview' : '◉ Diagram Preview'}
          </button>
        )}
        <span className="clipboard-hint">
          Ctrl+C Copy &nbsp;|&nbsp; Ctrl+V Paste &nbsp;|&nbsp; Ctrl+X Cut &nbsp;|&nbsp; Ctrl+A Select All &nbsp;|&nbsp; Del Clear
        </span>
        <span className="touch-hint">
          Long-press cell for row options
        </span>
        <span className="row-info">
          {realRowCount > 0 ? `${realRowCount} rows` : `${DEFAULT_EMPTY_ROWS} empty rows`} in {tab.name}
        </span>
      </div>

      {/* Grid + optional diagram preview split */}
      <div ref={splitContainerRef} style={{ display: 'flex', flex: 1, overflow: 'hidden', gap: 0 }}>
        {/* AG Grid */}
        <div className="grid-container" onContextMenu={handleCellContextMenu}
          onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchMove={handleTouchMove}
          style={showPreview && isFlowsTab ? { flex: `0 0 ${splitPercent}%`, minWidth: 0 } : { flex: 1 }}>
          <AgGridReact
          ref={gridRef}
          theme={excelTheme}
          columnDefs={fullColumns}
          defaultColDef={defaultColDef}
          rowSelection={{ mode: 'multiRow', headerCheckbox: true, enableClickSelection: false }}
          onCellValueChanged={handleCellValueChanged}
          onGridReady={onGridReady}
          singleClickEdit={true}
          stopEditingWhenCellsLoseFocus={true}
          undoRedoCellEditing={true}
          undoRedoCellEditingLimit={20}
          enableCellTextSelection={true}
          loadThemeGoogleFonts={false}
          popupParent={document.body}
        />

        {/* Custom right-click context menu */}
        {ctxMenu && (
          <div
            className="ctx-menu"
            style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 9999 }}
          >
            <button onClick={() => { insertRowAt(ctxMenu.rowIndex, 0); setCtxMenu(null); }}>
              ➕ Insert Row Above
            </button>
            <button onClick={() => { insertRowAt(ctxMenu.rowIndex, 1); setCtxMenu(null); }}>
              ➕ Insert Row Below
            </button>
            <button onClick={() => { clearColumn(ctxMenu.field); setCtxMenu(null); }}>
              {'\ud83d\uddd1\ufe0f'} Clear all &quot;{ctxMenu.field}&quot; values
            </button>
          </div>
        )}
      </div>

        {/* Resize handle between grid and diagram */}
        {showPreview && isFlowsTab && (
          <div className="split-resize-handle" onMouseDown={handleSplitResizeStart} title="Drag to resize grid / diagram" />
        )}

        {/* Diagram preview pane */}
        {showPreview && isFlowsTab && (
          <div style={{ flex: `0 0 ${100 - splitPercent}%`, minWidth: 200, minHeight: 0, overflow: 'hidden' }}>
            <DiagramPreview rows={flowRows} visible={showPreview && isFlowsTab} tower={tower} cap={cap} />
          </div>
        )}
      </div>
    </div>
  );
});

export default memo(TabEditor);
