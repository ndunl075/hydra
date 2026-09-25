import * as vscode from 'vscode';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadGates, parseGatesConfig, type Gate, type GatesConfig } from '../../core/gates/config';
import type { SettingsContext, SettingsPage } from '../types';

/**
 * Hydra Settings → Gates (docs/Gates_Plan.md, "Seeing results"): this
 * project's `.hydra/gates.json` — what has to pass before a head's work is
 * accepted or a lane is merged. Reads `gates.json`, or `checks.json` shown as
 * command gates with a note that saving converts it; add, edit and remove
 * command, screenshots and review gates; `maxAttempts` and the lanes policy.
 * Save validates by round-tripping the whole config through
 * config.ts's parseGatesConfig before writing, so this page never carries a
 * second copy of its rules — its errors are always config.ts's own.
 */
function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a project folder to edit its gates.');
  return folder.uri.fsPath;
}
const gatesFile = (root: string) => path.join(root, '.hydra', 'gates.json');

async function postConfig(ctx: SettingsContext): Promise<void> {
  try {
    const config = await loadGates(workspaceRoot());
    await ctx.post({ type: 'gatesConfig', ...config });
  } catch (error) {
    await ctx.post({ type: 'gatesConfig', source: 'none', lanes: 'onMerge', gates: [], error: error instanceof Error ? error.message : String(error) });
  }
}

