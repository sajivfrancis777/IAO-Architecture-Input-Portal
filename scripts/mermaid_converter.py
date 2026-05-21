#!/usr/bin/env python3
"""
mermaid_converter.py
────────────────────
Convert Mermaid diagram source to:
  • draw.io / diagrams.net  (.drawio XML)
  • Microsoft Visio          (.vsdx)

Supported Mermaid diagram types
  - flowchart / graph  (TD, LR, BT, RL)
  - sequenceDiagram
  - classDiagram
  - erDiagram (basic)

Usage
  python mermaid_converter.py input.mmd --format drawio --output output.drawio
  python mermaid_converter.py input.mmd --format vsdx   --output output.vsdx
  python mermaid_converter.py --demo  # generates a sample .mmd and converts both
"""

import argparse
import re
import sys
import os
import zipfile
import io
import textwrap
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom import minidom
from dataclasses import dataclass, field
from typing import Optional


# ──────────────────────────────────────────────────────────────────────────────
# Data model
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class Node:
    id: str
    label: str
    shape: str = "rectangle"   # rectangle | diamond | rounded | cylinder | ellipse | parallelogram
    style: str = ""
    css_class: str = ""        # mermaid class name (e.g. 'app', 'middleware', 'eol')

@dataclass
class Edge:
    src: str
    dst: str
    label: str = ""
    arrow: str = "normal"      # normal | open | dot | none
    line: str = "solid"        # solid | dashed

@dataclass
class DiagramIR:
    """Intermediate representation – diagram-type agnostic."""
    diagram_type: str = "flowchart"
    direction: str = "TB"      # TB LR BT RL
    nodes: list = field(default_factory=list)
    edges: list = field(default_factory=list)
    groups: list = field(default_factory=list)   # [(group_id, label, [member_ids])]
    sequences: list = field(default_factory=list) # for sequence diagrams: (actor_a, actor_b, msg, type)
    notes: list = field(default_factory=list)     # (actor, text)
    class_defs: dict = field(default_factory=dict)  # class_name -> {fill, stroke, color}
    style_defs: dict = field(default_factory=dict)  # element_id -> {fill, stroke, ...}


# ──────────────────────────────────────────────────────────────────────────────
# Mermaid parser
# ──────────────────────────────────────────────────────────────────────────────

FLOWCHART_DIRECTIONS = {"TD", "TB", "LR", "RL", "BT"}

# shape patterns: [text] ( text ) (( text )) {text} >text] /text/ etc.
SHAPE_PATTERNS = [
    (r'\[\[(.+?)\]\]',          'cylinder'),
    (r'\[\((.+?)\)\]',          'cylinder'),
    (r'\(\((.+?)\)\)',          'ellipse'),
    (r'\{(.+?)\}',              'diamond'),
    (r'\[/(.+?)/\]',            'parallelogram'),
    (r'\[\\(.+?)\\\]',          'parallelogram'),
    (r'\((.+?)\)',               'rounded'),
    (r'\[(.+?)\]',               'rectangle'),
    (r'>(.+?)\]',                'asymmetric'),
]

EDGE_PATTERNS = [
    (r'-->\|(.+?)\|',           'normal', 'solid',  True),   # -->|label|
    (r'-- (.+?) -->',           'normal', 'solid',  True),   # -- label -->
    (r'-\.->',                  'open',   'dashed', False),
    (r'==>',                    'normal', 'thick',  False),
    (r'-->',                    'normal', 'solid',  False),
    (r'---',                    'none',   'solid',  False),
    (r'-\.',                    'open',   'dashed', False),
]


def _extract_node(token: str) -> tuple[str, str, str, str]:
    """Return (id, label, shape, css_class) from a flowchart node token like A[Hello]:::app."""
    token = token.strip()
    # Extract :::className suffix before stripping
    css_class = ''
    class_m = re.search(r':::([A-Za-z0-9_-]+)\s*$', token)
    if class_m:
        css_class = class_m.group(1)
        token = token[:class_m.start()].strip()
    for pattern, shape in SHAPE_PATTERNS:
        m = re.match(r'^([A-Za-z0-9_\-]+)' + pattern + r'$', token)
        if m:
            label = m.group(2)
            # Strip surrounding quotes from labels like ["text"]
            if label.startswith('"') and label.endswith('"'):
                label = label[1:-1]
            return m.group(1), label, shape, css_class
    # bare id, no shape decoration
    return token, token, 'rectangle', css_class


def parse_mermaid(source: str) -> DiagramIR:
    ir = DiagramIR()
    lines = [l.strip() for l in source.strip().splitlines()]
    lines = [l for l in lines if l and not l.startswith('%%')]

    if not lines:
        return ir

    first = lines[0].lower()

    if first.startswith('sequencediagram'):
        return _parse_sequence(lines[1:], ir)
    if first.startswith('classdiagram'):
        return _parse_class(lines[1:], ir)
    if first.startswith('erdiagram'):
        return _parse_er(lines[1:], ir)
    if first.startswith(('flowchart', 'graph')):
        parts = first.split()
        direction = parts[1].upper() if len(parts) > 1 else 'TD'
        if direction not in FLOWCHART_DIRECTIONS:
            direction = 'TD'
        ir.direction = direction
        ir.diagram_type = 'flowchart'
        return _parse_flowchart(lines[1:], ir)

    # fallback – try flowchart
    return _parse_flowchart(lines, ir)


def _parse_flowchart(lines: list, ir: DiagramIR) -> DiagramIR:
    node_map: dict[str, Node] = {}
    current_subgraph: Optional[tuple] = None
    subgraph_stack: list = []
    subgraph_members: dict[str, list] = {}

    def ensure_node(nid, label=None, shape='rectangle', css_class=''):
        if nid not in node_map:
            node_map[nid] = Node(id=nid, label=label or nid, shape=shape, css_class=css_class)
        elif css_class and not node_map[nid].css_class:
            node_map[nid].css_class = css_class
        return node_map[nid]

    def _parse_style_props(prop_str: str) -> dict:
        """Parse 'fill:#CCE5FF,stroke:#0078D4,...' into a dict."""
        props = {}
        for part in prop_str.split(','):
            if ':' in part:
                k, v = part.split(':', 1)
                props[k.strip()] = v.strip()
        return props

    for line in lines:
        # ── Capture Mermaid directives ──
        line_lower = line.lower()

        # classDef — store class color definitions
        if line_lower.startswith('classdef '):
            m = re.match(r'classDef\s+(\S+)\s+(.*)', line, re.I)
            if m:
                class_name = m.group(1)
                ir.class_defs[class_name] = _parse_style_props(m.group(2))
            continue

        # style — store element-level styles (lanes, nodes)
        if re.match(r'^style\s+\S', line_lower):
            m = re.match(r'style\s+(\S+)\s+(.*)', line, re.I)
            if m:
                elem_id = m.group(1)
                ir.style_defs[elem_id] = _parse_style_props(m.group(2))
            continue

        if line_lower.startswith(('linkstyle ', 'click ', 'direction ')):
            # direction inside subgraph is local to that lane, don't override top-level
            if line_lower.startswith('direction ') and not subgraph_stack:
                d = line.split()[1].upper() if len(line.split()) > 1 else None
                if d in ('LR', 'RL', 'TB', 'TD', 'BT'):
                    ir.direction = d
            continue
        if re.match(r'^class\s+\S+\s+\S', line_lower):
            # class assignment: class nodeId className
            m = re.match(r'class\s+(\S+)\s+(\S+)', line)
            if m:
                nid, cname = m.group(1), m.group(2)
                if nid in node_map:
                    node_map[nid].css_class = cname
            continue

        # subgraph
        if line.lower().startswith('subgraph'):
            m = re.match(r'subgraph\s+([^\[]+?)(?:\s*\[(.+?)\])?$', line, re.I)
            sg_id = m.group(1).strip() if m else 'sg'
            sg_label = m.group(2).strip() if m and m.group(2) else sg_id
            # Strip surrounding quotes from subgraph labels like [" Source Systems"]
            if sg_label.startswith('"') and sg_label.endswith('"'):
                sg_label = sg_label[1:-1]
            sg_label = sg_label.strip()
            subgraph_stack.append((sg_id, sg_label))
            subgraph_members[sg_id] = []
            continue
        if line.lower() == 'end' and subgraph_stack:
            sg = subgraph_stack.pop()
            ir.groups.append((sg[0], sg[1], subgraph_members.get(sg[0], [])))
            continue

        # split on edge operators
        # handles: A --> B, A -->|label| B, A -- text --> B
        edge_match = None
        for ep, arrow, linestyle, has_label in EDGE_PATTERNS:
            # try compound: node EDGE node
            full = rf'^(.+?)\s*({ep})\s*(.+)$'
            m = re.match(full, line)
            if m:
                edge_match = (m, arrow, linestyle, has_label, ep)
                break

        if edge_match:
            m, arrow, linestyle, has_label, ep = edge_match
            left_raw = m.group(1).strip()
            edge_raw = m.group(2).strip()
            right_raw = m.group(len(m.groups())).strip()

            # extract edge label for -->|label| and -- label --> patterns
            edge_label = ''
            lm = re.search(r'\|(.+?)\|', edge_raw)
            if not lm:
                lm = re.match(r'-- (.+?) --', edge_raw)
            if lm:
                edge_label = lm.group(1).strip()
                # Strip surrounding quotes from edge labels like |"Direct"|
                if edge_label.startswith('"') and edge_label.endswith('"'):
                    edge_label = edge_label[1:-1]

            # parse both ends (may be compound "A & B")
            lefts  = [t.strip() for t in re.split(r'\s*&\s*', left_raw)]
            rights = [t.strip() for t in re.split(r'\s*&\s*', right_raw)]

            for lt in lefts:
                lid, ll, ls, lc = _extract_node(lt)
                ensure_node(lid, ll, ls, lc)
                for rt in rights:
                    rid, rl, rs, rc = _extract_node(rt)
                    ensure_node(rid, rl, rs, rc)
                    ir.edges.append(Edge(src=lid, dst=rid, label=edge_label, arrow=arrow, line=linestyle))
                    if subgraph_stack:
                        sg_id = subgraph_stack[-1][0]
                        if lid not in subgraph_members[sg_id]:
                            subgraph_members[sg_id].append(lid)
                        if rid not in subgraph_members[sg_id]:
                            subgraph_members[sg_id].append(rid)
        else:
            # standalone node definition
            m = re.match(r'^([A-Za-z0-9_\-]+)(.*)$', line)
            if m:
                nid = m.group(1)
                rest = m.group(2).strip()
                if rest:
                    nid2, label, shape, css_cls = _extract_node(nid + rest)
                    ensure_node(nid2, label, shape, css_cls)
                    # Track subgraph membership for standalone nodes
                    if subgraph_stack:
                        sg_id = subgraph_stack[-1][0]
                        if nid2 not in subgraph_members[sg_id]:
                            subgraph_members[sg_id].append(nid2)
                else:
                    ensure_node(nid)
                    if subgraph_stack:
                        sg_id = subgraph_stack[-1][0]
                        if nid not in subgraph_members[sg_id]:
                            subgraph_members[sg_id].append(nid)

    ir.nodes = list(node_map.values())
    return ir


