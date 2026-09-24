import * as vscode from 'vscode';
import type { ImportCategory } from '../../core/profileImport';
import { clearDismissedPrompts } from '../dismissedPrompts';
import type { SettingsContext, SettingsPage } from '../types';

/**
 * General: editor/keyboard entry points, the existing preference importer
 * (moved intact from extensionSettings.ts), dismissed-prompt reset, chat
 * location (setting + command owned by the Phase 3 agent — handled gracefully
 * if not present yet), and an Editor/Agents switch: the tiles set
 * hydra.startupLayout (Global, applied to new windows at activation) and
 * also switch the current window to match.
 */
export const generalPage: SettingsPage = {
  id: 'general',
  title: 'General',
  rows: [
    { title: 'Editor settings', description: 'Font, formatting, minimap and more.' },
    { title: 'Keyboard shortcuts', description: 'Rebind commands across Hydra and the editor.' },
    { title: 'Import from VS Code or Cursor', description: 'Bring settings, keybindings and snippets. Preview first; one-click undo.' },
    { title: 'Reset "Don\'t ask again" dialogs', description: 'Clear prompts you told Hydra to stop showing.' },
    { title: 'Chat location', description: 'Docked in the side bar, or open as editor tabs.' },
    { title: 'Window layout', description: 'Editor or Agents. Sets the startup view for new windows, and switches this window now.' },
    { title: 'Provider accounts', description: 'Sign in and manage Claude Code and Codex accounts.' },
    { title: 'Onboarding', description: 'Revisit the first-run setup.' },
  ],
  html(ctx: SettingsContext): string {
    const imports = ctx.imports;
    return `
    <h1>General</h1>
    <p class="lede">Editor behavior, imports, and how Hydra opens.</p>
    <div class="group">
      <h2>Editor</h2>
      <div class="row"><div class="row-text"><div class="row-title">Editor settings</div><div class="row-desc">Font, formatting, minimap and more.</div></div><div class="row-action"><button id="gs-editor">Open</button></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Keyboard shortcuts</div><div class="row-desc">Rebind commands across Hydra and the editor.</div></div><div class="row-action"><button id="gs-keybindings">Open</button></div></div>
    </div>
    <div class="group">
      <h2>Chat</h2>
      <div class="row"><div class="row-text"><div class="row-title">Chat location</div><div class="row-desc">Docked in the side bar (default), or open as renameable editor tabs.</div></div><div class="row-action"><div class="segmented" role="group" aria-label="Chat location" id="gs-chat-location"><button data-value="docked" aria-pressed="true">Docked</button><button data-value="tabs" aria-pressed="false">Tabs</button></div></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Window layout</div><div class="row-desc">Editor or Agents. Sets the startup view for new windows, and switches this window now.</div></div><div class="row-action"><div class="tiles" role="group" aria-label="Window layout" id="gs-layout"><button class="tile" data-value="editor" aria-pressed="true">Editor</button><button class="tile" data-value="agents" aria-pressed="false">Agents</button></div></div></div>
    </div>
    <div class="group">
      <h2>Reset</h2>
      <div class="row"><div class="row-text"><div class="row-title">Reset "Don't ask again" dialogs</div><div class="row-desc">Clear prompts you told Hydra to stop showing.</div></div><div class="row-action"><button id="gs-reset-prompts">Reset</button></div></div>
    </div>
    ${imports.available ? `
    <div class="group">
      <h2>Set up Hydra</h2>
      <div class="row"><div class="row-text"><div class="row-title">Onboarding</div><div class="row-desc">Revisit the first-run setup.</div></div><div class="row-action"><button id="gs-onboarding">Open</button></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Provider accounts</div><div class="row-desc">Sign in and manage Claude Code and Codex accounts.</div></div><div class="row-action"><button id="gs-accounts">Open</button></div></div>
    </div>
    <div class="group">
      <h2>Import preferences</h2>
      <div class="row"><div class="row-text"><div class="row-title">Import from VS Code or Cursor</div><div class="row-desc">Preview settings, keybindings and snippets before importing. Current Hydra preferences win on conflicts.</div></div>
        <div class="row-action"><button data-import="vscode">From VS Code</button><button data-import="cursor">From Cursor</button><button data-import="folder">Choose folder…</button></div></div>
      <div id="gs-import-preview" tabindex="-1" aria-labelledby="gs-import-preview-heading" hidden style="padding:0 14px 14px">
        <h3 id="gs-import-preview-heading">Import preview</h3><p id="gs-import-source"></p>
        <div class="categories" style="display:flex;flex-wrap:wrap;gap:16px;margin:12px 0">${(['settings', 'keybindings', 'snippets'] as const).map(category => `<label><input type="checkbox" data-category="${category}" checked> ${category[0]!.toUpperCase() + category.slice(1)} <span data-count="${category}"></span></label>`).join('')}</div>
        <p>Add brings a new preference. Keep preserves a conflict. Skip leaves an unavailable, account, or existing preference unchanged.</p>
        <ul id="gs-import-items" tabindex="0" aria-label="Preference changes" style="max-height:220px;overflow:auto;padding-left:20px;line-height:1.7"></ul>
        <p id="gs-import-truncated" hidden>Showing the first 500 entries. Category totals include all entries.</p>
        <ul id="gs-import-warnings" style="color:var(--vscode-descriptionForeground);line-height:1.7"></ul>
        <div class="row-action"><button class="primary" id="gs-apply-import">Import selected</button><button id="gs-cancel-import">Cancel</button></div>
      </div>
      <div class="row"><div class="row-text"><div class="row-title">Undo last import</div><div class="row-desc">Restore the preferences from before the last import.</div></div><div class="row-action"><button id="gs-undo-import" disabled>Undo</button></div></div>
      <p id="gs-import-recovery" hidden style="padding:0 14px 12px;color:var(--vscode-descriptionForeground)">The last import was interrupted. Undo it before importing again. Backups are retained if newer edits prevent safe recovery.</p>
    </div>` : ''}
    `;
  },
  script: `
  document.getElementById('gs-editor')?.addEventListener('click', () => send({type:'editorSettings'}));
  document.getElementById('gs-keybindings')?.addEventListener('click', () => send({type:'keyboardShortcuts'}));
  document.getElementById('gs-onboarding')?.addEventListener('click', () => send({type:'onboarding'}));
  document.getElementById('gs-accounts')?.addEventListener('click', () => send({type:'accounts'}));
  document.getElementById('gs-reset-prompts')?.addEventListener('click', () => send({type:'resetDismissedPrompts'}));
  document.querySelectorAll('#gs-chat-location button').forEach(button => button.addEventListener('click', () => send({type:'chatLocation', value: button.dataset.value})));
  document.querySelectorAll('#gs-layout button').forEach(button => button.addEventListener('click', () => send({type:'windowLayout', value: button.dataset.value})));
  (function(){
    const importStatus = () => document.getElementById('status');
    let preview, busy = false, undoAvailable = false;
    const sources = [...document.querySelectorAll('[data-import]')], categories = [...document.querySelectorAll('#gs-import-preview [data-category]')];
    const apply = document.getElementById('gs-apply-import'), undo = document.getElementById('gs-undo-import'), panel = document.getElementById('gs-import-preview');
    if (!sources.length) return;
    function update() { sources.forEach(button => button.disabled = busy); categories.forEach(input => input.disabled = busy); if (apply) apply.disabled = busy || !preview || !categories.some(input => input.checked && preview.counts[input.dataset.category] > 0); if (undo) undo.disabled = busy || !undoAvailable; const cancel = document.getElementById('gs-cancel-import'); if (cancel) cancel.disabled = busy; }
    function request(message, text) { busy = true; importStatus().textContent = text; update(); vscode.postMessage(message); }
    sources.forEach(button => button.addEventListener('click', () => { preview = undefined; panel.hidden = true; request({type:'previewImport', provider: button.dataset.import}, 'Reading preferences…'); }));
    categories.forEach(input => input.addEventListener('change', update));
    apply?.addEventListener('click', () => request({type:'applyImport', token: preview.token, categories: categories.filter(input => input.checked).map(input => input.dataset.category)}, 'Importing preferences…'));
    undo?.addEventListener('click', () => request({type:'undoImport'}, 'Restoring preferences…'));
    document.getElementById('gs-cancel-import')?.addEventListener('click', () => { preview = undefined; panel.hidden = true; importStatus().textContent = 'Preview cancelled.'; update(); sources[0].focus(); });
    window.addEventListener('message', event => {
      const message = event.data;
      if (message?.type === 'importPreview') {
        preview = message.preview; busy = false; panel.hidden = false;
        document.getElementById('gs-import-source').textContent = 'From ' + preview.source + ' into Hydra\\'s ' + preview.profile + ' profile.';
        categories.forEach(input => { input.checked = preview.counts[input.dataset.category] > 0; document.querySelector('#gs-import-preview [data-count="' + input.dataset.category + '"]').textContent = '(' + preview.counts[input.dataset.category] + ' new)'; });
        const list = document.getElementById('gs-import-items'); list.replaceChildren(); for (const item of preview.items) { const row = document.createElement('li'); row.textContent = (item.state === 'add' ? 'Add' : item.state === 'conflict' ? 'Keep' : 'Skip') + ' · ' + item.name + (item.detail ? ' — ' + item.detail : ''); list.appendChild(row); }
        const warnings = document.getElementById('gs-import-warnings'); warnings.replaceChildren(); for (const text of preview.warnings) { const row = document.createElement('li'); row.textContent = text; warnings.appendChild(row); }
        document.getElementById('gs-import-truncated').hidden = !preview.truncated; importStatus().textContent = 'Preview ready. Choose what to import.';
      }
      if (message?.type === 'importDone') { busy = false; preview = undefined; panel.hidden = true; importStatus().textContent = message.text; }
      if (message?.type === 'importCancelled') { busy = false; importStatus().textContent = 'Folder selection cancelled.'; }
      if (message?.type === 'importStatus') { undoAvailable = message.available; const recovery = document.getElementById('gs-import-recovery'); if (recovery) recovery.hidden = !message.interrupted; }
      if (message?.type === 'error') { busy = false; importStatus().textContent = message.text; }
      if (message?.type === 'chatLocationState') { document.querySelectorAll('#gs-chat-location button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === message.value))); }
      if (message?.type === 'windowLayoutState') { document.querySelectorAll('#gs-layout button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === message.value))); }
      update();
    });
  })();
  `,
  async onReady(ctx: SettingsContext): Promise<void> {
    if (ctx.imports.available) await ctx.post({ type: 'importStatus', ...await ctx.imports.status() });
    const startupLayout = vscode.workspace.getConfiguration('hydra').get<string>('startupLayout', 'editor');
    await ctx.post({ type: 'windowLayoutState', value: startupLayout === 'agents' ? 'agents' : 'editor' });
    const chatLocation = vscode.workspace.getConfiguration('hydra').get<string>('chatLocation', 'docked');
    await ctx.post({ type: 'chatLocationState', value: chatLocation });
  },
  async handle(message: Record<string, unknown>, ctx: SettingsContext): Promise<boolean> {
    switch (message.type) {
      case 'editorSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings');
        return true;
      case 'keyboardShortcuts':
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
        return true;
      case 'accounts':
        await vscode.commands.executeCommand('hydra.openAccounts');
        return true;
      case 'onboarding':
        await vscode.commands.executeCommand('hydra.openOnboarding');
        return true;
      case 'resetDismissedPrompts':
        await clearDismissedPrompts(ctx.globalState);
        await ctx.post({ type: 'status', text: 'Cleared dismissed dialogs. They will show again when you next hit them.' });
        return true;
      case 'chatLocation': {
        const value = message.value === 'tabs' ? 'tabs' : 'docked';
        try {
          await vscode.commands.executeCommand('hydra.setChatLocation', value);
          await ctx.post({ type: 'chatLocationState', value });
          await ctx.post({ type: 'status', text: `Chat location set to ${value === 'tabs' ? 'Tabs' : 'Docked'}.` });
        } catch {
          await ctx.post({ type: 'chatLocationState', value });
          await ctx.post({ type: 'status', text: 'Chat location will apply once this Hydra build supports it.' });
        }
        return true;
      }
      case 'windowLayout': {
        const value = message.value === 'agents' ? 'agents' : 'editor';
        await vscode.workspace.getConfiguration('hydra').update('startupLayout', value, vscode.ConfigurationTarget.Global);
        const state = await Promise.resolve(vscode.commands.executeCommand<{ mode: 'editor' | 'agents' }>('hydra.getConversationState')).catch(() => undefined);
        if (state && state.mode !== value) await vscode.commands.executeCommand('hydra.toggleMode');
        await ctx.post({ type: 'windowLayoutState', value });
        await ctx.post({ type: 'status', text: `Window layout set to ${value === 'agents' ? 'Agents' : 'Editor'}.` });
        return true;
      }
      case 'previewImport': {
        if (!['vscode', 'cursor', 'folder'].includes(String(message.provider))) throw new Error('Unknown import source.');
        const preview = await ctx.imports.choose(message.provider as 'vscode' | 'cursor' | 'folder');
        await ctx.post({ type: preview ? 'importPreview' : 'importCancelled', preview });
        return true;
      }
      case 'applyImport': {
        if (typeof message.token !== 'string' || !Array.isArray(message.categories)) throw new Error('Invalid import selection.');
        const files = await ctx.imports.apply(message.token, message.categories as ImportCategory[]);
        await ctx.post({ type: 'importDone', text: `Imported preferences into ${files} file${files === 1 ? '' : 's'}. Existing preferences were preserved.` });
        if (ctx.imports.available) await ctx.post({ type: 'importStatus', ...await ctx.imports.status() });
        return true;
      }
      case 'undoImport': {
        await ctx.imports.undo();
        await ctx.post({ type: 'importDone', text: 'Restored the preferences from before the last import.' });
        if (ctx.imports.available) await ctx.post({ type: 'importStatus', ...await ctx.imports.status() });
        return true;
      }
      default:
        return false;
    }
  },
};
