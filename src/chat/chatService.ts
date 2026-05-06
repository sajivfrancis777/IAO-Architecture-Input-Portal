/**
 * chatService.ts — LLM API abstraction layer.
 *
 * Configurable backend: supports direct API, Azure Functions proxy,
 * or Cloudflare Worker. Admin manages keys from the UI.
 *
 * Stores API config in localStorage (encrypted in production via Azure Key Vault).
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  artifacts?: ChatArtifact[];
}

export interface ChatArtifact {
  type: 'mermaid' | 'table' | 'code' | 'link';
  title: string;
  content: string;
}

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'azure-openai' | 'ollama' | 'custom';
  apiKey: string;
  model: string;
  endpoint?: string;  // Custom endpoint (Azure Functions, Cloudflare Worker, Ollama)
  maxTokens: number;
  temperature: number;
}

const CONFIG_KEY = 'iao_llm_config';
const HISTORY_KEY = 'iao_chat_history';

const DEFAULT_CONFIG: LLMConfig = {
  provider: 'azure-openai',
  apiKey: import.meta.env.VITE_AZURE_OPENAI_KEY ?? '',
  model: 'gpt-5.4-mini',
  endpoint: import.meta.env.VITE_AZURE_OPENAI_ENDPOINT ?? 'https://sajiv-moknxo97-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2024-12-01-preview',
  maxTokens: 1024,
  temperature: 0.3,
};

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

// System prompt grounding the assistant in IAO architecture context
const SYSTEM_PROMPT = `You are the IAO Architecture Assistant for Intel's IDM 2.0 program.
You help architects across 8 towers: FPR, OTC-IF, OTC-IP, FTS-IF, FTS-IP, PTP, MDM, E2E.

## CRITICAL RULES
1. **Ground all answers in provided context.** If no data is available, say so. Do NOT fabricate details.
2. **Summary-first responses for token efficiency:**
   - Show a HIGH-LEVEL SUMMARY first (3-5 bullet points max)
   - For lists (RICEFW, interfaces, defects): show top 5-10 items and state the total count
   - Always end with guidance on where to find more detail
3. **Never dump entire data sets.** Summarize, highlight key items, and reference the grid data.
4. Keep answers concise and actionable. Target under 400 words.
5. When generating diagrams, use Mermaid syntax compatible with the published SAD format.
   - Always wrap diagrams in a \`\`\`mermaid code fence.
   - Use flowchart LR (left-to-right) for integration/swim-lane diagrams.
   - Use flowchart TD (top-down) for data architecture and hierarchy diagrams.
   - Subgraph labels MUST be quoted: subgraph L1["Manufacturing / Boundary Apps"]. NEVER unquoted.
   - Node IDs must be alphanumeric (no spaces/dots): use IFS4 not "IF S/4 HANA" as the ID.
   - Put display labels in brackets with quotes: IFS4["IF S/4 HANA"]
   - **CRITICAL: ONE edge per line. NEVER chain multiple arrows on one line.**
     WRONG: MES --> XEUS --> PDF --> IFH
     CORRECT (each edge on its own line):
       MES --> XEUS
       XEUS --> PDF
       PDF --> IFH
   - Edge labels go in pipes with quotes: A -->|"Direct / NRT"| B
   - Keep diagrams under 40 nodes for readability.
   **ARCHITECTURE DIAGRAM REQUESTS — MANDATORY TRIPLE:**
   When asked for "architecture diagram", "integration diagram", or diagrams for a capability:
   - You MUST produce **3 SEPARATE Mermaid diagrams** (never combined into one):
     a. **Application Architecture** (heading: ### Application Architecture)
        - Nodes = Source System / Target System from flow data
        - Edges = labeled with Interface / Technology
        - Group by Source Lane / Target Lane as subgraphs
        - Use flowchart LR
     b. **Data Architecture** (heading: ### Data Architecture)
        - Nodes = Source DB Platform / Target DB Platform from flow data
        - Show which application writes to / reads from each database
        - Edges = data movement direction
        - Use flowchart TD
     c. **Technology Architecture** (heading: ### Technology Architecture)
        - Nodes = Source Tech Platform / Target Tech Platform from flow data
        - Edges = integration pattern (Point-to-Point, Hub-Spoke, etc.)
        - Group by platform category (Cloud, On-Prem, SaaS, Middleware)
        - Use flowchart LR
   - **ONLY use systems, databases, and platforms that appear in the provided context data.**
     Do NOT add systems that are not in the flow rows. If DB Platform or Tech Platform is blank
     in the data, omit that node from the respective diagram (do not guess).
   - Filter to the exact release + state the user requested.
   - Before each diagram, state: "Based on X flow rows for [Capability] [Release] [State]."
   - After all 3 diagrams, add a brief summary of key integration patterns observed.
6. Reference specific systems, capabilities, and integration patterns when relevant.
7. **BPMN PROCESS LISTING — MANDATORY FORMAT:**
   When the user asks to "list", "show all", or "show BPMN" business processes:
   - You MUST output each process as a MARKDOWN LINK in this EXACT format:
     [🔀 DS-020-020 Perform Cumulative Costing Run](#bpmn:DS-020-020)
   - The pattern is: [🔀 {ID} {Name}](#bpmn:{ID})
   - Add a one-line purpose BELOW each link
   - Group by logical phase with ### headings
   - FORBIDDEN: tables, plain text lists, em-dash formatting, numbered lists
   - End with: "**Click any process above to generate its detailed flowchart diagram.**"

   EXAMPLE (follow this format EXACTLY):
   ### Standard Costing
   [🔀 DS-020-010A Update Cost Components for Standard costing run Global](#bpmn:DS-020-010A)
   Updates cost component data for the global standard costing run.

   [🔀 DS-020-020 Perform Cumulative Costing Run](#bpmn:DS-020-020)
   Performs cumulative costing by checking material master data and updating MAP.

   When the user asks about a SPECIFIC process by ID or name, generate a detailed Mermaid flowchart for that ONE process with SAP transaction codes and decision gateways.
   **IMPORTANT**: If parsed BPMN step data is NOT in the context but the process name/ID IS known, you MUST STILL generate the diagram by inferring logical SAP business process steps from the process name and your SAP domain knowledge. This is NOT fabrication — it is domain inference and is explicitly permitted. Do NOT refuse. Do NOT ask for the BPMN XML. Just generate the best-effort diagram based on the process name.
   Example for "DS-020-020 Perform Cumulative Costing Run":
   \`\`\`mermaid
   flowchart LR
     A["Select Costing Variant"] --> B["Execute Costing Run CK40N"]
     B --> C{"Errors Found?"}
     C -->|"Yes"| D["Review Error Log"]
     D --> B
     C -->|"No"| E["Review Cost Estimates"]
     E --> F["Mark for Release"]
   \`\`\`
8. **Release & Phase disambiguation (applies to flows, dev objects, AND test objects):**
   - Data is scoped by **release** (R3, R4, etc.) and **state/phase**.
   - **Flows**: have release + state (Current, Future).
   - **Dev objects**: belong to a release (R3, R4, or all).
   - **Test objects**: belong to a release + test phase (MC1, MC2, ITC1, ITC2, UAT).
   - If the user asks about a capability WITHOUT specifying release or phase, ASK:
     "Which scope should I use? For example: R3 Current flows, R3 dev objects only, R3 ITC2 test status, or an overall summary across all releases."
   - If only release is given, default to **Current** state for flows, **all phases** for testing.
   - If the user says "overall" or "summary", provide aggregated counts across all releases/phases.
   - Always label outputs with the release and phase used, e.g. "DS-020 — R3 Current Flows" or "DS-020 — R3 ITC2 Test Status".`;

export function loadLLMConfig(): LLMConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch { return { ...DEFAULT_CONFIG }; }
}

export function saveLLMConfig(config: LLMConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function loadChatHistory(): ChatMessage[][] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveChatHistory(sessions: ChatMessage[][]) {
  // Keep last 50 sessions
  const trimmed = sessions.slice(-50);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
}

let messageCounter = 0;
function makeId(): string {
  return `msg_${Date.now()}_${++messageCounter}`;
}

// ── Cross-Repo Context Index ────────────────────────────────
// Fetched from ADA-Artifacts GitHub Pages. Contains all flow rows,
// system names, and capability metadata across every tower.
// When repos merge into one Azure repo, change CONTEXT_INDEX_BASE
// to same-origin (or remove it) — everything else works unchanged.
const CONTEXT_INDEX_BASE = 'https://sajivfrancis777.github.io/ADA-Artifacts/';

interface ContextIndexMeta {
  capabilityCount: number;
  flowCount: number;
  systemCount: number;
  iapmMappedCount?: number;
  iapmUnmatchedCount?: number;
  raidCount?: number;
  ricefwTotal?: number;
  ricefwActive?: number;
  jiraFetchedAt?: string;
}

interface FlowEntry {
  cap: string;
  tower: string;
  release: string;
  state: string;
  chain: string;
  hop: string;
  source: string;
  target: string;
  via: string;
  pattern: string;
  frequency: string;
  dataDesc: string;
}

interface CapabilityEntry {
  name: string;
  tower: string;
  towerName: string;
  group: string;
  systems: string[];
  flowCount: number;
}

interface IapmSystemEntry {
  iapmId: string;
  iapmAcronym: string;
  iapmName: string;
  category: string;
  aliases: string[];
  usedInFlows: boolean;
}

interface RaidEntry {
  raidId: string;
  type: string;
  severity: string;
  title: string;
  status: string;
  team: string;
  subTeam: string;
  dueDate: string;
  daysPastDue: string;
  release: string;
  deliverableId: string;
}

interface JiraSummary {
  fetchedAt: string;
  release: string;
  defectSummary?: {
    total: number;
    open: number;
    inProgress: number;
    resolved: number;
    critical: number;
    bySeverity: Array<{ severity: string; open: number; in_progress: number; resolved: number; total: number }>;
    aging: Array<{ bucket: string; critical: number; high: number; medium: number; low: number }>;
  };
  testSummary?: { total: number; passed: number; failed: number; blocked: number; not_run: number; pass_pct: number };
  readinessSummary?: Record<string, unknown>;
  towerReadiness?: Record<string, {
    totalDefects: number; open: number; closed: number; closureRate: string;
    criticalOpen: number; highOpen: number; goNogo: string;
  }>;
  towerDefects?: Record<string, { total: number; open: number; resolved: number }>;
  towerTests?: Record<string, { total: number; passed: number; failed: number; blocked: number; not_run: number; pass_pct: number }>;
}

interface RicefwSummary {
  total: number;
  byType: Record<string, number>;
  byTower: Record<string, number>;
  byStatus: Record<string, number>;
  activeCount: number;
  activeObjects: Array<{
    objectId: string; type: string; description: string;
    tower: string; status: string; source: string; target: string;
  }>;
}

interface ChangeRequestEntry {
  changeId: string;
  title: string;
  priority: string;
  status: string;
  decision: string;
  requestorTeam: string;
  impactedTowers: string;
  release: string;
  raidRef: string;
  complexity: string;
}

interface ChangeRequestSummary {
  total: number;
  byStatus: Record<string, number>;
  byDecision: Record<string, number>;
  byPriority: Record<string, number>;
  activeCount: number;
  activeCRs: ChangeRequestEntry[];
}

interface ContextIndex {
  _meta: ContextIndexMeta;
  systems: string[];
  iapmSystems?: Record<string, IapmSystemEntry>;
  capabilities: Record<string, CapabilityEntry>;
  flowIndex: FlowEntry[];
  systemGraph: Record<string, Array<{ target: string; via: string; pattern: string; cap: string; tower: string; state: string }>>;
  raidIndex?: RaidEntry[];
  jiraSummary?: JiraSummary;
  ricefwSummary?: RicefwSummary;
  changeRequests?: ChangeRequestSummary;
}

let contextIndex: ContextIndex | null = null;
let contextIndexLoading = false;

async function loadContextIndex(): Promise<ContextIndex | null> {
  if (contextIndex || contextIndexLoading) return contextIndex;
  contextIndexLoading = true;
  try {
    const r = await fetch(CONTEXT_INDEX_BASE + 'context-index.json');
    if (r.ok) {
      contextIndex = await r.json();
      console.log('[ADA Chat] Loaded context index:', contextIndex?._meta?.capabilityCount, 'capabilities,', contextIndex?._meta?.flowCount, 'flows');
    }
  } catch (e) {
    console.warn('[ADA Chat] Could not load context-index.json:', e);
  }
  contextIndexLoading = false;
  return contextIndex;
}

/** Extract known system names from user text (including IAPM aliases) */
function detectSystemNames(text: string): string[] {
  if (!contextIndex) return [];
  const found = new Set<string>();

  // Match against raw flow system names
  if (contextIndex.systems) {
    for (const sys of contextIndex.systems) {
      const escaped = sys.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('\\b' + escaped + '\\b', 'i');
      if (re.test(text)) found.add(sys);
    }
  }

  // Match against IAPM canonical names and aliases
  if (contextIndex.iapmSystems) {
    for (const [canonical, info] of Object.entries(contextIndex.iapmSystems)) {
      const escC = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('\\b' + escC + '\\b', 'i').test(text)) {
        for (const alias of (info.aliases || [])) found.add(alias);
        if (found.size === 0) found.add(canonical);
      }
      if (info.iapmName) {
        const escN = info.iapmName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('\\b' + escN + '\\b', 'i').test(text)) {
          for (const alias of (info.aliases || [])) found.add(alias);
        }
      }
    }
  }

  return [...found];
}

