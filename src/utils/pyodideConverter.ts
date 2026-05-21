/**
 * pyodideConverter.ts — In-browser Mermaid ↔ draw.io conversion via Pyodide.
 *
 * Loads `mermaid_converter.py` directly in the browser using Pyodide (Python-in-WASM).
 * This eliminates the need for a backend API — the entire conversion runs client-side.
 *
 * Flow:
 *   1. First call → loads Pyodide + injects mermaid_converter.py source
 *   2. Subsequent calls → reuses the loaded runtime (fast)
 *   3. Exposes: mermaidToDrawio(), drawioToMermaid(), vsdxToMermaid()
 */

// Pyodide source — prefer local (public/pyodide/) to bypass firewall,
// fallback to CDN if local files not found.
const PYODIDE_LOCAL = `${import.meta.env.BASE_URL}pyodide/`;
const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

// The Python converter source is fetched from the repo's public/scripts/ folder (same-origin)
const CONVERTER_PATH = `${import.meta.env.BASE_URL}scripts/mermaid_converter.py`;

/* eslint-disable @typescript-eslint/no-explicit-any */
let pyodideInstance: any = null;
let loadingPromise: Promise<any> | null = null;
let converterLoaded = false;

/**
 * Load Pyodide and the mermaid_converter module.
 * Caches the instance — subsequent calls are instant.
 *
 * Strategy: try local pyodide first (for Intel firewall), fall back to CDN
 * (works on GitHub Pages where CDN is reachable).
 */
async function ensurePyodide(): Promise<any> {
  if (pyodideInstance && converterLoaded) return pyodideInstance;

  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    // Determine which Pyodide source to use (local vs CDN)
    let indexURL = PYODIDE_CDN;

    if (!(window as any).loadPyodide) {
      // Try local first (bypasses Intel firewall on dev)
      const localAvailable = await fetch(`${PYODIDE_LOCAL}pyodide.js`, { method: 'HEAD' })
        .then(r => r.ok)
        .catch(() => false);

      const scriptUrl = localAvailable
        ? `${PYODIDE_LOCAL}pyodide.js`
        : `${PYODIDE_CDN}pyodide.js`;

      indexURL = localAvailable ? PYODIDE_LOCAL : PYODIDE_CDN;

      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptUrl;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(
          `Failed to load Pyodide from ${localAvailable ? 'local' : 'CDN'}. ` +
          (localAvailable ? '' : 'Run: powershell scripts/setup-pyodide-local.ps1')
        ));
        document.head.appendChild(script);
      });
    }

    // Initialize Pyodide with the resolved index URL
    pyodideInstance = await (window as any).loadPyodide({ indexURL });

    // Fetch the converter source
    const res = await fetch(CONVERTER_PATH);
    if (!res.ok) throw new Error(`Cannot load mermaid_converter.py (HTTP ${res.status})`);
    const converterSource = await res.text();

    // Write the converter to Pyodide FS and import it
    pyodideInstance.FS.writeFile('/home/pyodide/mermaid_converter.py', converterSource);
    await pyodideInstance.runPythonAsync(`
import sys
sys.path.insert(0, '/home/pyodide')
import mermaid_converter
`);

    converterLoaded = true;
    return pyodideInstance;
  })();

  return loadingPromise;
}

/* ── Public API ─────────────────────────────────────────────────── */

export interface ConvertResult {
  content: string;
  meta?: {
    diagram_type: string;
    node_count: number;
    edge_count: number;
  };
}

/**
 * Convert Mermaid source text → draw.io XML.
 */
export async function mermaidToDrawio(mermaidSource: string): Promise<ConvertResult> {
  const py = await ensurePyodide();

  // Escape the source for safe Python string interpolation
  const escaped = mermaidSource.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');

  const result = py.runPython(`
import json
from mermaid_converter import parse_mermaid, export_drawio

_src = """${escaped}"""
_ir = parse_mermaid(_src)
_xml = export_drawio(_ir)
json.dumps({
    "content": _xml,
    "meta": {
        "diagram_type": _ir.diagram_type,
        "node_count": len(_ir.nodes),
        "edge_count": len(_ir.edges),
    }
})
`);

  return JSON.parse(result);
}

/**
 * Convert draw.io XML → Mermaid source text.
 */