def _parse_sequence(lines: list, ir: DiagramIR) -> DiagramIR:
    ir.diagram_type = 'sequence'
    actors: dict[str, Node] = {}
    seq_id = 0

    def ensure_actor(name):
        if name not in actors:
            actors[name] = Node(id=name, label=name, shape='rectangle')

    for line in lines:
        # participant alias
        m = re.match(r'participant\s+(.+?)(?:\s+as\s+(.+))?$', line, re.I)
        if m:
            aid = m.group(1).strip()
            alabel = m.group(2).strip() if m.group(2) else aid
            actors[aid] = Node(id=aid, label=alabel, shape='rectangle')
            continue

        # message: A ->> B: text  or  A->B: text
        m = re.match(r'(.+?)\s*(->>|->|-->|-x|--x)\s*(.+?):\s*(.*)$', line)
        if m:
            a, op, b, msg = m.group(1).strip(), m.group(2), m.group(3).strip(), m.group(4).strip()
            ensure_actor(a)
            ensure_actor(b)
            linestyle = 'dashed' if '->' in op and op.startswith('--') or op in ('->>',) else 'solid'
            arrow = 'open' if '>>' in op else ('none' if 'x' in op else 'normal')
            ir.sequences.append((a, b, msg, arrow, linestyle))

        # note
        m = re.match(r'[Nn]ote\s+(?:over|left of|right of)\s+(.+?):\s*(.*)', line)
        if m:
            ir.notes.append((m.group(1).strip(), m.group(2).strip()))

    ir.nodes = list(actors.values())
    return ir


def _parse_class(lines: list, ir: DiagramIR) -> DiagramIR:
    ir.diagram_type = 'class'
    classes: dict[str, Node] = {}

    for line in lines:
        # class declaration
        m = re.match(r'class\s+(\w+)\s*\{?', line)
        if m:
            cid = m.group(1)
            if cid not in classes:
                classes[cid] = Node(id=cid, label=cid, shape='rectangle')
            continue
        # relationship: A --|> B or A --> B : label
        m = re.match(r'(\w+)\s+([<|o*\-\.]+[>\|o*]?)\s+(\w+)(?:\s*:\s*(.*))?', line)
        if m:
            a, rel, b, label = m.group(1), m.group(2), m.group(3), m.group(4) or ''
            for cid in (a, b):
                if cid not in classes:
                    classes[cid] = Node(id=cid, label=cid, shape='rectangle')
            arrow = 'open' if '>' in rel else 'none'
            linestyle = 'dashed' if '.' in rel else 'solid'
            ir.edges.append(Edge(src=a, dst=b, label=label.strip(), arrow=arrow, line=linestyle))

    ir.nodes = list(classes.values())
    return ir


def _parse_er(lines: list, ir: DiagramIR) -> DiagramIR:
    ir.diagram_type = 'er'
    entities: dict[str, Node] = {}

    for line in lines:
        m = re.match(r'(\w+)\s+\|[o|]{1,2}--[o|]{1,2}\|\s+(\w+)\s*:\s*(.*)', line)
        if m:
            a, b, label = m.group(1), m.group(2), m.group(3)
            for eid in (a, b):
                if eid not in entities:
                    entities[eid] = Node(id=eid, label=eid, shape='rectangle')
            ir.edges.append(Edge(src=a, dst=b, label=label.strip()))
        elif re.match(r'^[A-Za-z_]\w*\s*\{', line) or re.match(r'^[A-Za-z_]\w*$', line):
            eid = line.split()[0].rstrip('{').strip()
            if eid and eid not in entities:
                entities[eid] = Node(id=eid, label=eid, shape='rectangle')

    ir.nodes = list(entities.values())
    return ir


# ──────────────────────────────────────────────────────────────────────────────
# Layout engine  (simple grid / layered placement)
# ──────────────────────────────────────────────────────────────────────────────

