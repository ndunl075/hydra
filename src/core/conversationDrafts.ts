export interface ConversationDraft { prompt: string; version: string; revision: number }

/** One draft per task, shared by both surfaces. A receipt only consumes that exact edit. */
export class ConversationDrafts {
  private readonly drafts = new Map<string, ConversationDraft>();
  private revision = 0;

  get(id: string): ConversationDraft | undefined {
    const draft = this.drafts.get(id);
    return draft && { ...draft };
  }

  update(id: string, draft: Pick<ConversationDraft, 'prompt' | 'version'>): void {
    this.drafts.set(id, { prompt: draft.prompt, version: draft.version, revision: ++this.revision });
  }

  requireCurrent(id: string, prompt: string, version: string): void {
    const current = this.drafts.get(id);
    if (!current || current.version !== version || current.prompt !== prompt || !prompt.trim()) {
      throw new Error('This draft has changed or was already submitted. Review the current conversation before sending.');
    }
  }

  accepted(id: string, prompt: string, version: string): void {
    const current = this.drafts.get(id);
    if (current?.version === version && current.prompt === prompt) {
      this.drafts.set(id, { prompt: '', version, revision: ++this.revision });
    }
  }
}

export interface ConversationDraftState {
  local: Pick<ConversationDraft, 'prompt' | 'version'>;
  latest?: ConversationDraft;
  pendingVersion?: string;
}

/** Optimistic typing with direct receipts, even if snapshot publishing coalesces edits. */
export function receiveConversationDraft(state: ConversationDraftState, draft?: ConversationDraft, acknowledgedVersion?: string): ConversationDraftState {
  const latest = draft && (!state.latest || draft.revision >= state.latest.revision) ? draft : state.latest;
  const acknowledged = state.pendingVersion === acknowledgedVersion || state.pendingVersion === latest?.version;
  if (state.pendingVersion && !acknowledged) return { ...state, latest };
  return { local: latest || { prompt: '', version: '' }, latest };
}
