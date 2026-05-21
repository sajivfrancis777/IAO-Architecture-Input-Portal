/**
 * githubMermaidSave.ts — Write edited .mmd files back to the ADA-Artifacts repo.
 *
 * When an architect edits a diagram in draw.io and saves, the resulting Mermaid
 * is written to the correct location in the repo so the document generation
 * pipeline picks it up automatically.
 *
 * Path convention:
 *   towers/{tower}/<L1 folder>/{capId}/input/data/{layer}Diagram.mmd
 *
 * If no draw.io edits were made, the document pipeline uses the auto-generated
 * Mermaid from Excel data (existing behavior, unchanged).
 */
import { resolveCapabilityBasePath, invalidateTreeCache } from './githubFetch';
import { getWriteToken } from './githubSave';
import type { ArchLayer } from './flowsToMermaid';

const OWNER = 'sajivfrancis777';
const REPO = 'ADA-Artifacts';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

export interface MermaidSaveResult {
  ok: boolean;
  message: string;
  commitSha?: string;
}

/**
 * Build the .mmd filename for a given architecture layer.
 * Convention: ApplicationDiagram.mmd, DataDiagram.mmd, TechnologyDiagram.mmd
 */
function layerFilename(layer: ArchLayer): string {
  const names: Record<ArchLayer, string> = {
    application: 'ApplicationDiagram.mmd',
    data: 'DataDiagram.mmd',
    technology: 'TechnologyDiagram.mmd',
  };
  return names[layer];
}

/**
 * Save edited Mermaid source to the ADA-Artifacts repo via GitHub Contents API.
 *
 * Creates or updates the .mmd file at the canonical path. The document generation
 * pipeline checks for these files and uses them if present; otherwise it falls
 * back to auto-generating from Excel data.
 */
export async function saveMermaidToGitHub(
  tower: string,
  capId: string,
  layer: ArchLayer,
  mermaidSource: string,
): Promise<MermaidSaveResult> {
  const token = getWriteToken();
  if (!token) {
    return { ok: false, message: 'No GitHub write token configured.' };
  }

  // Resolve the base path for this capability
  const basePath = await resolveCapabilityBasePath(tower, capId);
  if (!basePath) {
    return {
      ok: false,
      message: `Cannot resolve repo path for ${tower}/${capId}. Ensure the capability directory exists.`,
    };
  }

  const filename = layerFilename(layer);
  const path = `${basePath}${filename}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // Check if file already exists (get SHA for update)
  let existingSha: string | undefined;
  try {
    const getRes = await fetch(`${API}/${path}?ref=main`, { headers });
    if (getRes.ok) {
      const existing = await getRes.json();
      existingSha = existing.sha;
    } else if (getRes.status !== 404) {
      return { ok: false, message: `GitHub API error: ${getRes.status}` };
    }
  } catch (e) {
    return { ok: false, message: `Network error: ${e instanceof Error ? e.message : 'unknown'}` };
  }

  // Encode content as base64
  const encoder = new TextEncoder();
  const bytes = encoder.encode(mermaidSource);
  const content = btoa(String.fromCharCode(...bytes));

  const commitMsg = `Update ${layer} diagram for ${tower}/${capId} (draw.io edit)`;

  const body: Record<string, unknown> = {
    message: commitMsg,
    content,
    branch: 'main',
  };
  if (existingSha) body.sha = existingSha;

  try {
    const putRes = await fetch(`${API}/${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });

    if (putRes.ok || putRes.status === 201) {
      const result = await putRes.json();
      invalidateTreeCache();
      return {
        ok: true,
        message: existingSha ? 'Updated .mmd on GitHub' : 'Created .mmd on GitHub',
        commitSha: result.commit?.sha,
      };
    }

    if (putRes.status === 401) {
      return { ok: false, message: 'GitHub token is invalid or expired.' };
    }
    if (putRes.status === 409) {
      return { ok: false, message: 'Conflict — file was modified externally. Reload and retry.' };
    }
    return { ok: false, message: `GitHub API error: ${putRes.status}` };
  } catch (e) {
    return { ok: false, message: `Network error: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}