export const gatesPage: SettingsPage = {
  id: 'gates',
  title: 'Gates',
  rows: [
    { title: 'Gates', description: 'What has to pass before a head\'s work is accepted, or before a lane merges.' },
    { title: 'Add gate', description: 'A command, a screenshots check, or an independent review.' },
    { title: 'Attempts and lanes', description: 'How many times a head may retry, and whether Merge runs the gates.' },
  ],
  html(): string {
    return `
    <h1>Gates</h1>
    <p class="lede">No agent grades its own work. Gates run before a head's work is accepted, and before you merge a lane (when the lanes policy below says so).</p>
    <p id="gt-source-note" class="mcp-hint" hidden></p>
    <p id="gt-error" class="mcp-hint mcp-error" role="alert" hidden></p>
    <div class="group">
      <h2>Gates</h2>
      <div id="gt-list" role="list" aria-label="Gates"></div>
      <p id="gt-empty" class="mcp-empty" hidden>No gates yet. Add one below.</p>
    </div>
    <details class="group mcp-add" id="gt-add">
      <summary><span class="row-title" id="gt-add-title">Add gate</span><span class="row-desc">A command, a screenshots check, or an independent review.</span></summary>
      <div class="mcp-add-body">
        <label class="mcp-field">Id<input type="text" id="gt-id" placeholder="unit" autocomplete="off"></label>
        <div class="mcp-field">
          <span>Type</span>
          <div class="segmented" role="group" aria-label="Gate type" id="gt-type"><button type="button" data-value="command" aria-pressed="true">Command</button><button type="button" data-value="screenshots" aria-pressed="false">Screenshots</button><button type="button" data-value="review" aria-pressed="false">Review</button></div>
        </div>
        <label class="mcp-show"><input type="checkbox" id="gt-required" checked> Required (blocks when it fails)</label>
        <div id="gt-fields-command">
          <label class="mcp-field">Command (one argument per line)<textarea id="gt-command" rows="3" placeholder="npm&#10;test"></textarea></label>
          <label class="mcp-field">Timeout (seconds)<input type="number" id="gt-timeout" min="1" max="900" value="600"></label>
        </div>
        <div id="gt-fields-screenshots" hidden>
          <label class="mcp-field">Start command (one argument per line)<textarea id="gt-start" rows="3" placeholder="npm&#10;run&#10;dev&#10;--&#10;--port&#10;{port}"></textarea></label>
          <label class="mcp-field">URL<input type="text" id="gt-url" placeholder="http://localhost:{port}/" autocomplete="off"></label>
          <label class="mcp-field">Widths (comma separated)<input type="text" id="gt-widths" placeholder="390, 768, 1280"></label>
          <label class="mcp-field">Ready timeout (seconds)<input type="number" id="gt-ready-timeout" min="1" max="600" value="90"></label>
        </div>
        <div id="gt-fields-review" hidden>
          <label class="mcp-field">Reviewer
            <select id="gt-reviewer"><option value="other">The other agent</option><option value="same">The same agent</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
          </label>
          <label class="mcp-field">Focus, optional<textarea id="gt-focus" rows="2" placeholder="What should the reviewer pay extra attention to?"></textarea></label>
        </div>
        <p id="gt-form-error" class="mcp-hint mcp-error" role="alert" hidden></p>
        <div class="row-action">
          <button id="gt-submit" class="primary">Add gate</button>
          <button id="gt-cancel-edit" hidden>Cancel</button>
        </div>
      </div>
    </details>
    <div class="group">
      <h2>Attempts and lanes</h2>
      <div class="row"><div class="row-text"><div class="row-title">Max attempts</div><div class="row-desc">How many times a head may retry after its gates fail.</div></div>
        <div class="row-action"><input type="number" id="gt-max-attempts" min="1" max="10" style="width:64px" aria-label="Max attempts"></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Lanes policy</div><div class="row-desc">Whether pressing Merge on a lane runs these gates first.</div></div>
        <div class="row-action"><select id="gt-lanes-policy"><option value="onMerge">Run on Merge</option><option value="off">Off</option></select></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Save</div><div class="row-desc">Writes .hydra/gates.json in the project root.</div></div>
        <div class="row-action"><button class="primary" id="gt-save">Save gates</button></div></div>
    </div>
    `;
  },
  script: `
  (function () {
    let gates = [];
    let editingId = null;
    const typeSeg = document.getElementById('gt-type');
    const fields = { command: document.getElementById('gt-fields-command'), screenshots: document.getElementById('gt-fields-screenshots'), review: document.getElementById('gt-fields-review') };
    function currentType() { return typeSeg?.querySelector('[aria-pressed="true"]')?.dataset.value || 'command'; }
    function showType(type) {
      for (const button of typeSeg?.querySelectorAll('button') || []) button.setAttribute('aria-pressed', String(button.dataset.value === type));
      for (const [key, el] of Object.entries(fields)) if (el) el.hidden = key !== type;
    }
    typeSeg?.addEventListener('click', event => { const button = event.target.closest('button[data-value]'); if (button) showType(button.dataset.value); });
    function parseLines(text) { return text.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean); }
    function parseWidths(text) { return text.split(/[\\s,]+/).map(part => part.trim()).filter(Boolean).map(Number).filter(Number.isFinite); }
    function summarize(gate) {
      if (gate.type === 'command') return (gate.command || []).join(' ');
      if (gate.type === 'screenshots') return (gate.start || []).join(' ') + ' → ' + gate.url;
      const who = gate.reviewer === 'other' ? 'the other agent' : gate.reviewer === 'same' ? 'the same agent' : gate.reviewer === 'claude' ? 'Claude Code' : 'Codex';
      return 'reviewed by ' + who;
    }
    const typeLabel = { command: 'Command', screenshots: 'Screenshots', review: 'Review' };
    function renderList() {
      const list = document.getElementById('gt-list'); if (!list) return;
      list.innerHTML = '';
      for (const gate of gates) {
        const row = document.createElement('div'); row.className = 'row'; row.setAttribute('role', 'listitem');
        row.innerHTML = '<div class="row-text"><div class="row-title">' + esc(gate.id) + (gate.required ? '' : ' <span class="row-desc">(not required)</span>') + '</div><div class="row-desc">' + typeLabel[gate.type] + ' · ' + esc(summarize(gate)) + '</div></div>' +
          '<div class="row-action"><button data-edit="' + esc(gate.id) + '">Edit</button><button data-remove="' + esc(gate.id) + '" class="danger">Remove</button></div>';
        list.appendChild(row);
      }
      document.getElementById('gt-empty').hidden = gates.length > 0;
      list.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => editGate(button.dataset.edit)));
      list.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => { gates = gates.filter(g => g.id !== button.dataset.remove); renderList(); }));
    }
    function esc(text) { return String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
    function resetForm() {
      editingId = null;
      document.getElementById('gt-add-title').textContent = 'Add gate';
      document.getElementById('gt-submit').textContent = 'Add gate';
      document.getElementById('gt-cancel-edit').hidden = true;
      document.getElementById('gt-id').value = '';
      document.getElementById('gt-required').checked = true;
      document.getElementById('gt-command').value = ''; document.getElementById('gt-timeout').value = '600';
      document.getElementById('gt-start').value = ''; document.getElementById('gt-url').value = 'http://localhost:{port}/';
      document.getElementById('gt-widths').value = '390, 768, 1280'; document.getElementById('gt-ready-timeout').value = '90';
      document.getElementById('gt-reviewer').value = 'other'; document.getElementById('gt-focus').value = '';
      document.getElementById('gt-form-error').hidden = true;
      showType('command');
    }
    function editGate(id) {
      const gate = gates.find(g => g.id === id); if (!gate) return;
      editingId = id;
      document.getElementById('gt-add').open = true;
      document.getElementById('gt-add-title').textContent = 'Edit gate';
      document.getElementById('gt-submit').textContent = 'Save gate';
      document.getElementById('gt-cancel-edit').hidden = false;
      document.getElementById('gt-id').value = gate.id;
      document.getElementById('gt-required').checked = gate.required;
      if (gate.type === 'command') { document.getElementById('gt-command').value = (gate.command || []).join('\\n'); document.getElementById('gt-timeout').value = String(gate.timeoutSeconds); }
      if (gate.type === 'screenshots') { document.getElementById('gt-start').value = (gate.start || []).join('\\n'); document.getElementById('gt-url').value = gate.url; document.getElementById('gt-widths').value = (gate.widths || []).join(', '); document.getElementById('gt-ready-timeout').value = String(gate.readyTimeoutSeconds); }
      if (gate.type === 'review') { document.getElementById('gt-reviewer').value = gate.reviewer; document.getElementById('gt-focus').value = gate.focus || ''; }
      showType(gate.type);
    }
    document.getElementById('gt-cancel-edit')?.addEventListener('click', resetForm);
    document.getElementById('gt-submit')?.addEventListener('click', () => {
      const type = currentType();
      const id = document.getElementById('gt-id').value.trim();
      const required = document.getElementById('gt-required').checked;
      const errorEl = document.getElementById('gt-form-error');
      if (!id) { errorEl.hidden = false; errorEl.textContent = 'Give the gate an id.'; return; }
      if (gates.some(g => g.id === id && g.id !== editingId)) { errorEl.hidden = false; errorEl.textContent = 'Two gates cannot share the id "' + id + '".'; return; }
      let gate;
      if (type === 'command') gate = { id, type, required, command: parseLines(document.getElementById('gt-command').value), timeoutSeconds: Number(document.getElementById('gt-timeout').value) || 600 };
      else if (type === 'screenshots') gate = { id, type, required, start: parseLines(document.getElementById('gt-start').value), url: document.getElementById('gt-url').value.trim(), widths: parseWidths(document.getElementById('gt-widths').value), readyTimeoutSeconds: Number(document.getElementById('gt-ready-timeout').value) || 90 };
      else gate = { id, type, required, reviewer: document.getElementById('gt-reviewer').value, focus: document.getElementById('gt-focus').value.trim() };
      errorEl.hidden = true;
      if (editingId) gates = gates.map(g => g.id === editingId ? gate : g); else gates = [...gates, gate];
      renderList(); resetForm();
    });
    document.getElementById('gt-save')?.addEventListener('click', () => {
      const maxAttempts = Number(document.getElementById('gt-max-attempts').value) || undefined;
      const lanes = document.getElementById('gt-lanes-policy').value;
      send({ type: 'setGates', maxAttempts, lanes, gates });
    });
    window.addEventListener('message', event => {
      const message = event.data;
      if (message?.type === 'gatesConfig') {
        gates = message.gates || [];
        document.getElementById('gt-max-attempts').value = String(message.maxAttempts || 3);
        document.getElementById('gt-lanes-policy').value = message.lanes || 'onMerge';
        const note = document.getElementById('gt-source-note');
        if (message.source === 'checks') { note.hidden = false; note.textContent = 'Showing .hydra/checks.json as command gates. Saving converts it to .hydra/gates.json.'; }
        else note.hidden = true;
        const errorEl = document.getElementById('gt-error');
        if (message.error) { errorEl.hidden = false; errorEl.textContent = message.error; } else errorEl.hidden = true;
        renderList();
      }
      if (message?.type === 'status') {
        const errorEl = document.getElementById('gt-error');
        errorEl.hidden = false; errorEl.textContent = message.text;
        setTimeout(() => { errorEl.hidden = true; }, 4000);
      }
    });
    resetForm();
  })();
  `,
  async onReady(ctx: SettingsContext): Promise<void> { await postConfig(ctx); },
  async handle(message: Record<string, unknown>, ctx: SettingsContext): Promise<boolean> {
    if (message.type !== 'setGates') return false;
    try {
      const root = workspaceRoot();
      const candidate = { maxAttempts: message.maxAttempts, lanes: message.lanes, gates: message.gates };
      const parsed = parseGatesConfig(candidate);
      const file = gatesFile(root);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, buildGatesFile(parsed), 'utf8');
      await ctx.post({ type: 'status', text: `Saved ${parsed.gates.length} gate${parsed.gates.length === 1 ? '' : 's'} to .hydra/gates.json.` });
      await postConfig(ctx);
    } catch (error) {
      await ctx.post({ type: 'status', text: error instanceof Error ? error.message : String(error) });
    }
    return true;
  },
};

/** Exported for tests: the raw gates.json this page would write for a given form-submitted config. */
export function buildGatesFile(config: Pick<GatesConfig, 'maxAttempts' | 'lanes' | 'gates'>): string {
  const parsed = parseGatesConfig(config);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export type { Gate };