def compute_layout(ir: DiagramIR, cell_w=160, cell_h=50, h_gap=30, v_gap=40):
    """
    Returns {node_id: (x, y, w, h)}.
    Uses subgraph-aware cluster layout for flowcharts with groups,
    simple BFS layering for flat flowcharts,
    and a vertical actor-lane approach for sequences.
    """
    positions = {}

    if ir.diagram_type == 'sequence':
        return _layout_sequence(ir, cell_w, cell_h, h_gap, v_gap)

    # Per-node width based on its own label length (like mermaid auto-sizing)
    node_widths: dict[str, int] = {}
    for n in ir.nodes:
        # ~8px per char + padding, min 120, max 280
        nw = max(120, min(len(n.label) * 8 + 24, 280))
        node_widths[n.id] = nw

    # Use median width for layout grid spacing (consistent horizontal rhythm)
    if node_widths:
        sorted_widths = sorted(node_widths.values())
        cell_w = sorted_widths[len(sorted_widths) // 2]
    else:
        cell_w = 160

    # If we have subgraph groups, use cluster layout
    if ir.groups:
        return _layout_clustered(ir, cell_w, cell_h, h_gap, v_gap, node_widths)

    # ── Flat layout (no subgraphs) ──
    node_ids = [n.id for n in ir.nodes]
    adj: dict[str, list] = {n: [] for n in node_ids}
    in_deg: dict[str, int] = {n: 0 for n in node_ids}

    for e in ir.edges:
        if e.src in adj and e.dst in adj:
            adj[e.src].append(e.dst)
            in_deg[e.dst] = in_deg.get(e.dst, 0) + 1

    # BFS layering
    from collections import deque
    queue = deque([n for n in node_ids if in_deg.get(n, 0) == 0])
    visited = set()
    layer_map: dict[str, int] = {}
    layer = 0

    while queue:
        next_q: deque = deque()
        for nid in queue:
            if nid in visited:
                continue
            visited.add(nid)
            layer_map[nid] = layer
            for nb in adj.get(nid, []):
                next_q.append(nb)
        queue = next_q
        layer += 1

    for nid in node_ids:
        if nid not in layer_map:
            layer_map[nid] = layer
            layer += 1

    layers: dict[int, list] = {}
    for nid, ly in layer_map.items():
        layers.setdefault(ly, []).append(nid)

    max_w = cell_w
    max_h = cell_h

    if ir.direction in ('LR', 'RL'):
        for ly_idx, members in sorted(layers.items()):
            x = ly_idx * (max_w + h_gap) + 40
            for i, nid in enumerate(members):
                y = i * (max_h + v_gap) + 40
                positions[nid] = (x, y, max_w, max_h)
    else:
        for ly_idx, members in sorted(layers.items()):
            y = ly_idx * (max_h + v_gap) + 40
            total_w = len(members) * (max_w + h_gap) - h_gap
            start_x = max(40, 400 - total_w // 2)
            for i, nid in enumerate(members):
                x = start_x + i * (max_w + h_gap)
                positions[nid] = (x, y, max_w, max_h)

    return positions


def _layout_clustered(ir: DiagramIR, cell_w, cell_h, h_gap, v_gap, node_widths=None):
    """
    2D dagre-like layout with lane-level ranking:
    - Compute inter-lane edges to rank LANES (not just nodes)
    - Lanes at the same rank sit side-by-side (same y level)
    - Downstream lanes stack below (increasing y)
    - Within each lane, nodes flow LR
    - Creates a natural 2D grid matching dagre's cluster behavior
    """
    positions = {}
    lane_h_gap = 40  # horizontal gap between side-by-side lanes
    lane_v_gap = 80  # vertical gap between lane rows (routing space for connectors)
    node_h_gap = h_gap  # gap between nodes within a lane

    if node_widths is None:
        node_widths = {}

    def get_nw(nid):
        return node_widths.get(nid, cell_w)

    # Collect all grouped node IDs
    grouped_ids: set = set()
    for _, _, members in ir.groups:
        grouped_ids.update(members)

    # Ungrouped nodes
    ungrouped = [n.id for n in ir.nodes if n.id not in grouped_ids]

    # Build lane list
    bands = list(ir.groups)
    if ungrouped:
        bands.append(('__ungrouped__', '', ungrouped))

    # Separate legend
    legend_bands = [b for b in bands if 'legend' in b[0].lower() or 'legend' in b[1].lower()]
    main_bands = [b for b in bands if b not in legend_bands]
    num_lanes = len(main_bands)

    # ── Build node-to-lane mapping ──
    node_to_lane: dict[str, int] = {}  # node_id -> lane index in main_bands
    for lane_idx, (sg_id, sg_label, members) in enumerate(main_bands):
        for m in members:
            node_to_lane[m] = lane_idx

    # ── Semantic tier ordering (architecture layer model) ──
    # Lanes are ranked by their architecture tier if keywords match.
    # This produces a natural layered flow: sources → processing → consumers
    TIER_KEYWORDS: list[tuple[int, list[str]]] = [
        (0, ['mes ', 'mes system', 'factory', 'plant', 'manufacturing exec']),
        (1, ['boundary', 'source']),
        (2, ['middleware', 'integration', 'mulesoft', 'sap po', 'bods', 'api gateway']),
        (3, ['cloud', 'custom', 'saas', 'ibp', 'legacy']),
        (4, ['erp', 's/4', 's4', 'sap ecc', 'cfin']),
        (5, ['data warehouse', 'dw', 'eca', 'snowflake', 'databricks', 'adls', 'hana', 'lake']),
        (6, ['report', 'analytics', 'power bi', 'bobj', 'edw', 'dashboard']),
    ]

    def _tier_for_lane(label: str) -> int | None:
        """Match lane label to a predefined architecture tier."""
        label_lower = label.lower()
        for tier, keywords in TIER_KEYWORDS:
            for kw in keywords:
                if kw in label_lower:
                    return tier
        return None  # no match → fall back to edge-based ranking

    # Try tier-based ranking first
    lane_ranks: dict[int, int] = {}
    has_tier_match = False
    for lane_idx, (sg_id, sg_label, members) in enumerate(main_bands):
        tier = _tier_for_lane(sg_label)
        if tier is not None:
            lane_ranks[lane_idx] = tier
            has_tier_match = True

    if not has_tier_match:
        # ── Fallback: Compute LANE-LEVEL ranks via inter-lane edges ──
        # An edge from lane A to lane B means lane A feeds lane B
        lane_ranks = {i: 0 for i in range(num_lanes)}
        lane_adj: dict[int, set] = {i: set() for i in range(num_lanes)}
        lane_in_deg: dict[int, int] = {i: 0 for i in range(num_lanes)}

        for e in ir.edges:
            src_lane = node_to_lane.get(e.src)
            dst_lane = node_to_lane.get(e.dst)
            if src_lane is not None and dst_lane is not None and src_lane != dst_lane:
                if dst_lane not in lane_adj[src_lane]:
                    lane_adj[src_lane].add(dst_lane)
                    lane_in_deg[dst_lane] = lane_in_deg.get(dst_lane, 0) + 1

        from collections import deque
        remaining_in_deg = dict(lane_in_deg)
        topo_queue = deque([i for i in range(num_lanes) if remaining_in_deg.get(i, 0) == 0])
        visited_lanes: set = set()

        # Process acyclic portion
        while topo_queue:
            li = topo_queue.popleft()
            if li in visited_lanes:
                continue
            visited_lanes.add(li)
            for nb in lane_adj.get(li, set()):
                if nb in visited_lanes:
                    continue
                lane_ranks[nb] = max(lane_ranks[nb], lane_ranks[li] + 1)
                remaining_in_deg[nb] -= 1
                if remaining_in_deg[nb] <= 0:
                    topo_queue.append(nb)

        # Cycle-breaking — all remaining lanes in cycles go to the SAME rank
        if len(visited_lanes) < num_lanes:
            cycle_rank = (max(lane_ranks[v] for v in visited_lanes) + 1) if visited_lanes else 1
            unvisited = [i for i in range(num_lanes) if i not in visited_lanes]
            for li in unvisited:
                lane_ranks[li] = cycle_rank
    else:
        # Fill in unmatched lanes using edge-based ranking relative to matched tiers
        unmatched = [i for i in range(num_lanes) if i not in lane_ranks]
        if unmatched:
            # Place unmatched lanes after the highest matched tier
            fallback_tier = max(lane_ranks.values()) + 1
            for li in unmatched:
                lane_ranks[li] = fallback_tier

    # ── Group lanes by their rank (same rank → same row) ──
    lane_rows: dict[int, list] = {}  # rank -> list of lane indices
    for lane_idx, rank_val in lane_ranks.items():
        lane_rows.setdefault(rank_val, []).append(lane_idx)

    # ── Compute each lane's internal dimensions ──
    # Within each lane, nodes are placed LR in a single row
    # (if lane has many nodes, they wrap to fit max_lane_width)
    lane_dims: dict[int, tuple] = {}  # lane_idx -> (width, height)
    for lane_idx, (sg_id, sg_label, members) in enumerate(main_bands):
        if not members:
            lane_dims[lane_idx] = (0, 0)
            continue
        # Single row LR layout
        total_w = sum(get_nw(m) for m in members) + node_h_gap * max(0, len(members) - 1)
        lane_dims[lane_idx] = (total_w, cell_h)

    # ── Position lanes in 2D grid ──
    # Lanes at same rank wrap to sub-rows using width-based bin packing
    lane_positions: dict[int, tuple] = {}  # lane_idx -> (lane_x, lane_y)
    max_row_width = 1200  # max pixels per visual row before wrapping
    pad = 16              # container internal padding per side
    header_h = 26         # container header/title height

    y_cursor = 40
    for rank_val in sorted(lane_rows.keys()):
        lanes_in_row = lane_rows[rank_val]
        # Sort by width ascending so greedy packing balances rows
        lanes_in_row.sort(key=lambda li: lane_dims[li][0])

        # Greedy bin-packing: assign lanes to sub-rows by cumulative width
        sub_rows: list[list[int]] = [[]]
        sub_row_widths: list[float] = [0]
        for li in reversed(lanes_in_row):  # widest first for greedy
            lw = lane_dims[li][0] + pad * 2
            # Find the sub-row with the most remaining space
            placed = False
            for sr_idx in range(len(sub_rows)):
                gap_needed = lane_h_gap if sub_rows[sr_idx] else 0
                if sub_row_widths[sr_idx] + gap_needed + lw <= max_row_width:
                    sub_rows[sr_idx].append(li)
                    sub_row_widths[sr_idx] += gap_needed + lw
                    placed = True
                    break
            if not placed:
                sub_rows.append([li])
                sub_row_widths.append(lw)

        # Position each sub-row
        for chunk in sub_rows:
            if not chunk:
                continue
            x_cursor = 40
            max_row_height = 0
            for li in chunk:
                lw, lh = lane_dims[li]
                lane_positions[li] = (x_cursor, y_cursor)
                x_cursor += lw + lane_h_gap + pad * 2
                max_row_height = max(max_row_height, lh)

            # Advance y past this sub-row (node height + header + padding + routing gap)
            y_cursor += max_row_height + header_h + pad * 2 + lane_v_gap

    # ── Position nodes within their lanes ──
    # Also track row boundaries for edge routing channels
    row_bottoms: list[float] = []  # y-coordinate of each visual row's bottom edge
    for lane_idx, (sg_id, sg_label, members) in enumerate(main_bands):
        if not members or lane_idx not in lane_positions:
            continue
        lane_x, lane_y = lane_positions[lane_idx]
        # Place nodes LR within lane
        x_inner = lane_x
        for nid in members:
            nw = get_nw(nid)
            positions[nid] = (x_inner, lane_y, nw, cell_h)
            x_inner += nw + node_h_gap

    # Compute routing channels (y-midpoints between adjacent visual rows)
    # These are horizontal corridors where edges can route without crossing nodes
    all_row_ys = sorted(set(lane_positions[li][1] for li in lane_positions))
    routing_channels: list[float] = []
    for i in range(len(all_row_ys) - 1):
        # Channel is in the gap between row i bottom and row i+1 top
        row_bottom = all_row_ys[i] + cell_h + header_h + pad
        row_next_top = all_row_ys[i + 1] - pad
        channel_y = (row_bottom + row_next_top) / 2
        routing_channels.append(channel_y)

    # Store layout metadata for edge routing
    positions['__routing_channels__'] = routing_channels
    positions['__row_ys__'] = all_row_ys
    positions['__lane_v_gap__'] = lane_v_gap
    positions['__header_h__'] = header_h
    positions['__pad__'] = pad

    # ── Position legend band at the bottom ──
    for sg_id, sg_label, members in legend_bands:
        if not members:
            continue
        x_inner = 40
        for nid in members:
            nw = get_nw(nid)
            positions[nid] = (x_inner, y_cursor, nw, cell_h)
            x_inner += nw + node_h_gap

    return positions


def _layout_sequence(ir: DiagramIR, cell_w, cell_h, h_gap, v_gap):
    positions = {}
    actor_order = [n.id for n in ir.nodes]
    x_step = cell_w + h_gap + 60
    for i, aid in enumerate(actor_order):
        x = 40 + i * x_step
        positions[aid] = (x, 20, cell_w, cell_h)
    return positions


# ──────────────────────────────────────────────────────────────────────────────
# draw.io exporter
# ──────────────────────────────────────────────────────────────────────────────

DRAWIO_SHAPE_STYLES = {
    'rectangle':    'rounded=0;whiteSpace=wrap;html=1;',
    'rounded':      'rounded=1;arcSize=50;whiteSpace=wrap;html=1;',
    'diamond':      'rhombus;whiteSpace=wrap;html=1;',
    'ellipse':      'ellipse;whiteSpace=wrap;html=1;',
    'cylinder':     'shape=cylinder3;whiteSpace=wrap;html=1;',
    'parallelogram':'shape=parallelogram;whiteSpace=wrap;html=1;',
    'asymmetric':   'shape=step;whiteSpace=wrap;html=1;',
}

DRAWIO_EDGE_STYLES = {
    ('normal', 'solid'):  'endArrow=block;endFill=1;',
    ('open',   'solid'):  'endArrow=open;endFill=0;',
    ('none',   'solid'):  'endArrow=none;',
    ('normal', 'dashed'): 'endArrow=block;endFill=1;dashed=1;',
    ('open',   'dashed'): 'endArrow=open;endFill=0;dashed=1;',
    ('none',   'dashed'): 'endArrow=none;dashed=1;',
    ('normal', 'thick'):  'endArrow=block;endFill=1;strokeWidth=3;',
}

# ── Edge Classification → Routing Strategy ──
# All edges use orthogonalEdgeStyle. The classification determines
# the waypoint strategy (none, right-margin, or left-margin routing).
EDGE_ROUTING_STYLES = {
    'same_row':    'edgeStyle=orthogonalEdgeStyle;curved=0;',
    'adjacent':    'edgeStyle=orthogonalEdgeStyle;',
    'multi_right': 'edgeStyle=orthogonalEdgeStyle;',
    'multi_left':  'edgeStyle=orthogonalEdgeStyle;',
}

# Threshold: if source node center-x is below this, use left-margin routing
LEFT_MARGIN_THRESHOLD = 150


def _classify_edge(src_row: int, dst_row: int, src_cx: float, dst_cx: float,
                   node_w: float = 120) -> str:
    """Classify an edge for routing strategy.

    Returns a key into EDGE_ROUTING_STYLES.
    - same_row: horizontal within a lane, no waypoints
    - adjacent: 1 tier hop, no waypoints (draw.io auto-routes)
    - multi_right: 2+ tier hop, right-margin waypoint routing
    - multi_left: 2+ tier hop, left-margin waypoint routing
    """
    if src_row == dst_row:
        return 'same_row'
    span = abs(dst_row - src_row)
    if span == 1:
        return 'adjacent'
    # Multi-hop: choose left or right margin based on source position
    if src_cx < LEFT_MARGIN_THRESHOLD:
        return 'multi_left'
    return 'multi_right'


def export_drawio(ir: DiagramIR) -> str:
    positions = compute_layout(ir)
    cell_id = 2  # 0 and 1 are reserved by draw.io

    # Extract routing metadata BEFORE computing page dimensions
    routing_channels = positions.pop('__routing_channels__', [])
    row_ys = positions.pop('__row_ys__', [])
    _lane_v_gap = positions.pop('__lane_v_gap__', 80)
    _header_h = positions.pop('__header_h__', 26)
    _pad = positions.pop('__pad__', 16)

    # Compute page dimensions — single page that fits all content (no page breaks)
    if positions:
        max_x = max(x + w for x, y, w, h in positions.values()) + 80
        max_y = max(y + h for x, y, w, h in positions.values()) + 80
        # Account for subgraph containers + lane headers + edge routing margin
        if ir.groups:
            max_x += 120
            max_y += 120
        page_w = max(max_x, 800)
        page_h = max(max_y, 600)
        # Right margin routing column for long-distance edges
        route_right_x = max(x + w for x, y, w, h in positions.values()) + 60
    else:
        page_w, page_h = 1169, 827
        route_right_x = 900

    # page='0' disables page breaks — diagram is a single infinite canvas fitted to content
    # This prevents content from overflowing to a second page
    mxgraph = Element('mxGraphModel',
        dx='0', dy='0', grid='1', gridSize='10',
        guides='1', tooltips='1', connect='1', arrows='1',
        fold='1', page='0', pageScale='1', pageWidth=str(page_w),
        pageHeight=str(page_h), math='0', shadow='0')

    root = SubElement(mxgraph, 'root')
    SubElement(root, 'mxCell', id='0')
    SubElement(root, 'mxCell', id='1', parent='0')

    id_map: dict[str, str] = {}  # node.id -> cell_id string

    # ── sequence diagram handling ──
    if ir.diagram_type == 'sequence':
        return _export_drawio_sequence(ir, positions)

    # ── groups first (so members sit on top) ──
    group_cell_ids: dict[str, str] = {}
    group_origins: dict[str, tuple] = {}  # sg_id -> (gx, gy)
    pad = 16
    header_h = 22

    # Fallback lane colors if no style_defs provided (matching mermaid LANE_COLORS)
    fallback_lane_colors = [
        ('#E3F2FD', '#0078D4'),  # Azure blue
        ('#E8F5E9', '#2E7D32'),  # Green
        ('#FFFDE7', '#F9A825'),  # Yellow
        ('#FCE4EC', '#C62828'),  # Red
        ('#F3E5F5', '#7B1FA2'),  # Purple
        ('#E0F7FA', '#00ACC1'),  # Cyan
        ('#FFF3E0', '#FF9800'),  # Orange
    ]

    for lane_idx, (sg_id, sg_label, members) in enumerate(ir.groups):
        # Responsive bounding box — shrinks to fit actual content
        xs = [positions[m][0] for m in members if m in positions]
        ys = [positions[m][1] for m in members if m in positions]
        ws = [positions[m][2] for m in members if m in positions]
        hs = [positions[m][3] for m in members if m in positions]
        if not xs:
            continue
        gx = min(xs) - pad
        gy = min(ys) - header_h - pad
        # Width fits content (responsive, not uniform)
        gw = max(x + w for x, w in zip(xs, ws)) - gx + pad
        gh = max(y + h for y, h in zip(ys, hs)) - gy + pad

        gc_id = str(cell_id); cell_id += 1
        # Use lane style from parsed mermaid `style SG_ID ...` if available
        if sg_id in ir.style_defs:
            sd = ir.style_defs[sg_id]
            fill_color = sd.get('fill', fallback_lane_colors[lane_idx % len(fallback_lane_colors)][0])
            stroke_color = sd.get('stroke', fallback_lane_colors[lane_idx % len(fallback_lane_colors)][1])
        else:
            fill_color, stroke_color = fallback_lane_colors[lane_idx % len(fallback_lane_colors)]
        # Container style: rounded box with label header (no collapse/minimize button)
        # collapsible=0 removes the minimize icon; container=1 groups children
        sg_style = (f'rounded=1;whiteSpace=wrap;html=1;container=1;collapsible=0;'
                    f'fillColor={fill_color};strokeColor={stroke_color};strokeWidth=2;'
                    f'fontStyle=1;fontSize=12;verticalAlign=top;spacingTop=4;'
                    f'labelPosition=center;align=center;')
        gc = SubElement(root, 'mxCell', id=gc_id,
                        value=sg_label, style=sg_style, vertex='1',
                        parent='1')
        SubElement(gc, 'mxGeometry', x=str(gx), y=str(gy),
                   width=str(gw), height=str(gh), **{'as': 'geometry'})
        group_cell_ids[sg_id] = gc_id
        group_origins[sg_id] = (gx, gy)

    # ── member-to-group map ──
    member_parent: dict[str, str] = {}
    for sg_id, _, members in ir.groups:
        if sg_id in group_cell_ids:
            for m in members:
                member_parent[m] = sg_id

    # ── Pre-assign node IDs (needed so edges can reference them) ──
    for node in ir.nodes:
        nc_id = str(cell_id); cell_id += 1
        id_map[node.id] = nc_id

    def _get_node_row(node_id):
        """Find which visual row a node belongs to (index into row_ys)."""
        if node_id not in positions:
            return 0
        _, ny, _, _ = positions[node_id]
        for i, ry in enumerate(row_ys):
            if abs(ny - ry) < 5:  # tolerance for floating point
                return i
        # Closest row
        if row_ys:
            return min(range(len(row_ys)), key=lambda i: abs(row_ys[i] - ny))
        return 0

    # ── edges FIRST (rendered behind nodes in draw.io) ──
    # In draw.io, elements earlier in the XML are rendered behind later elements.
    # Emitting edges before nodes ensures connectors always go behind nodes.
    right_stagger = 0  # Offset counter for staggering right-margin routes
    left_stagger = 0   # Offset counter for staggering left-margin routes
    left_margin_x = 0  # Left margin x (left of all containers)

    for edge in ir.edges:
        src_id = id_map.get(edge.src)
        dst_id = id_map.get(edge.dst)
        if not src_id or not dst_id:
            continue
        style_key = (edge.arrow, edge.line)
        arrow_style = DRAWIO_EDGE_STYLES.get(style_key, DRAWIO_EDGE_STYLES[('normal', 'solid')])

        # Determine relative positions for exit/entry point constraints
        src_pos = positions.get(edge.src)
        dst_pos = positions.get(edge.dst)

        exit_entry = ''
        waypoints = []
        edge_class = 'adjacent'  # default

        if src_pos and dst_pos:
            sx, sy, sw, sh = src_pos
            tx, ty, tw, th = dst_pos
            src_cx, src_cy = sx + sw / 2, sy + sh / 2
            dst_cx, dst_cy = tx + tw / 2, ty + th / 2
            src_row = _get_node_row(edge.src)
            dst_row = _get_node_row(edge.dst)

            # Classify edge to determine routing strategy
            edge_class = _classify_edge(src_row, dst_row, src_cx, dst_cx, sw)

            if edge_class == 'same_row':
                # Same row → exit/enter from sides, no waypoints
                if dst_cx > src_cx:
                    exit_entry = 'exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;'
                else:
                    exit_entry = 'exitX=0;exitY=0.5;exitDx=0;exitDy=0;entryX=1;entryY=0.5;entryDx=0;entryDy=0;'

            elif edge_class == 'adjacent':
                # 1-tier hop: exit bottom/top, enter top/bottom, NO waypoints
                # draw.io auto-routes cleanly for single-lane gaps
                if dst_row > src_row:
                    exit_entry = 'exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;'
                else:
                    exit_entry = 'exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0;'

            elif edge_class == 'multi_right':
                # Right-margin routing: exit bottom/top, route via right margin
                stagger_x = route_right_x + right_stagger * 20
                right_stagger += 1
                if dst_row > src_row:
                    # Forward: exit bottom, route right margin, enter top
                    exit_entry = 'exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;'
                    first_ch = routing_channels[src_row] if src_row < len(routing_channels) else src_cy + 60
                    last_ch = routing_channels[dst_row - 1] if (dst_row - 1) < len(routing_channels) else dst_cy - 60
                    waypoints.append((stagger_x, first_ch))
                    waypoints.append((stagger_x, last_ch))
                else:
                    # Reverse: exit top, route right margin, enter bottom
                    exit_entry = 'exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0;'
                    first_ch = routing_channels[src_row - 1] if (src_row - 1) < len(routing_channels) else src_cy - 60
                    last_ch = routing_channels[dst_row] if dst_row < len(routing_channels) else dst_cy + 60
                    waypoints.append((stagger_x, first_ch))
                    waypoints.append((stagger_x, last_ch))

            elif edge_class == 'multi_left':
                # Left-margin routing: exit left side, route via left margin
                stagger_x = left_margin_x - left_stagger * 20
                left_stagger += 1
                if dst_row > src_row:
                    # Forward: exit left side, drop along left margin, enter bottom
                    exit_entry = 'exitX=0;exitY=0.5;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0;'
                    # Waypoints: left margin at source height, left margin below target, target cx below
                    below_target_y = dst_cy + th / 2 + 20
                    waypoints.append((stagger_x, src_cy))
                    waypoints.append((stagger_x, below_target_y))
                    waypoints.append((dst_cx, below_target_y))
                else:
                    # Reverse: exit left side, rise along left margin, enter top
                    exit_entry = 'exitX=0;exitY=0.5;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;'
                    above_target_y = dst_cy - th / 2 - 20
                    waypoints.append((stagger_x, src_cy))
                    waypoints.append((stagger_x, above_target_y))
                    waypoints.append((dst_cx, above_target_y))

        # Build edge style: arrow type + routing style + common styling
        routing_style = EDGE_ROUTING_STYLES.get(edge_class, 'edgeStyle=orthogonalEdgeStyle;')
        edge_style = (f'{arrow_style}'
                      f'{routing_style}'
                      'rounded=1;orthogonalLoop=1;'
                      'jettySize=auto;jumpStyle=arc;jumpSize=8;'
                      'sourcePerimeterSpacing=8;targetPerimeterSpacing=8;'
                      f'{exit_entry}'
                      'strokeColor=#333333;strokeWidth=1.5;fontSize=10;'
                      'labelBackgroundColor=#FFFFFF;labelBorderColor=#CCCCCC;'
                      'spacingTop=2;spacingBottom=2;spacingLeft=4;spacingRight=4;')

        ec_id = str(cell_id); cell_id += 1
        ec = SubElement(root, 'mxCell', id=ec_id,
                        value=edge.label, style=edge_style,
                        edge='1', source=src_id, target=dst_id, parent='1')
        # Position label strategically based on edge type:
        # - Same-row/adjacent: midpoint (short edges, label centered)
        # - Multi-hop: closer to source end so label is near the originating node
        if edge_class in ('same_row', 'adjacent'):
            label_x = '0'       # midpoint of short edge
            label_y_off = '-12'  # offset above line
        else:
            label_x = '-0.7'    # 85% toward source — label near source node
            label_y_off = '0'   # on-line (margin routing gives space)
        geo = SubElement(ec, 'mxGeometry', x=label_x, y='0', relative='1', **{'as': 'geometry'})
        SubElement(geo, 'mxPoint', x='0', y=label_y_off, **{'as': 'offset'})

        # Add waypoints if computed
        if waypoints:
            points_arr = SubElement(geo, 'Array', **{'as': 'points'})
            for wp_x, wp_y in waypoints:
                SubElement(points_arr, 'mxPoint', x=str(int(wp_x)), y=str(int(wp_y)))

    # ── nodes (rendered on top of edges) ──
    for node in ir.nodes:
        pos = positions.get(node.id, (40, 40, 160, 80))
        x, y, w, h = pos
        style = DRAWIO_SHAPE_STYLES.get(node.shape, DRAWIO_SHAPE_STYLES['rectangle'])

        # Apply colors from mermaid classDef if node has a css_class
        if node.css_class and node.css_class in ir.class_defs:
            cd = ir.class_defs[node.css_class]
            if 'fill' in cd:
                style += f'fillColor={cd["fill"]};'
            if 'stroke' in cd:
                style += f'strokeColor={cd["stroke"]};'
            if 'color' in cd:
                style += f'fontColor={cd["color"]};'
            if 'stroke-width' in cd:
                style += f'strokeWidth={cd["stroke-width"].replace("px","")};'
            if 'stroke-dasharray' in cd:
                style += 'dashed=1;'
        else:
            # Default node style (light blue, like ArchiMate Application)
            style += 'fillColor=#CCE5FF;strokeColor=#0078D4;fontColor=#003A6C;'
        style += 'fontSize=13;fontStyle=1;'

        parent_id = '1'
        sg_id = member_parent.get(node.id)
        if sg_id and sg_id in group_cell_ids:
            parent_id = group_cell_ids[sg_id]
            # Convert to coordinates relative to the group container
            gx, gy = group_origins[sg_id]
            x = x - gx
            y = y - gy

        nc_id = id_map[node.id]
        nc = SubElement(root, 'mxCell', id=nc_id,
                        value=node.label, style=style,
                        vertex='1', parent=parent_id)
        SubElement(nc, 'mxGeometry', x=str(x), y=str(y),
                   width=str(w), height=str(h), **{'as': 'geometry'})

    # ── serialise ──
    rough = tostring(mxgraph, encoding='unicode')
    pretty = minidom.parseString(rough).toprettyxml(indent='  ')
    # strip the XML declaration minidom adds (draw.io doesn't need it)
    lines = pretty.split('\n')
    if lines[0].startswith('<?xml'):
        lines = lines[1:]
    return '\n'.join(lines)


def _export_drawio_sequence(ir: DiagramIR, positions: dict) -> str:
    """Specialised draw.io export for sequence diagrams using swimlanes."""
    cell_id = 2
    mxgraph = Element('mxGraphModel', dx='1422', dy='762', grid='1', gridSize='10',
                       guides='1', tooltips='1', connect='1', arrows='1',
                       fold='1', page='1', pageScale='1', pageWidth='1169',
                       pageHeight='827', math='0', shadow='0')
    root = SubElement(mxgraph, 'root')
    SubElement(root, 'mxCell', id='0')
    SubElement(root, 'mxCell', id='1', parent='0')

    id_map: dict[str, str] = {}
    actor_ids = [n.id for n in ir.nodes]
    x_step = 220
    actor_x: dict[str, int] = {}

    # Actor boxes at top
    for i, aid in enumerate(actor_ids):
        x = 40 + i * x_step
        actor_x[aid] = x + 80   # centre of the box
        nc_id = str(cell_id); cell_id += 1
        id_map[aid] = nc_id
        nc = SubElement(root, 'mxCell', id=nc_id,
                        value=aid,
                        style='shape=mxgraph.flowchart.start_2;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;',
                        vertex='1', parent='1')
        SubElement(nc, 'mxGeometry', x=str(x), y='20',
                   width='160', height='60', **{'as': 'geometry'})

    # Lifeline verticals
    total_h = 80 + len(ir.sequences) * 60 + 40
    for aid in actor_ids:
        ax = actor_x[aid]
        lc_id = str(cell_id); cell_id += 1
        lc = SubElement(root, 'mxCell', id=lc_id, value='',
                        style='endArrow=none;dashed=1;strokeColor=#999999;',
                        edge='1', parent='1')
        geo = SubElement(lc, 'mxGeometry', relative='1', **{'as': 'geometry'})
        pts = SubElement(geo, 'Array', **{'as': 'points'})
        SubElement(geo, 'mxPoint', x=str(ax), y='80', **{'as': 'sourcePoint'})
        SubElement(geo, 'mxPoint', x=str(ax), y=str(total_h), **{'as': 'targetPoint'})

    # Messages
    for idx, (a, b, msg, arrow, linestyle) in enumerate(ir.sequences):
        y = 100 + idx * 60
        ax = actor_x.get(a, 100)
        bx = actor_x.get(b, 300)
        edge_style = f'endArrow={"block" if arrow == "normal" else "open"};endFill={"1" if arrow == "normal" else "0"};'
        if linestyle == 'dashed':
            edge_style += 'dashed=1;'
        mc_id = str(cell_id); cell_id += 1
        mc = SubElement(root, 'mxCell', id=mc_id, value=msg,
                        style=edge_style + 'exitX=0.5;exitY=0.5;entryX=0.5;entryY=0.5;',
                        edge='1', parent='1')
        geo = SubElement(mc, 'mxGeometry', relative='1', **{'as': 'geometry'})
        SubElement(geo, 'mxPoint', x=str(ax), y=str(y), **{'as': 'sourcePoint'})
        SubElement(geo, 'mxPoint', x=str(bx), y=str(y), **{'as': 'targetPoint'})

    rough = tostring(mxgraph, encoding='unicode')
    pretty = minidom.parseString(rough).toprettyxml(indent='  ')
    lines = pretty.split('\n')
    if lines[0].startswith('<?xml'):
        lines = lines[1:]
    return '\n'.join(lines)


# ──────────────────────────────────────────────────────────────────────────────
# Visio (VSDX) exporter
# VSDX is a ZIP archive containing XML parts.
# We generate a minimal but fully editable file.
# ──────────────────────────────────────────────────────────────────────────────

VSDX_CONTENT_TYPES = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/visio/document.xml"
    ContentType="application/vnd.ms-visio.drawing.main+xml"/>
  <Override PartName="/visio/pages/page1.xml"
    ContentType="application/vnd.ms-visio.page+xml"/>
</Types>
"""

VSDX_ROOT_RELS = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document"
    Target="visio/document.xml"/>
</Relationships>
"""

VSDX_DOCUMENT_RELS = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/page"
    Target="pages/page1.xml"/>
</Relationships>
"""

VSDX_DOCUMENT = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisioDocument xmlns="http://schemas.microsoft.com/office/visio/2012/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <DocumentSheet NameU="TheDoc" UniqueID="{00000000-0000-0000-0000-000000000001}"/>
  <Pages>
    <Page ID="1" NameU="Page-1">
      <Rel r:id="rId1"/>
    </Page>
  </Pages>
</VisioDocument>
"""


def _vsdx_shape(shape_id: int, node: Node, x: float, y: float, w: float, h: float) -> str:
    """Generate a Visio Shape XML element as a string."""
    # Visio uses inches; convert px at 96dpi
    px_to_in = 1 / 96.0
    vx = x * px_to_in
    vy = y * px_to_in
    vw = w * px_to_in
    vh = h * px_to_in

    # Visio origin is bottom-left; page height 11 inches (letter)
    page_h = 11.0
    vy_visio = page_h - vy - vh

    shape_map = {
        'diamond':   'msoShapeType="5"',
        'ellipse':   'msoShapeType="9"',
        'rounded':   'msoShapeType="5"',
        'cylinder':  'msoShapeType="22"',
        'rectangle': '',
    }

    label_xml = node.label.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

    return f"""    <Shape ID="{shape_id}" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3">
      <XForm>
        <PinX>{vx + vw/2:.4f}</PinX>
        <PinY>{vy_visio + vh/2:.4f}</PinY>
        <Width>{vw:.4f}</Width>
        <Height>{vh:.4f}</Height>
        <LocPinX>0.5</LocPinX>
        <LocPinY>0.5</LocPinY>
        <Angle>0</Angle>
        <FlipX>0</FlipX>
        <FlipY>0</FlipY>
        <ResizeMode>0</ResizeMode>
      </XForm>
      <Fill>
        <FillForegnd>RGB(219,235,247)</FillForegnd>
        <FillBkgnd>RGB(255,255,255)</FillBkgnd>
      </Fill>
      <Line>
        <LineWeight>0.01</LineWeight>
        <LineColor>RGB(108,142,191)</LineColor>
      </Line>
      <Text><cp IX="0"/>{label_xml}</Text>
    </Shape>"""


def _vsdx_connector(conn_id: int, edge: Edge, src_id: int, dst_id: int,
                     src_pos: tuple, dst_pos: tuple) -> str:
    px_to_in = 1 / 96.0
    page_h = 11.0

    sx = (src_pos[0] + src_pos[2] / 2) * px_to_in
    sy = page_h - (src_pos[1] + src_pos[3]) * px_to_in
    ex = (dst_pos[0] + dst_pos[2] / 2) * px_to_in
    ey = page_h - dst_pos[1] * px_to_in

    label_xml = edge.label.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    dashed = '1' if edge.line == 'dashed' else '0'

    return f"""    <Shape ID="{conn_id}" Type="Edge" LineStyle="3" FillStyle="3" TextStyle="3">
      <XForm1D>
        <BeginX>{sx:.4f}</BeginX>
        <BeginY>{sy:.4f}</BeginY>
        <EndX>{ex:.4f}</EndX>
        <EndY>{ey:.4f}</EndY>
      </XForm1D>
      <Line>
        <LinePattern>{dashed}</LinePattern>
      </Line>
      <Connect FromSheet="{conn_id}" FromCell="BeginX" ToSheet="{src_id}" ToCell="PinX"/>
      <Connect FromSheet="{conn_id}" FromCell="EndX"   ToSheet="{dst_id}" ToCell="PinX"/>
      <Text><cp IX="0"/>{label_xml}</Text>
    </Shape>"""


def export_vsdx(ir: DiagramIR) -> bytes:
    positions = compute_layout(ir)
    shapes_xml_parts = []
    id_map: dict[str, int] = {}
    shape_id = 1

    for node in ir.nodes:
        pos = positions.get(node.id, (40, 40, 160, 80))
        id_map[node.id] = shape_id
        shapes_xml_parts.append(_vsdx_shape(shape_id, node, *pos))
        shape_id += 1

    for edge in ir.edges:
        src_id = id_map.get(edge.src)
        dst_id = id_map.get(edge.dst)
        if src_id and dst_id:
            src_pos = positions.get(edge.src, (0, 0, 160, 80))
            dst_pos = positions.get(edge.dst, (0, 0, 160, 80))
            shapes_xml_parts.append(_vsdx_connector(shape_id, edge, src_id, dst_id, src_pos, dst_pos))
            shape_id += 1

    shapes_block = '\n'.join(shapes_xml_parts)

    page_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xml:space="preserve">
  <Shapes>
{shapes_block}
  </Shapes>
</PageContents>
"""

    # pack into ZIP
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml',               VSDX_CONTENT_TYPES)
        zf.writestr('_rels/.rels',                        VSDX_ROOT_RELS)
        zf.writestr('visio/document.xml',                 VSDX_DOCUMENT)
        zf.writestr('visio/_rels/document.xml.rels',      VSDX_DOCUMENT_RELS)
        zf.writestr('visio/pages/page1.xml',              page_xml)
        zf.writestr('visio/pages/_rels/page1.xml.rels',
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<Relationships xmlns="http://schemas.openxmlformats.org/'
                    'package/2006/relationships"/>')
    return buf.getvalue()


# ──────────────────────────────────────────────────────────────────────────────
# Demo content
# ──────────────────────────────────────────────────────────────────────────────

DEMO_FLOWCHART = """\
flowchart TD
    A([Start]) --> B{Validate Input}
    B -->|Valid| C[Process Request]
    B -->|Invalid| D[Return Error]
    C --> E[(Database)]
    C --> F[/Generate Report/]
    E --> G([End])
    F --> G

    subgraph Processing [Core Processing]
        C
        E
        F
    end
"""

DEMO_SEQUENCE = """\
sequenceDiagram
    participant UI as Web UI
    participant API as REST API
    participant DB as PostgreSQL

    UI ->> API: POST /orders
    API ->> DB: INSERT order
    DB -->> API: order_id
    API -->> UI: 201 Created
    UI ->> API: GET /orders/123
    API ->> DB: SELECT order
    DB -->> API: order data
    API -->> UI: 200 OK
"""

DEMO_CLASS = """\
classDiagram
    class Animal {
        +String name
        +int age
        +speak() String
    }
    class Dog {
        +String breed
        +fetch() void
    }
    class Cat {
        +bool indoor
        +purr() void
    }
    Animal <|-- Dog
    Animal <|-- Cat
"""


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Convert Mermaid diagrams to draw.io or Visio (.vsdx)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Examples:
              python mermaid_converter.py diagram.mmd --format drawio
              python mermaid_converter.py diagram.mmd --format vsdx --output out.vsdx
              python mermaid_converter.py --demo
        """))

    parser.add_argument('input',         nargs='?',  help='.mmd source file')
    parser.add_argument('--format', '-f', default='drawio',
                        choices=['drawio', 'vsdx', 'both'],
                        help='Output format (default: drawio)')
    parser.add_argument('--output', '-o', default=None,
                        help='Output file path (auto-named if omitted)')
    parser.add_argument('--demo',  action='store_true',
                        help='Run demo: generate sample diagrams and convert both formats')

    args = parser.parse_args()

    if args.demo:
        _run_demo()
        return

    if not args.input:
        parser.print_help()
        sys.exit(1)

    with open(args.input, 'r', encoding='utf-8') as f:
        source = f.read()

    stem = os.path.splitext(args.input)[0]
    _convert_and_save(source, args.format, args.output, stem)


