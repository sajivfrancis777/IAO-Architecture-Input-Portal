/**
 * ChatPanel — Slide-out AI Architecture Assistant.
 *
 * Production-grade chat with:
 *   - Message history with timestamps
 *   - Prompt templates gallery
 *   - Session history browser
 *   - Markdown rendering for assistant responses
 *   - Artifact detection (Mermaid diagrams, tables)
 *   - Configurable position (right or bottom)
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  sendMessage, createUserMessage, loadLLMConfig, saveLLMConfig,
  loadChatHistory, saveChatHistory, clearChatHistory,
  type ChatMessage,
} from './chatService';
import { PROMPT_TEMPLATES, TEMPLATE_CATEGORIES } from './promptTemplates';
import { renderMarkdown, renderMermaidDiagrams } from './renderMarkdown';
import ChatIcon from './ChatIcon';

type ChatView = 'chat' | 'history' | 'templates' | 'admin';

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  /** Current grid context — injected into system prompt so the assistant has real data */
  gridContext?: string;
  /** Raw flow rows from the grid — used for pre-built diagram generation (same as DiagramPreview) */
  flowRows?: Record<string, unknown>[];
}

export default function ChatPanel({ open, onClose, gridContext, flowRows }: ChatPanelProps) {
  const { user, isAdmin } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ChatView>('chat');
  const [sessions, setSessions] = useState<ChatMessage[][]>(() => loadChatHistory());
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [maximized, setMaximized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Render Mermaid diagrams + bind expand buttons after messages update
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    renderMermaidDiagrams(container);
    // Bind expand buttons
    container.querySelectorAll<HTMLButtonElement>('.md-mermaid-expand').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';
      btn.addEventListener('click', () => {
        const wrap = btn.closest('.md-mermaid-wrap');
        const mermaidEl = wrap?.querySelector('.md-mermaid');
        if (!mermaidEl) return;
        const svg = mermaidEl.querySelector('svg');
        const overlay = document.createElement('div');
        overlay.className = 'md-mermaid-overlay';
        const contentDiv = document.createElement('div');
        contentDiv.className = 'md-mermaid-overlay-content';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'md-mermaid-overlay-close';
        closeBtn.title = 'Close';
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', () => overlay.remove());
        contentDiv.appendChild(closeBtn);
        if (svg) {
          // Use outerHTML so embedded <style> with scoped selectors
          // (classDef fill colors) are preserved in the clone.
          const wrapper = document.createElement('div');
          wrapper.className = 'md-mermaid-zoom-container';
          wrapper.innerHTML = svg.outerHTML;
          const clonedSvg = wrapper.querySelector('svg');
          if (clonedSvg) {
            // Assign a fresh ID so scoped styles don't collide
            const freshId = 'mmd-expand-' + Date.now();
            const oldId = clonedSvg.getAttribute('id') || '';
            clonedSvg.setAttribute('id', freshId);
            // Rewrite scoped style selectors from old ID to new ID
            const styleEl = clonedSvg.querySelector('style');
            if (styleEl && oldId) {
              styleEl.textContent = (styleEl.textContent || '').split('#' + oldId).join('#' + freshId);
            }
            clonedSvg.style.width = '100%';
            clonedSvg.style.height = '100%';
            clonedSvg.style.maxWidth = 'none';
          }
          contentDiv.appendChild(wrapper);

          // ── Zoom & Pan ──
          let scale = 1, panX = 0, panY = 0, isPanning = false, startX = 0, startY = 0;
          const applyTransform = () => { wrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`; };
          wrapper.addEventListener('wheel', (e) => { e.preventDefault(); const delta = e.deltaY > 0 ? 0.9 : 1.1; scale = Math.min(Math.max(scale * delta, 0.2), 10); applyTransform(); }, { passive: false });
          wrapper.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; isPanning = true; startX = e.clientX - panX; startY = e.clientY - panY; wrapper.setPointerCapture(e.pointerId); wrapper.style.cursor = 'grabbing'; });
          wrapper.addEventListener('pointermove', (e) => { if (!isPanning) return; panX = e.clientX - startX; panY = e.clientY - startY; applyTransform(); });
          wrapper.addEventListener('pointerup', (e) => { isPanning = false; wrapper.releasePointerCapture(e.pointerId); wrapper.style.cursor = 'grab'; });
          // Double-click to reset
          wrapper.addEventListener('dblclick', () => { scale = 1; panX = 0; panY = 0; applyTransform(); });

          // Zoom toolbar
          const zoomBar = document.createElement('div');
          zoomBar.className = 'md-mermaid-zoom-toolbar';
          zoomBar.innerHTML = '<button class="md-mermaid-zoom-btn" data-action="in" title="Zoom in">＋</button>' +
            '<button class="md-mermaid-zoom-btn" data-action="out" title="Zoom out">－</button>' +
            '<button class="md-mermaid-zoom-btn" data-action="reset" title="Reset zoom">⟳</button>';
          zoomBar.addEventListener('click', (e) => {
            const action = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action');
            if (action === 'in') { scale = Math.min(scale * 1.25, 10); applyTransform(); }
            else if (action === 'out') { scale = Math.max(scale * 0.8, 0.2); applyTransform(); }
            else if (action === 'reset') { scale = 1; panX = 0; panY = 0; applyTransform(); }
          });
          contentDiv.appendChild(zoomBar);
        } else {
          const pre = document.createElement('pre');
          pre.className = 'md-pre';
          pre.style.maxHeight = 'none';
          pre.textContent = mermaidEl.textContent;
          contentDiv.appendChild(pre);
        }
        overlay.appendChild(contentDiv);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
      });
    });
    // Bind refresh buttons — force re-render of mermaid diagrams
    container.querySelectorAll<HTMLButtonElement>('.md-mermaid-refresh').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';
      btn.addEventListener('click', () => {
        const wrap = btn.closest('.md-mermaid-wrap');
        const mermaidEl = wrap?.querySelector<HTMLElement>('.md-mermaid');
        if (!mermaidEl) return;
        // Get the raw code from the details section
        const codeEl = wrap?.querySelector('.md-mermaid-code code');
        const rawCode = codeEl?.textContent || '';
        if (!rawCode) return;
        // Reset the element so renderMermaidDiagrams picks it up again
        mermaidEl.textContent = rawCode;
        mermaidEl.classList.remove('md-mermaid-rendered', 'md-mermaid-error');
        delete mermaidEl.dataset.rendered;
        // Re-render this specific element
        renderMermaidDiagrams(wrap as HTMLElement);
      });
    });
    // Bind BPMN drill-down buttons — auto-send a follow-up prompt
    container.querySelectorAll<HTMLButtonElement>('.md-bpmn-drill').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';
      btn.addEventListener('click', () => {
        const processId = btn.dataset.processId || '';
        const processName = btn.textContent?.replace(/^🔀\s*/, '').trim() || processId;
        sendPromptRef.current(
          `Generate a detailed Mermaid flowchart diagram for BPMN process ${processName}. ` +
          `Include all process steps, decision gateways, SAP transaction codes, and error handling paths.`
        );
      });
    });
  }, [messages, maximized]);

  // Focus input when panel opens
  useEffect(() => {
    if (open && view === 'chat') {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [open, view]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg = createUserMessage(text);
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    const config = loadLLMConfig();
    const response = await sendMessage(
      newMessages.filter(m => m.role !== 'system'),
      config,
      gridContext,
      flowRows,
    );
    const final = [...newMessages, response];
    setMessages(final);
    setLoading(false);

    // Save session
    const updated = [...sessions.filter(s => s.length > 0), final];
    setSessions(updated);
    saveChatHistory(updated);
  }, [input, loading, messages, sessions, gridContext, flowRows]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleNewChat = useCallback(() => {
    if (messages.length > 0) {
      const updated = [...sessions.filter(s => s.length > 0), messages];
      setSessions(updated);
      saveChatHistory(updated);
    }
    setMessages([]);
    setView('chat');
  }, [messages, sessions]);

  const loadSession = useCallback((idx: number) => {
    setMessages(sessions[idx] ?? []);
    setView('chat');
  }, [sessions]);

  const deleteSession = useCallback((idx: number) => {
    if (!confirm('Delete this conversation?')) return;
    const updated = [...sessions];
    updated.splice(idx, 1);
    setSessions(updated);
    saveChatHistory(updated);
  }, [sessions]);

  const clearAllSessions = useCallback(() => {
    if (!confirm('Delete ALL conversation history? This cannot be undone.')) return;
    setSessions([]);
    setMessages([]);
    clearChatHistory();
  }, []);

  const useTemplate = useCallback((prompt: string) => {
    setInput(prompt);
    setView('chat');
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Auto-send a prompt (used by BPMN drill-down clicks)
  const sendPromptDirect = useCallback(async (text: string) => {
    if (loading) return;
    const userMsg = createUserMessage(text);
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    const config = loadLLMConfig();
    const response = await sendMessage(
      newMessages.filter(m => m.role !== 'system'),
      config,
      gridContext,
      flowRows,
    );
    const final = [...newMessages, response];
    setMessages(final);
    setLoading(false);

    const updated = [...sessions.filter(s => s.length > 0), final];
    setSessions(updated);
    saveChatHistory(updated);
  }, [loading, messages, sessions, gridContext, flowRows]);

  // Stable ref so DOM event handlers always get the latest function
  const sendPromptRef = useRef(sendPromptDirect);
  sendPromptRef.current = sendPromptDirect;

  // ── Export handlers ────────────────────────────────────────
  const extractTitle = (md: string) => {
    const match = md.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : 'Architecture Response';
  };
  const safeName = (title: string) => title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 50) || 'document';

  const handleCopyMd = (md: string) => {
    navigator.clipboard.writeText(md);
  };

  const handleDownloadHtml = (md: string) => {
    const title = extractTitle(md);
    const htmlBody = renderMarkdown(md);
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const css = 'body{font-family:"Segoe UI",Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;color:#1a1a1a;max-width:210mm;margin:0 auto;padding:15mm;background:#fff}h1{font-size:22pt;color:#00285a;border-bottom:3px solid #0071c5;padding-bottom:8px;margin-top:30px}h2{font-size:16pt;color:#00285a;border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:24px}h3{font-size:13pt;color:#0071c5;margin-top:18px}table{border-collapse:collapse;width:100%;margin:12px 0;font-size:9.5pt}th{background:#00285a;color:#fff;font-weight:600;text-align:left;padding:4px 6px;border:1px solid #00285a}td{padding:4px 6px;border:1px solid #ddd}tr:nth-child(even) td{background:#f5f8fc}code{font-family:"Cascadia Code",Consolas,monospace;font-size:9pt;background:#f0f0f0;padding:1px 4px;border-radius:3px}pre{background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:4px;overflow-x:auto;font-size:8.5pt}blockquote{border-left:4px solid #0071c5;background:#f5f8fc;margin:12px 0;padding:8px 16px;color:#333}.header-bar{background:#00285a;color:#fff;padding:16px 24px;margin:-15mm -15mm 20px -15mm}.header-bar h1{color:#fff;border:none;margin:0;padding:0;font-size:20pt}.header-bar .subtitle{color:#a8c7e8;font-size:10pt}.footer{font-size:8pt;color:#888;text-align:center;margin-top:30px;padding-top:10px;border-top:1px solid #ddd}';
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title><style>${css}</style></head><body><div class="header-bar"><h1>${title}</h1><div class="subtitle">IAO Architecture — Generated ${timestamp}</div></div>${htmlBody}<div class="footer">IAO Architecture · Intel IDM 2.0 · Generated ${timestamp}</div></body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeName(title) + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleDownloadMd = (md: string) => {
    const title = extractTitle(md);
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeName(title) + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!open) return null;

  return (
    <div className={`chat-overlay ${maximized ? 'chat-overlay-max' : ''}`}>
      <div className={`chat-panel ${maximized ? 'chat-panel-max' : ''}`}>
        {/* Header */}
        <div className="chat-header">
          <div className="chat-header-left">
            <span className="chat-logo"><ChatIcon size={28} color="#fff" /></span>
            <div>
              <h3 className="chat-title">Architecture Assistant</h3>
              <span className="chat-subtitle">IAO · IDM 2.0</span>
            </div>
          </div>
          <div className="chat-header-actions">
            <button className="chat-icon-btn" onClick={handleNewChat} title="New conversation">＋</button>
            <button className="chat-icon-btn" onClick={() => setMaximized(m => !m)} title={maximized ? 'Restore' : 'Maximize'}>{maximized ? '⊖' : '⊕'}</button>
            <button className="chat-icon-btn" onClick={onClose} title="Close">✕</button>
          </div>
        </div>

        {/* Navigation tabs */}
        <div className="chat-nav">
          {(['chat', 'templates', 'history'] as const).map(v => (
            <button key={v} className={`chat-nav-btn ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
              {v === 'chat' ? '💬 Chat' : v === 'templates' ? '📋 Templates' : '📜 History'}
            </button>
          ))}
          {isAdmin && (
            <button className={`chat-nav-btn ${view === 'admin' ? 'active' : ''}`} onClick={() => setView('admin')}>
              ⚙️ Admin
            </button>
          )}
        </div>

        {/* Chat view */}
        {view === 'chat' && (
          <>
            <div className="chat-messages" ref={messagesContainerRef}>
              {messages.length === 0 && (
                <div className="chat-welcome">
                  <div className="chat-welcome-icon"><ChatIcon size={56} color="#0071C5" /></div>
                  <h4>Welcome, {user.displayName}</h4>
                  <p>Ask about architecture, integration patterns, system dependencies, or use a template to get started.</p>
                  <div className="chat-quick-actions">
                    {PROMPT_TEMPLATES.slice(0, 4).map(t => (
                      <button key={t.id} className="chat-quick-btn" onClick={() => useTemplate(t.prompt)}>
                        {t.icon} {t.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map(msg => (
                <div key={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
                  <div className="chat-msg-avatar">
                    {msg.role === 'user' ? '👤' : <ChatIcon size={18} color="#0071C5" />}
                  </div>
                  <div className="chat-msg-body">
                    <div className="chat-msg-meta">
                      <span className="chat-msg-name">{msg.role === 'user' ? user.displayName : 'Assistant'}</span>
                      <span className="chat-msg-time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    {msg.role === 'user'
                      ? <div className="chat-msg-content">{msg.content}</div>
                      : <div className="chat-msg-content md-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                    }
                    {msg.role === 'assistant' && (
                      <div className="chat-msg-actions">
                        <button className="chat-msg-act" onClick={() => handleCopyMd(msg.content)}>📋 Copy</button>
                        <button className="chat-msg-act" onClick={() => handleDownloadHtml(msg.content)}>🌐 HTML</button>
                        <button className="chat-msg-act" onClick={() => handleDownloadMd(msg.content)}>📄 Word</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="chat-msg chat-msg-assistant">
                  <div className="chat-msg-avatar"><ChatIcon size={18} color="#0071C5" /></div>
                  <div className="chat-msg-body">
                    <div className="chat-typing">
                      <span></span><span></span><span></span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="chat-input-area">
              <textarea
                ref={inputRef}
                className="chat-input"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about architecture…"
                rows={1}
                disabled={loading}
              />
              <button
                className="chat-send-btn"
                onClick={handleSend}
                disabled={!input.trim() || loading}
                title="Send (Enter)"
              >
                ➤
              </button>
            </div>
          </>
        )}

        {/* Templates view */}
        {view === 'templates' && (
          <div className="chat-templates">
            <div className="chat-template-cats">
              <button className={`chat-cat-btn ${selectedCategory === 'All' ? 'active' : ''}`}
                onClick={() => setSelectedCategory('All')}>All</button>
              {TEMPLATE_CATEGORIES.map(c => (
                <button key={c} className={`chat-cat-btn ${selectedCategory === c ? 'active' : ''}`}
                  onClick={() => setSelectedCategory(c)}>{c}</button>
              ))}
            </div>
            <div className="chat-template-list">
              {PROMPT_TEMPLATES
                .filter(t => selectedCategory === 'All' || t.category === selectedCategory)
                .map(t => (
                <div key={t.id} className="chat-template-card" onClick={() => useTemplate(t.prompt)}>
                  <span className="chat-template-icon">{t.icon}</span>
                  <div>
                    <div className="chat-template-title">{t.title}</div>
                    <div className="chat-template-desc">{t.prompt.slice(0, 80)}…</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* History view */}
        {view === 'history' && (
          <div className="chat-history">
            {sessions.length === 0 ? (
              <div className="chat-empty">No conversation history yet</div>
            ) : (
              <>
                <div className="chat-history-toolbar">
                  <span className="chat-history-count">{sessions.length} conversation{sessions.length !== 1 ? 's' : ''}</span>
                  <button className="chat-history-clear-all" onClick={clearAllSessions}>🗑 Clear All</button>
                </div>
                {sessions.map((session, idx) => {
                  const firstUser = session.find(m => m.role === 'user');
                  const msgCount = session.length;
                  const time = session[0]?.timestamp;
                  return (
                    <div key={idx} className="chat-history-item">
                      <div className="chat-history-content" onClick={() => loadSession(idx)}>
                        <div className="chat-history-preview">
                          {firstUser?.content.slice(0, 100) ?? 'Empty session'}
                        </div>
                        <div className="chat-history-meta">
                          {msgCount} messages · {time ? new Date(time).toLocaleDateString() : ''}
                        </div>
                      </div>
                      <button className="chat-history-del" onClick={() => deleteSession(idx)} title="Delete">🗑</button>
                    </div>
                  );
                }).reverse()}
              </>
            )}
          </div>
        )}

        {/* Admin view */}
        {view === 'admin' && <AdminSection />}

        {/* Footer */}
        <div className="chat-footer">
          <span className="chat-footer-text">
            Powered by AI · {user.role === 'admin' ? '🔑 Admin' : `👤 ${user.role}`}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Admin Section (inline) ──────────────────────────────────────

function AdminSection() {
  const { isAdmin } = useAuth();
  const [config, setConfig] = useState(() => loadLLMConfig());
  const [saved, setSaved] = useState(false);

  if (!isAdmin) {
    return <div className="chat-empty">Admin access required</div>;
  }

  const handleSave = () => {
    saveLLMConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="chat-admin">
      <h4 className="chat-admin-title">🔧 LLM Configuration</h4>

      <label className="chat-admin-label">Provider</label>
      <select className="chat-admin-select" value={config.provider}
        onChange={e => setConfig({ ...config, provider: e.target.value as typeof config.provider })}>
        <option value="anthropic">Anthropic (Claude)</option>
        <option value="openai">OpenAI (GPT)</option>
        <option value="azure-openai">Azure OpenAI</option>
        <option value="custom">Custom Endpoint</option>
      </select>

      <label className="chat-admin-label">API Key</label>
      <input className="chat-admin-input" type="password" value={config.apiKey}
        onChange={e => setConfig({ ...config, apiKey: e.target.value })}
        placeholder="sk-... or your API key" />

      <label className="chat-admin-label">Model</label>
      <input className="chat-admin-input" type="text" value={config.model}
        onChange={e => setConfig({ ...config, model: e.target.value })}
        placeholder="claude-sonnet-4-20250514" />

      {(config.provider === 'custom' || config.provider === 'azure-openai') && (
        <>
          <label className="chat-admin-label">Endpoint URL</label>
          <input className="chat-admin-input" type="url" value={config.endpoint ?? ''}
            onChange={e => setConfig({ ...config, endpoint: e.target.value })}
            placeholder="https://your-api.azurewebsites.net/api/chat" />
        </>
      )}

      <label className="chat-admin-label">Max Tokens</label>
      <input className="chat-admin-input" type="number" value={config.maxTokens}
        onChange={e => setConfig({ ...config, maxTokens: Number(e.target.value) })} />

      <label className="chat-admin-label">Temperature</label>
      <input className="chat-admin-input" type="range" min="0" max="1" step="0.1"
        value={config.temperature}
        onChange={e => setConfig({ ...config, temperature: Number(e.target.value) })} />
      <span className="chat-admin-hint">{config.temperature} (0 = precise, 1 = creative)</span>

      <button className="chat-admin-save" onClick={handleSave}>
        {saved ? '✓ Saved' : '💾 Save Configuration'}
      </button>

      <div className="chat-admin-section">
        <h4 className="chat-admin-title">👥 Access Control</h4>
        <p className="chat-admin-hint">
          Role-based access is configured. When Entra ID is enabled, roles will sync from Azure AD app roles.
          Current mode: localStorage (local development).
        </p>
        <div className="chat-admin-roles">
          <div className="chat-role-card">
            <strong>Admin</strong>
            <span>Full access: API keys, user management, all features</span>
          </div>
          <div className="chat-role-card">
            <strong>Architect</strong>
            <span>Edit flows, use chat, view diagrams, download/upload Excel</span>
          </div>
          <div className="chat-role-card">
            <strong>Viewer</strong>
            <span>Read-only: browse flows and diagrams, no editing</span>
          </div>
        </div>
      </div>
    </div>
  );
}
