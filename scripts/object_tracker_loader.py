"""
S4 R3 Intel Object Tracker Loader
----------------------------------
Parses the Deloitte Object Tracker CSV and provides:
1. Structured access to 1,424 RICEFW objects
2. Object ID → Tower + Type decomposition
3. Cross-reference helpers for Smartsheet RICEFW join (via Console ID)
4. Interface flow extraction (Source → Middleware → Target)

Source: S4_R3_Intel_Object_Tracker.xlsx from Intel/Deloitte SharePoint
CSV export stored at: data/S4_R3_Object_Tracker.csv (cp1252 encoding)
"""

import csv
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Optional

# --- Constants ---

DATA_DIR = Path(__file__).parent.parent / "data"
CSV_PATH = DATA_DIR / "S4_R3_Object_Tracker.csv"

# Object ID prefix → Tower mapping (derived from data patterns)
TOWER_PREFIX_MAP = {
    "FPR": "FPR",
    "OTC": "OTC",      # further split by _IF / _IP suffix
    "FTS": "FTS",      # further split by _IF / _IP suffix
    "PTP": "PTP",
    "LOG": "LOG",      # Logistics (maps to FTS)
    "MDM": "MDM",
    "DATE": "MDM",     # Master Data
    "E2E": "E2E",
}

# Object Type code → RICEFW letter
TYPE_CODE_MAP = {
    "01.Report": "R",
    "02.Interface": "I",
    "03.Conversion": "C",
    "04.Enhancement": "E",
    "05.Form": "F",
    "06.Workflow": "W",
}

# Key column indices (avoid re-parsing headers every time)
KEY_COLUMNS = [
    "Development System", "Scope", "Release Name", "Console ID", "Object ID",
    "Object Type", "Business Unit", "System", "New TR", "Description",
    "Tower Name", "Sub-Tower Name", "Object Status", "Source System",
    "Target System", "Middleware", "Boundary App Involved?",
    "Boundary Application Name", "Boundary App. IAPM ID",
    "FS % Complete", "HLT % Complete", "S/4 TDD % Complete",
    "S/4 Build & TUT % Complete", "FUT % Complete",
]


class ObjectTrackerRecord:
    """Lightweight wrapper around a single object tracker row."""

    def __init__(self, row: dict):
        self._row = row

    @property
    def object_id(self) -> str:
        return self._row.get("Object ID", "").strip()

    @property
    def console_id(self) -> str:
        return self._row.get("Console ID", "").strip()

    @property
    def description(self) -> str:
        return self._row.get("Description", "").strip()

    @property
    def object_type(self) -> str:
        return self._row.get("Object Type", "").strip()

    @property
    def ricefw_letter(self) -> str:
        return TYPE_CODE_MAP.get(self.object_type, "?")

    @property
    def tower_name(self) -> str:
        return self._row.get("Tower Name", "").strip()

    @property
    def tower_short(self) -> str:
        """Derive short tower code from Tower Name (e.g., '03. FPR' → 'FPR')."""
        tn = self.tower_name
        # Strip leading number prefix like "03. " or "06. "
        m = re.match(r"\d+[A-Za-z]?\.\s*(.+)", tn)
        return m.group(1).strip() if m else tn

    @property
    def source_system(self) -> str:
        return self._row.get("Source System", "").strip()

    @property
    def target_system(self) -> str:
        return self._row.get("Target System", "").strip()

    @property
    def middleware(self) -> str:
        return self._row.get("Middleware", "").strip()

    @property
    def dev_system(self) -> str:
        return self._row.get("Development System", "").strip()

    @property
    def status(self) -> str:
        return self._row.get("Object Status", "").strip()

    @property
    def boundary_app(self) -> Optional[str]:
        if self._row.get("Boundary App Involved?", "").strip() == "01.Yes":
            return self._row.get("Boundary Application Name", "").strip() or None
        return None

    @property
    def boundary_iapm_id(self) -> Optional[str]:
        val = self._row.get("Boundary App. IAPM ID", "").strip()
        return val if val else None

    @property
    def is_interface(self) -> bool:
        return self.ricefw_letter == "I"

    def to_dict(self) -> dict:
        return {
            "object_id": self.object_id,
            "console_id": self.console_id,
            "description": self.description,
            "ricefw_type": self.ricefw_letter,
            "tower": self.tower_short,
            "source_system": self.source_system,
            "target_system": self.target_system,
            "middleware": self.middleware,
            "dev_system": self.dev_system,
            "status": self.status,
            "boundary_app": self.boundary_app,
            "boundary_iapm_id": self.boundary_iapm_id,
        }