def _convert_and_save(source: str, fmt: str, output: Optional[str], stem: str):
    ir = parse_mermaid(source)
    print(f"  Diagram type  : {ir.diagram_type}")
    print(f"  Nodes         : {len(ir.nodes)}")
    print(f"  Edges         : {len(ir.edges)}")
    if ir.sequences:
        print(f"  Messages      : {len(ir.sequences)}")
    if ir.groups:
        print(f"  Groups        : {len(ir.groups)}")

    if fmt in ('drawio', 'both'):
        path = output if (output and fmt != 'both') else stem + '.drawio'
        xml = export_drawio(ir)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(xml)
        print(f"  ✓ draw.io     : {path}")

    if fmt in ('vsdx', 'both'):
        path = output if (output and fmt != 'both') else stem + '.vsdx'
        data = export_vsdx(ir)
        with open(path, 'wb') as f:
            f.write(data)
        print(f"  ✓ Visio       : {path}")


def _run_demo():
    demos = [
        ('demo_flowchart', DEMO_FLOWCHART),
        ('demo_sequence',  DEMO_SEQUENCE),
        ('demo_class',     DEMO_CLASS),
    ]
    for stem, source in demos:
        print(f"\n── {stem} ──")
        mmd_path = f'/home/claude/{stem}.mmd'
        with open(mmd_path, 'w') as f:
            f.write(source)
        _convert_and_save(source, 'both', None, f'/home/claude/{stem}')


