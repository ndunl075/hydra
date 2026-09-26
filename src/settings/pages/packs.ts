import * as vscode from 'vscode';
import { testMcpServer, type McpServerSpec } from '../../core/mcpServers';
import { resolvePlaceholders } from '../../core/packs/format';
import { leadFolder } from '../leadFolder';
import { postFromPacks } from './gates';
import type { SettingsContext, SettingsPage } from '../types';
import { packCard, savedNote, thirdPartyWarning, type PackCardView } from './packsHelpers';

/**
 * Settings → Packs (docs/Packs_Plan.md, section 6): one card per pack with its
 * state and one button, a "What it contains" disclosure, and the review panel
 * that "Turn on"/"Review…" opens inline in the card.
 *
 * Security (section 4 and the "Security rules" note in this phase's brief):
 * every other action goes through the `hydra.packs.*` commands, which any
 * extension could also call — but allowing a pack never may, so **only** the
 * review panel's own button calls `ctx.packs.turnOn` directly, in this file,
 * never through a command. There is no `hydra.packs.allow` command.
 */
const guideUrl = 'https://github.com/ndunl075/hydra/blob/main/docs/Packs_Plan.md';

async function postState(ctx: SettingsContext): Promise<void> {
  try {
    const root = await leadFolder();
    const { packs } = await ctx.packs.state(root);
    const cards = packs
      .slice()
      .sort((a, b) => Number(b.pack?.source === 'builtin') - Number(a.pack?.source === 'builtin'))
      .map(pack => packCard(pack, process.execPath));
    await ctx.post({ type: 'packsState', packs: cards, error: undefined });
    // Settings → Gates shows the packs' gates too: keep it in step with what just changed.
    await postFromPacks(ctx, root);
  } catch (error) {
    await ctx.post({ type: 'packsState', packs: [], error: error instanceof Error ? error.message : String(error) });
  }
}

/** `${NAME}` filled in from your own environment, for Test (never written anywhere). */
function resolveEnvRefs(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const found = process.env[name];
    if (found === undefined) throw new Error(`\${${name}} isn't set in your environment.`);
    return found;
  });
}
/** A pack's own server spec, resolved for Test: {pack}/{node} to the pack's folder and Hydra's executable, ${NAME} to your environment. */
function resolveTestSpec(spec: McpServerSpec, packFolder: string): McpServerSpec {
  if (spec.type === 'stdio') {
    const resolved = resolvePlaceholders([spec.command, ...spec.args], packFolder, process.execPath);
    return { type: 'stdio', command: resolved.parts[0]!, args: resolved.parts.slice(1), env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, resolveEnvRefs(value)])) };
  }
  return { ...spec, url: resolveEnvRefs(spec.url), headers: Object.fromEntries(Object.entries(spec.headers).map(([key, value]) => [key, resolveEnvRefs(value)])) };
}

