/**
 * AG Grid column definitions for all tabs.
 * Flows tab uses simplified 14-column layout — enrichment fills the rest.
 */
import type { ColDef, ColGroupDef, ValueSetterParams } from 'ag-grid-community';
import AutocompleteCellEditor from './AutocompleteCellEditor';
import DropdownEditor from './DropdownEditor';
import { ALL_SYSTEMS, DB_OPTIONS, PLATFORM_OPTIONS } from '../data/systemRegistry';
import { getPlatformDefaults } from '../utils/platformLookup';

// ─── Reusable cell editors ───────────────────────────────────────
const FREQUENCY_VALUES = ['Real-Time', 'Near Real-Time', 'Hourly', 'Daily', 'Weekly', 'Monthly', 'On-Demand', 'Batch'];
const PRIORITY_VALUES = ['Critical', 'High', 'Medium', 'Low'];
const STATUS_VALUES = ['Open', 'In Progress', 'Completed', 'Blocked', 'Deferred'];

// Simplified Flows dropdowns (14-column input — enrichment script fills the rest)
const INTERFACE_VALUES = ['IDoc', 'RFC', 'BAPI', 'REST API', 'OData', 'SOAP', 'SFTP', 'File', 'CPI', 'PI/PO', 'MuleSoft', 'Kafka', 'DB Link', 'Manual', 'Other'];
const CONFIDENCE_VALUES = ['High', 'Medium', 'Low'];
const LANE_VALUES = ['SAP', 'S/4HANA', 'Integration', 'MuleSoft', 'Data', 'Snowflake', 'Data Warehouse', 'Application', 'Business', 'Technology', 'Infrastructure', 'Other'];
const DB_PLATFORM_VALUES = DB_OPTIONS;
const TECH_PLATFORM_VALUES = PLATFORM_OPTIONS;
const INTEGRATION_PATTERN_VALUES = ['Point-to-Point', 'Hub-Spoke', 'Publish-Subscribe', 'Batch File', 'API Gateway', 'Database Link'];

/**
 * Auto-fill helper: when Source/Target System is selected and the DB Platform
 * and Tech Platform cells are still empty, pre-fill them from SYSTEM_DEFAULTS
 * or the remote IAPM platform cache (12K+ systems).
 */
function systemAutoFillSetter(dbField: string, platField: string) {
  return (params: ValueSetterParams) => {
    const field = params.colDef.field;
    if (!field) return false;
    params.data[field] = params.newValue;
    const sys = String(params.newValue || '');
    const defaults = getPlatformDefaults(sys);
    if (defaults) {
      // Always overwrite DB/Platform when system name changes — canonical data wins
      if (defaults.db) params.data[dbField] = defaults.db;
      if (defaults.platform) params.data[platField] = defaults.platform;
    }
    // Refresh auto-filled neighbor cells so the UI shows new values immediately
    if (defaults && params.api) {
      const cols = [dbField, platField];
      setTimeout(() => params.api.refreshCells({ columns: cols }), 0);
    }
    return true;
  };
}


/** Dropdown editor using props.onValueChange() — the AG Grid-correct pattern. */
function selectEditor(values: string[]): Partial<ColDef> {
  return {
    cellEditor: DropdownEditor,
    cellEditorParams: { values },
  };
}

/** Numeric column: coerce string values from SheetJS to numbers on display. */
function numericCol(): Partial<ColDef> {
  return {
    valueFormatter: (p) => {
      if (p.value == null || p.value === '') return '';
      const n = Number(p.value);
      return isNaN(n) ? String(p.value) : String(n);
    },
    valueParser: (p) => {
      if (p.newValue == null || p.newValue === '') return null;
      const n = Number(p.newValue);
      return isNaN(n) ? p.newValue : n;
    },
  };
}

/** Column that contains long-form text — wraps and auto-sizes row height.
 *  Uses default inline text editor (agLargeTextCellEditor is broken with
 *  AG Grid 32.x modular imports — renders as blank popup). */
function textCol(width = 350): Partial<ColDef> {
  return {
    width,
    wrapText: true,
    autoHeight: true,
    cellEditorParams: { maxLength: 2000 },
    cellStyle: { whiteSpace: 'normal', lineHeight: '1.4', paddingTop: '6px', paddingBottom: '6px' },
  };
}

const defaultColDef: ColDef = {
  editable: true,
  resizable: true,
  sortable: true,
  filter: true,
  minWidth: 60,
  wrapHeaderText: true,
  autoHeaderHeight: true,
};

