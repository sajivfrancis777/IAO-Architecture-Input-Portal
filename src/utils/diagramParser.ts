/**
 * Diagram Parser — client-side extraction of integration hops from
 * architecture diagram files.
 *
 * Supported formats:
 *   - Draw.io / diagrams.net (.drawio, .xml) — plain XML
 *   - BPMN 2.0 (.bpmn) — XML with sequenceFlow
 *   - ArchiMate Open Exchange (.xml) — relationships with source/target
 *   - Visio (.vsdx) — ZIP/XML, parsed via JSZip in browser
 *
 * Each parser extracts a directed graph (nodes + edges), then DFS
 * traversal produces flattened hop rows matching the AG Grid Flows schema.
 *
 * Multi-tab support: diagrams with multiple pages/tabs produce separate
 * HopSheet entries, each mapped to a release + state via tab name regex.
 */

// ── Types ─────────────────────────────────────────────────────

export interface HopRow {
  'Flow Chain': string;
  'Hop #': number;
  'Source System': string;
  'Target System': string;
  'Interface / Technology': string;
  'Frequency': string;
  'Data Description': string;
}

export interface HopSheet {
  tabName: string;          // original diagram tab/page name
  release: string;          // parsed release (R1, R2, R3, R4, All)
  state: string;            // parsed state (Current, Future)
  hops: HopRow[];
}

export interface ParseResult {
  ok: boolean;
  format: string;
  sheets: HopSheet[];
  totalChains: number;
  totalHops: number;
  error?: string;
}

interface GraphNode {
  id: string;
  label: string;
}

interface GraphEdge {
  source: string;
  target: string;
  label: string;
}