if __name__ == '__main__':
    main()


# ──────────────────────────────────────────────────────────────────────────────
# IR → Mermaid serializer
# Converts a DiagramIR back to clean Mermaid source text.
# This closes the round-trip: drawio/vsdx → IR → Mermaid → preview/ADA ingest
# ──────────────────────────────────────────────────────────────────────────────

# Shape → Mermaid node syntax
SHAPE_TO_MERMAID = {
    'rectangle':    ('[', ']'),
    'rounded':      ('([', '])'),   # stadium / pill
    'ellipse':      ('((', '))'),
    'diamond':      ('{', '}'),
    'cylinder':     ('[(', ')]'),
    'parallelogram':('[/', '/]'),
    'asymmetric':   ('>', ']'),
}

# Arrow/line → Mermaid edge syntax
EDGE_TO_MERMAID = {
    ('normal', 'solid'):  '-->',
    ('open',   'solid'):  '-->',
    ('none',   'solid'):  '---',
    ('normal', 'dashed'): '-. ->',
    ('open',   'dashed'): '-. ->',
    ('none',   'dashed'): '-.-',
    ('normal', 'thick'):  '==>',
}

# Sequence message types → Mermaid arrow
SEQ_ARROW = {
    ('normal', 'solid'):  '->>',
    ('open',   'solid'):  '->',
    ('none',   'solid'):  '-)',
    ('normal', 'dashed'): '-->>',
    ('open',   'dashed'): '-->',
    ('none',   'dashed'): '--)',
}


