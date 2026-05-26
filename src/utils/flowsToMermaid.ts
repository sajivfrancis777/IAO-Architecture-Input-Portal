/**
 * flowsToMermaid.ts — Generate Mermaid diagrams matching the published SAD documents.
 *
 * Exact port of mermaid_builder.py ArchiMate-inspired rendering:
 *   Application: 📦 blue boxes, swim lanes, Interface/Technology edge labels
 *   Data:        🗄️ green cylinders for databases, app boxes above, data flow edges
 *   Technology:  🖥️ platform-category colored nodes (cloud/SaaS/on-prem/middleware)
 *
 * ArchiMate 3.2 color conventions:
 *   Business  = Yellow (#FFFFB3)
 *   Application = Azure Blue (#CCE5FF)
 *   Technology = Green (#C8E6C9)
 *   Middleware = Orange (#FFE0B2)
 *   Data = Teal (#B2EBF2)
 *   EOL = Red (#FFCDD2)
 */

import { getIapmUrl } from './iapmLookup';

export interface FlowRow {
  'Flow Chain'?: string;
  'Hop #'?: number | string;
  'Source System'?: string;
  'Source Lane'?: string;
  'Target System'?: string;
  'Target Lane'?: string;
  'Interface / Technology'?: string;
  'Frequency'?: string;
  'Data Description'?: string;
  'Source DB Platform'?: string;
  'Target DB Platform'?: string;
  'Source Tech Platform'?: string;
  'Target Tech Platform'?: string;
  'Integration Pattern'?: string;
  [key: string]: unknown;
}

export type ArchLayer = 'application' | 'data' | 'technology';

// ── Helpers ──────────────────────────────────────────────────

