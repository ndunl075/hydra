import React, { useEffect, useRef, useState } from 'react';
import type { ClientMessage, Task, SessionView } from '../src/core/model';
import { receiveConversationDraft, type ConversationDraft, type ConversationDraftState } from '../src/core/conversationDrafts';
import { pendingSchedule } from '../src/core/scheduler';
import { TurnModelLabel } from './ModelControls';
import { HydraMark } from './HydraMark';
import { ComposerIcon } from './ComposerIcons';
import { withoutPlannerMarker, withoutPlannerSuffix } from '../src/core/plannerSuffix';
import type { ModelCatalog } from '../src/core/modelSelection';
import type { Provider, ProviderInfo } from '../src/core/model';
import { canEditBrief, emptyBrief } from '../src/core/taskContext';
import { latestContextUsage } from '../src/core/contextUsage';
import { ContextRing, ModelPicker, PermissionModePicker, asTaskPermissionMode } from './ComposerPickers';

/** What the sidebar composer needs beyond the task: catalogs to pick from and the delegation preference. */
export interface ComposerContext { catalogs: Partial<Record<Provider, ModelCatalog>>; providers: ProviderInfo[] }
const providerName = (provider: string) => provider === 'claude' ? 'Claude Code' : 'Codex';
export function SessionThread({ task, session, busy, draft, send, available = true, compact = false, composer }: { task: Task; session: SessionView; busy: boolean; draft?: ConversationDraft; send: (message: ClientMessage) => void; available?: boolean; compact?: boolean; composer?: ComposerContext }) {
  // Provider, model and permission mode can change until the first launch; after
  // that the session belongs to them, so the composer reports them instead.
  const editable = canEditBrief(task, session);
  const locked = 'Locked after launch: this conversation’s session belongs to its provider, model and permission mode. Start a new task to change them.';
  const messages = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  useEffect(() => {
    if (compact && messages.current && followOutput.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [compact, session.turns.length, session.turns.at(-1)?.text, session.approvals?.length]);
  const [state, setState] = useState<ConversationDraftState>({ local: draft || { prompt: '', version: '' }, latest: draft });
  useEffect(() => {
    setState(current => receiveConversationDraft(current, draft));
  }, [draft?.revision]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === 'conversationDraftAck' && message.id === task.id) setState(current => receiveConversationDraft(current, message.draft, message.version));
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [task.id]);
  const { local } = state;
  const prompt = local.prompt;
  const setPrompt = (prompt: string) => {
    const version = crypto.randomUUID();
    setState(current => ({ ...current, local: { prompt, version }, pendingVersion: version }));
    send({ type: 'conversationDraft', id: task.id, prompt, version });
  };
  useEffect(() => {
    if (!compact) return;
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== 'contextAttached' || !Array.isArray(event.data.paths)) return;
      const reference = event.data.paths.map((item: string) => `\`${item}\``).join(' ');
      setPrompt(`${prompt}${prompt.trim() ? '\n' : ''}Context: ${reference}`);
    };
    window.addEventListener('message', listener); return () => window.removeEventListener('message', listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, prompt]);
  const running = task.state === 'running' || !!session.active;
  const turnCount = session.totalTurns || session.turns.length;
  // A send in flight: shown at once, cleared when its turn appears. If no turn
  // appears and nothing is running after a while, the send failed (the host
  // reports why); the typed text goes back in the box.
  const [sending, setSending] = useState<{ prompt: string; turns: number; at: number } | null>(null);
  useEffect(() => {
    if (!sending) return;
    if (turnCount > sending.turns || running && !sending.prompt) { setSending(null); return; }
    const timer = setTimeout(() => {
      if (running) return;
      if (sending.prompt && !prompt.trim()) setPrompt(sending.prompt);
      setSending(null);
    }, 12000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, turnCount, running]);
  // Before the first launch the box is not dead: what is typed extends the task's
  // first message (the brief is still editable then), and send starts the task.
  // saveBrief updates the prompt synchronously on receipt, so the start that
  // follows it reads the extended message.
  const submitCompact = () => {
    if (blocked) return;
    if (retryable) { send({ type: 'retryBlocked', id: task.id }); setSending({ prompt: '', turns: turnCount, at: Date.now() }); return; }
    if (task.sessionId) {
      if (!prompt.trim()) return;
      send({ type: 'followUp', id: task.id, prompt, draftVersion: local.version });
      // Show the message and a working state now, as the provider's own panel
      // does; the host takes a few seconds to start the provider process.
      setSending({ prompt, turns: turnCount, at: Date.now() }); setPrompt('');
      return;
    }
    if (prompt.trim()) {
      const base = task.brief || { ...emptyBrief(), goal: task.prompt };
      send({ type: 'saveBrief', id: task.id, brief: { ...base, goal: `${base.goal.trim()}\n\n${prompt.trim()}` } });
      setPrompt('');
    }
    send({ type: 'startManaged', id: task.id });
    setSending({ prompt: '', turns: turnCount, at: Date.now() });
  };
  // Only these make a reply impossible; while a turn runs or the host is busy you
  // can still click in and type (as in the provider's own panel), only Send waits.
  const cannotReply = task.state === 'external' || task.interface === 'official-extension' || !!task.sessionProvider && task.sessionProvider !== task.provider;
  // A launch that failed at startup leaves its schedule blocked. Send then
  // retries that same launch instead of sitting disabled with only Cancel.
  const retryable = task.schedule?.state === 'blocked' && !!task.schedule.request && !task.schedule.uncertain && !running && !cannotReply;
  const blocked = busy || !!sending || (pendingSchedule(task) && !retryable) || !available || running || cannotReply;
  return <div className="session-conversation">
    <div className="session-messages" ref={messages} onScroll={event => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }}>
    {!session.turns.length && <article className={compact ? 'message user-card' : 'message'}>{!compact && <div className="message-author"><strong>You</strong><span className="local-tag">TASK BRIEF</span></div>}<p className="prompt-text">{task.prompt}</p></article>}
    {(session.totalTurns || session.turns.length) > 10 && <p className="quiet">Showing the latest ten turns. Full conversation and process events remain in local storage.</p>}
    {session.turns.slice(-10).map(turn => <React.Fragment key={turn.id}>
      <article className={compact ? 'message user-card' : 'message'}>{!compact && <div className="message-author"><span className="avatar">N</span><strong>You</strong><time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>}<p className="prompt-text">{withoutPlannerSuffix(turn.prompt)}</p></article>
      <article className="message assistant-message">{!compact && <div className="message-author"><HydraMark className="avatar hydra-avatar" /><strong>{providerName(turn.provider || 'claude')}</strong><span className="local-tag">{turn.status === 'completed' ? 'TURN FINISHED' : turn.status.toUpperCase()}</span></div>}{compact && turn.status !== 'completed' && <span className="turn-status">{turn.status}</span>}{withoutPlannerMarker(turn.text || '') ? <p className="prompt-text">{withoutPlannerMarker(turn.text || '')}</p> : turn.status === 'running' ? <WorkingIndicator label="Thinking" /> : <p className="prompt-text">No response text returned.</p>}
        {(!compact || turn.modelSettings?.rerouted) && <TurnModelLabel turn={turn} />}
        {turn.error && <p className="session-error" role="status">{turn.error}</p>}
        {turn.textTruncated && <p className="session-note">Showing the first 50,000 characters here. Full output is retained in local raw diagnostics; model context is unchanged.</p>}
        {!!turn.permissionDenials && <p className="session-note">{turn.permissionDenials} permission request(s) denied. Interactive approvals are unavailable here; use the provider terminal when needed.</p>}
        {turn.usage && !compact && <p className="session-note">{turn.provider === 'codex' ? 'Latest model response (not a turn total)' : 'Provider result'} tokens: {turn.usage.input.toLocaleString()} input · {turn.usage.output.toLocaleString()} output{turn.usage.cacheRead !== undefined && ` · ${turn.usage.cacheRead.toLocaleString()} cache read`}{turn.usage.cacheCreated !== undefined && ` · ${turn.usage.cacheCreated.toLocaleString()} cache created`}{turn.usage.estimatedUsd !== undefined && ` · $${turn.usage.estimatedUsd.toFixed(4)} provider estimate, not your bill`}</p>}
      </article>
    </React.Fragment>)}
    {sending && turnCount <= sending.turns && <>
      {sending.prompt && <article className={compact ? 'message user-card' : 'message'}><p className="prompt-text">{sending.prompt}</p></article>}
      <article className="message assistant-message"><WorkingIndicator label={`Starting ${providerName(task.provider)}`} /></article>
    </>}
    {session.approvals?.map(approval => <article key={approval.id} className="approval-request" aria-label={`${approval.kind} approval`}>
      <div className="section-label">{approval.kind.toUpperCase()} APPROVAL</div><p>Review this request before allowing {providerName(task.provider)} to proceed. This grants only the displayed request.</p><pre>{approval.detail}</pre>
      <div className="task-actions"><button className="stop-button" disabled={!running} onClick={() => send({ type: 'approve', id: task.id, approvalId: approval.id, decision: 'decline' })}>Decline</button><button className="secondary" disabled={!running} onClick={() => send({ type: 'approve', id: task.id, approvalId: approval.id, decision: 'accept' })}>Allow this request</button></div>
    </article>)}
    {!!task.sessionProvider && task.sessionProvider !== task.provider && <p role="status">This recorded session belongs to {providerName(task.sessionProvider)}. Create a separate task for {providerName(task.provider)}.</p>}
    </div>
    {/* The sidebar composer is the same shape as the one that starts a task, so the
        input does not change form once a conversation exists. The manager view keeps
        the labelled form, where the surrounding controls explain themselves. */}
    {compact ? <form className="task-prompt-form chat-start-composer" onSubmit={event => { event.preventDefault(); submitCompact(); }}>
      <div className="task-prompt-box">
        <textarea className="task-prompt-textarea" rows={1} maxLength={32000} value={prompt} disabled={cannotReply} aria-label={task.sessionId ? 'Follow-up' : 'Add to your first message'}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitCompact(); } }}
          placeholder={task.sessionId ? 'Reply to this agent' : 'Add to your first message, or send to start'} />
        <div className="task-prompt-toolbar">
          <div className="task-prompt-toolbar-group">
            <button type="button" className="composer-icon-button" aria-label="Attach context" title="Attach a file to this reply" disabled={blocked} onClick={() => send({ type: 'attachContext' })}><ComposerIcon name="plus" /></button>
            <ContextRing usage={latestContextUsage(session.turns)} />
            <ModelPicker selection={task.modelSelection || null} effective={[...session.turns].reverse().find(turn => turn.modelSettings?.effective)?.modelSettings?.effective} provider={task.provider} catalogs={composer?.catalogs || {}} providers={composer?.providers || []} busy={busy} send={send} locked={editable ? undefined : locked}
              onSelect={(selection, provider) => send({ type: 'saveProviderSelection', id: task.id, provider, selection })} />
          </div>
          <div className="task-prompt-toolbar-group">
            <PermissionModePicker provider={task.provider} mode={task.permissionMode?.mode ?? null} busy={busy} locked={editable ? undefined : locked}
              onSelect={next => send({ type: 'savePermissionMode', id: task.id, permissionMode: asTaskPermissionMode(task.provider, next) })} />
            {running ? <button className="composer-stop" type="button" disabled={busy} title="Stop process" aria-label="Stop process" onClick={() => send({ type: 'stop', id: task.id })}>■</button>
              : task.sessionId ? <button className="task-prompt-send" type="submit" disabled={blocked || !retryable && !prompt.trim()} title={retryable ? 'Retry the failed launch' : 'Send'} aria-label={retryable ? 'Retry' : 'Send'}><ComposerIcon name="up" /></button>
              : <button className="task-prompt-send composer-start" type="button" disabled={blocked} title={retryable ? 'Retry the failed launch' : 'Start task'} aria-label={retryable ? 'Retry' : 'Start task'} onClick={submitCompact}><ComposerIcon name="up" /></button>}
          </div>
        </div>
      </div>
      <p className="form-note">Runs in this task worktree. Review approvals in this conversation.</p>
    </form> : <form className="follow-up" onSubmit={event => { event.preventDefault(); if (!blocked && prompt.trim()) send({ type: 'followUp', id: task.id, prompt, draftVersion: local.version }); }}>
      <label>Follow-up<textarea rows={3} maxLength={32000} value={prompt} disabled={blocked || !task.sessionId} onChange={event => setPrompt(event.target.value)} placeholder={task.sessionId ? "Continue this task..." : "Start the task to begin a conversation."} /></label>
      <div className="task-actions">{task.sessionId ? <button className="primary" disabled={blocked || !prompt.trim()} type="submit">Send</button> : <button className="primary" disabled={blocked} type="button" onClick={() => send({ type: 'startManaged', id: task.id })}>Start task</button>}{running ? <button className="stop-button" disabled={busy} type="button" onClick={() => send({ type: 'stop', id: task.id })}>Stop process</button> : <button className="secondary" type="button" disabled={blocked} onClick={() => send({ type: 'launch', id: task.id })}>Open provider terminal</button>}</div>
      <p className="form-note">Messages run in this task worktree. Follow-ups resume its provider session. {task.provider === 'codex' ? 'Stop requests an interrupt, then terminates the owned process if needed. Approvals grant only the displayed request; unsupported prompts stop the turn.' : 'Stop process terminates the owned process tree. Approvals grant only the displayed command or file request; unsupported interactions stop the turn.'}</p>
      <button className="secondary" type="button" disabled={busy} onClick={() => send({ type: 'showSessionDiagnostics', id: task.id })}>Raw diagnostics</button>
    </form>}
  </div>;
}

/** An animated "working" line, shown the moment a send is made. */
function WorkingIndicator({ label }: { label: string }) {
  return <p className="working-indicator" role="status"><span className="working-dot" aria-hidden="true" />{label}…</p>;
}