def _safe_id(raw: str) -> str:
    """Ensure node ID is valid Mermaid identifier (alphanum + underscore)."""
    cleaned = re.sub(r'[^A-Za-z0-9_]', '_', raw.strip())
    if cleaned and cleaned[0].isdigit():
        cleaned = 'n_' + cleaned
    return cleaned or 'node'


def _node_to_mermaid(node: Node, indent: str = '    ') -> str:
    """Render a single node as Mermaid syntax with optional class."""
    nid = _safe_id(node.id)
    label = node.label.replace('"', "'")
    open_b, close_b = SHAPE_TO_MERMAID.get(node.shape, ('[', ']'))
    class_suffix = f':::{node.css_class}' if node.css_class else ''
    return f'{indent}{nid}{open_b}"{label}"{close_b}{class_suffix}'


def serialize_mermaid(ir: DiagramIR) -> str:
    """
    Serialize a DiagramIR to clean Mermaid source text.

    Supports:
      - flowchart (all directions, subgraphs)
      - sequenceDiagram
      - classDiagram
      - erDiagram
    """
    if ir.diagram_type == 'sequence':
        return _serialize_sequence(ir)
    if ir.diagram_type == 'class':
        return _serialize_class(ir)
    if ir.diagram_type == 'er':
        return _serialize_er(ir)
    return _serialize_flowchart(ir)