export async function drawioToMermaid(drawioXml: string): Promise<ConvertResult> {
  const py = await ensurePyodide();

  // Write the XML to a temp file to avoid escaping issues
  py.FS.writeFile('/tmp/input.xml', drawioXml);

  const result = py.runPython(`
import json
from mermaid_converter import serialize_mermaid, DiagramIR, Node, Edge
import xml.etree.ElementTree as ET
import re

def _clean_label(raw):
    text = re.sub(r'<[^>]+>', ' ', raw)
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&nbsp;', ' ')
    return ' '.join(text.split()).strip()

def _to_node_id(label, fallback):
    base = label if label else fallback
    safe = re.sub(r'[^A-Za-z0-9_]', '_', base)
    safe = safe.strip('_')
    if not safe or safe[0].isdigit():
        safe = 'n_' + safe
    return safe[:40] or f"node_{fallback[:8]}"

def _infer_shape_from_style(style):
    s = style.lower()
    if "rhombus" in s or "diamond" in s: return "diamond"
    if "ellipse" in s: return "ellipse"
    if "cylinder" in s or "storage" in s: return "cylinder"
    if "parallelogram" in s: return "parallelogram"
    if "rounded=1" in s or "arcsize" in s: return "rounded"
    return "rectangle"

def _infer_edge_style(style):
    s = style.lower()
    linestyle = "dashed" if "dashed=1" in s else "solid"
    if "endarrow=none" in s: return ("none", linestyle)
    if "endarrow=open" in s: return ("open", linestyle)
    if "strokewidth=3" in s or "thick" in s: return ("normal", "thick")
    return ("normal", linestyle)

with open('/tmp/input.xml', 'r') as f:
    xml_str = f.read()

ir = DiagramIR()
ir.diagram_type = "flowchart"
ir.direction = "TD"

root = ET.fromstring(xml_str)
cells = root.findall(".//mxCell")

node_cells = {}
edge_cells = []

for cell in cells:
    cid = cell.get("id", "")
    if cid in ("0", "1"):
        continue
    if cell.get("vertex") == "1":
        node_cells[cid] = cell
    elif cell.get("edge") == "1":
        edge_cells.append(cell)

id_map = {}
for cid, cell in node_cells.items():
    label = _clean_label(cell.get("value", "") or cid)
    style = cell.get("style", "")
    shape = _infer_shape_from_style(style)
    safe_id = _to_node_id(label, cid)
    id_map[cid] = safe_id
    ir.nodes.append(Node(id=safe_id, label=label, shape=shape))

for cell in edge_cells:
    src_cid = cell.get("source", "")
    dst_cid = cell.get("target", "")
    src_id = id_map.get(src_cid)
    dst_id = id_map.get(dst_cid)
    if not src_id or not dst_id:
        continue
    label = _clean_label(cell.get("value", ""))
    style = cell.get("style", "")
    arrow, ln = _infer_edge_style(style)
    ir.edges.append(Edge(src=src_id, dst=dst_id, label=label, arrow=arrow, line=ln))

# ── Infer CSS class from node fill color ──
FILL_TO_CLASS = {
    '#CCE5FF': 'app',
    '#cce5ff': 'app',
    '#FFE0B2': 'middleware',
    '#ffe0b2': 'middleware',
    '#FFCDD2': 'eol',
    '#ffcdd2': 'eol',
    '#C8E6C9': 'dbCyl',
    '#c8e6c9': 'dbCyl',
    '#BBDEFB': 'cloud',
    '#bbdefb': 'cloud',
    '#B2EBF2': 'dbData',
    '#b2ebf2': 'dbData',
    '#E1BEE7': 'saas',
    '#e1bee7': 'saas',
}

for node in ir.nodes:
    cid_for_node = next((c for c, nid in id_map.items() if nid == node.id), None)
    if cid_for_node and cid_for_node in node_cells:
        st = node_cells[cid_for_node].get("style", "")
        fill_m = re.search(r'fillColor=([^;]+)', st)
        if fill_m:
            fill = fill_m.group(1)
            cls = FILL_TO_CLASS.get(fill, '')
            if cls:
                node.css_class = cls

# ── Detect groups (containers, swimlanes, or group style) ──
for cid, cell in node_cells.items():
    style = cell.get("style", "")
    is_container = ("swimlane" in style or "container=1" in style
                    or "group" in style.lower())
    if is_container:
        group_id = id_map.get(cid, cid)
        group_label = _clean_label(cell.get("value", group_id))
        members = [
            id_map[c] for c, el in node_cells.items()
            if el.get("parent") == cid and c != cid and c in id_map
        ]
        if members:
            ir.groups.append((group_id, group_label, members))
            ir.nodes = [n for n in ir.nodes if n.id != group_id]
            # Extract lane style from container fill/stroke
            fill_m = re.search(r'fillColor=([^;]+)', style)
            stroke_m = re.search(r'strokeColor=([^;]+)', style)
            if fill_m or stroke_m:
                props = {}
                if fill_m: props['fill'] = fill_m.group(1)
                if stroke_m: props['stroke'] = stroke_m.group(1)
                ir.style_defs[group_id] = props

# ── Default classDefs (ArchiMate colors) ──
ir.class_defs = {
    'app': {'fill': '#CCE5FF', 'stroke': '#0078D4', 'stroke-width': '2px', 'color': '#003A6C'},
    'middleware': {'fill': '#FFE0B2', 'stroke': '#E65100', 'stroke-width': '2px', 'color': '#BF360C'},
    'eol': {'fill': '#FFCDD2', 'stroke': '#C62828', 'stroke-width': '2px', 'color': '#B71C1C'},
    'dbCyl': {'fill': '#C8E6C9', 'stroke': '#2E7D32', 'stroke-width': '2px', 'color': '#1B5E20'},
    'cloud': {'fill': '#BBDEFB', 'stroke': '#1565C0', 'stroke-width': '2px', 'color': '#0D47A1'},
    'dbData': {'fill': '#B2EBF2', 'stroke': '#00838F', 'stroke-width': '2px', 'color': '#004D40'},
    'saas': {'fill': '#E1BEE7', 'stroke': '#7B1FA2', 'stroke-width': '2px', 'color': '#4A148C'},
}

mmd = serialize_mermaid(ir)
json.dumps({
    "content": mmd,
    "meta": {
        "diagram_type": ir.diagram_type,
        "node_count": len(ir.nodes),
        "edge_count": len(ir.edges),
        "group_count": len(ir.groups),
    }
})
`);

  return JSON.parse(result);
}

