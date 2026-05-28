/**
 * chatService.ts — LLM API abstraction layer.
 *
 * Configurable backend: supports direct API, Azure Functions proxy,
 * or Cloudflare Worker. Admin manages keys from the UI.
 *
 * Stores API config in localStorage (encrypted in production via Azure Key Vault).
 */

import { flowsToMermaid, type FlowRow } from '../utils/flowsToMermaid';

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
   - **When Document Metrics are provided**, use those exact numbers (pass rates, object counts, completion %, RAID counts) in your response. Never estimate when actual metrics are available.
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
7. **LIVE JIRA ACCESS**: You have tool functions to query JIRA live:
   - \`jira_search\`: Look up a specific issue/test case by key (IAODTM-C43670, IAODTM-12345) or search by text/JQL
   - \`jira_test_cases\`: Query Zephyr Scale test cases by tower, capability, release, or phase
   - \`jira_defects\`: Query bugs with severity/status/tower filters
   - \`jira_test_case_detail\`: **BATCH enrichment** — get full details (description, objective, status, steps, approval info) for many test cases at once. Use when:
     • User asks for details on all test cases in a cycle → pass cycle_key
     • User wants descriptions/status for specific test case keys → pass test_case_keys array
     • User says "pull details for these", "show me the descriptions", "why are they not approved"
   **When the user asks about a specific JIRA ticket or wants live data not in the static context, USE these tools.** Do NOT say "I cannot access JIRA" or "I don't have enough context" — call the appropriate tool instead. For batch queries involving multiple test cases, ALWAYS use jira_test_case_detail (never loop jira_search one at a time).
   **CRITICAL: When the user confirms a query scope or says "yes", "go ahead", "proceed", or "go with the defaults", IMMEDIATELY call the tool with the stated parameters. Do NOT ask for further confirmation or say "I need to query" — just execute the tool call in the same turn. Never respond with "I'm ready to pull" without actually pulling.**
8. **BPMN PROCESS LISTING — MANDATORY FORMAT:**
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
9. **Release & Phase disambiguation (applies to flows, dev objects, AND test objects):**
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

// ── JIRA Proxy (live queries via local dev server or Azure Function) ──
const JIRA_PROXY_BASE = import.meta.env.VITE_JIRA_PROXY_URL ?? 'http://localhost:3001';

// ── JIRA Tool Definitions for Azure OpenAI Function Calling ────────
const JIRA_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'jira_search',
      description: 'Search JIRA issues or look up a specific issue/test case/test cycle by key. Use when the user asks about a specific JIRA ticket (e.g. IAODTM-12345 for bugs, IAODTM-T1234 for test cases, IAODTM-C43670 for test cycles), wants to search defects by text, or needs live JIRA data not in the static context.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Exact JIRA key. -C prefix = test cycle, -T prefix = test case, plain number = bug/issue. Example: IAODTM-C43670, IAODTM-T1234, IAODTM-12345.' },
          jql: { type: 'string', description: 'Raw JQL query for advanced searches. If provided, other filters are ignored.' },
          text: { type: 'string', description: 'Free text search in summary/description.' },
          issue_type: { type: 'string', description: 'Issue type filter (Bug, Task, Issue). Default: any.' },
          max_results: { type: 'number', description: 'Max results to return (default 20, max 200).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'jira_test_cases',
      description: 'Query Zephyr Scale test cases with filters. Use when the user asks about test cases, test coverage, or testing status for a tower or capability.',
      parameters: {
        type: 'object',
        properties: {
          tower: { type: 'string', description: 'Tower shortcode (FPR, OTC-IF, OTC-IP, FTS-IF, FTS-IP, PTP, MDM, E2E).' },
          capability_id: { type: 'string', description: 'Capability ID filter (e.g. DS-020, MR-010-020).' },
          release: { type: 'string', description: 'Release filter (R3, R4, R5).' },
          test_phase: { type: 'string', description: 'Test phase (ITC1, ITC2, TUT, E2E, UAT).' },
          max_results: { type: 'number', description: 'Max results (default 100).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'jira_defects',
      description: 'Query JIRA bugs/defects with severity, status, tower, and test phase filters. Use when the user asks about open defects, bug counts, or defect details beyond what the static summary provides.',
      parameters: {
        type: 'object',
        properties: {
          tower: { type: 'string', description: 'Tower shortcode for filtering.' },
          severity: { type: 'string', description: 'Severity filter — single value or comma-separated (e.g. "Critical", "Critical,High"). Accepted values: Critical, High, Medium, Low.' },
          status: { type: 'string', description: 'Status filter (Open, In Progress, Resolved, Closed).' },
          release: { type: 'string', description: 'Release filter (R3, R4, R5). Default: R3.' },
          test_phase: { type: 'string', description: 'Test phase/cycle filter (MC1, MC2, ITC1, ITC2, UAT, E2E).' },
          max_results: { type: 'number', description: 'Max results (default 50).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'jira_test_case_detail',
      description: 'Get enriched test case details (description, objective, status, steps, approval info) for a batch of test cases. Use when the user asks about specific test case details, wants descriptions/objectives for multiple test cases, or asks to drill into a test cycle\'s linked cases. Accepts a cycle_key (IAODTM-C...) to fetch ALL test cases in that cycle, or a list of test_case_keys (IAODTM-T...) for specific lookups. Returns full details including steps, tower doc links, and status. ALWAYS use this tool (not jira_search) when the user wants details for multiple test cases at once.',
      parameters: {
        type: 'object',
        properties: {
          cycle_key: { type: 'string', description: 'Test cycle key (e.g. IAODTM-C43670). Fetches the cycle then enriches ALL linked test cases.' },
          test_case_keys: { type: 'array', items: { type: 'string' }, description: 'Array of test case keys (e.g. ["IAODTM-T69796", "IAODTM-T91787"]). Use when you already have specific keys.' },
          include_steps: { type: 'boolean', description: 'Include test script steps in response (default true). Set false for summary-only.' },
          max_cases: { type: 'number', description: 'Max test cases to enrich (default 100, max 200).' },
        },
      },
    },
  },
];

/** Execute a JIRA tool call via the proxy server. */
async function executeJiraTool(name: string, args: Record<string, unknown>): Promise<string> {
  const endpointMap: Record<string, string> = {
    jira_search: '/api/jira/search',
    jira_test_cases: '/api/jira/test-cases',
    jira_defects: '/api/jira/defects',
    jira_test_case_detail: '/api/jira/test-case-detail',
  };
  const path = endpointMap[name];
  if (!path) return JSON.stringify({ error: `Unknown tool: ${name}` });

  try {
    const resp = await fetch(JIRA_PROXY_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!resp.ok) {
      const err = await resp.text();
      return JSON.stringify({ error: `JIRA proxy error ${resp.status}: ${err}` });
    }
    return await resp.text();
  } catch (e) {
    return JSON.stringify({ error: `JIRA proxy unreachable: ${e instanceof Error ? e.message : 'unknown'}. Start the proxy with: python scripts/jira_proxy.py` });
  }
}

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
  srcDbPlatform?: string;
  tgtDbPlatform?: string;
  srcTechPlatform?: string;
  tgtTechPlatform?: string;
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
  towers?: string[];
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

// ── Document Summary Index (deep metric grounding) ──────────────
// Pre-extracted metrics from generated docs (RICEFW counts, pass rates, etc.)
interface DocSummaryTower {
  ricefw?: Record<string, string | null>;
  testing?: Record<string, string | number | null | Record<string, number> | Array<Record<string, string>>>;
  openRaids?: number;
  activeCRs?: number;
  capabilities?: Record<string, Record<string, unknown>>;
}
interface DocSummaryIndex {
  programSummary: {
    totalTowers: number; totalCapabilities: number; totalDocumentsIndexed: number;
    totalDevObjects: number; totalCompleted: number; totalActive: number;
    completionPct: number; totalOpenRaids: number; totalActiveCRs: number;
  };
  towers: Record<string, DocSummaryTower>;
}

let docSummaryIndex: DocSummaryIndex | null = null;
let docSummaryLoading = false;

async function loadDocSummaryIndex(): Promise<DocSummaryIndex | null> {
  if (docSummaryIndex || docSummaryLoading) return docSummaryIndex;
  docSummaryLoading = true;
  try {
    const r = await fetch(CONTEXT_INDEX_BASE + 'doc-summary-index.json');
    if (r.ok) {
      docSummaryIndex = await r.json();
      console.log('[ADA Chat] Loaded doc-summary-index:', docSummaryIndex?.programSummary?.totalCapabilities, 'caps,', docSummaryIndex?.programSummary?.totalDocumentsIndexed, 'docs');
    }
  } catch (e) {
    console.warn('[ADA Chat] Could not load doc-summary-index.json:', e);
  }
  docSummaryLoading = false;
  return docSummaryIndex;
}

/** Build grounding context from doc-summary-index for detected towers/capabilities. */
function getDocSummaryContext(text: string): string {
  if (!docSummaryIndex) return '';
  const parts: string[] = [];
  const lower = text.toLowerCase();

  // Detect tower(s) in user query
  const towerRe = /\b(FPR|OTC-IF|OTC-IP|FTS-IF|FTS-IP|PTP|MDM|E2E)\b/gi;
  const towerMatches = [...new Set((text.match(towerRe) || []).map(t => t.toUpperCase()))];

  // Detect cap IDs
  const capIdRe = /\b([A-Z]{1,4}-(?:IF-|IP-)?[A-Z]{0,3}-?\d{2,3})\b/gi;
  const capIds = [...new Set((text.match(capIdRe) || []).map(m => m.toUpperCase()))];

  // Program-level summary if asking broadly
  if (/program|overall|all.*tower|dashboard|health|summary/i.test(lower) && towerMatches.length === 0 && capIds.length === 0) {
    const ps = docSummaryIndex.programSummary;
    let section = '### Program Metrics (from generated documents)\n';
    section += `- **Towers:** ${ps.totalTowers} | **Capabilities:** ${ps.totalCapabilities}\n`;
    section += `- **Total Dev Objects:** ${ps.totalDevObjects} | **Completed:** ${ps.totalCompleted} (${ps.completionPct}%)\n`;
    section += `- **Open RAIDs:** ${ps.totalOpenRaids} | **Active CRs:** ${ps.totalActiveCRs}\n\n`;
    section += '| Tower | Objects | Completion | Pass Rate | Open RAIDs | Open Defects |\n';
    section += '|-------|---------|------------|-----------|------------|-------------|\n';
    for (const [tw, data] of Object.entries(docSummaryIndex.towers || {})) {
      const rw = data.ricefw || {};
      const ts = data.testing || {} as Record<string, unknown>;
      section += `| ${tw} | ${rw.totalObjects || '—'} | ${rw.avgBuildCompletion || '—'} | ${(ts as Record<string, unknown>).passRate || '—'} | ${data.openRaids || '—'} | ${(ts as Record<string, unknown>).openDefects || '—'} |\n`;
    }
    parts.push(section);
  }

  // Tower-level detail
  for (const tw of towerMatches) {
    const tData = (docSummaryIndex.towers || {})[tw];
    if (!tData) continue;
    let section = `### ${tw} Tower Metrics\n`;
    if (tData.ricefw) {
      const r = tData.ricefw;
      section += `**RICEFW:** ${r.totalObjects} objects (S4: ${r.s4Objects}, ECA: ${r.ecaObjects}) | Active: ${r.activeCount} | Completed: ${r.completedCount} | Rejected: ${r.rejectedCount}\n`;
      section += `**Completion:** FS ${r.avgFsCompletion}, Build ${r.avgBuildCompletion}, FUT ${r.avgFutCompletion}\n`;
      if (r.s4Breakdown) section += `**S4 Breakdown:** ${r.s4Breakdown}\n`;
    }
    if (tData.testing) {
      const t = tData.testing as Record<string, unknown>;
      section += `**Testing:** Pass Rate ${t.passRate} | Open Defects: ${t.openDefects} (Critical: ${t.criticalDefects})\n`;
      if (t.testsPassed != null) section += `**Execution:** Passed: ${t.testsPassed}, Failed: ${t.testsFailed}, Blocked: ${t.testsBlocked}, Not Run: ${t.testsNotRun}\n`;
    }
    if (tData.openRaids) section += `**Open RAIDs:** ${tData.openRaids}\n`;
    if (tData.activeCRs) section += `**Active CRs:** ${tData.activeCRs}\n`;
    parts.push(section);
  }

  // Capability-level detail
  for (const cid of capIds.slice(0, 5)) {
    for (const [tw, tData] of Object.entries(docSummaryIndex.towers || {})) {
      const capData = (tData.capabilities || {})[cid] as Record<string, Record<string, unknown>> | undefined;
      if (!capData) continue;
      let section = `### ${cid} Document Metrics (${tw})\n`;
      if (capData.ricefw) {
        const r = capData.ricefw;
        section += `**RICEFW:** ${r.totalObjects} objects (S4: ${r.s4Objects}, ECA: ${r.ecaObjects}) | Active: ${r.activeCount} | Completed: ${r.completedCount}\n`;
        section += `**Completion:** FS ${r.avgFsCompletion}, Build ${r.avgBuildCompletion}, FUT ${r.avgFutCompletion}\n`;
      }
      if (capData.testing) {
        const t = capData.testing;
        section += `**Testing:** Pass Rate ${t.passRate} | Open Defects: ${t.openDefects} (Critical: ${t.criticalDefects})\n`;
      }
      if (capData.architecture) {
        const a = capData.architecture;
        section += `**Architecture:** ${a.diagramCount} diagrams, ${a.systemCount} systems\n`;
      }
      parts.push(section);
      break;
    }
  }

  const result = parts.join('\n\n');
  if (result.length > 8000) return result.slice(0, 8000) + '\n…(metrics truncated)';
  return result;
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
        section += '| Release | State | Flow Chain | Source | Target | Via | Pattern | Frequency | Data | Src DB Platform | Tgt DB Platform | Src Tech Platform | Tgt Tech Platform |\n';
        section += '|---------|-------|------------|--------|--------|-----|---------|-----------|------|-----------------|-----------------|-------------------|-------------------|\n';
        for (const f of flows.slice(0, 15)) {
          section += `| ${f.release} | ${f.state} | ${f.chain} | ${f.source} | ${f.target} | ${f.via} | ${f.pattern} | ${f.frequency} | ${f.dataDesc} | ${f.srcDbPlatform || ''} | ${f.tgtDbPlatform || ''} | ${f.srcTechPlatform || ''} | ${f.tgtTechPlatform || ''} |\n`;
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
          section += '| Release | State | Flow Chain | Hop | Source | Target | Via | Pattern | Frequency | Data | Src DB Platform | Tgt DB Platform | Src Tech Platform | Tgt Tech Platform |\n';
          section += '|---------|-------|------------|-----|--------|--------|-----|---------|-----------|------|-----------------|-----------------|-------------------|-------------------|\n';
          const maxRows = Math.min(capFlows.length, 80);
          for (let i = 0; i < maxRows; i++) {
            const f = capFlows[i];
            section += `| ${f.release} | ${f.state} | ${f.chain} | ${f.hop} | ${f.source} | ${f.target} | ${f.via} | ${f.pattern} | ${f.frequency} | ${f.dataDesc} | ${f.srcDbPlatform || ''} | ${f.tgtDbPlatform || ''} | ${f.srcTechPlatform || ''} | ${f.tgtTechPlatform || ''} |\n`;
          }
          if (capFlows.length > 80) section += `| … | | ${capFlows.length - 80} more rows | | | | | | | | | | | |\n`;
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
      // Check both the towers array (from tower resolution) and team field
      raidItems = raidItems.filter(r =>
        (r.towers && r.towers.some(t => t.toUpperCase() === towerFilter)) ||
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

// ══════════════════════════════════════════════════════════════════
// PRE-BUILT DIAGRAM GENERATION (deterministic, same as DiagramPreview)
// ══════════════════════════════════════════════════════════════════

// ── Query Intent Detection ────────────────────────────────────
type QueryIntent = 'ricefw' | 'testing' | 'defects' | 'readiness' | 'architecture' | 'dashboard' | 'raid' | 'cr' | 'bpmn';

function detectIntent(text: string): Set<QueryIntent> {
  const lower = text.toLowerCase();
  const intents = new Set<QueryIntent>();
  if (/ricefw|dev.?obj|development.?obj|custom|enhancement|report.*object|interface.*object|conversion|form|workflow/i.test(lower)) intents.add('ricefw');
  if (/test|defect|bug|pass.?rate|execution|regression|qa/i.test(lower)) intents.add('testing');
  if (/defect|bug|open.*issue|critical|severity|resolved/i.test(lower)) intents.add('defects');
  if (/readiness|go.?live|process.?step|cutover|ready/i.test(lower)) intents.add('readiness');
  if (/architect|sad|system.*design|data.*flow|integration.*flow|interface|landscape/i.test(lower)) intents.add('architecture');
  if (/dashboard|metric|kpi|summary|program|overview|health/i.test(lower)) intents.add('dashboard');
  if (/\braid\b|risk|issue|blocker|action.*item|dependency/i.test(lower)) intents.add('raid');
  if (/\bcr\b|change.?request|scope.*change|descope/i.test(lower)) intents.add('cr');
  if (/bpmn|process.*flow|business.*process|process.*step/i.test(lower)) intents.add('bpmn');
  if (intents.size === 0) intents.add('architecture'); // default
  return intents;
}

/** Intent-based formatting guidance injected into system prompt. */
const INTENT_FORMAT_GUIDES: Record<QueryIntent, string> = {
  ricefw: `## Output Format: RICEFW Analysis
Respond concisely:
- **Total Objects:** count (S4: X, ECA: Y)
- **By Type:** table with R/I/C/E/F/W counts
- **Completion:** FS %, Build %, FUT %
- **Top 10 Objects:** table with ID, Name, Type, Status
- **At Risk:** items not yet complete
Ground ALL data in actual RICEFW content. Never fabricate object IDs.`,

  testing: `## Output Format: Testing & Defects
Respond concisely:
- **Pass Rate:** X% (Y passed / Z total)
- **Defect Summary:** table by severity (Open/Resolved/Total)
- **Top 5 Open Defects:** table with ID, Severity, Summary
- **Risk:** 1-2 sentences on release readiness
Ground ALL data in actual testing content.`,

  defects: `## Output Format: Defect Analysis
Respond concisely:
- **Defect Summary:** table by severity (Open/Resolved/Total)
- **Top 10 Open Defects:** table with ID, Severity, Summary, Status
- **Trends:** compare to prior phase if data available
Ground ALL data in actual defect content.`,

  readiness: `## Output Format: Process Readiness
Respond concisely:
- **Status:** Ready / Not Ready / Partial
- **Key Gaps:** bullet list of items not yet ready
- **Checklist:** Config ✓/✗ | Integration ✓/✗ | UAT ✓/✗ | Training ✓/✗
Ground ALL data in actual readiness content.`,

  architecture: `## Output Format: Architecture Summary
Respond concisely:
- **Overview:** 1-2 sentences on capability purpose
- **Key Systems:** bullet list (max 6) with roles
- **Critical Interfaces:** table with Source, Target, Type, Middleware (top 5)
- **Observations:** 2-3 key gaps or risks
Use only systems that appear in the provided context.`,

  dashboard: `## Output Format: Dashboard Metrics
Respond concisely:
- **Headline Metrics:** total capabilities, overall completion %
- **Tower Health:** table with Tower, Caps, Pass Rate, Open Defects
- **Key Risks:** top 3 blockers or concerns
Use actual metrics from Document Metrics context when available.`,

  raid: `## Output Format: RAID Summary
Respond concisely:
- **Total Open:** count by type (Risk/Action/Issue/Dependency)
- **By Severity:** P0: X, P1: Y, P2: Z
- **Top Items:** table with RAID ID, Type, Severity, Title, Status (top 10)
Ground in actual RAID data.`,

  cr: `## Output Format: Change Request Summary
Respond concisely:
- **Total Active CRs:** count
- **By Priority:** High: X, Medium: Y, Low: Z
- **Top CRs:** table with CR ID, Priority, Title, Status, Tower (top 10)
Ground in actual CR data.`,

  bpmn: `## Output Format: BPMN Process
When listing processes, use clickable links: [🔀 {ID} {Name}](#bpmn:{ID})
When showing a single process, generate a Mermaid flowchart with decision gateways and SAP T-codes.`,
};

/** Detect if user message is requesting architecture diagrams. */
function isDiagramRequest(text: string): boolean {
  const lower = text.toLowerCase();
  const diagramKeywords = [
    'architecture diagram', 'integration diagram', 'system diagram',
    'generate.*diagram', 'show.*diagram', 'draw.*diagram',
    'application.*data.*technology', 'application.*architecture',
    'data.*architecture', 'technology.*architecture',
    'generate the architecture', 'show the architecture',
  ];
  return diagramKeywords.some(kw => new RegExp(kw).test(lower));
}

/**
 * Build a deterministic response with pre-generated Mermaid diagrams.
 * Uses the SAME flowsToMermaid() function as DiagramPreview — guarantees
 * visual parity across Preview, Chat, and published Documents.
 */
function buildPreGeneratedDiagramResponse(
  rawRows: Record<string, unknown>[],
  userText: string,
): ChatMessage {
  // Cast to FlowRow[] — the grid data matches this interface
  const rows = rawRows as FlowRow[];

  // Filter rows by release/state if specified in the user message
  const filteredRows = filterRowsByRequest(rows, userText);
  const rowCount = filteredRows.length;

  // Generate all three layers
  const appDiagram = flowsToMermaid(filteredRows, 'application', 'APP');
  const dataDiagram = flowsToMermaid(filteredRows, 'data', 'DAT');
  const techDiagram = flowsToMermaid(filteredRows, 'technology', 'TECH');

  // Build response
  let content = `📐 **Architecture Diagrams** — Generated from ${rowCount} flow rows (same as Preview tab)\n\n`;

  if (appDiagram) {
    content += `## Application Architecture\nShows application components grouped by lane, with interface/technology labels on edges.\n\n\`\`\`mermaid\n${appDiagram}\n\`\`\`\n\n`;
  } else {
    content += `## Application Architecture\n⚠️ No application diagram — no Source/Target System data in the selected rows.\n\n`;
  }

  if (dataDiagram) {
    content += `## Data Architecture\nShows database platforms with application boxes above, connected by data flow edges.\n\n\`\`\`mermaid\n${dataDiagram}\n\`\`\`\n\n`;
  } else {
    content += `## Data Architecture\n⚠️ No data diagram — DB Platform columns are empty for the selected rows. Fill in "Source DB Platform" and "Target DB Platform" in the grid to enable this view.\n\n`;
  }

  if (techDiagram) {
    content += `## Technology Architecture\nShows technology platforms colored by category (cloud/SaaS/on-prem/middleware) with integration pattern labels.\n\n\`\`\`mermaid\n${techDiagram}\n\`\`\`\n\n`;
  } else {
    content += `## Technology Architecture\n⚠️ No technology diagram — Tech Platform columns are empty for the selected rows. Fill in "Source Tech Platform" and "Target Tech Platform" in the grid to enable this view.\n\n`;
  }

  content += `---\n💡 These diagrams are **deterministic** — they match the Preview tab exactly. Edit grid data to update them.`;

  return {
    id: makeId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
  };
}

/** Filter flow rows by release/state mentioned in user text. */
function filterRowsByRequest(rows: FlowRow[], userText: string): FlowRow[] {
  const lower = userText.toLowerCase();

  // Detect release (R1, R2, R3, R4, R5, Release 3, etc.)
  const releaseMatch = lower.match(/\b(?:r|release\s*)(\d)\b/);
  const release = releaseMatch ? `R${releaseMatch[1]}` : null;

  // Detect state (current, future)
  const stateMatch = lower.match(/\b(current|future)\b/);
  const state = stateMatch ? stateMatch[1].charAt(0).toUpperCase() + stateMatch[1].slice(1) : null;

  let filtered = rows;
  if (release) {
    filtered = filtered.filter(r => {
      const rowRelease = String(r['Release'] ?? r['release'] ?? '').trim();
      return rowRelease.toLowerCase() === release.toLowerCase() || rowRelease.includes(releaseMatch![1]);
    });
  }
  if (state) {
    filtered = filtered.filter(r => {
      const rowState = String(r['State'] ?? r['state'] ?? '').trim();
      return rowState.toLowerCase() === state.toLowerCase();
    });
  }

  // If filtering removed all rows, fall back to all rows
  return filtered.length > 0 ? filtered : rows;
}

/**
 * Extract flow rows from the context-index (cross-repo knowledge base) when
 * the editor grid is empty. Converts FlowEntry[] → FlowRow[] format so
 * flowsToMermaid() can generate identical diagrams.
 */
function extractFlowRowsFromContextIndex(userText: string): FlowRow[] {
  if (!contextIndex?.flowIndex) return [];

  const { release, state } = detectFilters(userText);
  const capIdRe = /\b([A-Z]{1,4}-(?:IF-|IP-)?[A-Z]{0,3}-?\d{2,3})\b/gi;
  const capIds = [...new Set((userText.match(capIdRe) || []).map(m => m.toUpperCase()))];
  const systems = detectSystemNames(userText);

  let entries: FlowEntry[] = [];

  // Filter by capability ID first
  if (capIds.length > 0) {
    entries = contextIndex.flowIndex.filter(f => capIds.includes(f.cap.toUpperCase()));
  } else if (systems.length > 0) {
    // Filter by system names
    const sysSet = new Set(systems.map(s => s.toUpperCase()));
    entries = contextIndex.flowIndex.filter(f =>
      sysSet.has((f.source || '').toUpperCase()) || sysSet.has((f.target || '').toUpperCase())
    );
  }

  if (entries.length === 0) return [];

  // Apply release/state filters
  if (release) entries = entries.filter(f => f.release?.toUpperCase() === release);
  if (state) entries = entries.filter(f => f.state?.toLowerCase() === state);
  if (entries.length === 0) return [];

  // Convert FlowEntry → FlowRow (the format flowsToMermaid expects)
  return entries.map(f => ({
    'Flow Chain': f.chain || '',
    'Hop #': f.hop || '',
    'Source System': f.source || '',
    'Target System': f.target || '',
    'Source Lane': '',  // Not available in context-index
    'Target Lane': '',
    'Interface / Technology': f.via || '',
    'Frequency': f.frequency || '',
    'Data Description': f.dataDesc || '',
    'Source DB Platform': f.srcDbPlatform || '',
    'Target DB Platform': f.tgtDbPlatform || '',
    'Source Tech Platform': f.srcTechPlatform || '',
    'Target Tech Platform': f.tgtTechPlatform || '',
    'Integration Pattern': f.pattern || '',
    'Release': f.release || '',
    'State': f.state || '',
  } as FlowRow));
}

/**
 * Send a message to the configured LLM and get a response.
 * @param gridContext — optional stringified grid data for context-aware answers
 * @param flowRows — optional raw flow rows for deterministic diagram generation (same as DiagramPreview)
 */
export async function sendMessage(
  messages: ChatMessage[],
  config: LLMConfig,
  gridContext?: string,
  flowRows?: Record<string, unknown>[],
): Promise<ChatMessage> {
  if (!config.apiKey && !config.endpoint && config.provider !== 'ollama') {
    return {
      id: makeId(),
      role: 'assistant',
      content: '⚙️ **No LLM API configured.** Click your profile icon (bottom-right) → "🔑 AI Assistant — API Key" to enter your API key.\n\nYou can use Anthropic (Claude), OpenAI (GPT), Azure OpenAI, or Ollama (local).',
      timestamp: Date.now(),
    };
  }

  // Load cross-repo context index and doc summary (from ADA-Artifacts GitHub Pages)
  await Promise.all([loadContextIndex(), loadDocSummaryIndex()]);

  // Extract user's latest message text for context search
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUserMsg?.content || '';

  // ── PRE-BUILT DIAGRAM INTERCEPTION ──
  // If the user asks for architecture diagrams and we have flow data, generate them
  // deterministically using the SAME code as DiagramPreview (no LLM hallucination).
  const diagramRequest = isDiagramRequest(userText);
  if (diagramRequest) {
    // Priority 1: Use grid flow rows (exact same data as Preview tab)
    if (flowRows && flowRows.length > 0) {
      return buildPreGeneratedDiagramResponse(flowRows, userText);
    }
    // Priority 2: Extract from context-index (cross-repo knowledge base)
    const contextRows = extractFlowRowsFromContextIndex(userText);
    if (contextRows.length > 0) {
      return buildPreGeneratedDiagramResponse(contextRows, userText);
    }
  }

  // Search context index for cross-capability grounding
  const crossCapContext = searchContextIndex(userText);

  // Document metrics grounding: pre-extracted numbers from generated docs
  const docMetricsContext = getDocSummaryContext(userText);

  // Detect query intent and inject formatting guidance
  const intents = detectIntent(userText);
  const formatGuides = [...intents]
    .map(intent => INTENT_FORMAT_GUIDES[intent])
    .filter(Boolean)
    .slice(0, 2); // Max 2 format guides to avoid prompt bloat

  // Build system prompt with all grounding sources
  let systemPrompt = SYSTEM_PROMPT;
  if (formatGuides.length > 0) {
    systemPrompt += '\n\n' + formatGuides.join('\n\n');
  }
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
  if (docMetricsContext) {
    systemPrompt += `\n\n## Document Metrics (pre-extracted from generated reports)\nUse these exact numbers when answering quantitative questions about RICEFW counts, pass rates, completion %, RAIDs, or CRs.\n\n${docMetricsContext}`;
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

    // OpenAI / Azure OpenAI (Chat Completions API) with JIRA function calling
    const endpoint = config.provider === 'azure-openai' && config.endpoint
      ? config.endpoint
      : 'https://api.openai.com/v1/chat/completions';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
      headers[config.provider === 'azure-openai' ? 'api-key' : 'Authorization'] =
        config.provider === 'azure-openai' ? config.apiKey : `Bearer ${config.apiKey}`;
    }

    const useMaxCompletionTokens = config.provider === 'azure-openai';

    // Detect if JIRA proxy is likely reachable (don't add tools if proxy is down)
    const jiraKeyPattern = /\b(IAODTM-[A-Z]?\d+|jira|test case|defect|bug)\b/i;
    const includeJiraTools = jiraKeyPattern.test(userText);

    // Tool-calling loop: LLM may request JIRA data, we execute and send back
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loopMessages: any[] = [...apiMessages];
    const MAX_TOOL_ROUNDS = 3;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const payload: Record<string, unknown> = {
        messages: loopMessages,
        model: config.model,
        ...(useMaxCompletionTokens
          ? { max_completion_tokens: config.maxTokens }
          : { max_tokens: config.maxTokens }),
        temperature: config.temperature,
      };
      // Only include tools on first round or if previous round had tool calls
      if (includeJiraTools && round < MAX_TOOL_ROUNDS) {
        payload.tools = JIRA_TOOLS;
        payload.tool_choice = 'auto';
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      const choice = data.choices?.[0];
      const msg = choice?.message;

      // If no tool calls, we have the final response
      if (!msg?.tool_calls || msg.tool_calls.length === 0) {
        return {
          id: makeId(),
          role: 'assistant',
          content: msg?.content ?? 'No response',
          timestamp: Date.now(),
        };
      }

      // Execute tool calls and append results
      loopMessages.push(msg); // assistant message with tool_calls
      for (const tc of msg.tool_calls) {
        const fnName = tc.function?.name ?? '';
        let fnArgs: Record<string, unknown> = {};
        try { fnArgs = JSON.parse(tc.function?.arguments ?? '{}'); } catch { /* empty */ }
        const result = await executeJiraTool(fnName, fnArgs);
        loopMessages.push({
          role: 'tool' as const,
          tool_call_id: tc.id,
          content: result,
        });
      }
    }

    // Fallback if loop exhausted (shouldn't happen)
    return {
      id: makeId(),
      role: 'assistant',
      content: 'Tool calling loop exhausted. Please try a simpler query.',
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