function sanitizeId(prefix: string, name: string): string {
  return `${prefix}_${name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
}

/** Append Mermaid click directives for nodes that have IAPM URLs. */
function appendIapmClicks(lines: string[], nodeIdToName: Map<string, string>): void {
  for (const [nodeId, name] of nodeIdToName) {
    const url = getIapmUrl(name);
    if (url) {
      lines.push(`    click ${nodeId} "${url}" _blank`);
    }
  }
}

function truncate(s: string, max = 28): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

const LANE_ORDER: Record<string, number> = {
  'Business': 0, 'Business Process': 0,
  'Application': 1, 'SAP': 1, 'S/4HANA': 1,
  'Integration': 2, 'Middleware': 2, 'MuleSoft': 2,
  'Data': 3, 'Data Warehouse': 3, 'Snowflake': 3,
  'Technology': 4, 'Infrastructure': 4,
};

function laneSortKey(lane: string): number {
  return LANE_ORDER[lane] ?? 50;
}

// ── ArchiMate 3.2 class definitions (matches mermaid_builder.py) ──

const ARCHIMATE_CLASSDEFS = `
    classDef app           fill:#CCE5FF,stroke:#0078D4,stroke-width:2px,color:#003A6C
    classDef middleware     fill:#FFE0B2,stroke:#E65100,stroke-width:2px,color:#BF360C
    classDef dataEntity    fill:#BBDEFB,stroke:#1565C0,stroke-width:1px,color:#0D47A1,stroke-dasharray:5 3
    classDef eol           fill:#FFCDD2,stroke:#C62828,stroke-width:2px,color:#B71C1C
    classDef dbCyl         fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px,color:#1B5E20
    classDef dbCloud       fill:#BBDEFB,stroke:#0078D4,stroke-width:2px,color:#003A6C
    classDef dbData        fill:#B2EBF2,stroke:#00838F,stroke-width:2px,color:#004D40
    classDef saas          fill:#E1BEE7,stroke:#7B1FA2,stroke-width:2px,color:#4A148C
    classDef cloud         fill:#BBDEFB,stroke:#1565C0,stroke-width:2px,color:#0D47A1
    classDef onprem        fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px,color:#1B5E20
    classDef platMw        fill:#FFE0B2,stroke:#E65100,stroke-width:2px,color:#BF360C`;

// ── Lane subgraph colors ──

const LANE_COLORS: [string, string][] = [
  ['fill:#E3F2FD', 'stroke:#0078D4'],   // Azure blue
  ['fill:#E8F5E9', 'stroke:#2E7D32'],   // Green
  ['fill:#FFFDE7', 'stroke:#F9A825'],   // Yellow
  ['fill:#FCE4EC', 'stroke:#C62828'],   // Red
  ['fill:#F3E5F5', 'stroke:#7B1FA2'],   // Purple
  ['fill:#E0F7FA', 'stroke:#00ACC1'],   // Cyan
  ['fill:#FFF3E0', 'stroke:#FF9800'],   // Orange
];

// ── Platform classification (matches _classify_platform in Python) ──

const PLATFORM_CATEGORIES: [string, string[]][] = [
  ['cloud',      ['azure', 'aws', 'gcp', 'google cloud', 'btp']],
  ['saas',       ['saas', 'salesforce', 'servicenow', 'workday', 'ariba', 'concur', 'successfactors', 'anypoint']],
  ['data',       ['snowflake', 'databricks', 'data lake', 'delta lake', 'redshift', 'bigquery', 'teradata', 'hana db', 'sidecar']],
  ['middleware', ['mulesoft', 'apigee', 'sap po', 'sap pi', 'biztalk', 'kafka', 'tibco', 'webmethods', 'integration']],
  ['onprem',     ['on-prem', 'on_prem', 'hec']],
];

function classifyPlatform(label: string): string {
  const low = label.toLowerCase();
  for (const [cat, keywords] of PLATFORM_CATEGORIES) {
    if (keywords.some(k => low.includes(k))) return cat;
  }
  return 'onprem';
}

function classifyDb(label: string): string {
  const low = label.toLowerCase();
  if (['azure', 'aws', 'gcp', 'cosmosdb', 'dynamodb', 'rds'].some(k => low.includes(k))) return 'cloud';
  if (['snowflake', 'databricks', 'delta', 'bigquery', 'redshift'].some(k => low.includes(k))) return 'data';
  return 'onprem';
}

// ── Mermaid init header (matches Python) ──

const MERMAID_INIT = '%%{init: {"theme": "base", ' +
  '"themeVariables": {"fontSize": "18px", "fontFamily": "Segoe UI, Arial, sans-serif"}, ' +
  '"flowchart": {"useMaxWidth": true, "htmlLabels": true, "nodeSpacing": 50, "rankSpacing": 60}} }%%';

// ═══════════════════════════════════════════════════════════════
// APPLICATION ARCHITECTURE
// ═══════════════════════════════════════════════════════════════

function buildApplicationDiagram(rows: FlowRow[], prefix: string): string {
  interface AppNode { id: string; name: string; lane: string; }
  const apps = new Map<string, AppNode>();
  const edges: { src: string; tgt: string; label: string }[] = [];
  const lanes = new Map<string, string[]>();

  for (const row of rows) {
    const src = String(row['Source System'] ?? '').trim();
    const tgt = String(row['Target System'] ?? '').trim();
    if (!src || !tgt) continue;

    const srcLane = String(row['Source Lane'] ?? 'Other').trim() || 'Other';
    const tgtLane = String(row['Target Lane'] ?? 'Other').trim() || 'Other';
    const tech = String(row['Interface / Technology'] ?? '').trim();

    const srcId = sanitizeId(prefix, src);
    const tgtId = sanitizeId(prefix, tgt);

    if (!apps.has(srcId)) {
      apps.set(srcId, { id: srcId, name: src, lane: srcLane });
      lanes.set(srcLane, [...(lanes.get(srcLane) ?? []), srcId]);
    }
    if (!apps.has(tgtId)) {
      apps.set(tgtId, { id: tgtId, name: tgt, lane: tgtLane });
      lanes.set(tgtLane, [...(lanes.get(tgtLane) ?? []), tgtId]);
    }

    edges.push({ src: srcId, tgt: tgtId, label: tech ? truncate(tech) : '' });
  }

  if (apps.size === 0) return '';

  const lines: string[] = [MERMAID_INIT, 'flowchart TB', ARCHIMATE_CLASSDEFS, ''];

  // Swim lanes
  const sortedLanes = [...lanes.keys()].sort((a, b) => laneSortKey(a) - laneSortKey(b));
  const laneStyles: { id: string; fill: string; stroke: string }[] = [];

  for (let i = 0; i < sortedLanes.length; i++) {
    const lane = sortedLanes[i];
    const sgId = sanitizeId(prefix + '_LN', lane);
    const [fill, stroke] = LANE_COLORS[i % LANE_COLORS.length];
    laneStyles.push({ id: sgId, fill, stroke });

    lines.push(`    subgraph ${sgId}[" ${lane}"]`);
    lines.push(`        direction LR`);
    for (const nid of [...new Set(lanes.get(lane)!)].sort()) {
      const app = apps.get(nid)!;
      // 📦 box shape — matches Python: {nid}["📦 {name}"]:::app
      lines.push(`        ${nid}["📦 ${app.name}"]:::app`);
    }
    lines.push('    end');
    lines.push('');
  }

  // Edges
  const seen = new Set<string>();
  for (const e of edges) {
    const key = `${e.src}|${e.tgt}|${e.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(e.label ? `    ${e.src} -->|"${e.label}"| ${e.tgt}` : `    ${e.src} --> ${e.tgt}`);
  }
  lines.push('');

  // Legend (matches Python)
  lines.push('    subgraph Legend["📐 LEGEND"]');
  lines.push('        direction LR');
  lines.push('        L_APP["📦 Application"]:::app');
  lines.push('        L_MW["🔗 Middleware"]:::middleware');
  lines.push('        L_EOL["⛔ End-of-Life"]:::eol');
  lines.push('    end');
  lines.push('    style Legend fill:#F5F5F5,stroke:#999,stroke-width:1px');
  lines.push('');

  // Lane styles
  for (const { id, fill, stroke } of laneStyles) {
    lines.push(`    style ${id} ${fill},${stroke},stroke-width:2px`);
  }

  // IAPM clickable links
  const nodeNames = new Map<string, string>();
  for (const [nid, app] of apps) nodeNames.set(nid, app.name);
  appendIapmClicks(lines, nodeNames);

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// DATA ARCHITECTURE — DB cylinders with app boxes above
// ═══════════════════════════════════════════════════════════════

function buildDataDiagram(rows: FlowRow[], prefix: string): string {
  interface AppInfo { id: string; name: string; }
  const apps = new Map<string, AppInfo>();
  const dbs = new Map<string, string>();        // db_nid → db_label
  const appToDb = new Map<string, string>();     // app_nid → db_nid
  const dbEdges: { src: string; tgt: string; label: string }[] = [];

  for (const row of rows) {
    const srcSys = String(row['Source System'] ?? '').trim();
    const tgtSys = String(row['Target System'] ?? '').trim();
    if (!srcSys || !tgtSys) continue;

    const srcDb = String(row['Source DB Platform'] ?? '').trim();
    const tgtDb = String(row['Target DB Platform'] ?? '').trim();
    const tech = String(row['Interface / Technology'] ?? '').trim();

    const srcAppId = sanitizeId(prefix + 'A', srcSys);
    const tgtAppId = sanitizeId(prefix + 'A', tgtSys);

    if (!apps.has(srcAppId)) apps.set(srcAppId, { id: srcAppId, name: srcSys });
    if (!apps.has(tgtAppId)) apps.set(tgtAppId, { id: tgtAppId, name: tgtSys });

    // Register databases
    if (srcDb) {
      const srcDbId = sanitizeId(prefix + 'D', srcDb);
      if (!dbs.has(srcDbId)) dbs.set(srcDbId, srcDb);
      appToDb.set(srcAppId, srcDbId);
    }
    if (tgtDb) {
      const tgtDbId = sanitizeId(prefix + 'D', tgtDb);
      if (!dbs.has(tgtDbId)) dbs.set(tgtDbId, tgtDb);
      appToDb.set(tgtAppId, tgtDbId);
    }

    // DB-to-DB edge
    if (srcDb && tgtDb) {
      const srcDbId = sanitizeId(prefix + 'D', srcDb);
      const tgtDbId = sanitizeId(prefix + 'D', tgtDb);
      if (srcDbId !== tgtDbId) {
        dbEdges.push({ src: srcDbId, tgt: tgtDbId, label: tech ? truncate(tech) : '' });
      }
    }
  }

  if (dbs.size === 0) return '';

  const lines: string[] = [MERMAID_INIT, 'flowchart TB', ARCHIMATE_CLASSDEFS, ''];

  // Group apps by DB
  const dbToApps = new Map<string, string[]>();
  for (const [appId, dbId] of appToDb) {
    dbToApps.set(dbId, [...(dbToApps.get(dbId) ?? []), appId]);
  }

  // Render each DB cluster: app(s) above → DB cylinder below
  let i = 0;
  for (const [dbId, dbLabel] of [...dbs].sort()) {
    const clusterApps = [...new Set(dbToApps.get(dbId) ?? [])].sort();
    const sgId = sanitizeId(prefix + 'CL', dbLabel);
    const dbCat = classifyDb(dbLabel);
    const dbCls = dbCat === 'cloud' ? 'dbCloud' : dbCat === 'data' ? 'dbData' : 'dbCyl';

    lines.push(`    subgraph ${sgId}[" "]`);
    lines.push(`        direction TB`);
    // App boxes above
    for (const appId of clusterApps) {
      const app = apps.get(appId);
      if (app) lines.push(`        ${appId}["📦 ${app.name}"]:::app`);
    }
    // DB CYLINDER — the key shape: [(  )] = cylinder in Mermaid
    lines.push(`        ${dbId}[("🗄️ ${dbLabel}")]:::${dbCls}`);
    // App → DB realization links (dashed)
    for (const appId of clusterApps) {
      lines.push(`        ${appId} -.-> ${dbId}`);
    }
    lines.push('    end');
    const [fill, stroke] = LANE_COLORS[i % LANE_COLORS.length];
    lines.push(`    style ${sgId} ${fill},${stroke},stroke-width:1px`);
    lines.push('');
    i++;
  }

  // DB-to-DB data flow edges
  const seen = new Set<string>();
  for (const e of dbEdges) {
    const key = `${e.src}|${e.tgt}|${e.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(e.label ? `    ${e.src} ==>|"${e.label}"| ${e.tgt}` : `    ${e.src} ==> ${e.tgt}`);
  }
  lines.push('');

  // Legend
  lines.push('    subgraph Legend["📐 LEGEND"]');
  lines.push('        direction LR');
  lines.push('        L_APP["📦 Application"]:::app');
  lines.push('        L_DB[("🗄️ Database")]:::dbCyl');
  lines.push('        L_CDB[("☁️ Cloud DB")]:::dbCloud');
  lines.push('    end');
  lines.push('    style Legend fill:#F5F5F5,stroke:#999,stroke-width:1px');

  // IAPM clickable links (app nodes in data diagram)
  const appNodeNames = new Map<string, string>();
  for (const [nid, app] of apps) appNodeNames.set(nid, app.name);
  appendIapmClicks(lines, appNodeNames);

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// TECHNOLOGY ARCHITECTURE — platform-category colored nodes
// ═══════════════════════════════════════════════════════════════

function buildTechnologyDiagram(rows: FlowRow[], prefix: string): string {
  interface PlatNode { id: string; name: string; category: string; lane: string; }
  const platforms = new Map<string, PlatNode>();
  const edges: { src: string; tgt: string; label: string }[] = [];
  const lanes = new Map<string, string[]>();

  for (const row of rows) {
    const srcPlat = String(row['Source Tech Platform'] ?? '').trim();
    const tgtPlat = String(row['Target Tech Platform'] ?? '').trim();
    if (!srcPlat || !tgtPlat) continue;

    const srcLane = String(row['Source Lane'] ?? '').trim() || String(row['Flow Chain'] ?? 'Other').trim() || 'Other';
    const tgtLane = String(row['Target Lane'] ?? '').trim() || String(row['Flow Chain'] ?? 'Other').trim() || 'Other';
    const pattern = String(row['Integration Pattern'] ?? '').trim();

    const srcId = sanitizeId(prefix, srcPlat);
    const tgtId = sanitizeId(prefix, tgtPlat);

    if (!platforms.has(srcId)) {
      const cat = classifyPlatform(srcPlat);
      platforms.set(srcId, { id: srcId, name: srcPlat, category: cat, lane: srcLane });
      lanes.set(srcLane, [...(lanes.get(srcLane) ?? []), srcId]);
    }
    if (!platforms.has(tgtId)) {
      const cat = classifyPlatform(tgtPlat);
      platforms.set(tgtId, { id: tgtId, name: tgtPlat, category: cat, lane: tgtLane });
      lanes.set(tgtLane, [...(lanes.get(tgtLane) ?? []), tgtId]);
    }

    edges.push({ src: srcId, tgt: tgtId, label: pattern ? truncate(pattern) : '' });
  }

  if (platforms.size === 0) return '';

  const lines: string[] = [MERMAID_INIT, 'flowchart TB', ARCHIMATE_CLASSDEFS, ''];

  // Platform-category → classDef mapping
  const catToClass: Record<string, string> = {
    cloud: 'cloud', saas: 'saas', data: 'dbData', middleware: 'platMw', onprem: 'onprem',
  };

  // Swim lanes
  const sortedLanes = [...lanes.keys()].sort((a, b) => laneSortKey(a) - laneSortKey(b));
  const laneStyles: { id: string; fill: string; stroke: string }[] = [];

  for (let i = 0; i < sortedLanes.length; i++) {
    const lane = sortedLanes[i];
    const sgId = sanitizeId(prefix + '_LN', lane);
    const [fill, stroke] = LANE_COLORS[i % LANE_COLORS.length];
    laneStyles.push({ id: sgId, fill, stroke });

    lines.push(`    subgraph ${sgId}[" ${lane}"]`);
    lines.push(`        direction LR`);
    for (const nid of [...new Set(lanes.get(lane)!)].sort()) {
      const plat = platforms.get(nid)!;
      const cls = catToClass[plat.category] ?? 'onprem';
      const emoji = plat.category === 'cloud' ? '☁️' : plat.category === 'saas' ? '🌐' :
                    plat.category === 'middleware' ? '🔗' : '🖥️';
      lines.push(`        ${nid}["${emoji} ${plat.name}"]:::${cls}`);
    }
    lines.push('    end');
    lines.push('');
  }

  // Edges
  const seen = new Set<string>();
  for (const e of edges) {
    const key = `${e.src}|${e.tgt}|${e.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(e.label ? `    ${e.src} -->|"${e.label}"| ${e.tgt}` : `    ${e.src} --> ${e.tgt}`);
  }
  lines.push('');

  // Legend
  lines.push('    subgraph Legend["📐 LEGEND"]');
  lines.push('        direction LR');
  lines.push('        L_OP["🖥️ On-Prem"]:::onprem');
  lines.push('        L_CL["☁️ Cloud"]:::cloud');
  lines.push('        L_SA["🌐 SaaS"]:::saas');
  lines.push('        L_MW["🔗 Middleware"]:::platMw');
  lines.push('    end');
  lines.push('    style Legend fill:#F5F5F5,stroke:#999,stroke-width:1px');
  lines.push('');

  // Lane styles
  for (const { id, fill, stroke } of laneStyles) {
    lines.push(`    style ${id} ${fill},${stroke},stroke-width:2px`);
  }

  // IAPM clickable links (platform nodes)
  const platNames = new Map<string, string>();
  for (const [nid, plat] of platforms) platNames.set(nid, plat.name);
  appendIapmClicks(lines, platNames);

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

export function flowsToMermaid(rows: FlowRow[], layer: ArchLayer = 'application', prefix = 'FW'): string {
  switch (layer) {
    case 'application': return buildApplicationDiagram(rows, prefix);
    case 'data':        return buildDataDiagram(rows, prefix);
    case 'technology':  return buildTechnologyDiagram(rows, prefix);
  }
}
