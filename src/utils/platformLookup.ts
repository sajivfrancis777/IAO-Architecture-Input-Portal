/**
 * platformLookup.ts — Fetches the IAPM-derived system-platforms.json
 * from ADA-Artifacts GitHub Pages and provides a lookup for auto-filling
 * DB Platform and Tech Platform in the grid.
 *
 * Falls back to static SYSTEM_DEFAULTS when the remote JSON is unavailable.
 */
import { SYSTEM_DEFAULTS } from '../data/systemRegistry';

// ── Config ──────────────────────────────────────────────────────

const PLATFORM_JSON_BASE =
  import.meta.env.VITE_CONTEXT_INDEX_URL
    ? new URL('.', import.meta.env.VITE_CONTEXT_INDEX_URL).href
    : 'https://sajivfrancis777.github.io/ADA-Artifacts/';

const PLATFORM_JSON_URL = PLATFORM_JSON_BASE + 'system-platforms.json';

// ── Types ───────────────────────────────────────────────────────

export interface PlatformEntry {
  db: string;
  platform: string;
  hosting?: string;
  iapmId?: number;
  parentIapmId?: number;
  confidence?: 'iapm' | 'enriched' | 'assumed';
}

interface PlatformCache {
  generated: string;
  source: string;
  count: number;
  systems: Record<string, PlatformEntry>;
}

// ── In-memory cache ─────────────────────────────────────────────

let _cache: PlatformCache | null = null;
let _fetchPromise: Promise<PlatformCache | null> | null = null;

/**
 * Load the platform cache from ADA-Artifacts GitHub Pages.
 * Returns cached data on subsequent calls.
 * Returns null if fetch fails (caller should fall back to static defaults).
 */
export async function loadPlatformCache(): Promise<PlatformCache | null> {
  if (_cache) return _cache;
  if (_fetchPromise) return _fetchPromise;

  _fetchPromise = (async () => {
    try {
      const res = await fetch(PLATFORM_JSON_URL, { cache: 'no-cache' });
      if (!res.ok) {
        console.warn(`[ADA] system-platforms.json HTTP ${res.status}`);
        return null;
      }
      const data: PlatformCache = await res.json();
      if (data?.systems && typeof data.systems === 'object') {
        _cache = data;
        console.info(`[ADA] Loaded ${data.count} system platforms (source: ${data.source}, generated: ${data.generated})`);
        return _cache;
      }
      console.warn('[ADA] system-platforms.json has unexpected shape');
      return null;
    } catch (e) {
      console.warn('[ADA] Could not load system-platforms.json:', e);
      return null;
    }
  })();

  return _fetchPromise;
}

/**
 * Look up DB Platform and Tech Platform for a given system name.
 * Priority:
 *  1. Static SYSTEM_DEFAULTS (architect-curated, always wins)
 *  2. Remote system-platforms.json (IAPM-derived, 12K+ systems)
 *  3. null (no data available)
 */
export function getPlatformDefaults(systemName: string): { db: string; platform: string } | null {
  // 1. Static curated defaults always take priority
  const staticEntry = (SYSTEM_DEFAULTS as Record<string, { db: string; platform: string }>)[systemName];
  if (staticEntry) return staticEntry;

  // 2. Check remote cache (case-insensitive fuzzy match)
  if (_cache?.systems) {
    // Exact match first
    const exact = _cache.systems[systemName];
    if (exact) return { db: exact.db, platform: exact.platform };

    // Case-insensitive match
    const lower = systemName.toLowerCase();
    for (const [key, val] of Object.entries(_cache.systems)) {
      if (key.toLowerCase() === lower) {
        return { db: val.db, platform: val.platform };
      }
    }
  }

  return null;
}

/**
 * Synchronous check: is the platform cache loaded?
 * Use this to decide whether to show "loading..." indicators.
 */
export function isPlatformCacheReady(): boolean {
  return _cache !== null;
}

/**
 * Re-enrich flow rows: overwrite Source/Target DB Platform and Tech Platform
 * with canonical values from SYSTEM_DEFAULTS or the remote platform cache.
 * Only overwrites if a canonical entry exists for the system name.
 * Returns the number of cells corrected.
 */
export function enrichFlowPlatforms(rows: Record<string, unknown>[]): number {
  let corrected = 0;
  for (const row of rows) {
    const src = String(row['Source System'] || '');
    const tgt = String(row['Target System'] || '');
    if (src) {
      const d = getPlatformDefaults(src);
      if (d) {
        if (d.db && row['Source DB Platform'] !== d.db) { row['Source DB Platform'] = d.db; corrected++; }
        if (d.platform && row['Source Tech Platform'] !== d.platform) { row['Source Tech Platform'] = d.platform; corrected++; }
      }
    }
    if (tgt) {
      const d = getPlatformDefaults(tgt);
      if (d) {
        if (d.db && row['Target DB Platform'] !== d.db) { row['Target DB Platform'] = d.db; corrected++; }
        if (d.platform && row['Target Tech Platform'] !== d.platform) { row['Target Tech Platform'] = d.platform; corrected++; }
      }
    }
  }
  return corrected;
}