/** Detect release and state filters from user text */
function detectFilters(text: string): { release?: string; state?: string } {
  const relMatch = text.match(/\b(R[0-9])\b/i);
  const release = relMatch ? relMatch[1].toUpperCase() : undefined;
  let state: string | undefined;
  if (/\bfuture\b/i.test(text)) state = 'future';
  else if (/\bcurrent\b/i.test(text)) state = 'current';
  return { release, state };
}

/** Search context index for flows matching system names or cap IDs */
function searchContextIndex(text: string): string {
  if (!contextIndex) return '';
  const systems = detectSystemNames(text);
  const { release, state } = detectFilters(text);
  // Also detect cap IDs
  const capIdRe = /\b([A-Z]{1,4}-(?:IF-|IP-)?[A-Z]{0,3}-?\d{2,3})\b/gi;
  const capIds = [...new Set((text.match(capIdRe) || []).map(m => m.toUpperCase()))];

  // Program health queries (RAID, defects, RICEFW, CRs) don't need system/cap context
  const programHealthRe = /\b(raid|risk|issue|action|blocker|defect|bug|test|ricefw|change request|CR\b|readiness|go.?no.?go)/i;
  if (systems.length === 0 && capIds.length === 0 && !programHealthRe.test(text)) return '';

  const parts: string[] = [];

  // Find flows involving mentioned systems across ALL capabilities
  if (systems.length > 0 && contextIndex.flowIndex) {
    const sysSet = new Set(systems.map(s => s.toUpperCase()));
    const matchingFlows = contextIndex.flowIndex.filter(f =>
      sysSet.has((f.source || '').toUpperCase()) || sysSet.has((f.target || '').toUpperCase())
    );
    if (matchingFlows.length > 0) {
      const byCap: Record<string, FlowEntry[]> = {};
      for (const f of matchingFlows) {
        const key = `${f.cap} (${f.tower})`;
        if (!byCap[key]) byCap[key] = [];
        byCap[key].push(f);
      }
      let section = `### Cross-Capability Flow Data for: ${systems.join(', ')}\nFound ${matchingFlows.length} flow rows across ${Object.keys(byCap).length} capabilities.\n\n`;
      let totalRows = 0;
      for (const [capKey, flows] of Object.entries(byCap)) {
        if (totalRows > 80) { section += `\n…(${matchingFlows.length - totalRows} more rows across additional capabilities)\n`; break; }
        const capInfo = contextIndex.capabilities[flows[0].cap];
        section += `**${capKey}** — ${capInfo?.name || ''}\n`;
        section += '| Release | State | Flow Chain | Source | Target | Via | Pattern | Frequency | Data |\n';
        section += '|---------|-------|------------|--------|--------|-----|---------|-----------|------|\n';
        for (const f of flows.slice(0, 15)) {
          section += `| ${f.release} | ${f.state} | ${f.chain} | ${f.source} | ${f.target} | ${f.via} | ${f.pattern} | ${f.frequency} | ${f.dataDesc} |\n`;
          totalRows++;
        }
        if (flows.length > 15) section += `| … | | ${flows.length - 15} more rows | | | | | | |\n`;
        section += '\n';
      }
      parts.push(section);
    }

    // IAPM application metadata for mentioned systems
    if (contextIndex.iapmSystems) {
      const iapmRows: string[] = [];
      const matched = new Set<string>();
      for (const sys of systems) {
        for (const [canonical, info] of Object.entries(contextIndex.iapmSystems)) {
          if (matched.has(canonical)) continue;
          const aliases = (info.aliases || []).map((a: string) => a.toUpperCase());
          if (aliases.includes(sys.toUpperCase()) || canonical.toUpperCase() === sys.toUpperCase()) {
            iapmRows.push(`| ${canonical} | ${info.iapmId || '—'} | ${info.iapmName} | ${info.category} |`);
            matched.add(canonical);
          }
        }
      }
      if (iapmRows.length > 0) {
        let iapmSection = `### IAPM Application Registry (Corporate Vetted)\n`;
        iapmSection += '| System | IAPM ID | Official Name | Category |\n';
        iapmSection += '|--------|---------|---------------|----------|\n';
        iapmSection += iapmRows.join('\n');
        parts.push(iapmSection);
      }
    }

    // System adjacency
    if (contextIndex.systemGraph) {
      const edges: string[] = [];
      for (const sys of systems) {
        for (const e of (contextIndex.systemGraph[sys] || []).slice(0, 10)) {
          edges.push(`${sys} → ${e.target} (via ${e.via || 'direct'}, ${e.pattern || 'unknown'}, cap ${e.cap})`);
        }
        for (const [src, targets] of Object.entries(contextIndex.systemGraph)) {
          for (const e of targets) {
            if (e.target === sys) {
              edges.push(`${src} → ${sys} (via ${e.via || 'direct'}, ${e.pattern || 'unknown'}, cap ${e.cap})`);
            }
          }
        }
      }
      const unique = [...new Set(edges)].slice(0, 30);
      if (unique.length > 0) {
        parts.push(`### System Connectivity: ${systems.join(', ')}\n${unique.join('\n')}`);
      }
    }
  }

  // Capability metadata AND flow rows for detected cap IDs
  if (capIds.length > 0 && contextIndex.capabilities) {
    for (const cid of capIds.slice(0, 5)) {
      const cap = contextIndex.capabilities[cid];
      if (!cap) continue;
      parts.push(`### ${cid} — ${cap.name} (${cap.tower})\n**Group:** ${cap.group} | **Systems:** ${cap.systems.join(', ')} | **Flow Count:** ${cap.flowCount}`);

      // Pull actual flow rows for this capability from the flow index
      if (contextIndex.flowIndex) {
        let capFlows = contextIndex.flowIndex.filter(f => f.cap === cid);
        // Apply release/state filters if user specified them
        if (release) capFlows = capFlows.filter(f => f.release?.toUpperCase() === release);
        if (state) capFlows = capFlows.filter(f => f.state?.toLowerCase() === state);
        // Skip rows that are clearly template/placeholder data
        capFlows = capFlows.filter(f => f.source && !f.source.startsWith('e.g.'));

        if (capFlows.length > 0) {
          const filterLabel = [release, state].filter(Boolean).join(' ') || 'All';
          let section = `### ${cid} Flow Data (${filterLabel}) — ${capFlows.length} rows\n`;
          section += '| Release | State | Flow Chain | Hop | Source | Target | Via | Pattern | Frequency | Data |\n';
          section += '|---------|-------|------------|-----|--------|--------|-----|---------|-----------|------|\n';
          const maxRows = Math.min(capFlows.length, 80);
          for (let i = 0; i < maxRows; i++) {
            const f = capFlows[i];
            section += `| ${f.release} | ${f.state} | ${f.chain} | ${f.hop} | ${f.source} | ${f.target} | ${f.via} | ${f.pattern} | ${f.frequency} | ${f.dataDesc} |\n`;
          }
          if (capFlows.length > 80) section += `| … | | ${capFlows.length - 80} more rows | | | | | | | |\n`;
          parts.push(section);
        }
      }
    }
  }

  // ── RAID Search ─────────────────────────────────────────────────────────
  const raidKeywords = /\b(raid|risk|issue|action|blocker|roadblock|escalat|key decision)\b/i;
  if (raidKeywords.test(text) && contextIndex.raidIndex && contextIndex.raidIndex.length > 0) {
    let raidItems = contextIndex.raidIndex;

    // Filter by capability deliverable ID (exact match on Deliverable ID field)
    if (capIds.length > 0) {
      const capMatched = raidItems.filter(r =>
        r.deliverableId && capIds.some(cid =>
          r.deliverableId.toUpperCase().includes(cid)
        )
      );
      if (capMatched.length > 0) {
        raidItems = capMatched;
      }
      // If no deliverable ID match, fall through to tower filter below
    }

    // Filter by tower — explicit tower name OR derived from capability ID
    const towerRe = /\b(FPR|OTC[- ]?IF|OTC[- ]?IP|FTS[- ]?IF|FTS[- ]?IP|PTP|MDM|E2E)\b/i;
    const towerMatch = text.match(towerRe);
    let towerFilter: string | null = null;
    if (towerMatch) {
      towerFilter = towerMatch[1].toUpperCase().replace(/\s+/g, ' ');
    } else if (capIds.length > 0 && contextIndex.capabilities) {
      // Derive tower from capability ID (e.g., DS-020 → FPR)
      for (const cid of capIds) {
        const cap = contextIndex.capabilities[cid];
        if (cap?.tower) { towerFilter = cap.tower.toUpperCase(); break; }
      }
    }
    if (towerFilter && raidItems.length === contextIndex.raidIndex.length) {
      // Only apply tower filter if deliverableId filter didn't narrow it
      raidItems = raidItems.filter(r =>
        r.team.toUpperCase().includes(towerFilter!.replace('-', ' ')) ||
        r.team.toUpperCase().includes(towerFilter!)
      );
    }

    // Filter by severity if mentioned
    if (/\b(p1|high|critical)\b/i.test(text)) {
      raidItems = raidItems.filter(r => r.severity.includes('P1') || r.severity.toLowerCase().includes('high'));
    } else if (/\b(p2|medium)\b/i.test(text)) {
      raidItems = raidItems.filter(r => r.severity.includes('P2'));
    }

    // Filter by type if mentioned
    if (/\brisk\b/i.test(text) && !/\b(raid|issue|action)\b/i.test(text)) {
      raidItems = raidItems.filter(r => r.type === 'Risk');
    } else if (/\bissue\b/i.test(text) && !/\b(raid|risk|action)\b/i.test(text)) {
      raidItems = raidItems.filter(r => r.type === 'Issue');
    } else if (/\baction\b/i.test(text) && !/\b(raid|risk|issue)\b/i.test(text)) {
      raidItems = raidItems.filter(r => r.type === 'Action');
    }

    if (raidItems.length > 0) {
      let section = `### Active RAID Items (${raidItems.length} matching)\n`;
      section += '| RAID ID | Type | Severity | Title | Status | Team | Due Date | Days Past Due |\n';
      section += '|---------|------|----------|-------|--------|------|----------|---------------|\n';
      const maxRaid = Math.min(raidItems.length, 30);
      for (let i = 0; i < maxRaid; i++) {
        const r = raidItems[i];
        section += `| ${r.raidId} | ${r.type} | ${r.severity} | ${r.title} | ${r.status} | ${r.team} | ${r.dueDate} | ${r.daysPastDue} |\n`;
      }
      if (raidItems.length > 30) section += `| … | | | ${raidItems.length - 30} more items | | | | |\n`;
      parts.push(section);
    }
  }

  // ── Defect / Bug Search ─────────────────────────────────────────────────
  const defectKeywords = /\b(defect|bug|severity|critical|open defect|defect summary)\b/i;
  if (defectKeywords.test(text) && contextIndex.jiraSummary?.defectSummary) {
    const ds = contextIndex.jiraSummary.defectSummary;
    let section = `### Defect Summary (${contextIndex.jiraSummary.release})\n`;
    section += `**Total:** ${ds.total} | **Open:** ${ds.open} | **In Progress:** ${ds.inProgress} | **Resolved:** ${ds.resolved} | **Critical Total:** ${ds.critical}\n\n`;

    if (ds.bySeverity && ds.bySeverity.length > 0) {
      section += '| Severity | Open | In Progress | Resolved | Total |\n';
      section += '|----------|------|-------------|----------|-------|\n';
      for (const s of ds.bySeverity) {
        section += `| ${s.severity} | ${s.open} | ${s.in_progress} | ${s.resolved} | ${s.total} |\n`;
      }
      section += '\n';
    }

    // Per-tower defects if available
    if (contextIndex.jiraSummary.towerDefects) {
      const towerMatch2 = text.match(/\b(FPR|OTC[- ]?IF|OTC[- ]?IP|FTS[- ]?IF|FTS[- ]?IP|PTP|MDM|E2E)\b/i);
      if (towerMatch2) {
        const tf = towerMatch2[1].toUpperCase().replace(/\s+/g, '-');
        const td = contextIndex.jiraSummary.towerDefects[tf];
        if (td) {
          section += `\n**${tf} Defects:** Total ${td.total} | Open ${td.open} | Resolved ${td.resolved}\n`;
        }
      } else {
        section += '\n| Tower | Total | Open | Resolved |\n';
        section += '|-------|-------|------|----------|\n';
        for (const [t, d] of Object.entries(contextIndex.jiraSummary.towerDefects)) {
          section += `| ${t} | ${d.total} | ${d.open} | ${d.resolved} |\n`;
        }
      }
    }
    parts.push(section);
  }

  // ── Test Coverage / Testing Search ──────────────────────────────────────
  const testKeywords = /\b(test|testing|pass rate|coverage|test case|execution|FUT)\b/i;
  if (testKeywords.test(text) && contextIndex.jiraSummary?.towerTests) {
    let section = '### Test Execution Summary\n';
    section += '| Tower | Total | Passed | Failed | Blocked | Not Run | Pass % |\n';
    section += '|-------|-------|--------|--------|---------|---------|--------|\n';
    for (const [tower, t] of Object.entries(contextIndex.jiraSummary.towerTests)) {
      section += `| ${tower} | ${t.total} | ${t.passed} | ${t.failed} | ${t.blocked} | ${t.not_run} | ${t.pass_pct}% |\n`;
    }
    parts.push(section);
  }

  // ── Release Readiness / Go-NoGo Search ──────────────────────────────────
  const readinessKeywords = /\b(readiness|go.?no.?go|release|go live|go-live|cutover)\b/i;
  if (readinessKeywords.test(text) && contextIndex.jiraSummary?.towerReadiness) {
    let section = '### Release Readiness (per Tower)\n';
    section += '| Tower | Total Defects | Open | Closed | Closure Rate | Critical Open | High Open | GO/NO-GO |\n';
    section += '|-------|---------------|------|--------|--------------|---------------|-----------|----------|\n';
    for (const [tower, r] of Object.entries(contextIndex.jiraSummary.towerReadiness)) {
      section += `| ${tower} | ${r.totalDefects} | ${r.open} | ${r.closed} | ${r.closureRate} | ${r.criticalOpen} | ${r.highOpen} | **${r.goNogo}** |\n`;
    }
    parts.push(section);
  }

  // ── RICEFW Object Search ────────────────────────────────────────────────
  const ricefwKeywords = /\b(ricefw|object|report|interface|conversion|enhancement|form|workflow|wricef|dev object)\b/i;
  if (ricefwKeywords.test(text) && contextIndex.ricefwSummary) {
    const rs = contextIndex.ricefwSummary;
    let section = `### RICEFW Object Summary\n`;
    section += `**Total:** ${rs.total} | **Active (non-complete):** ${rs.activeCount}\n\n`;

    // By type
    section += '| Type | Count |\n|------|-------|\n';
    const typeLabels: Record<string, string> = { R: 'Report', I: 'Interface', C: 'Conversion', E: 'Enhancement', F: 'Form', W: 'Workflow' };
    for (const [code, count] of Object.entries(rs.byType)) {
      section += `| ${typeLabels[code] || code} (${code}) | ${count} |\n`;
    }

    // By tower (top entries)
    const towerEntries = Object.entries(rs.byTower).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (towerEntries.length > 0) {
      section += '\n| Tower | Objects |\n|-------|--------|\n';
      for (const [t, c] of towerEntries) {
        section += `| ${t} | ${c} |\n`;
      }
    }

    // Active objects (non-complete) if user seems to want detail
    if (/\b(active|in progress|dev|build|pending|open)\b/i.test(text) && rs.activeObjects.length > 0) {
      section += `\n#### Active Objects (${rs.activeCount} total, showing top 20)\n`;
      section += '| Object ID | Type | Description | Tower | Status | Source | Target |\n';
      section += '|-----------|------|-------------|-------|--------|--------|--------|\n';
      for (const obj of rs.activeObjects.slice(0, 20)) {
        section += `| ${obj.objectId} | ${obj.type} | ${obj.description} | ${obj.tower} | ${obj.status} | ${obj.source} | ${obj.target} |\n`;
      }
      if (rs.activeCount > 20) section += `| … | | ${rs.activeCount - 20} more | | | | |\n`;
    }
    parts.push(section);
  }

  // ── Change Request Search ───────────────────────────────────────────────
  const crKeywords = /\b(change request|CR|change id|scope change|new scope|design change|CCB)\b/i;
  if (crKeywords.test(text) && contextIndex.changeRequests) {
    const crs = contextIndex.changeRequests;
    let section = `### Change Request Summary\n`;
    section += `**Total:** ${crs.total} | **Active (New/In Progress):** ${crs.activeCount}\n\n`;

    // By decision
    section += '| Decision | Count |\n|----------|-------|\n';
    for (const [d, c] of Object.entries(crs.byDecision)) {
      section += `| ${d} | ${c} |\n`;
    }

    // By priority
    section += '\n| Priority | Count |\n|----------|-------|\n';
    for (const [p, c] of Object.entries(crs.byPriority)) {
      section += `| ${p} | ${c} |\n`;
    }

    // Active CRs list
    if (crs.activeCRs && crs.activeCRs.length > 0) {
      let filtered = crs.activeCRs;

      // Filter by tower if mentioned
      const towerMatch3 = text.match(/\b(FPR|OTC[- ]?IF|OTC[- ]?IP|FTS[- ]?IF|FTS[- ]?IP|PTP|MDM|E2E)\b/i);
      if (towerMatch3) {
        const tf = towerMatch3[1].toUpperCase().replace(/\s+/g, '-');
        filtered = filtered.filter(cr =>
          cr.requestorTeam.toUpperCase().includes(tf.replace('-', ' ')) ||
          cr.impactedTowers.toUpperCase().includes(tf)
        );
      }

      // Filter by priority if mentioned
      if (/\b(very high|critical|urgent)\b/i.test(text)) {
        filtered = filtered.filter(cr => cr.priority.toLowerCase().includes('very high'));
      } else if (/\bhigh\b/i.test(text)) {
        filtered = filtered.filter(cr => cr.priority.toLowerCase().includes('high'));
      }

      if (filtered.length > 0) {
        section += `\n#### Active Change Requests (${filtered.length} matching)\n`;
        section += '| Change ID | Title | Priority | Team | Impacted Towers | Release | RAID Ref |\n';
        section += '|-----------|-------|----------|------|-----------------|---------|----------|\n';
        const maxCr = Math.min(filtered.length, 25);
        for (let i = 0; i < maxCr; i++) {
          const cr = filtered[i];
          section += `| ${cr.changeId} | ${cr.title} | ${cr.priority} | ${cr.requestorTeam} | ${cr.impactedTowers} | ${cr.release} | ${cr.raidRef} |\n`;
        }
        if (filtered.length > 25) section += `| … | ${filtered.length - 25} more | | | | | |\n`;
      }
    }
    parts.push(section);
  }

  const result = parts.join('\n\n---\n\n');
  return result.length > 16000 ? result.slice(0, 16000) + '\n\n…(context truncated)' : result;
}