// ─── Tab 1: Flows (14 simplified columns — enrichment fills the rest) ──
const flowsColumns: (ColDef | ColGroupDef)[] = [
  {
    headerName: 'Flow Identification',
    marryChildren: true,
    children: [
      { field: 'Flow Chain', width: 200 },
      { field: 'Hop #', width: 80, ...numericCol() },
    ],
  },
  {
    headerName: 'Application Architecture',
    marryChildren: true,
    children: [
      // AutocompleteCellEditor with isPopup()=true prevents stopEditingWhenCellsLoseFocus race
      { field: 'Source System', width: 240, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: ALL_SYSTEMS }, valueSetter: systemAutoFillSetter('Source DB Platform', 'Source Tech Platform') },
      { field: 'Source Lane', width: 160, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: LANE_VALUES } },
      { field: 'Target System', width: 240, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: ALL_SYSTEMS }, valueSetter: systemAutoFillSetter('Target DB Platform', 'Target Tech Platform') },
      { field: 'Target Lane', width: 160, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: LANE_VALUES } },
      { field: 'Interface / Technology', width: 220, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: INTERFACE_VALUES } },
      { field: 'Frequency', width: 180, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: FREQUENCY_VALUES } },
      { field: 'Data Description', width: 280 },
    ],
  },
  {
    headerName: 'Data Architecture',
    marryChildren: true,
    children: [
      { field: 'Source DB Platform', width: 200, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: DB_PLATFORM_VALUES } },
      { field: 'Target DB Platform', width: 200, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: DB_PLATFORM_VALUES } },
    ],
  },
  {
    headerName: 'Technology Architecture (optional — auto-filled if blank)',
    marryChildren: true,
    children: [
      { field: 'Source Tech Platform', width: 220, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: TECH_PLATFORM_VALUES } },
      { field: 'Target Tech Platform', width: 220, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: TECH_PLATFORM_VALUES } },
      { field: 'Integration Pattern', width: 200, cellEditor: AutocompleteCellEditor, cellEditorParams: { values: INTEGRATION_PATTERN_VALUES } },
    ],
  },
  {
    field: 'Confidence',
    width: 130,
    ...selectEditor(CONFIDENCE_VALUES),
    cellStyle: (params) => {
      const v = String(params.value || '').toLowerCase();
      if (v === 'high') return { backgroundColor: '#e6f4ea', color: '#1e7e34' };
      if (v === 'medium') return { backgroundColor: '#fff8e1', color: '#b8860b' };
      if (v === 'low') return { backgroundColor: '#fce4ec', color: '#c62828' };
      return null;
    },
  },
];

// ─── Tab 2: Business Drivers ─────────────────────────────────────
const businessDriversColumns: ColDef[] = [
  { field: 'Driver #', width: 90, ...numericCol() },
  { field: 'Driver Name', width: 220 },
  { field: 'Description', ...textCol(400) },
  { field: 'Strategic Alignment', ...textCol(280) },
  { field: 'Priority', width: 160, ...selectEditor(PRIORITY_VALUES) },
];

// ─── Tab 3: Success Criteria ─────────────────────────────────────
const successCriteriaColumns: ColDef[] = [
  { field: 'Metric', ...textCol(220) },
  { field: 'Target', ...textCol(180) },
  { field: 'Measure', ...textCol(220) },
  { field: 'Baseline', ...textCol(180) },
  { field: 'Owner', width: 180 },
];



// ─── Tab 5: NFRs ─────────────────────────────────────────────────
const nfrsColumns: ColDef[] = [
  { field: 'Category', width: 160 },
  { field: 'Requirement', ...textCol(350) },
  { field: 'Target / SLA', width: 180 },
  { field: 'Priority', width: 160, ...selectEditor(PRIORITY_VALUES) },
  { field: 'Notes', ...textCol(280) },
];

// ─── Tab 6: Security Controls ────────────────────────────────────
const securityColumns: ColDef[] = [
  { field: 'Concern', width: 180 },
  { field: 'Approach', ...textCol(320) },
  { field: 'Standard / Policy', width: 220 },
  { field: 'Owner', width: 180 },
  { field: 'Notes', ...textCol(280) },
];



// ─── Tab 8: Recommendations ─────────────────────────────────────
const recommendationsColumns: ColDef[] = [
  { field: '#', width: 60, ...numericCol() },
  { field: 'Category', width: 160 },
  { field: 'Recommendation', ...textCol(400) },
  { field: 'Priority', width: 160, ...selectEditor(PRIORITY_VALUES) },
  { field: 'Owner', width: 180 },
  { field: 'Target Date', width: 130 },
  { field: 'Status', width: 160, ...selectEditor(STATUS_VALUES) },
];

// ─── Exports ─────────────────────────────────────────────────────

export interface TabDefinition {
  name: string;
  columns: (ColDef | ColGroupDef)[];
}

export const TAB_DEFINITIONS: TabDefinition[] = [
  { name: 'Flows', columns: flowsColumns },
  { name: 'Business Drivers', columns: businessDriversColumns },
  { name: 'Success Criteria', columns: successCriteriaColumns },
  { name: 'NFRs', columns: nfrsColumns },
  { name: 'Security Controls', columns: securityColumns },
  { name: 'Recommendations', columns: recommendationsColumns },
];

export { defaultColDef };
