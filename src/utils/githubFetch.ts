/**
 * GitHub API utilities for fetching XLSX files from the ADA-Artifacts repo.
 *
 * Uses the Git Trees API (one call, cached) to discover all file paths,
 * then the Git Blobs API to fetch content as ArrayBuffer.
 *
 * Auth: If VITE_GITHUB_TOKEN is set, uses it for 5,000 req/hr.
 * Otherwise falls back to unauthenticated (60 req/hr).
 * Long-term: replace with Azure Function proxy.
 */

const OWNER = 'sajivfrancis777';
const REPO = 'ADA-Artifacts';
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const BRANCH = 'main';

/* ── Auth headers ──────────────────────────────────────────────── */

const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_TOKEN as string | undefined;

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

/** Read-only API headers — usable without a write token (build-time token or unauthenticated). */
export function readApiHeaders(): Record<string, string> {
  return apiHeaders();
}

/* ── Types ─────────────────────────────────────────────────────── */

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

export interface FileInfo {
  /** 'All' for universal files, 'R1'-'R5' for release-specific */
  release: string;
  /** 'Current' or 'Future' */
  state: string;
}

/* ── Caches (in-memory, page lifetime) ────────────────────────── */

let pathIndex: Map<string, string> | null = null;

/**
 * In-memory blob cache: SHA → ArrayBuffer.
 * Since SHA is content-addressed, the same SHA always yields the same bytes.
 * Prevents redundant API calls when switching back to a previously loaded file.
 */
const blobCache = new Map<string, ArrayBuffer>();

/**
 * Fetch the full recursive tree from GitHub and build a path→SHA index.
 * Result is cached in memory (page lifetime) + sessionStorage (tab lifetime).
 */
async function ensureIndex(): Promise<Map<string, string>> {
  if (pathIndex) return pathIndex;

  // Try sessionStorage first (survives soft navigations, not hard refresh)
  const CACHE_KEY = 'iao-github-tree';
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const entries: [string, string][] = JSON.parse(cached);
      pathIndex = new Map(entries);
      return pathIndex;
    } catch { /* invalid cache, refetch */ }
  }

  const res = await fetch(`${API_BASE}/git/trees/${BRANCH}?recursive=1`, {
    headers: apiHeaders(),
  });

  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? 'GitHub API rate limit exceeded. Try again in a few minutes.'
        : `GitHub API error: ${res.status} ${res.statusText}`,
    );
  }

  const data: { tree: TreeEntry[]; truncated: boolean } = await res.json();
  pathIndex = new Map();
  for (const entry of data.tree) {
    if (entry.type === 'blob') {
      pathIndex.set(entry.path, entry.sha);
    }
  }

  // Cache in sessionStorage to avoid re-fetching on soft navigations
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify([...pathIndex]));
  } catch { /* storage full — fine, we have it in memory */ }

  return pathIndex;
}

/**
 * Invalidate the in-memory + sessionStorage tree cache so the next
 * ensureIndex() call re-fetches the tree from GitHub.
 * Call this after uploads or when expecting new files from background processing.
 */
export function invalidateTreeCache(): void {
  pathIndex = null;
  blobCache.clear();
  try { sessionStorage.removeItem('iao-github-tree'); } catch { /* ok */ }
}

/* ── Public API ────────────────────────────────────────────────── */

/**
 * Find the full repo path for a capability's file.
 * Matches pattern: towers/{tower}/<any L1 folder>/{capId}/input/data/{filename}
 */
export async function resolveFilePath(
  tower: string,
  capId: string,
  filename: string,
): Promise<string | null> {
  const index = await ensureIndex();
  const suffix = `/${capId}/input/data/${filename}`;

  for (const [path] of index) {
    if (path.startsWith(`towers/${tower}/`) && path.endsWith(suffix)) {
      return path;
    }
  }
  return null;
}

/**
 * Find the base directory path for a capability's input data folder.
 * Returns e.g. "towers/FPR/DS Provide Decision Support/DS-020/input/data/"
 * by scanning the tree index for ANY file in that capability's input/data/ dir.
 */
export async function resolveCapabilityBasePath(
  tower: string,
  capId: string,
): Promise<string | null> {
  const index = await ensureIndex();
  const marker = `/${capId}/input/data/`;

  for (const [path] of index) {
    if (path.startsWith(`towers/${tower}/`) && path.includes(marker)) {
      return path.substring(0, path.indexOf(marker) + marker.length);
    }
  }
  return null;
}

/**
 * List actual XLSX/BPMN files that exist for a capability in the repo.
 */
export async function listCapabilityFiles(
  tower: string,
  capId: string,
): Promise<string[]> {
  const index = await ensureIndex();
  const results: string[] = [];

  for (const [path] of index) {
    if (
      path.startsWith(`towers/${tower}/`) &&
      path.includes(`/${capId}/input/`)
    ) {
      results.push(path.split('/').pop()!);
    }
  }
  return results;
}

/**
 * Grouped file listing for a capability's input/ subfolders.
 * Returns filenames sorted into data/uploads/bpmn/extracts buckets.
 */
export interface CapabilityInputFiles {
  data: string[];
  uploads: string[];
  bpmn: string[];
  extracts: string[];
}

export async function listCapabilityInputFiles(
  tower: string,
  capId: string,
): Promise<CapabilityInputFiles> {
  const index = await ensureIndex();
  const result: CapabilityInputFiles = { data: [], uploads: [], bpmn: [], extracts: [] };

  for (const [path] of index) {
    if (!path.startsWith(`towers/${tower}/`) || !path.includes(`/${capId}/input/`)) continue;
    const filename = path.split('/').pop()!;
    if (path.includes('/input/data/'))     result.data.push(filename);
    else if (path.includes('/input/uploads/'))  result.uploads.push(filename);
    else if (path.includes('/input/bpmn/'))     result.bpmn.push(filename);
    else if (path.includes('/input/extracts/')) result.extracts.push(filename);
  }
  return result;
}

/**
 * Fetch a file from GitHub by its repo path and return as ArrayBuffer.
 * Uses the Git Blobs API (SHA-based) to avoid path-encoding issues.
 */
export async function fetchFileContent(repoPath: string): Promise<ArrayBuffer> {
  const index = await ensureIndex();
  const sha = index.get(repoPath);
  if (!sha) throw new Error(`File not found in repo: ${repoPath}`);

  // Return cached blob if we already fetched this SHA
  const cached = blobCache.get(sha);
  if (cached) return cached;

  const res = await fetch(`${API_BASE}/git/blobs/${sha}`, {
    headers: apiHeaders(),
  });

  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? 'GitHub API rate limit exceeded.'
        : `GitHub blob API: ${res.status} ${res.statusText}`,
    );
  }

  const data: { content: string; encoding: string } = await res.json();

  // Decode base64 → ArrayBuffer (strip whitespace GitHub adds to base64)
  const raw = atob(data.content.replace(/\s/g, ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  const buffer = bytes.buffer;
  blobCache.set(sha, buffer);
  return buffer;
}

/**
 * Parse release + state from an XLSX filename.
 *   CurrentFlows.xlsx       → { release: 'All', state: 'Current' }
 *   R3_FutureFlows.xlsx     → { release: 'R3',  state: 'Future' }
 */
export function parseFileInfo(filename: string): FileInfo {
  const m = filename.match(/^(?:(R\d+)_)?(Current|Future)Flows\.xlsx$/i);
  if (!m) return { release: 'All', state: 'Current' };
  return {
    release: m[1] ?? 'All',
    state: m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase(),
  };
}