export const packsPage: SettingsPage = {
  id: 'packs',
  title: 'Packs',
  rows: [
    { title: 'Packs', description: 'Roles, gates, MCP servers and skills a project turns on. Nothing runs until you turn a pack on.' },
    { title: 'Add pack from folder…', description: 'Validate a folder as a pack and copy it into your packs folder.' },
    { title: 'Open packs folder', description: 'Open your packs folder (~/.hydra/packs, or hydra.packs.folder).' },
  ],
  html(): string {
    return `
    <h1>Packs</h1>
    <p class="lede">Packs add roles, gates, MCP servers and skills to this project. Nothing from a pack runs until you turn it on here.</p>
    <p id="pk-error" class="mcp-hint mcp-error" role="alert" hidden></p>
    <div class="group">
      <h2>Packs</h2>
      <div id="pk-list" role="list" aria-label="Packs"></div>
      <p id="pk-empty" class="mcp-empty" hidden>No packs found.</p>
    </div>
    <div class="group">
      <h2>More</h2>
      <div class="row"><div class="row-text"><div class="row-title">Add pack from folder…</div><div class="row-desc">Validate a folder as a pack and copy it into your packs folder.</div></div>
        <div class="row-action"><button id="pk-add-folder">Add pack from folder…</button></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Open packs folder</div><div class="row-desc">Your packs folder, so you can add or edit pack folders yourself.</div></div>
        <div class="row-action"><button id="pk-open-folder">Open packs folder</button></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Reload</div><div class="row-desc">Rescan the built-in and your packs folders.</div></div>
        <div class="row-action"><button id="pk-reload">Reload</button></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Packs guide</div><div class="row-desc">The full plan: format, trust, and what each pack can do.</div></div>
        <div class="row-action"><button id="pk-guide">Open</button></div></div>
    </div>
    `;
  },
  script: `
  (function () {
    let packs = [];
    const open = new Set(); // pack ids with the disclosure or review panel open
    function esc(text) { return String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
    function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }

    function renderContents(pack, contents, forReview) {
      const wrap = el('div', 'pk-contents');
      if (pack.thirdParty && forReview) { const warn = el('p', 'mcp-hint mcp-error', ${JSON.stringify(thirdPartyWarning)}); wrap.appendChild(warn); }
      if (contents.roles.length) {
        wrap.appendChild(el('h3', null, 'Roles'));
        for (const role of contents.roles) {
          const box = el('div', 'pk-item');
          box.appendChild(el('div', 'row-title', role.title + ' (' + role.provider + (role.changes === 'optional' ? ', may finish without changing anything' : '') + ')'));
          box.appendChild(el('div', 'row-desc', role.description));
          if (role.toolsSentence) box.appendChild(el('div', 'row-desc', role.toolsSentence));
          if (role.skills.length) box.appendChild(el('div', 'row-desc', 'Skills: ' + role.skills.join(', ')));
          const details = document.createElement('details');
          const summary = document.createElement('summary'); summary.textContent = 'Instructions';
          const pre = el('pre', 'pk-instructions', role.instructions);
          details.append(summary, pre); box.appendChild(details);
          wrap.appendChild(box);
        }
      }
      if (contents.gates.length) {
        wrap.appendChild(el('h3', null, 'Gates'));
        for (const gate of contents.gates) {
          const box = el('div', 'pk-item');
          box.appendChild(el('div', 'row-title', gate.id + ' · ' + gate.kind + (gate.required ? '' : ' (not required)')));
          if (gate.command) box.appendChild(el('pre', 'pk-instructions', gate.command.text));
          if (gate.focus) box.appendChild(el('div', 'row-desc', 'Focus: ' + gate.focus));
          if (gate.role) box.appendChild(el('div', 'row-desc', 'Reviewer role: ' + gate.role));
          box.appendChild(el('div', 'row-desc', gate.when));
          if (!forReview) {
            const skip = el('button', null, 'Skip in this project');
            skip.addEventListener('click', () => send({ type: 'packsSkipGate', id: pack.id, gate: gate.id, skip: true }));
            box.appendChild(skip);
          }
          wrap.appendChild(box);
        }
      }
      if (contents.servers.length) {
        wrap.appendChild(el('h3', null, 'MCP servers'));
        for (const server of contents.servers) {
          const box = el('div', 'pk-item');
          box.appendChild(el('div', 'row-title', server.id));
          box.appendChild(el('pre', 'pk-instructions', server.command ? server.command.text : server.url || ''));
          if (server.env.length) box.appendChild(el('div', 'row-desc', server.env.map(e => e.name + '=' + e.value).join(', ')));
          if (server.roles.length) box.appendChild(el('div', 'row-desc', 'Used by: ' + server.roles.join(', ')));
          box.appendChild(el('div', 'row-desc', server.note));
          if (server.claudeOnly) box.appendChild(el('div', 'row-desc', 'Claude only: ' + server.claudeOnly));
          if (server.downloads) box.appendChild(el('div', 'row-desc', server.downloads));
          const test = el('button', null, 'Test');
          const result = el('span', 'mcp-test-result');
          test.addEventListener('click', () => {
            test.disabled = true; result.textContent = 'Testing…';
            const token = 'pk-test-' + pack.id + '-' + server.id + '-' + Date.now();
            pending.set(token, r => { test.disabled = false; result.textContent = r.ok ? (r.toolCount + ' tool' + (r.toolCount === 1 ? '' : 's')) : r.error; result.classList.toggle('mcp-error', !r.ok); });
            send({ type: 'packsTestServer', id: pack.id, server: server.id, token });
          });
          box.append(test, result);
          wrap.appendChild(box);
        }
      }
      if (contents.skills.length) {
        wrap.appendChild(el('h3', null, 'Skills'));
        for (const skill of contents.skills) {
          const box = el('div', 'pk-item');
          box.appendChild(el('div', 'row-title', skill.id));
          box.appendChild(el('div', 'row-desc', skill.description));
          box.appendChild(el('div', 'row-desc', skill.files.join(', ')));
          if (skill.scripts.length) box.appendChild(el('div', 'row-desc mcp-error', 'Agents may run these: ' + skill.scripts.join(', ')));
          wrap.appendChild(box);
        }
      }
      return wrap;
    }

    function renderReviewPanel(pack) {
      const panel = el('div', 'pk-review');
      panel.appendChild(renderContents(pack, pack.contents || { roles: [], gates: [], servers: [], skills: [] }, true));
      const actions = el('div', 'row-action');
      const button = el('button', 'primary', pack.reviewButtonLabel || 'Turn on');
      button.addEventListener('click', () => send({ type: 'packsTurnOn', id: pack.id, hash: pack.hash || '' }));
      const cancel = el('button', null, 'Cancel');
      cancel.addEventListener('click', () => { open.delete(pack.id); render(); });
      actions.append(button, cancel);
      panel.appendChild(actions);
      return panel;
    }

    function renderCard(pack) {
      const card = el('div', 'group pk-card');
      const head = el('div', 'row');
      const text = el('div', 'row-text');
      const title = el('div', 'row-title');
      title.appendChild(document.createTextNode(pack.title + ' '));
      title.appendChild(el('span', 'chip', pack.sourceLabel));
      title.appendChild(document.createTextNode(' '));
      title.appendChild(el('span', 'chip', pack.stateLabel));
      text.appendChild(title);
      if (pack.description) text.appendChild(el('div', 'row-desc', pack.description));
      if (pack.counts) text.appendChild(el('div', 'row-desc', pack.counts));
      if (pack.reason) text.appendChild(el('div', 'row-desc mcp-error', pack.reason));
      for (const note of pack.notes || []) text.appendChild(el('div', 'row-desc', note));
      head.appendChild(text);
      const action = el('div', 'row-action');
      if (pack.button) {
        const button = el('button', pack.button.id === 'turnOff' ? 'danger' : 'primary', pack.button.label);
        button.addEventListener('click', () => {
          if (pack.button.id === 'turnOff') { send({ type: 'packsSetEnabled', id: pack.id, on: false }); return; }
          if (pack.button.id === 'turnOn' && pack.state === 'off') { open.add(pack.id); render(); return; }
          if (pack.button.id === 'review') { open.add(pack.id); render(); return; }
        });
        action.appendChild(button);
      }
      if (pack.contents) {
        const toggle = el('button', null, open.has(pack.id) ? 'Hide details' : 'What it contains');
        toggle.addEventListener('click', () => { if (open.has(pack.id)) open.delete(pack.id); else open.add(pack.id); render(); });
        action.appendChild(toggle);
      }
      head.appendChild(action);
      card.appendChild(head);
      if (open.has(pack.id)) {
        if (pack.button && (pack.button.id === 'turnOn' || pack.button.id === 'review') && pack.state !== 'on') card.appendChild(renderReviewPanel(pack));
        else if (pack.contents) card.appendChild(renderContents(pack, pack.contents, false));
      }
      return card;
    }

    function render() {
      const list = document.getElementById('pk-list');
      list.innerHTML = '';
      for (const pack of packs) list.appendChild(renderCard(pack));
      document.getElementById('pk-empty').hidden = packs.length > 0;
    }

    const pending = new Map();
    document.getElementById('pk-add-folder')?.addEventListener('click', () => send({ type: 'packsAddFolder' }));
    document.getElementById('pk-open-folder')?.addEventListener('click', () => send({ type: 'packsOpenFolder' }));
    document.getElementById('pk-reload')?.addEventListener('click', () => send({ type: 'packsReload' }));
    document.getElementById('pk-guide')?.addEventListener('click', () => send({ type: 'packsOpenGuide' }));

    window.addEventListener('message', event => {
      const message = event.data;
      if (message?.type === 'packsState') {
        packs = message.packs || [];
        const errorEl = document.getElementById('pk-error');
        if (message.error) { errorEl.hidden = false; errorEl.textContent = message.error; } else errorEl.hidden = true;
        render();
      }
      if (message?.type === 'packsTurnOnDone') { open.delete(message.id); }
      if (message?.type === 'mcpTestResult' && pending.has(message.token)) { pending.get(message.token)(message.result); pending.delete(message.token); }
      if (message?.type === 'status') {
        const errorEl = document.getElementById('pk-error');
        errorEl.hidden = false; errorEl.textContent = message.text;
        setTimeout(() => { errorEl.hidden = true; }, 4000);
      }
    });
  })();
  `,
  async onReady(ctx: SettingsContext): Promise<void> { await postState(ctx); },
  async handle(message: Record<string, unknown>, ctx: SettingsContext): Promise<boolean> {
    switch (message.type) {
      case 'packsRefresh':
        await postState(ctx);
        return true;
      case 'packsSetEnabled': {
        const id = String(message.id), on = !!message.on;
        try {
          await vscode.commands.executeCommand('hydra.packs.setEnabled', undefined, id, on);
          await ctx.post({ type: 'status', text: on ? `Turned on the ${id} pack.` : `Turned off the ${id} pack.` });
        } catch (error) { await ctx.post({ type: 'status', text: error instanceof Error ? error.message : String(error) }); }
        await postState(ctx);
        return true;
      }
      case 'packsSkipGate': {
        const id = String(message.id), gate = String(message.gate), skip = !!message.skip;
        try {
          await vscode.commands.executeCommand('hydra.packs.skipGate', undefined, id, gate, skip);
          await ctx.post({ type: 'status', text: skip ? `Skipped "${gate}" in this project.` : `"${gate}" runs again in this project.` });
        } catch (error) { await ctx.post({ type: 'status', text: error instanceof Error ? error.message : String(error) }); }
        await postState(ctx);
        return true;
      }
      case 'packsAddFolder': {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Add pack from folder' });
        if (picked?.[0]) {
          try {
            await vscode.commands.executeCommand('hydra.packs.addFolder', picked[0].fsPath);
            await ctx.post({ type: 'status', text: 'Added the pack. Reload to see it.' });
          } catch (error) { await ctx.post({ type: 'status', text: error instanceof Error ? error.message : String(error) }); }
        }
        await postState(ctx);
        return true;
      }
      case 'packsOpenFolder': {
        try { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(await ctx.packs.userFolder())); }
        catch (error) { await ctx.post({ type: 'status', text: error instanceof Error ? error.message : String(error) }); }
        return true;
      }
      case 'packsReload':
        try { await vscode.commands.executeCommand('hydra.packs.reload'); } catch { /* still refresh the page below */ }
        await postState(ctx);
        return true;
      case 'packsOpenGuide':
        await vscode.env.openExternal(vscode.Uri.parse(guideUrl));
        return true;
      // ---- The review panel's own button: turnOn (allow, then setEnabled) is called directly here, ----
      // ---- never through a public command (docs/Packs_Plan.md, section 4; "Security rules" above). ----
      case 'packsTurnOn': {
        const id = String(message.id), hash = String(message.hash ?? '');
        try {
          const root = await leadFolder();
          await ctx.packs.turnOn(root, id, hash);
          await ctx.post({ type: 'status', text: savedNote });
          await ctx.post({ type: 'packsTurnOnDone', id });
        } catch (error) { await ctx.post({ type: 'status', text: error instanceof Error ? error.message : String(error) }); }
        await postState(ctx);
        return true;
      }
      case 'packsTestServer': {
        const id = String(message.id), serverId = String(message.server), token = String(message.token ?? '');
        let result;
        try {
          const root = await leadFolder();
          const { packs: found } = await ctx.packs.state(root);
          const pack = found.find(candidate => candidate.id === id);
          const spec = pack?.pack?.valid?.manifest.mcpServers[serverId];
          if (!spec) throw new Error(`There's no server "${serverId}" in the ${id} pack.`);
          result = await testMcpServer(resolveTestSpec(spec, pack?.copy ?? pack!.pack!.folder));
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : 'Could not test that server.', durationMs: 0 };
        }
        await ctx.post({ type: 'mcpTestResult', token, result });
        return true;
      }
      default:
        return false;
    }
  },
};

export type { PackCardView };
