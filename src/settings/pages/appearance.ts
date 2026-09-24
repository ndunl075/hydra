import * as vscode from 'vscode';
import type { SettingsContext, SettingsPage } from '../types';

interface IconThemeEntry { id: string; label: string }

function installedIconThemes(): IconThemeEntry[] {
  const themes: IconThemeEntry[] = [{ id: '', label: 'None' }];
  for (const extension of vscode.extensions.all) {
    const contributed = (extension.packageJSON as { contributes?: { iconThemes?: { id: string; label?: string }[] } } | undefined)?.contributes?.iconThemes;
    for (const theme of contributed || []) themes.push({ id: theme.id, label: theme.label || theme.id });
  }
  return themes;
}

/** Appearance: the existing Dark/Light control (unchanged setAppearance behaviour/message), plus an icon theme picker. */
export const appearancePage: SettingsPage = {
  id: 'appearance',
  title: 'Appearance',
  rows: [
    { title: 'Dark / Light', description: 'One theme for the editor, terminals, and agent manager.' },
    { title: 'Icon theme', description: 'File and folder icons, from installed icon theme extensions.' },
  ],
  html(): string {
    return `
    <h1>Appearance</h1>
    <p class="lede">Choose a theme for the editor, terminals, and agent manager. Both use Hydra's dark green accents.</p>
    <div class="group">
      <h2>Theme</h2>
      <div class="row"><div class="row-text"><div class="row-title">Dark / Light</div><div class="row-desc">Applies to your user profile and turns off automatic system dark/light switching. High-contrast settings remain available in the editor.</div></div>
        <div class="row-action"><div class="segmented" role="group" aria-label="Appearance" id="ap-mode"><button data-mode="dark" aria-pressed="false">Dark</button><button data-mode="light" aria-pressed="false">Light</button></div></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Icon theme</div><div class="row-desc">File and folder icons, from installed icon theme extensions.</div></div>
        <div class="row-action"><select id="ap-icon-theme" aria-label="Icon theme"></select></div></div>
    </div>
    `;
  },
  script: `
  const apChoices = [...document.querySelectorAll('#ap-mode [data-mode]')];
  apChoices.forEach(button => button.addEventListener('click', () => { apChoices.forEach(choice => choice.disabled = true); send({type:'appearance', mode: button.dataset.mode}); }));
  const apIconSelect = document.getElementById('ap-icon-theme');
  apIconSelect?.addEventListener('change', () => send({type:'iconTheme', value: apIconSelect.value}));
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'appearance') { apChoices.forEach(button => { button.disabled = false; button.setAttribute('aria-pressed', String(button.dataset.mode === message.mode)); }); }
    if (message?.type === 'iconThemes' && apIconSelect) { apIconSelect.replaceChildren(); for (const theme of message.themes) { const option = document.createElement('option'); option.value = theme.id; option.textContent = theme.label; if (theme.id === message.current) option.selected = true; apIconSelect.appendChild(option); } }
  });
  `,
  async onReady(ctx: SettingsContext): Promise<void> {
    const kind = vscode.window.activeColorTheme.kind;
    await ctx.post({ type: 'appearance', mode: kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark' });
    const current = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme', '') || '';
    await ctx.post({ type: 'iconThemes', themes: installedIconThemes(), current });
  },
  async handle(message: Record<string, unknown>, ctx: SettingsContext): Promise<boolean> {
    switch (message.type) {
      // 'appearance' is handled by the shell itself (HydraSettings.setAppearance), which also owns the
      // theme-change subscription that republishes this row — see src/settings/shell.ts.
      case 'iconTheme': {
        const value = typeof message.value === 'string' ? message.value : '';
        await vscode.workspace.getConfiguration('workbench').update('iconTheme', value || null, vscode.ConfigurationTarget.Global);
        await ctx.post({ type: 'status', text: value ? `Icon theme set to ${value}.` : 'Icon theme cleared.' });
        return true;
      }
      default:
        return false;
    }
  },
};