interface DiagramPage {
  name: string;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

// ── Release / State detection from tab names ──────────────────

// Release detection — ordered so more-specific patterns match first.
// Sub-releases (R1.1, R1.2) map to their parent release.
// Patterns cover: R1, Release 1, Rel 1, Rel-1, Rel.1, Wave 1, W1,
//   Phase 1, Ph1, Cutover 1, Go-Live 1, GL1, Sprint 1, and R5–R9.
const RELEASE_PATTERNS: [RegExp, string][] = [
  // ADA canonical tab names: R1_CurrentFlows, R1_FutureFlows, etc.
  [/\bR1_/i, 'R1'], [/\bR2_/i, 'R2'], [/\bR3_/i, 'R3'],
  [/\bR4_/i, 'R4'], [/\bR5_/i, 'R5'],
  // Sub-releases → parent (must come before Rn)
  [/\bR1[._]\d\b/i, 'R1'], [/\bR2[._]\d\b/i, 'R2'],
  [/\bR3[._]\d\b/i, 'R3'], [/\bR4[._]\d\b/i, 'R4'],
  // Canonical: R1–R9 and long-form variations
  [/\bR1\b/i, 'R1'], [/\bRelease[\s._-]*1\b/i, 'R1'], [/\bRel[\s._-]*1\b/i, 'R1'],
  [/\bR2\b/i, 'R2'], [/\bRelease[\s._-]*2\b/i, 'R2'], [/\bRel[\s._-]*2\b/i, 'R2'],
  [/\bR3\b/i, 'R3'], [/\bRelease[\s._-]*3\b/i, 'R3'], [/\bRel[\s._-]*3\b/i, 'R3'],
  [/\bR4\b/i, 'R4'], [/\bRelease[\s._-]*4\b/i, 'R4'], [/\bRel[\s._-]*4\b/i, 'R4'],
  [/\bR5\b/i, 'R5'], [/\bRelease[\s._-]*5\b/i, 'R5'], [/\bRel[\s._-]*5\b/i, 'R5'],
  [/\bR6\b/i, 'R6'], [/\bRelease[\s._-]*6\b/i, 'R6'],
  [/\bR7\b/i, 'R7'], [/\bRelease[\s._-]*7\b/i, 'R7'],
  [/\bR8\b/i, 'R8'], [/\bRelease[\s._-]*8\b/i, 'R8'],
  [/\bR9\b/i, 'R9'], [/\bRelease[\s._-]*9\b/i, 'R9'],
  // Alternative naming: Wave, Phase, Cutover, Go-Live, Sprint
  [/\bWave[\s._-]*1\b/i, 'R1'], [/\bW1\b/i, 'R1'],
  [/\bWave[\s._-]*2\b/i, 'R2'], [/\bW2\b/i, 'R2'],
  [/\bWave[\s._-]*3\b/i, 'R3'], [/\bW3\b/i, 'R3'],
  [/\bWave[\s._-]*4\b/i, 'R4'], [/\bW4\b/i, 'R4'],
  [/\bPhase[\s._-]*1\b/i, 'R1'], [/\bPh[\s._-]*1\b/i, 'R1'],
  [/\bPhase[\s._-]*2\b/i, 'R2'], [/\bPh[\s._-]*2\b/i, 'R2'],
  [/\bPhase[\s._-]*3\b/i, 'R3'], [/\bPh[\s._-]*3\b/i, 'R3'],
  [/\bPhase[\s._-]*4\b/i, 'R4'], [/\bPh[\s._-]*4\b/i, 'R4'],
  [/\bCutover[\s._-]*1\b/i, 'R1'], [/\bCutover[\s._-]*2\b/i, 'R2'],
  [/\bCutover[\s._-]*3\b/i, 'R3'], [/\bCutover[\s._-]*4\b/i, 'R4'],
  [/\bGo[\s-]?Live[\s._-]*1\b/i, 'R1'], [/\bGL[\s._-]*1\b/i, 'R1'],
  [/\bGo[\s-]?Live[\s._-]*2\b/i, 'R2'], [/\bGL[\s._-]*2\b/i, 'R2'],
  [/\bGo[\s-]?Live[\s._-]*3\b/i, 'R3'], [/\bGL[\s._-]*3\b/i, 'R3'],
  [/\bGo[\s-]?Live[\s._-]*4\b/i, 'R4'], [/\bGL[\s._-]*4\b/i, 'R4'],
  [/\bSprint[\s._-]*1\b/i, 'R1'], [/\bSprint[\s._-]*2\b/i, 'R2'],
  [/\bSprint[\s._-]*3\b/i, 'R3'], [/\bSprint[\s._-]*4\b/i, 'R4'],
  // Early-phase labels
  [/\bPOC\b/i, 'R1'], [/\bPilot\b/i, 'R1'], [/\bMVP\b/i, 'R1'],
];

// State detection — Future vs Current (default: Current)
// ADA canonical names (FutureFlows, CurrentFlows) checked first.
const STATE_PATTERNS: [RegExp, string][] = [
  [/FutureFlows/i, 'Future'],
  [/CurrentFlows/i, 'Current'],
  [/\bfuture[\s-]?state\b/i, 'Future'],
  [/\bfuture\b/i, 'Future'],
  [/\bto[\s-]?be\b/i, 'Future'],
  [/\btarget[\s-]?state\b/i, 'Future'],
  [/\btarget\b/i, 'Future'],
  [/\bproposed\b/i, 'Future'],
  [/\bplanned\b/i, 'Future'],
  [/\bin[\s-]?design\b/i, 'Future'],
  [/\bdraft\b/i, 'Future'],
  [/\bcurrent[\s-]?state\b/i, 'Current'],
  [/\bcurrent\b/i, 'Current'],
  [/\bas[\s-]?is\b/i, 'Current'],
  [/\bbaseline\b/i, 'Current'],
  [/\bexisting\b/i, 'Current'],
  [/\blegacy\b/i, 'Current'],
  [/\bpre[\s-]?migration\b/i, 'Current'],
  [/\bdelta\b/i, 'Future'],
  [/\bincremental\b/i, 'Future'],
];

function detectReleaseState(tabName: string): { release: string; state: string } {
  let release = 'All';
  let state = 'Current';
  for (const [re, val] of RELEASE_PATTERNS) {
    if (re.test(tabName)) { release = val; break; }
  }
  for (const [re, val] of STATE_PATTERNS) {
    if (re.test(tabName)) { state = val; break; }
  }
  return { release, state };
}

// ── Graph → Hop Rows (DFS chain extraction) ──────────────────

function graphToHops(pages: DiagramPage[]): HopSheet[] {
  const sheets: HopSheet[] = [];

  for (const page of pages) {
    const { release, state } = detectReleaseState(page.name);

    // Build adjacency list
    const adj = new Map<string, GraphEdge[]>();
    const hasIncoming = new Set<string>();
    for (const edge of page.edges) {
      if (!adj.has(edge.source)) adj.set(edge.source, []);
      adj.get(edge.source)!.push(edge);
      hasIncoming.add(edge.target);
    }

    // Find root nodes (no incoming edges, but have outgoing)
    const roots: string[] = [];
    for (const nodeId of adj.keys()) {
      if (!hasIncoming.has(nodeId)) roots.push(nodeId);
    }

    // Also add isolated edges where source has no other connections
    if (roots.length === 0 && page.edges.length > 0) {
      // Fallback: use all sources that appear first
      const seen = new Set<string>();
      for (const edge of page.edges) {
        if (!seen.has(edge.source)) {
          roots.push(edge.source);
          seen.add(edge.source);
        }
      }
    }

    const hops: HopRow[] = [];
    let chainId = 0;

    // DFS from each root
    for (const root of roots) {
      const visited = new Set<string>();
      const stack: { nodeId: string; path: { nodeId: string; edgeLabel: string }[] }[] = [
        { nodeId: root, path: [] },
      ];

      while (stack.length > 0) {
        const { nodeId, path } = stack.pop()!;
        const edges = adj.get(nodeId) || [];

        if (edges.length === 0 && path.length > 0) {
          // Leaf node — emit the chain
          chainId++;
          for (let i = 0; i < path.length; i++) {
            const src = i === 0
              ? page.nodes.get(root)?.label || root
              : page.nodes.get(path[i - 1].nodeId)?.label || path[i - 1].nodeId;
            const tgt = page.nodes.get(path[i].nodeId)?.label || path[i].nodeId;
            hops.push({
              'Flow Chain': `Chain-${chainId}`,
              'Hop #': i + 1,
              'Source System': src,
              'Target System': tgt,
              'Interface / Technology': path[i].edgeLabel || '',
              'Frequency': '',
              'Data Description': '',
            });
          }
          continue;
        }

        for (const edge of edges) {
          if (visited.has(`${nodeId}->${edge.target}`)) continue;
          visited.add(`${nodeId}->${edge.target}`);
          stack.push({
            nodeId: edge.target,
            path: [...path, { nodeId: edge.target, edgeLabel: edge.label }],
          });
        }
      }

      // Handle single-hop chains (edges from root with no further connections)
      if (chainId === 0 && page.edges.length > 0) {
        // Simple edge-by-edge extraction
        chainId++;
        let hopNum = 0;
        for (const edge of page.edges) {
          hopNum++;
          const src = page.nodes.get(edge.source)?.label || edge.source;
          const tgt = page.nodes.get(edge.target)?.label || edge.target;
          hops.push({
            'Flow Chain': `Chain-${chainId}`,
            'Hop #': hopNum,
            'Source System': src,
            'Target System': tgt,
            'Interface / Technology': edge.label || '',
            'Frequency': '',
            'Data Description': '',
          });
        }
      }
    }

    if (hops.length > 0) {
      sheets.push({ tabName: page.name, release, state, hops });
    }
  }

  return sheets;
}

// ── Draw.io / diagrams.net Parser ─────────────────────────────

function parseDrawio(xml: string): DiagramPage[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const pages: DiagramPage[] = [];

  // Draw.io structure: <mxfile> → <diagram name="..."> → <mxGraphModel> → <root> → <mxCell>
  const diagrams = doc.querySelectorAll('diagram');
  // If no <diagram> tags, treat the whole doc as a single page
  const containers = diagrams.length > 0
    ? Array.from(diagrams)
    : [doc.documentElement];

  for (const container of containers) {
    const pageName = container.getAttribute('name') || 'Page 1';
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    const cells = container.querySelectorAll('mxCell');
    for (const cell of Array.from(cells)) {
      const id = cell.getAttribute('id') || '';
      const source = cell.getAttribute('source');
      const target = cell.getAttribute('target');
      const value = cell.getAttribute('value') || '';
      const label = stripHtml(value);

      if (source && target) {
        // Edge
        edges.push({ source, target, label });
      } else if (id && label && !source && !target) {
        // Node (has a label, no source/target)
        const style = cell.getAttribute('style') || '';
        // Skip pure text labels and styles that are just formatting
        if (!style.includes('text;') && !style.includes('edgeLabel')) {
          nodes.set(id, { id, label });
        }
      }
    }

    // Also check <object> elements (draw.io uses these for custom shapes)
    const objects = container.querySelectorAll('object');
    for (const obj of Array.from(objects)) {
      const id = obj.getAttribute('id') || '';
      const label = obj.getAttribute('label') || '';
      if (id && label) {
        nodes.set(id, { id, label: stripHtml(label) });
      }
    }

    // ── Fallback: Spatial label resolution for unlabeled nodes ──
    // Some diagrams use separate text cells overlaid on container boxes
    // instead of setting the box's value attribute directly. For any node
    // referenced by an edge but missing from the nodes map, try to resolve
    // its label via: (1) child text cells, (2) spatial overlap matching.
    if (edges.length > 0) {
      const connectedIds = new Set<string>();
      for (const edge of edges) {
        connectedIds.add(edge.source);
        connectedIds.add(edge.target);
      }

      const unlabeled = new Set<string>();
      for (const cid of connectedIds) {
        if (!nodes.has(cid)) unlabeled.add(cid);
      }

      if (unlabeled.size > 0) {
        // Collect geometry and text cells for spatial matching
        type CellGeo = { x: number; y: number; w: number; h: number };
        const geoMap = new Map<string, CellGeo>();
        const textCells: { id: string; label: string; geo: CellGeo }[] = [];

        for (const cell of Array.from(cells)) {
          const id = cell.getAttribute('id') || '';
          const geo = cell.querySelector('mxGeometry');
          if (geo && id) {
            const g: CellGeo = {
              x: parseFloat(geo.getAttribute('x') || '0'),
              y: parseFloat(geo.getAttribute('y') || '0'),
              w: parseFloat(geo.getAttribute('width') || '0'),
              h: parseFloat(geo.getAttribute('height') || '0'),
            };
            geoMap.set(id, g);

            // Identify text cells (potential floating labels)
            const style = cell.getAttribute('style') || '';
            const value = cell.getAttribute('value') || '';
            const lbl = stripHtml(value);
            if (lbl && style.includes('text;') && !cell.getAttribute('source')) {
              textCells.push({ id, label: lbl, geo: g });
            }
          }
        }

        // Strategy 1: child text cells (parent matches the container)
        for (const cid of unlabeled) {
          for (const cell of Array.from(cells)) {
            if (cell.getAttribute('parent') === cid) {
              const val = stripHtml(cell.getAttribute('value') || '');
              const style = cell.getAttribute('style') || '';
              if (val && (style.includes('text;') || !style.includes('edgeLabel'))) {
                nodes.set(cid, { id: cid, label: val });
                break;
              }
            }
          }
        }

        // Strategy 2: spatial overlap — find the best-fit text cell
        // (closest text cell whose center is within the container bounds)
        for (const cid of unlabeled) {
          if (nodes.has(cid)) continue; // already resolved by Strategy 1
          const box = geoMap.get(cid);
          if (!box || box.w === 0 || box.h === 0) continue;

          // Box center
          const bCx = box.x + box.w / 2;
          const bCy = box.y + box.h / 2;
          let bestLabel = '';
          let bestDist = Infinity;

          for (const tc of textCells) {
            // Text cell center
            const tcx = tc.geo.x + tc.geo.w / 2;
            const tcy = tc.geo.y + tc.geo.h / 2;
            // Check if text center is within container bounds (10px tolerance)
            if (
              tcx >= box.x - 10 && tcx <= box.x + box.w + 10 &&
              tcy >= box.y - 10 && tcy <= box.y + box.h + 10
            ) {
              // Prefer the text cell closest to the container's center
              const dist = Math.hypot(tcx - bCx, tcy - bCy);
              if (dist < bestDist) {
                bestDist = dist;
                bestLabel = tc.label;
              }
            }
          }

          if (bestLabel) {
            nodes.set(cid, { id: cid, label: bestLabel });
          }
        }

        // Strategy 3: parent-chain walk — for child shapes (e.g. database
        // icons inside an application box), walk up the parent hierarchy
        // to find the nearest ancestor that already has a resolved label.
        // Build a parent map from all cells.
        const parentMap = new Map<string, string>();
        for (const cell of Array.from(cells)) {
          const id = cell.getAttribute('id') || '';
          const parent = cell.getAttribute('parent') || '';
          if (id && parent) parentMap.set(id, parent);
        }

        for (const cid of unlabeled) {
          if (nodes.has(cid)) continue; // already resolved
          let pid = parentMap.get(cid);
          let depth = 0;
          while (pid && depth < 5) {
            if (nodes.has(pid)) {
              nodes.set(cid, { id: cid, label: nodes.get(pid)!.label });
              break;
            }
            pid = parentMap.get(pid);
            depth++;
          }
        }

        // Strategy 4: sibling label — if a node's parent has a text child
        // (sibling with text; style), use that sibling's label.
        for (const cid of unlabeled) {
          if (nodes.has(cid)) continue;
          const myParent = parentMap.get(cid);
          if (!myParent) continue;

          // Find siblings (cells with same parent) that are text labels
          for (const cell of Array.from(cells)) {
            if (cell.getAttribute('parent') === myParent && cell.getAttribute('id') !== cid) {
              const style = cell.getAttribute('style') || '';
              const val = stripHtml(cell.getAttribute('value') || '');
              if (val && style.includes('text;')) {
                nodes.set(cid, { id: cid, label: val });
                break;
              }
            }
          }
        }
      }
    }

    if (edges.length > 0) {
      pages.push({ name: pageName, nodes, edges });
    }
  }

  return pages;
}

// ── BPMN 2.0 Parser ──────────────────────────────────────────

function parseBpmn(xml: string): DiagramPage[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const pages: DiagramPage[] = [];

  // BPMN: <process> contains tasks/events, <sequenceFlow> connects them
  const processes = doc.querySelectorAll('process');
  const containers = processes.length > 0 ? Array.from(processes) : [doc.documentElement];

  for (const proc of containers) {
    const pageName = proc.getAttribute('name') || proc.getAttribute('id') || 'Process';
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    // Collect all elements with an id and name as potential nodes
    const allElements = proc.querySelectorAll('*');
    for (const el of Array.from(allElements)) {
      const id = el.getAttribute('id');
      const name = el.getAttribute('name');
      const tag = el.localName;
      if (id && name && tag !== 'sequenceFlow' && tag !== 'messageFlow' && tag !== 'association') {
        nodes.set(id, { id, label: name });
      }
    }

    // Extract sequence flows
    const flows = proc.querySelectorAll('sequenceFlow');
    for (const flow of Array.from(flows)) {
      const source = flow.getAttribute('sourceRef') || '';
      const target = flow.getAttribute('targetRef') || '';
      const label = flow.getAttribute('name') || '';
      if (source && target) {
        edges.push({ source, target, label });
      }
    }

    // Also check messageFlow (cross-pool communication)
    const msgFlows = doc.querySelectorAll('messageFlow');
    for (const flow of Array.from(msgFlows)) {
      const source = flow.getAttribute('sourceRef') || '';
      const target = flow.getAttribute('targetRef') || '';
      const label = flow.getAttribute('name') || '';
      if (source && target) {
        edges.push({ source, target, label });
      }
    }

    if (edges.length > 0) {
      pages.push({ name: pageName, nodes, edges });
    }
  }

  return pages;
}

// ── ArchiMate Open Exchange Format Parser ─────────────────────

function parseArchiMate(xml: string): DiagramPage[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const pages: DiagramPage[] = [];
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // ArchiMate Open Exchange uses a default namespace which breaks
  // querySelectorAll (CSS selectors don't support default namespaces).
  // Use getElementsByTagNameNS with wildcard, or strip namespace and retry.
  // Strategy: try querySelectorAll first (no-namespace XML), then fallback
  // to getElementsByTagNameNS('*', 'element') for namespaced documents.
  let elements = Array.from(doc.querySelectorAll('element'));
  if (elements.length === 0) {
    // Namespace-aware fallback — '*' matches any namespace
    elements = Array.from(doc.getElementsByTagNameNS('*', 'element'));
  }

  for (const el of elements) {
    const id = el.getAttribute('identifier') || el.getAttribute('id') || '';
    // ArchiMate uses <name> child elements or name attribute
    // getElementsByTagNameNS needed here too for <name> in a namespace
    const nameEls = el.getElementsByTagNameNS('*', 'name');
    const nameEl = nameEls.length > 0 ? nameEls[0] : el.querySelector('name');
    const label = nameEl?.textContent || el.getAttribute('name') || el.getAttribute('label') || '';
    if (id && label) {
      nodes.set(id, { id, label: label.trim() });
    }
  }

  let relationships = Array.from(doc.querySelectorAll('relationship'));
  if (relationships.length === 0) {
    relationships = Array.from(doc.getElementsByTagNameNS('*', 'relationship'));
  }

  for (const rel of relationships) {
    const source = rel.getAttribute('source') || '';
    const target = rel.getAttribute('target') || '';
    const type = rel.getAttribute('xsi:type') || rel.getAttribute('type') || '';
    // Use relationship name if present (architect-labeled interface technology)
    const nameEls = rel.getElementsByTagNameNS('*', 'name');
    const nameLabel = nameEls.length > 0 ? (nameEls[0].textContent || '').trim() : '';
    // Fall back to relationship type if no name
    const relType = type.replace(/.*:/, ''); // strip namespace prefix
    const label = nameLabel || relType || '';
    if (source && target) {
      edges.push({ source, target, label });
    }
  }

  // If views exist, try to create per-view pages for release/state detection
  let views: Element[] = Array.from(doc.querySelectorAll('view'));
  if (views.length === 0) {
    views = Array.from(doc.getElementsByTagNameNS('*', 'view'));
  }

  if (views.length > 0 && edges.length > 0) {
    // Map view nodes to their element references
    for (const view of views) {
      const nameEls = view.getElementsByTagNameNS('*', 'name');
      const viewName = nameEls.length > 0
        ? (nameEls[0].textContent || '').trim()
        : (view.getAttribute('name') || view.getAttribute('identifier') || 'ArchiMate View');

      // Collect element refs in this view (viewNode → elementRef)
      const viewNodeEls = view.getElementsByTagNameNS('*', 'node');
      const viewElementIds = new Set<string>();
      for (const vn of Array.from(viewNodeEls)) {
        const ref = vn.getAttribute('elementRef') || vn.getAttribute('elementref') || '';
        if (ref) viewElementIds.add(ref);
      }

      // If view has element refs, filter edges to those involving view elements
      if (viewElementIds.size > 0) {
        const viewEdges = edges.filter(
          e => viewElementIds.has(e.source) || viewElementIds.has(e.target)
        );
        if (viewEdges.length > 0) {
          pages.push({ name: viewName, nodes, edges: viewEdges });
        }
      }
    }
  }

  // Fallback: if no view-based pages were created, use all edges as one page
  if (pages.length === 0 && edges.length > 0) {
    pages.push({ name: 'ArchiMate Model', nodes, edges });
  }

  return pages;
}

// ── Visio (.vsdx) Parser ──────────────────────────────────────
// Visio files are ZIP archives containing XML.
// Uses JSZip for extraction (already in the build as a transitive dep
// of SheetJS). Falls back to server-side parsing if JSZip isn't available.

async function parseVisio(data: ArrayBuffer): Promise<DiagramPage[]> {
  // Dynamic import — JSZip is large, only load when needed
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);