def _serialize_flowchart(ir: DiagramIR) -> str:
    lines = []

    # Emit %%{init}%% header for consistent rendering
    lines.append('%%{init: {"theme": "base", "securityLevel": "loose", '
                 '"themeVariables": {"fontSize": "18px"}, '
                 '"flowchart": {"useMaxWidth": true, "htmlLabels": true, '
                 '"nodeSpacing": 50, "rankSpacing": 60}} }%%')
    lines.append(f'flowchart {ir.direction}')

    # Emit classDef declarations (preserved from original or defaults)
    if ir.class_defs:
        for class_name, props in ir.class_defs.items():
            prop_str = ','.join(f'{k}:{v}' for k, v in props.items())
            lines.append(f'    classDef {class_name} {prop_str}')
        lines.append('')

    # Build group membership map
    member_to_group: dict[str, str] = {}
    for sg_id, _, members in ir.groups:
        for m in members:
            member_to_group[m] = sg_id

    # Nodes not in any group — emit top level
    grouped_members: set = set()
    for _, _, members in ir.groups:
        grouped_members.update(members)

    standalone = [n for n in ir.nodes if n.id not in grouped_members]
    for node in standalone:
        lines.append(_node_to_mermaid(node))

    # Subgraphs with direction LR for nodes within lanes
    for sg_id, sg_label, members in ir.groups:
        lines.append(f'')
        lines.append(f'    subgraph {_safe_id(sg_id)} ["{sg_label}"]')
        # Inner direction: LR for TB diagrams, TB for LR diagrams
        inner_dir = 'LR' if ir.direction in ('TB', 'TD') else 'TB'
        lines.append(f'        direction {inner_dir}')
        for nid in members:
            node_obj = next((n for n in ir.nodes if n.id == nid), None)
            if node_obj:
                lines.append(_node_to_mermaid(node_obj, indent='        '))
        lines.append(f'    end')

    # Edges
    if ir.edges:
        lines.append('')
    for edge in ir.edges:
        src = _safe_id(edge.src)
        dst = _safe_id(edge.dst)
        arrow = EDGE_TO_MERMAID.get((edge.arrow, edge.line), '-->')
        if edge.label:
            label_clean = edge.label.replace('"', "'")
            lines.append(f'    {src} {arrow}|"{label_clean}"| {dst}')
        else:
            lines.append(f'    {src} {arrow} {dst}')

    # Emit lane style declarations
    if ir.style_defs:
        lines.append('')
        for elem_id, props in ir.style_defs.items():
            prop_str = ','.join(f'{k}:{v}' for k, v in props.items())
            lines.append(f'    style {_safe_id(elem_id)} {prop_str}')

    return '\n'.join(lines) + '\n'