/**
 * Send a message to the configured LLM and get a response.
 * @param gridContext — optional stringified grid data for context-aware answers
 */
export async function sendMessage(
  messages: ChatMessage[],
  config: LLMConfig,
  gridContext?: string,
): Promise<ChatMessage> {
  if (!config.apiKey && !config.endpoint && config.provider !== 'ollama') {
    return {
      id: makeId(),
      role: 'assistant',
      content: '⚙️ **No LLM API configured.** Click your profile icon (bottom-right) → "🔑 AI Assistant — API Key" to enter your API key.\n\nYou can use Anthropic (Claude), OpenAI (GPT), Azure OpenAI, or Ollama (local).',
      timestamp: Date.now(),
    };
  }

  // Load cross-repo context index (from ADA-Artifacts GitHub Pages)
  await loadContextIndex();

  // Extract user's latest message text for context search
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUserMsg?.content || '';

  // Search context index for cross-capability grounding
  const crossCapContext = searchContextIndex(userText);

  // Build system prompt with all grounding sources
  let systemPrompt = SYSTEM_PROMPT;
  if (gridContext) {
    // Check if grid data is mostly empty template rows
    const hasRealData = gridContext.includes('|') && !/e\.g\. MES|e\.g\. XEUS/.test(gridContext.slice(0, 500));
    if (hasRealData) {
      systemPrompt += `\n\n## Current Architecture Data (from the editor grid)\n${gridContext}`;
    } else {
      systemPrompt += `\n\n## Note: Editor grid contains template/placeholder rows. Use the cross-capability context below as the authoritative data source.`;
    }
  }
  if (crossCapContext) {
    systemPrompt += `\n\n## Cross-Capability Context (from architecture knowledge base)\nThe following data spans ALL towers and capabilities in the program. This is the AUTHORITATIVE source — prefer it over grid data when the grid appears empty or contains placeholders.\n\n${crossCapContext}`;
  }

  // Send only last 6 messages to reduce token cost
  const recentMessages = messages.slice(-6);
  const apiMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...recentMessages.map(m => ({ role: m.role, content: m.content })),
  ];

  try {
    // Ollama local model (native format)
    if (config.provider === 'ollama') {
      const ollamaBase = config.endpoint || OLLAMA_DEFAULT_URL;
      const ollamaModel = config.model || 'llama3';
      const res = await fetch(`${ollamaBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages: apiMessages,
          stream: false,
          options: {
            temperature: config.temperature,
            num_predict: config.maxTokens,
          },
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama error ${res.status}: ${errText}`);
      }
      const data = await res.json();
      return {
        id: makeId(),
        role: 'assistant',
        content: data.message?.content ?? 'No response from Ollama',
        timestamp: Date.now(),
      };
    }

    // Custom endpoint (Azure Functions, Cloudflare Worker, iGPT, LiteLLM, vLLM)
    if (config.endpoint && config.provider === 'custom') {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: apiMessages,
          model: config.model,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Custom endpoint error ${res.status}: ${errText}`);
      }
      const data = await res.json();
      return {
        id: makeId(),
        role: 'assistant',
        content: data.content ?? data.message?.content ?? data.choices?.[0]?.message?.content ?? 'No response',
        timestamp: Date.now(),
      };
    }

    // Direct Anthropic API (requires CORS proxy in production)
    if (config.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          system: systemPrompt,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${err}`);
      }
      const data = await res.json();
      return {
        id: makeId(),
        role: 'assistant',
        content: data.content?.[0]?.text ?? 'No response',
        timestamp: Date.now(),
      };
    }

    // OpenAI / Azure OpenAI (Chat Completions API)
    const endpoint = config.provider === 'azure-openai' && config.endpoint
      ? config.endpoint
      : 'https://api.openai.com/v1/chat/completions';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
      headers[config.provider === 'azure-openai' ? 'api-key' : 'Authorization'] =
        config.provider === 'azure-openai' ? config.apiKey : `Bearer ${config.apiKey}`;
    }

    const useMaxCompletionTokens = config.provider === 'azure-openai';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: apiMessages,
        model: config.model,
        ...(useMaxCompletionTokens
          ? { max_completion_tokens: config.maxTokens }
          : { max_tokens: config.maxTokens }),
        temperature: config.temperature,
      }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    return {
      id: makeId(),
      role: 'assistant',
      content: data.choices?.[0]?.message?.content ?? 'No response',
      timestamp: Date.now(),
    };
  } catch (e) {
    return {
      id: makeId(),
      role: 'assistant',
      content: `❌ **Error:** ${e instanceof Error ? e.message : 'Unknown error'}\n\nCheck your API configuration in Admin → API Keys.`,
      timestamp: Date.now(),
    };
  }
}

export function createUserMessage(content: string): ChatMessage {
  return { id: makeId(), role: 'user', content, timestamp: Date.now() };
}

/** List models available on the local Ollama instance */
export async function listOllamaModels(endpoint?: string): Promise<string[]> {
  const base = endpoint || OLLAMA_DEFAULT_URL;
  try {
    const res = await fetch(`${base}/api/tags`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.models) ? data.models.map((m: { name: string }) => m.name) : [];
  } catch {
    return [];
  }
}

export function clearChatHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

export function clearLLMApiKey() {
  const cfg = loadLLMConfig();
  cfg.apiKey = '';
  saveLLMConfig(cfg);
}

export function exportChatHistory(): string {
  return localStorage.getItem(HISTORY_KEY) || '[]';
}

export function resetAllSettings() {
  localStorage.removeItem(CONFIG_KEY);
  localStorage.removeItem(HISTORY_KEY);
}