  const pages: DiagramPage[] = [];

  // Visio structure: visio/pages/pageN.xml + visio/pages/_rels/pageN.xml.rels
  // Each page has <Shape> elements with connections defined via <Connect>

  // First, find all page XML files
  const pageFiles: { name: string; content: string }[] = [];
  const pageRe = /^visio\/pages\/page(\d+)\.xml$/i;

  for (const [path, file] of Object.entries(zip.files)) {
    const match = path.match(pageRe);
    if (match && !file.dir) {
      const content = await file.async('string');
      pageFiles.push({ name: path, content });
    }
  }

  // Also read pages.xml for page names
  const pagesXmlFile = zip.file('visio/pages/pages.xml');
  const pageNames = new Map<number, string>();
  if (pagesXmlFile) {
    const pagesXml = await pagesXmlFile.async('string');
    const parser = new DOMParser();
    const pagesDoc = parser.parseFromString(pagesXml, 'text/xml');
    const pageEls = pagesDoc.querySelectorAll('Page');
    pageEls.forEach((p, idx) => {
      const name = p.getAttribute('Name') || p.getAttribute('NameU') || `Page ${idx + 1}`;
      pageNames.set(idx, name);
    });
  }

  // Parse each page
  for (let i = 0; i < pageFiles.length; i++) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(pageFiles[i].content, 'text/xml');
    const pageName = pageNames.get(i) || `Page ${i + 1}`;

    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    // Collect shapes — these are potential nodes
    const shapes = doc.querySelectorAll('Shape');
    for (const shape of Array.from(shapes)) {
      const id = shape.getAttribute('ID') || '';
      // Text content is in <Text> child
      const textEl = shape.querySelector('Text');
      const label = textEl?.textContent?.trim() || '';
      if (id && label) {
        nodes.set(id, { id, label });
      }
    }

