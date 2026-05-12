/**
 * visioTemplateGenerator.ts — Dynamically generates a scoped .vsdx template
 * containing only the Instructions tab + the tab(s) matching the user's
 * current release/state selection.
 *
 * Mirrors the Draw.io scoping in templateGenerator.ts but for Visio ZIP/XML.
 */
import JSZip from 'jszip';

/** Map release + state to the expected page name in the template */
function getTargetPageName(release: string, state: string): string {
  if (release === 'All') {
    return state === 'Current' ? 'CurrentFlows(UNIVERSAL)' : 'FutureFlows(UNIVERSAL)';
  }
  return `${release}_${state}Flows`;
}

/**
 * Fetch the static .vsdx template and return a filtered ArrayBuffer
 * containing only the Instructions page + the page matching the selection.
 *
 * Falls back to the full template if filtering fails.
 */
export async function generateScopedVisioTemplate(
  release: string,
  state: string,
  baseUrl: string,
): Promise<ArrayBuffer> {
  const targetPage = getTargetPageName(release, state);

  const res = await fetch(`${baseUrl}templates/integration-flows-template.vsdx`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.arrayBuffer();

  const zip = await JSZip.loadAsync(data);

  // 1. Read pages.xml to find all page names and their rId mappings
  const pagesXmlFile = zip.file('visio/pages/pages.xml');
  if (!pagesXmlFile) throw new Error('No pages.xml in template');
  const pagesXml = await pagesXmlFile.async('string');

  const parser = new DOMParser();
  const pagesDoc = parser.parseFromString(pagesXml, 'text/xml');
  const pageEls = Array.from(pagesDoc.querySelectorAll('Page'));

  // Determine which pages to keep
  const keepPages: { idx: number; name: string; relId: string }[] = [];
  const removePages: { idx: number; name: string; relId: string }[] = [];

  for (let i = 0; i < pageEls.length; i++) {
    const name = pageEls[i].getAttribute('NameU') || pageEls[i].getAttribute('Name') || '';
    const relEl = pageEls[i].querySelector('Rel');
    const relId = relEl?.getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id',
    ) || relEl?.getAttribute('r:id') || '';

    if (name === 'Instructions' || name === targetPage) {
      keepPages.push({ idx: i, name, relId });
    } else {
      removePages.push({ idx: i, name, relId });
    }
  }

  // If we can't find the target, return original unmodified
  if (keepPages.length <= 1) {
    return data;
  }

  // 2. Read pages.xml.rels to map rId → pageN.xml filename
  const relsFile = zip.file('visio/pages/_rels/pages.xml.rels');
  if (!relsFile) throw new Error('No pages.xml.rels');
  const relsXml = await relsFile.async('string');
  const relsDoc = parser.parseFromString(relsXml, 'text/xml');
  const relEls = Array.from(relsDoc.querySelectorAll('Relationship'));

  // Build map: rId → target filename
  const relMap = new Map<string, string>();
  for (const rel of relEls) {
    relMap.set(rel.getAttribute('Id') || '', rel.getAttribute('Target') || '');
  }

  // Determine page files to remove
  const removeFiles = new Set<string>();
  const removeRelIds = new Set<string>();
  for (const rp of removePages) {
    removeRelIds.add(rp.relId);
    const target = relMap.get(rp.relId);
    if (target) {
      removeFiles.add(`visio/pages/${target}`);
    }
  }

  // 3. Remove page XML files from ZIP
  for (const f of removeFiles) {
    zip.remove(f);
  }

  // 4. Rebuild pages.xml — remove unwanted <Page> elements
  for (const rp of removePages) {
    const el = pageEls[rp.idx];
    el.parentNode?.removeChild(el);
  }
  // Renumber Page IDs sequentially
  const remainingPages = Array.from(pagesDoc.querySelectorAll('Page'));
  remainingPages.forEach((p, i) => p.setAttribute('ID', String(i)));

  const serializer = new XMLSerializer();
  const newPagesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + serializer.serializeToString(pagesDoc);
  zip.file('visio/pages/pages.xml', newPagesXml);

  // 5. Rebuild pages.xml.rels — remove unwanted <Relationship> entries
  for (const rel of relEls) {
    if (removeRelIds.has(rel.getAttribute('Id') || '')) {
      rel.parentNode?.removeChild(rel);
    }
  }
  // Renumber Relationship IDs sequentially
  const remainingRels = Array.from(relsDoc.querySelectorAll('Relationship'));
  remainingRels.forEach((r, i) => r.setAttribute('Id', `rId${i + 1}`));
  // Also update the Rel r:id references in pages.xml to match
  const finalPageEls = Array.from(pagesDoc.querySelectorAll('Page'));
  finalPageEls.forEach((p, i) => {
    const relEl = p.querySelector('Rel');
    if (relEl) {
      // Set r:id attribute (namespace-aware)
      relEl.setAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'r:id', `rId${i + 1}`,
      );
    }
  });
  // Re-serialize pages.xml with updated rIds
  const finalPagesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + serializer.serializeToString(pagesDoc);
  zip.file('visio/pages/pages.xml', finalPagesXml);

  const newRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + serializer.serializeToString(relsDoc);
  zip.file('visio/pages/_rels/pages.xml.rels', newRelsXml);

  // 6. Rebuild [Content_Types].xml — remove <Override> for removed page files
  const ctFile = zip.file('[Content_Types].xml');
  if (ctFile) {
    const ctXml = await ctFile.async('string');
    const ctDoc = parser.parseFromString(ctXml, 'text/xml');
    const overrides = Array.from(ctDoc.querySelectorAll('Override'));
    for (const ov of overrides) {
      const partName = ov.getAttribute('PartName') || '';
      // partName is like "/visio/pages/page5.xml"
      const normalized = partName.startsWith('/') ? partName.slice(1) : partName;
      if (removeFiles.has(normalized)) {
        ov.parentNode?.removeChild(ov);
      }
    }
    const newCtXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + serializer.serializeToString(ctDoc);
    zip.file('[Content_Types].xml', newCtXml);
  }

  // 7. Generate the filtered ZIP as ArrayBuffer
  return zip.generateAsync({ type: 'arraybuffer', mimeType: 'application/vnd.ms-visio.drawing' });
}