/**
 * Convert Visio .vsdx binary (ArrayBuffer) → Mermaid source text.
 */
export async function vsdxToMermaid(vsdxBuffer: ArrayBuffer): Promise<ConvertResult> {
  const py = await ensurePyodide();

  // Write the binary to Pyodide FS
  const uint8 = new Uint8Array(vsdxBuffer);
  py.FS.writeFile('/tmp/input.vsdx', uint8);

  const result = py.runPython(`
import json
import zipfile
import io
import re
import xml.etree.ElementTree as ET
from mermaid_converter import serialize_mermaid, DiagramIR, Node, Edge

def _clean_label(raw):
    text = re.sub(r'<[^>]+>', ' ', raw)
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&nbsp;', ' ')
    return ' '.join(text.split()).strip()

def _to_node_id(label, fallback):
    base = label if label else fallback
    safe = re.sub(r'[^A-Za-z0-9_]', '_', base)
    safe = safe.strip('_')
    if not safe or safe[0].isdigit():
        safe = 'n_' + safe
    return safe[:40] or f"node_{fallback[:8]}"

with open('/tmp/input.vsdx', 'rb') as f:
    data = f.read()

ir = DiagramIR()
ir.diagram_type = "flowchart"
ir.direction = "TD"

with zipfile.ZipFile(io.BytesIO(data)) as zf:
    page_xml = None
    for name in zf.namelist():
        if name.startswith("visio/pages/page") and name.endswith(".xml"):
            page_xml = zf.read(name).decode("utf-8")
            break

if not page_xml:
    raise ValueError("No page found in .vsdx file")

ns = {"v": "http://schemas.microsoft.com/office/visio/2012/main"}
root = ET.fromstring(page_xml)
shapes = root.findall(".//v:Shape", ns)
id_map = {}

for shape in shapes:
    sid = shape.get("ID", "")
    stype = shape.get("Type", "Shape")
    text_el = shape.find(".//v:Text", ns)
    if text_el is not None:
        raw = text_el.text or ""
        for _child in text_el:
            raw += (_child.tail or "")
        label = _clean_label(raw) or f"Shape_{sid}"
    else:
        label = f"Shape_{sid}"
    if stype == "Edge":
        continue
    safe_id = _to_node_id(label, sid)
    id_map[sid] = safe_id
    ir.nodes.append(Node(id=safe_id, label=label, shape="rectangle"))

for shape in shapes:
    if shape.get("Type") != "Edge":
        continue
    connects = shape.findall(".//v:Connect", ns)
    src_sid = dst_sid = None
    for conn in connects:
        cell = conn.get("FromCell", "")
        to = conn.get("ToSheet", "")
        if "Begin" in cell:
            src_sid = to
        elif "End" in cell:
            dst_sid = to
    text_el = shape.find(".//v:Text", ns)
    label = _clean_label(text_el.text or "") if text_el is not None else ""
    src_id = id_map.get(src_sid or "")
    dst_id = id_map.get(dst_sid or "")
    if src_id and dst_id:
        ir.edges.append(Edge(src=src_id, dst=dst_id, label=label))

mmd = serialize_mermaid(ir)
json.dumps({
    "content": mmd,
    "meta": {
        "diagram_type": ir.diagram_type,
        "node_count": len(ir.nodes),
        "edge_count": len(ir.edges),
    }
})
`);

  return JSON.parse(result);
}

/**
 * Check if Pyodide is already loaded (non-blocking).
 */
export function isPyodideReady(): boolean {
  return converterLoaded;
}

/**
 * Pre-warm Pyodide in the background (call on app init for faster first edit).
 */
export function preloadPyodide(): void {
  ensurePyodide().catch(() => {
    // Swallow — will retry on actual use
  });
}