    // Connections: <Connect> elements define how shapes connect
    const connects = doc.querySelectorAll('Connect');
    const connectionMap = new Map<string, { from?: string; to?: string }>();

    for (const conn of Array.from(connects)) {
      const fromSheet = conn.getAttribute('FromSheet') || '';
      const toSheet = conn.getAttribute('ToSheet') || '';
      const fromCell = conn.getAttribute('FromCell') || '';

      if (!connectionMap.has(fromSheet)) {
        connectionMap.set(fromSheet, {});
      }
      const entry = connectionMap.get(fromSheet)!;

      // BeginX → source connection, EndX → target connection
      if (fromCell === 'BeginX') {
        entry.from = toSheet;
      } else if (fromCell === 'EndX') {
        entry.to = toSheet;
      }
    }

    // Convert connection map to edges
    for (const [connectorId, conn] of connectionMap) {
      if (conn.from && conn.to) {
        // Edge label is the connector shape's text
        const connLabel = nodes.get(connectorId)?.label || '';
        edges.push({ source: conn.from, target: conn.to, label: connLabel });
        // Remove connector from nodes (it's an edge, not a node)
        nodes.delete(connectorId);
      }
    }

    if (edges.length > 0) {
      pages.push({ name: pageName, nodes, edges });
    }
  }

  return pages;
}