def _serialize_sequence(ir: DiagramIR) -> str:
    lines = ['sequenceDiagram']

    # Declare participants with aliases
    for node in ir.nodes:
        nid = _safe_id(node.id)
        label = node.label.replace('"', "'")
        if nid != label:
            lines.append(f'    participant {nid} as {label}')
        else:
            lines.append(f'    participant {nid}')

    if ir.sequences:
        lines.append('')

    for a, b, msg, arrow_type, linestyle in ir.sequences:
        src = _safe_id(a)
        dst = _safe_id(b)
        arrow = SEQ_ARROW.get((arrow_type, linestyle), '->>')
        msg_clean = msg.replace('"', "'")
        lines.append(f'    {src} {arrow} {dst}: {msg_clean}')

    for actor, note_text in ir.notes:
        lines.append(f'    Note over {_safe_id(actor)}: {note_text}')

    return '\n'.join(lines) + '\n'


def _serialize_class(ir: DiagramIR) -> str:
    lines = ['classDiagram']

    for node in ir.nodes:
        lines.append(f'    class {_safe_id(node.id)} {{')
        lines.append(f'    }}')

    if ir.edges:
        lines.append('')

    for edge in ir.edges:
        src = _safe_id(edge.src)
        dst = _safe_id(edge.dst)
        # infer relationship from arrow/line
        if edge.arrow == 'open' and edge.line == 'solid':
            rel = '<|--'
        elif edge.arrow == 'normal' and edge.line == 'dashed':
            rel = '<..'
        elif edge.arrow == 'none':
            rel = '--'
        else:
            rel = '-->'
        label_part = f' : {edge.label}' if edge.label else ''
        lines.append(f'    {src} {rel} {dst}{label_part}')

    return '\n'.join(lines) + '\n'


def _serialize_er(ir: DiagramIR) -> str:
    lines = ['erDiagram']

    for node in ir.nodes:
        lines.append(f'    {_safe_id(node.id)} {{')
        lines.append(f'    }}')

    if ir.edges:
        lines.append('')

    for edge in ir.edges:
        src = _safe_id(edge.src)
        dst = _safe_id(edge.dst)
        label = edge.label or 'relates_to'
        lines.append(f'    {src} ||--o| {dst} : "{label}"')

    return '\n'.join(lines) + '\n'


# ──────────────────────────────────────────────────────────────────────────────
# Extended CLI — add --to-mermaid flag
# ──────────────────────────────────────────────────────────────────────────────

def _convert_and_save_extended(source: str, fmt: str, output: Optional[str],
                                stem: str, to_mermaid: bool = False):
    ir = parse_mermaid(source)
    print(f"  Diagram type  : {ir.diagram_type}")
    print(f"  Nodes         : {len(ir.nodes)}")
    print(f"  Edges         : {len(ir.edges)}")

    if fmt in ('drawio', 'both'):
        path = (output if (output and fmt != 'both') else stem + '.drawio')
        xml = export_drawio(ir)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(xml)
        print(f"  ✓ draw.io     : {path}")

    if fmt in ('vsdx', 'both'):
        path = (output if (output and fmt != 'both') else stem + '.vsdx')
        data = export_vsdx(ir)
        with open(path, 'wb') as f:
            f.write(data)
        print(f"  ✓ Visio       : {path}")

    if to_mermaid:
        path = stem + '.roundtrip.mmd'
        mmd = serialize_mermaid(ir)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(mmd)
        print(f"  ✓ Mermaid RT  : {path}")


def roundtrip_demo():
    """Parse Mermaid → IR → serialize back to Mermaid. Validates the loop."""
    from io import StringIO
    demos = [
        ('flowchart', DEMO_FLOWCHART),
        ('sequence',  DEMO_SEQUENCE),
        ('class',     DEMO_CLASS),
    ]
    print('\n── Round-trip serializer demo ──')
    for name, source in demos:
        ir = parse_mermaid(source)
        out = serialize_mermaid(ir)
        lines = len([l for l in out.splitlines() if l.strip()])
        print(f'  {name:12s} → {len(ir.nodes)} nodes, {len(ir.edges)} edges → {lines} Mermaid lines')
        path = f'/home/claude/demo_{name}.roundtrip.mmd'
        with open(path, 'w') as f:
            f.write(out)
        print(f'               saved: {path}')
