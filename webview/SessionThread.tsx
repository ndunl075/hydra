import React, { useEffect, useRef, useState } from 'react';
import type { ClientMessage, Task, SessionView } from '../src/core/model';
import { receiveConversationDraft, type ConversationDraft, type ConversationDraftState } from '../src/core/conversationDrafts';
import { pendingSchedule } from '../src/core/scheduler';
import { TurnModelLabel } from './ModelControls';
import { HydraMark } from './HydraMark';
const providerName = (provider: string) => provider === 'claude' ? 'Claude Code' : 'Codex';
export function SessionThread({ task, session, busy, draft, send, available = true, compact = false }: { task: Task; session: SessionView; busy: boolean; draft?: ConversationDraft; send: (message: ClientMessage) => void; available?: boolean; compact?: boolean }) {
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
  const running = task.state === 'running' || !!session.active;
  const blocked = busy || pendingSchedule(task) || !available || running || task.state === 'external' || task.interface === 'official-extension' || !!task.sessionProvider && task.sessionProvider !== task.provider;
  return <div className="session-conversation">
    <div className="session-messages" ref={messages} onScroll={event => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }}>
    {!session.turns.length && <article className="message"><div className="message-author"><strong>You</strong><span className="local-tag">TASK BRIEF</span></div><p className="prompt-text">{task.prompt}</p></article>}
    {(session.totalTurns || session.turns.length) > 10 && <p className="quiet">Showing the latest ten turns. Full conversation and process events remain in local storage.</p>}
    {session.turns.slice(-10).map(turn => <React.Fragment key={turn.id}>
      <article className="message"><div className="message-author"><span className="avatar">N</span><strong>You</strong><time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p className="prompt-text">{turn.prompt}</p></article>
      <article className="message assistant-message"><div className="message-author"><HydraMark className="avatar hydra-avatar" /><strong>{providerName(turn.provider || 'claude')}</strong><span className="local-tag">{turn.status === 'completed' ? 'TURN FINISHED' : turn.status.toUpperCase()}</span></div><p className="prompt-text">{turn.text || (turn.status === 'running' ? 'Waiting for provider output…' : 'No response text returned.')}</p>
        <TurnModelLabel turn={turn} />
        {turn.error && <p className="session-error" role="status">{turn.error}</p>}
        {turn.textTruncated && <p className="session-note">Showing the first 50,000 characters here. Full output is retained in local raw diagnostics; model context is unchanged.</p>}
        {!!turn.permissionDenials && <p className="session-note">{turn.permissionDenials} permission request(s) denied. Interactive approvals are unavailable here; use the provider terminal when needed.</p>}
        {turn.usage && <p className="session-note">{turn.provider === 'codex' ? 'Latest model response (not a turn total)' : 'Provider result'} tokens: {turn.usage.input.toLocaleString()} input · {turn.usage.output.toLocaleString()} output{turn.usage.cacheRead !== undefined && ` · ${turn.usage.cacheRead.toLocaleString()} cache read`}{turn.usage.cacheCreated !== undefined && ` · ${turn.usage.cacheCreated.toLocaleString()} cache created`}{turn.usage.estimatedUsd !== undefined && ` · $${turn.usage.estimatedUsd.toFixed(4)} provider estimate, not your bill`}</p>}
      </article>
    </React.Fragment>)}
    {session.approvals?.map(approval => <article key={approval.id} className="approval-request" aria-label={`${approval.kind} approval`}>
      <div className="section-label">{approval.kind.toUpperCase()} APPROVAL</div><p>Review this request before allowing {providerName(task.provider)} to proceed. This grants only the displayed request.</p><pre>{approval.detail}</pre>
      <div className="task-actions"><button className="stop-button" disabled={!running} onClick={() => send({ type: 'approve', id: task.id, approvalId: approval.id, decision: 'decline' })}>Decline</button><button className="secondary" disabled={!running} onClick={() => send({ type: 'approve', id: task.id, approvalId: approval.id, decision: 'accept' })}>Allow this request</button></div>
    </article>)}
    {!!task.sessionProvider && task.sessionProvider !== task.provider && <p role="status">This recorded session belongs to {providerName(task.sessionProvider)}. Create a separate task for {providerName(task.provider)}.</p>}
    </div>
    <form className="follow-up" onSubmit={event => { event.preventDefault(); if (!blocked && prompt.trim()) send({ type: 'followUp', id: task.id, prompt, draftVersion: local.version }); }}>
      <label>Follow-up<textarea rows={3} maxLength={32000} value={prompt} disabled={blocked || !task.sessionId} onChange={event => setPrompt(event.target.value)} placeholder={task.sessionId ? "Continue this task..." : "Start the task to begin a conversation."} /></label>
      <div className="task-actions">{task.sessionId ? <button className="primary" disabled={blocked || !prompt.trim()} type="submit">Send</button> : <button className="primary" disabled={blocked} type="button" onClick={() => send({ type: 'startManaged', id: task.id })}>Start task</button>}{running ? <button className="stop-button" disabled={busy} type="button" onClick={() => send({ type: 'stop', id: task.id })}>Stop process</button> : <button className="secondary" type="button" disabled={blocked} onClick={() => send({ type: 'launch', id: task.id })}>Open provider terminal</button>}</div>
      <p className="form-note">{compact ? 'Runs in this task worktree. Review approvals in this conversation.' : <>Messages run in this task worktree. Follow-ups resume its provider session. {task.provider === 'codex' ? 'Stop requests an interrupt, then terminates the owned process if needed. Approvals grant only the displayed request; unsupported prompts stop the turn.' : 'Stop process terminates the owned process tree. Approvals grant only the displayed command or file request; unsupported interactions stop the turn.'}</>}</p>
      {!compact && <button className="secondary" type="button" disabled={busy} onClick={() => send({ type: 'showSessionDiagnostics', id: task.id })}>Raw diagnostics</button>}
    </form>
  </div>;
}