// ── Format Detection ──────────────────────────────────────────

function detectFormat(filename: string, content: string | null): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (ext === 'vsdx') return 'visio';
  if (ext === 'bpmn') return 'bpmn';
  if (ext === 'drawio') return 'drawio';

  // For .xml files, inspect content
  if (content) {
    if (content.includes('<mxfile') || content.includes('<mxGraphModel')) return 'drawio';
    if (content.includes('http://www.omg.org/spec/BPMN') || content.includes('<bpmn:')) return 'bpmn';
    if (content.includes('archimate') || content.includes('ArchiMate')) return 'archimate';
  }

  return 'unknown';
}

// ── HTML tag stripper ─────────────────────────────────────────

function stripHtml(html: string): string {
  if (!html || !html.includes('<')) return html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

// ── Main Entry Point ──────────────────────────────────────────

/**
 * Parse a diagram file and extract integration hop rows.
 * For XML-based formats, pass the text content.
 * For Visio (.vsdx), pass the ArrayBuffer.
 */
export async function parseDiagram(
  filename: string,
  data: ArrayBuffer,
): Promise<ParseResult> {
  try {
    const textContent = isTextFormat(filename)
      ? new TextDecoder().decode(data)
      : null;

    const format = detectFormat(filename, textContent);

    let pages: DiagramPage[];

    switch (format) {
      case 'drawio':
        pages = parseDrawio(textContent!);
        break;
      case 'bpmn':
        pages = parseBpmn(textContent!);
        break;
      case 'archimate':
        pages = parseArchiMate(textContent!);
        break;
      case 'visio':
        pages = await parseVisio(data);
        break;
      default:
        return {
          ok: false,
          format: 'unknown',
          sheets: [],
          totalChains: 0,
          totalHops: 0,
          error: `Unsupported file format: .${filename.split('.').pop()}. Supported: .drawio, .bpmn, .xml (ArchiMate), .vsdx (Visio)`,
        };
    }

    if (pages.length === 0) {
      return {
        ok: false,
        format,
        sheets: [],
        totalChains: 0,
        totalHops: 0,
        error: 'No integration flows found in the diagram. Ensure shapes are connected with edges/arrows.',
      };
    }

    const sheets = graphToHops(pages);
    const totalHops = sheets.reduce((sum, s) => sum + s.hops.length, 0);
    const totalChains = sheets.reduce((sum, s) => {
      const chains = new Set(s.hops.map(h => h['Flow Chain']));
      return sum + chains.size;
    }, 0);

    return {
      ok: true,
      format,
      sheets,
      totalChains,
      totalHops,
    };
  } catch (e) {
    return {
      ok: false,
      format: 'unknown',
      sheets: [],
      totalChains: 0,
      totalHops: 0,
      error: `Parse error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function isTextFormat(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop() || '';
  return ['drawio', 'bpmn', 'xml'].includes(ext);
}

// ── Hops JSON structure for persistence ───────────────────────

export interface HopsJsonFile {
  metadata: {
    source_file: string;
    extracted_at: string;
    format: string;
    total_chains: number;
    total_hops: number;
    capability: string;
    tower: string;
  };
  sheets: HopSheet[];
}

export function buildHopsJson(
  result: ParseResult,
  filename: string,
  tower: string,
  cap: string,
): HopsJsonFile {
  return {
    metadata: {
      source_file: filename,
      extracted_at: new Date().toISOString(),
      format: result.format,
      total_chains: result.totalChains,
      total_hops: result.totalHops,
      capability: cap,
      tower,
    },
    sheets: result.sheets,
  };
}
