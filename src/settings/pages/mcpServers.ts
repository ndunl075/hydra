import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  addMcpServer, configuredSpec, defaultMcpContext, enableMcpServerFor, listMcpServers, mcpAgents, removeMcpServer, testMcpServer, validateServerSpec,
  type McpAgent, type McpContext, type McpServerSpec,
} from '../../core/mcpServers';
import { findProvider } from '../../core/providers';
import type { SettingsContext, SettingsPage } from '../types';
import { mcpAgentLabel } from './mcpServersHelpers';

/**
 * MCP servers (Settings plan, Phase 4 UI): one card listing every user-level
 * server of Claude Code and Codex, an Add form, and per-row Test/Remove.
 *
 * All mutation goes through src/core/mcpServers.ts directly (not the
 * hydra.mcpServers.* commands): those commands also pop a window
 * notification on failure (extension.ts's `command()` wrapper), which would
 * double up with the inline, per-action status this page already shows.
 * Secrets never reach the webview: listMcpServers() masks them, and the
 * unmasked spec for Test only ever exists in the extension host.
 */
const lockIcon = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7"/></svg>';
const caretIcon = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2l8 6-8 6z"/></svg>';

/** Mirrors extension.ts's private claudeForRegistration(): the configured/PATH claude, else the extension's bundled one. */
async function claudeExecutablePath(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('hydra').get<string>('claudePath');
  const info = await findProvider('claude', configured).catch(() => undefined);
  if (info?.executable) return info.executable;
  const extension = vscode.extensions.getExtension('anthropic.claude-code');
  if (!extension) return undefined;
  const bundled = path.join(extension.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return await realpath(bundled).catch(() => undefined);
}
async function buildContext(): Promise<McpContext> {
  return defaultMcpContext(await claudeExecutablePath());
}
async function refreshList(ctx: SettingsContext): Promise<void> {
  const list = await listMcpServers(await buildContext());
  await ctx.post({ type: 'mcpList', list });
}
function parseAgent(value: unknown): McpAgent {
  if (value !== 'claude' && value !== 'codex') throw new Error('Choose Claude Code or Codex.');
  return value;
}
function parseAgentList(value: unknown): McpAgent[] {
  if (!Array.isArray(value) || !value.length || value.some(agent => !mcpAgents.includes(agent as McpAgent))) throw new Error('Choose Claude Code, Codex, or both.');
  return [...new Set(value as McpAgent[])];
}

export const mcpServersPage: SettingsPage = {
  id: 'mcpServers',
  title: 'MCP servers',
  rows: [
    { title: 'MCP servers', description: 'Manage your other MCP servers for Claude Code and Codex from one place.' },
    { title: 'Add MCP server', description: 'Add a stdio command or an HTTP server, for Claude Code, Codex, or both.' },
    { title: 'Test', description: 'Start a server briefly and list its tools.' },
    { title: 'Use with Claude Code', description: 'Configure a server for Claude Code.' },
    { title: 'Use with Codex', description: 'Configure a server for Codex.' },
    { title: 'Remove MCP server', description: 'Remove a server Hydra added, from one or both agents.' },
  ],
  html(): string {
    return `
    <h1>MCP servers</h1>
    <p class="lede">Manage your other MCP servers for both agents from one place. Hydra's own <code>hydra</code> server is locked here — manage it on Connectors.</p>
    <p id="mcp-cli-hint" class="mcp-hint" hidden>Claude Code's CLI wasn't found, so Hydra can't change Claude's servers here. Connect Claude Code on the Connectors page first.</p>
    <div class="group" id="mcp-list-group">
      <div class="row"><div class="row-text"><div class="row-title">Servers</div><div class="row-desc">Loading…</div></div><div class="row-action"><button id="mcp-refresh">Refresh</button></div></div>
      <p id="mcp-list-errors" class="mcp-hint" hidden></p>
      <div id="mcp-list" role="list" aria-label="MCP servers"></div>
      <p id="mcp-empty" class="mcp-empty" hidden>No MCP servers yet. Add one below.</p>
    </div>
    <details class="group mcp-add" id="mcp-add">
      <summary><span class="row-title">Add MCP server</span><span class="row-desc">A stdio command or an HTTP server, for one or both agents.</span></summary>
      <div class="mcp-add-body">
        <label class="mcp-field">Name<input type="text" id="mcp-add-name" placeholder="my-server" autocomplete="off"></label>
        <div class="mcp-field">
          <span>Type</span>
          <div class="segmented" role="group" aria-label="Server type" id="mcp-add-type"><button type="button" data-value="stdio" aria-pressed="true">Stdio command</button><button type="button" data-value="http" aria-pressed="false">HTTP</button></div>
        </div>
        <div id="mcp-add-stdio">
          <label class="mcp-field">Command<input type="text" id="mcp-add-command" placeholder="npx" autocomplete="off"></label>
          <label class="mcp-field">Arguments (one per line)<textarea id="mcp-add-args" rows="3" placeholder="-y&#10;@scope/server"></textarea></label>
          <label class="mcp-field">Environment (KEY=VALUE, one per line)<textarea id="mcp-add-env" rows="3" class="mcp-masked" placeholder="API_TOKEN=..."></textarea></label>
          <label class="mcp-show"><input type="checkbox" id="mcp-add-env-show"> Show values</label>
        </div>
        <div id="mcp-add-http" hidden>
          <label class="mcp-field">URL<input type="text" id="mcp-add-url" placeholder="https://mcp.example.com/mcp" autocomplete="off"></label>
          <label class="mcp-field">Headers (Name: value, one per line)<textarea id="mcp-add-headers" rows="3" class="mcp-masked" placeholder="Authorization: Bearer ..."></textarea></label>
          <label class="mcp-show"><input type="checkbox" id="mcp-add-headers-show"> Show values</label>
        </div>
        <fieldset class="mcp-field mcp-use-with"><legend>Use with</legend>
          <label><input type="checkbox" id="mcp-add-claude" checked> Claude Code</label>
          <label><input type="checkbox" id="mcp-add-codex" checked> Codex</label>
        </fieldset>
        <p id="mcp-add-error" class="mcp-hint mcp-error" role="alert" hidden></p>
        <p id="mcp-add-test-result" class="mcp-hint" hidden></p>
        <div class="row-action">
          <button id="mcp-add-test">Test before adding</button>
          <button class="primary" id="mcp-add-submit">Add server</button>
        </div>
      </div>
    </details>
    <p class="mcp-footer">Hydra keeps no copy of secrets; each agent stores them where it already does. Hydra never edits Codex servers it didn't add.</p>
    <p class="mcp-footer" id="mcp-paths"></p>
    `;
  },
  script: `
  (function () {
    const listGroup = document.getElementById('mcp-list-group');
    const listEl = document.getElementById('mcp-list');
    const emptyEl = document.getElementById('mcp-empty');
    const errorsEl = document.getElementById('mcp-list-errors');
    const cliHint = document.getElementById('mcp-cli-hint');
    const pathsEl = document.getElementById('mcp-paths');
    const agentLabel = agent => agent === 'claude' ? 'Claude Code' : 'Codex';
    let latest = null;
    const pending = new Map(); // token -> render callback for a Test result
    let removeConfirm = null; // name currently showing its inline "Remove?" confirm

    function summarize(spec) {
      const text = spec.type === 'stdio' ? [spec.command, ...(spec.args || [])].join(' ') : spec.url;
      return text.length > 160 ? text.slice(0, 159) + '…' : text;
    }
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function detailLines(spec) {
      const lines = [];
      if (spec.type === 'stdio') {
        lines.push('command: ' + spec.command);
        if (spec.args && spec.args.length) lines.push('args: ' + spec.args.join(' '));
        for (const key of Object.keys(spec.env || {})) lines.push('env ' + key + '=' + spec.env[key]);
      } else {
        lines.push('url: ' + spec.url);
        if (spec.bearerTokenEnvVar) lines.push('bearer token variable: ' + spec.bearerTokenEnvVar);
        for (const key of Object.keys(spec.headers || {})) lines.push('header ' + key + ': ' + spec.headers[key]);
      }
      return lines;
    }
    function toolsTooltip(tools) { return tools && tools.length ? tools.join(', ') : 'no tools'; }

    function renderTestArea(container, name, agent) {
      const area = el('div', 'mcp-test-area');
      const button = el('button', null, 'Test');
      const result = el('span', 'mcp-test-result');
      button.addEventListener('click', () => {
        button.disabled = true;
        result.textContent = 'Testing…';
        result.removeAttribute('title');
        const token = 'row-' + name + '-' + agent + '-' + Date.now();
        pending.set(token, testResult => {
          button.disabled = false;
          if (testResult.ok) {
            const chip = el('span', 'chip', testResult.toolCount + ' tool' + (testResult.toolCount === 1 ? '' : 's'));
            chip.title = toolsTooltip(testResult.tools);
            result.replaceChildren(chip);
          } else {
            result.textContent = testResult.error + (testResult.stderrTail ? ' — ' + testResult.stderrTail.split('\\n').slice(-1)[0] : '');
            result.title = testResult.stderrTail || '';
            result.classList.add('mcp-error');
          }
        });
        send({ type: 'mcpTest', name, agent, token });
      });
      area.append(button, result);
      container.appendChild(area);
    }

    function renderChip(name, agent, config) {
      const chip = el('button', 'mcp-chip');
      chip.type = 'button';
      chip.setAttribute('role', 'switch');
      const on = !!(config && config.spec);
      chip.setAttribute('aria-checked', String(on));
      chip.textContent = agentLabel(agent);
      const disabledReason = config && config.readOnlyReason;
      if (on && disabledReason) { chip.disabled = true; chip.title = disabledReason; chip.classList.add('mcp-chip-locked'); }
      else if (!on && agent === 'claude' && !latest.claudeCliAvailable) { chip.disabled = true; chip.title = 'Claude Code CLI not found.'; }
      chip.addEventListener('click', () => {
        if (chip.disabled) return;
        chip.disabled = true;
        send({ type: 'mcpToggle', name, agent, on: !on });
      });
      if (on) chip.classList.add('mcp-chip-on');
      return chip;
    }

    function renderServer(entry) {
      const row = el('div', 'row mcp-row');
      row.setAttribute('role', 'listitem');
      const text = el('div', 'row-text');
      const title = el('div', 'row-title');
      title.appendChild(document.createTextNode(entry.name + ' '));
      if (entry.locked) {
        const lock = el('span', 'mcp-lock');
        lock.innerHTML = ${JSON.stringify(lockIcon)};
        lock.title = 'Managed on Connectors';
        title.appendChild(lock);
        const link = el('button', 'linklike', 'Managed on Connectors');
        link.type = 'button';
        link.addEventListener('click', () => showPage('connectors'));
        title.appendChild(link);
      }
      text.appendChild(title);
      const spec = entry.spec;
      if (spec) text.appendChild(el('div', 'row-desc', summarize(spec)));
      if (entry.differs) text.appendChild(el('div', 'row-desc mcp-differs', 'Configured differently for each agent.'));
      const problems = Object.entries(entry.agents || {}).filter(([, config]) => config && config.problem).map(([agent, config]) => agentLabel(agent) + ': ' + config.problem);
      if (problems.length) text.appendChild(el('div', 'row-desc mcp-error', problems.join(' · ')));
      row.appendChild(text);

      const action = el('div', 'row-action');
      if (!entry.locked) {
        action.appendChild(renderChip(entry.name, 'claude', entry.agents.claude));
        action.appendChild(renderChip(entry.name, 'codex', entry.agents.codex));
      } else {
        for (const agent of ['claude', 'codex']) {
          if (entry.agents[agent]) { const chip = el('span', 'chip mcp-chip-on', agentLabel(agent)); action.appendChild(chip); }
        }
      }
      const detailsToggle = el('button', 'quiet mcp-caret');
      detailsToggle.type = 'button';
      detailsToggle.innerHTML = ${JSON.stringify(caretIcon)};
      detailsToggle.setAttribute('aria-label', 'Details for ' + entry.name);
      detailsToggle.setAttribute('aria-expanded', 'false');
      action.appendChild(detailsToggle);
      row.appendChild(action);

      const details = el('div', 'mcp-details');
      details.hidden = true;
      if (spec) {
        const pre = el('pre', null, detailLines(spec).join('\\n'));
        details.appendChild(pre);
      }
      const removableAgents = mcpAgentsOf(entry).filter(agent => entry.agents[agent] && entry.agents[agent].removable);
      const testRow = el('div', 'mcp-details-row');
      for (const agent of mcpAgentsOf(entry)) { if (entry.agents[agent] && entry.agents[agent].spec) renderTestArea(testRow, entry.name, agent); }
      details.appendChild(testRow);
      if (!entry.locked && removableAgents.length) {
        const removeArea = el('div', 'mcp-details-row');
        const removeButton = el('button', 'danger', 'Remove');
        const confirmArea = el('span', 'mcp-confirm');
        confirmArea.hidden = true;
        const confirmText = el('span', null, 'Remove "' + entry.name + '" from ' + removableAgents.map(agentLabel).join(' and ') + '?');
        const yes = el('button', 'danger', 'Remove');
        const no = el('button', null, 'Cancel');
        yes.addEventListener('click', () => { send({ type: 'mcpRemoveAll', name: entry.name, agents: removableAgents }); });
        no.addEventListener('click', () => { confirmArea.hidden = true; removeButton.hidden = false; removeConfirm = null; });
        confirmArea.append(confirmText, yes, no);
        removeButton.addEventListener('click', () => { removeButton.hidden = true; confirmArea.hidden = false; removeConfirm = entry.name; });
        removeArea.append(removeButton, confirmArea);
        details.appendChild(removeArea);
      }
      row.appendChild(details);
      detailsToggle.addEventListener('click', () => {
        details.hidden = !details.hidden;
        detailsToggle.setAttribute('aria-expanded', String(!details.hidden));
      });
      return row;
    }
    function mcpAgentsOf(entry) { return ['claude', 'codex'].filter(agent => entry.agents[agent]); }

    function render(list) {
      latest = list;
      listEl.replaceChildren();
      for (const entry of list.servers) listEl.appendChild(renderServer(entry));
      emptyEl.hidden = list.servers.length > 0;
      const errors = Object.entries(list.errors || {}).map(([agent, text]) => agentLabel(agent) + ': ' + text);
      errorsEl.hidden = !errors.length;
      errorsEl.textContent = errors.join(' · ');
      cliHint.hidden = !!list.claudeCliAvailable;
      pathsEl.textContent = 'Claude: ' + list.paths.claude + '  ·  Codex: ' + list.paths.codex;
      const summaryDesc = listGroup.querySelector('.row-desc');
      if (summaryDesc) summaryDesc.textContent = list.servers.length + ' server' + (list.servers.length === 1 ? '' : 's') + ' configured at user level.';
      document.getElementById('mcp-add-claude').disabled = !list.claudeCliAvailable;
      if (!list.claudeCliAvailable) document.getElementById('mcp-add-claude').checked = false;
    }

    document.getElementById('mcp-refresh').addEventListener('click', () => send({ type: 'mcpRefresh' }));

    // ---- Add form ----
    const typeButtons = [...document.querySelectorAll('#mcp-add-type button')];
    const stdioFields = document.getElementById('mcp-add-stdio');
    const httpFields = document.getElementById('mcp-add-http');
    let addType = 'stdio';
    typeButtons.forEach(button => button.addEventListener('click', () => {
      addType = button.dataset.value;
      typeButtons.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      stdioFields.hidden = addType !== 'stdio';
      httpFields.hidden = addType !== 'http';
    }));
    document.getElementById('mcp-add-env-show').addEventListener('change', event => document.getElementById('mcp-add-env').classList.toggle('mcp-masked', !event.target.checked));
    document.getElementById('mcp-add-headers-show').addEventListener('change', event => document.getElementById('mcp-add-headers').classList.toggle('mcp-masked', !event.target.checked));

    function parseLines(text) { return text.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean); }
    function parsePairs(text, separator) {
      const values = {}; const errors = [];
      parseLines(text).forEach((line, index) => {
        const at = line.indexOf(separator);
        if (at <= 0) { errors.push('Line ' + (index + 1) + ': expected ' + (separator === '=' ? 'KEY=VALUE' : '"Header-Name: value"') + '.'); return; }
        const key = line.slice(0, at).trim();
        if (!key) { errors.push('Line ' + (index + 1) + ' needs a name.'); return; }
        values[key] = separator === '=' ? line.slice(at + 1) : line.slice(at + 1).trim();
      });
      return { values, errors };
    }
    function buildSpec() {
      if (addType === 'stdio') {
        const command = document.getElementById('mcp-add-command').value.trim();
        if (!command) throw new Error('Enter the command that starts the server.');
        const env = parsePairs(document.getElementById('mcp-add-env').value, '=');
        if (env.errors.length) throw new Error(env.errors[0]);
        return { type: 'stdio', command, args: parseLines(document.getElementById('mcp-add-args').value), env: env.values };
      }
      const url = document.getElementById('mcp-add-url').value.trim();
      if (!url) throw new Error("Enter the server's full URL.");
      const headers = parsePairs(document.getElementById('mcp-add-headers').value, ':');
      if (headers.errors.length) throw new Error(headers.errors[0]);
      return { type: 'http', url, headers: headers.values };
    }
    function selectedAgents() {
      const agents = [];
      if (document.getElementById('mcp-add-claude').checked) agents.push('claude');
      if (document.getElementById('mcp-add-codex').checked) agents.push('codex');
      return agents;
    }
    const addError = document.getElementById('mcp-add-error');
    const addTestResult = document.getElementById('mcp-add-test-result');
    function showAddError(text) { addError.textContent = text; addError.hidden = !text; }

    document.getElementById('mcp-add-test').addEventListener('click', () => {
      showAddError('');
      let spec;
      try { spec = buildSpec(); } catch (error) { showAddError(error.message); return; }
      addTestResult.hidden = false;
      addTestResult.classList.remove('mcp-error');
      addTestResult.textContent = 'Testing…';
      const token = 'add-test-' + Date.now();
      pending.set(token, result => {
        if (result.ok) { addTestResult.textContent = result.toolCount + ' tool' + (result.toolCount === 1 ? '' : 's') + ': ' + toolsTooltip(result.tools); addTestResult.classList.remove('mcp-error'); }
        else { addTestResult.textContent = result.error + (result.stderrTail ? ' — ' + result.stderrTail.split('\\n').slice(-1)[0] : ''); addTestResult.classList.add('mcp-error'); }
      });
      send({ type: 'mcpTestSpec', spec, token });
    });
    document.getElementById('mcp-add-submit').addEventListener('click', () => {
      showAddError('');
      let spec;
      try { spec = buildSpec(); } catch (error) { showAddError(error.message); return; }
      const name = document.getElementById('mcp-add-name').value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) { showAddError('A server name uses letters, digits, "-" and "_" (up to 64), starting with a letter or digit.'); return; }
      const agents = selectedAgents();
      if (!agents.length) { showAddError('Choose Claude Code, Codex, or both.'); return; }
      send({ type: 'mcpAdd', name, spec, agents });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (message && message.type === 'mcpList') render(message.list);
      if (message && message.type === 'mcpTestResult' && pending.has(message.token)) { pending.get(message.token)(message.result); pending.delete(message.token); }
      if (message && message.type === 'mcpAddError') showAddError(message.text);
      if (message && message.type === 'mcpAddDone') {
        showAddError('');
        addTestResult.hidden = true;
        ['mcp-add-name', 'mcp-add-command', 'mcp-add-args', 'mcp-add-env', 'mcp-add-url', 'mcp-add-headers'].forEach(id => { document.getElementById(id).value = ''; });
        document.getElementById('mcp-add').removeAttribute('open');
        document.getElementById('mcp-refresh').focus();
      }
      if (message && message.type === 'mcpRemoved') {
        removeConfirm = null;
      }
    });
  })();
  `,
  async onReady(ctx: SettingsContext): Promise<void> {
    await refreshList(ctx);
  },
  async handle(message: Record<string, unknown>, ctx: SettingsContext): Promise<boolean> {
    switch (message.type) {
      case 'mcpRefresh':
        await refreshList(ctx);
        return true;
      case 'mcpToggle': {
        const name = String(message.name), agent = parseAgent(message.agent), on = !!message.on;
        try {
          const context = await buildContext();
          if (on) await enableMcpServerFor(context, name, agent);
          else await removeMcpServer(context, name, agent);
          await ctx.post({ type: 'status', text: `${on ? 'Enabled' : 'Removed'} "${name}" for ${mcpAgentLabel(agent)}.` });
        } catch (error) {
          await ctx.post({ type: 'error', text: error instanceof Error ? error.message : 'Could not update that server.' });
        }
        await refreshList(ctx);
        return true;
      }
      case 'mcpRemoveAll': {
        const name = String(message.name), agents = parseAgentList(message.agents);
        const context = await buildContext();
        const failures: string[] = [];
        for (const agent of agents) {
          try { await removeMcpServer(context, name, agent); } catch (error) { failures.push(`${mcpAgentLabel(agent)}: ${error instanceof Error ? error.message : 'failed'}`); }
        }
        await ctx.post(failures.length ? { type: 'error', text: `Removed "${name}" where possible. ${failures.join(' ')}` } : { type: 'status', text: `Removed "${name}".` });
        await ctx.post({ type: 'mcpRemoved', name });
        await refreshList(ctx);
        return true;
      }
      case 'mcpTest': {
        const name = String(message.name), agent = parseAgent(message.agent), token = String(message.token ?? '');
        let result;
        try {
          const context = await buildContext();
          const spec = await configuredSpec(context, name, agent);
          result = await testMcpServer(spec);
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : 'Could not test that server.', durationMs: 0 };
        }
        await ctx.post({ type: 'mcpTestResult', token, result });
        return true;
      }
      case 'mcpTestSpec': {
        const token = String(message.token ?? '');
        let result;
        try {
          const spec = validateServerSpec(message.spec) as McpServerSpec;
          result = await testMcpServer(spec);
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : 'Could not test that server.', durationMs: 0 };
        }
        await ctx.post({ type: 'mcpTestResult', token, result });
        return true;
      }
      case 'mcpAdd': {
        try {
          const context = await buildContext();
          const name = String(message.name), spec = validateServerSpec(message.spec), agents = parseAgentList(message.agents);
          await addMcpServer(context, name, spec, agents);
          await ctx.post({ type: 'mcpAddDone' });
          await ctx.post({ type: 'status', text: `Added "${name}".` });
        } catch (error) {
          await ctx.post({ type: 'mcpAddError', text: error instanceof Error ? error.message : 'Could not add that server.' });
        }
        await refreshList(ctx);
        return true;
      }
      default:
        return false;
    }
  },
};
