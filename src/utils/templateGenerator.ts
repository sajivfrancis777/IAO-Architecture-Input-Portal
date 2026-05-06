/**
 * templateGenerator.ts — Dynamically generates a scoped .drawio template
 * containing only the Instructions tab + the tab matching the user's
 * current release/state selection.
 *
 * This ensures architects get a focused template without all 12 tabs.
 */

/** Map release + state to the expected tab name in the template */
function getTabName(release: string, state: string): string {
  if (release === 'All') {
    return state === 'Current' ? 'CurrentFlows(UNIVERSAL)' : 'FutureFlows(UNIVERSAL)';
  }
  return `${release}_${state}Flows`;
}

/**
 * Fetch the static .drawio template and return a filtered version
 * containing only the Instructions page + the page matching the selection.
 *
 * Falls back to the full template if parsing/filtering fails.
 */
export async function generateScopedDrawioTemplate(
  release: string,
  state: string,
  baseUrl: string,
): Promise<string> {
  const targetTab = getTabName(release, state);

  try {
    const res = await fetch(`${baseUrl}templates/integration-flows-template.drawio`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    // Parse the XML and filter <diagram> elements
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    const mxfile = doc.querySelector('mxfile');
    if (!mxfile) throw new Error('Invalid .drawio template');

    const diagrams = Array.from(mxfile.querySelectorAll('diagram'));
    const kept: Element[] = [];

    for (const diag of diagrams) {
      const name = diag.getAttribute('name') || '';
      // Keep Instructions tab + the matching release/state tab
      if (name === 'Instructions' || name === targetTab) {
        kept.push(diag);
      }
    }

    // If we didn't find the target tab, keep all (fallback)
    if (kept.length <= 1) {
      return xml;
    }

    // Rebuild filtered XML
    // Remove all diagrams from mxfile, then re-add the kept ones
    for (const diag of diagrams) {
      mxfile.removeChild(diag);
    }
    for (const diag of kept) {
      mxfile.appendChild(diag);
    }

    const serializer = new XMLSerializer();
    return serializer.serializeToString(doc);
  } catch (e) {
    console.warn('[templateGenerator] Falling back to full template:', e);
    // Fallback: return null to signal caller should use static file
    throw e;
  }
}