class ObjectTrackerLoader:
    """Load and query the S4 R3 Object Tracker CSV."""

    def __init__(self, csv_path: Path = CSV_PATH):
        self._records: list[ObjectTrackerRecord] = []
        self._by_object_id: dict[str, ObjectTrackerRecord] = {}
        self._by_console_id: dict[str, list[ObjectTrackerRecord]] = defaultdict(list)
        self._load(csv_path)

    def _load(self, csv_path: Path):
        with open(csv_path, "r", encoding="cp1252") as f:
            reader = csv.DictReader(f)
            for row in reader:
                rec = ObjectTrackerRecord(row)
                self._records.append(rec)
                if rec.object_id:
                    self._by_object_id[rec.object_id] = rec
                if rec.console_id:
                    self._by_console_id[rec.console_id].append(rec)

    @property
    def count(self) -> int:
        return len(self._records)

    def get_by_object_id(self, obj_id: str) -> Optional[ObjectTrackerRecord]:
        return self._by_object_id.get(obj_id)

    def get_by_console_id(self, console_id: str) -> list[ObjectTrackerRecord]:
        return self._by_console_id.get(console_id, [])

    def filter_by_tower(self, tower: str) -> list[ObjectTrackerRecord]:
        """Filter by short tower name (FPR, PTP, OTC IF, etc.)."""
        tower_lower = tower.lower()
        return [r for r in self._records if tower_lower in r.tower_short.lower()]

    def filter_by_type(self, ricefw_letter: str) -> list[ObjectTrackerRecord]:
        """Filter by RICEFW type letter (R/I/C/E/F/W)."""
        return [r for r in self._records if r.ricefw_letter == ricefw_letter.upper()]

    def interfaces(self) -> list[ObjectTrackerRecord]:
        """Get all interface objects (type I)."""
        return self.filter_by_type("I")

    def interface_flows(self) -> list[dict]:
        """
        Extract integration flows from interface objects.
        Returns list of {object_id, source, middleware, target, tower, description}.
        """
        flows = []
        for rec in self.interfaces():
            if rec.source_system and rec.source_system != "NA":
                flows.append({
                    "object_id": rec.object_id,
                    "source": rec.source_system,
                    "middleware": rec.middleware if rec.middleware != "NA" else "",
                    "target": rec.target_system if rec.target_system != "NA" else "S/4",
                    "tower": rec.tower_short,
                    "description": rec.description,
                    "boundary_app": rec.boundary_app,
                })
        return flows

    def summary(self) -> dict:
        """Return summary statistics."""
        type_counts = Counter(r.ricefw_letter for r in self._records)
        tower_counts = Counter(r.tower_short for r in self._records)
        status_counts = Counter(r.status for r in self._records)
        mw_counts = Counter(
            r.middleware for r in self._records
            if r.middleware and r.middleware != "NA"
        )
        return {
            "total": self.count,
            "by_type": dict(type_counts.most_common()),
            "by_tower": dict(tower_counts.most_common()),
            "by_status": dict(status_counts.most_common()),
            "by_middleware": dict(mw_counts.most_common()),
            "interfaces_with_flow": len(self.interface_flows()),
        }

    def cross_reference_smartsheet(self, smartsheet_ids: set[str]) -> dict:
        """
        Cross-reference Console IDs against Smartsheet RICEFW IDs.
        Returns: {matched: [...], tracker_only: [...], smartsheet_only: [...]}
        """
        tracker_console_ids = set(self._by_console_id.keys())
        matched = tracker_console_ids & smartsheet_ids
        tracker_only = tracker_console_ids - smartsheet_ids
        smartsheet_only = smartsheet_ids - tracker_console_ids
        return {
            "matched": len(matched),
            "tracker_only": len(tracker_only),
            "smartsheet_only": len(smartsheet_only),
            "match_rate": f"{len(matched) / max(len(tracker_console_ids), 1) * 100:.1f}%",
        }


# --- CLI ---

if __name__ == "__main__":
    import json
    import sys

    loader = ObjectTrackerLoader()
    print(f"Loaded {loader.count} objects from {CSV_PATH.name}")
    print()

    summary = loader.summary()
    print("=== RICEFW Type Distribution ===")
    for t, c in summary["by_type"].items():
        print(f"  {t}: {c}")
    print()

    print("=== Tower Distribution ===")
    for t, c in summary["by_tower"].items():
        print(f"  {t}: {c}")
    print()

    print("=== Middleware (non-NA) ===")
    for m, c in summary["by_middleware"].items():
        print(f"  {m}: {c}")
    print()

    print(f"=== Interface Flows: {summary['interfaces_with_flow']} ===")
    flows = loader.interface_flows()
    print("Sample flows (first 10):")
    for flow in flows[:10]:
        mw = f" → [{flow['middleware']}]" if flow["middleware"] else ""
        print(f"  {flow['object_id']:15s} {flow['source']:20s}{mw} → {flow['target']}")
    print()

    # If --json flag, dump full interface flows
    if "--json" in sys.argv:
        print(json.dumps(flows, indent=2))
    elif "--tower" in sys.argv:
        idx = sys.argv.index("--tower") + 1
        if idx < len(sys.argv):
            tower = sys.argv[idx]
            filtered = loader.filter_by_tower(tower)
            print(f"\n=== Objects for tower '{tower}': {len(filtered)} ===")
            for r in filtered[:20]:
                print(f"  {r.object_id:15s} [{r.ricefw_letter}] {r.description[:60]}")
