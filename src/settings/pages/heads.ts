import * as vscode from 'vscode';
import type { SettingsContext, SettingsPage } from '../types';

const headsGuideUrl = 'https://github.com/ndunl075/hydra/blob/main/docs/Heads.md';

/**
 * Heads: hydra.maxConcurrentHelpers (the only per-head cap that exists today
 * — there is no minutes/turns/budget default setting in the codebase; the
 * closest thing, soft budgets in src/core/budgets.ts, is per-task/per-project
 * and set elsewhere, not a global default, so it is not duplicated here),
 * Stop all heads (the existing hydra.stopAllHelpers command), and a link to
 * the Heads guide.
 */
export const headsPage: SettingsPage = {
  id: 'heads',
  title: 'Heads',
  rows: [
    { title: 'Heads at a time', description: 'Maximum Hydra heads running at once in this window. More wait in a queue.' },
    { title: 'Stop all heads', description: 'Cancel every running head in this window.' },
    { title: 'Heads guide', description: 'How Hydra heads work and when to use them.' },
  ],
  html(): string {
    return `
    <h1>Heads</h1>
    <p class="lede">Hydra heads are parallel agents Hydra runs in their own worktrees.</p>
    <div class="group">
      <h2>Concurrency</h2>
      <div class="row"><div class="row-text"><div class="row-title">Heads at a time</div><div class="row-desc">Maximum Hydra heads running at once in this window. More wait in a queue.</div></div>
        <div class="row-action"><input type="number" id="hd-max" min="1" max="8" step="1" style="width:56px" aria-label="Maximum heads at a time"></div></div>
      <div class="row"><div class="row-text"><div class="row-title">Stop all heads</div><div class="row-desc">Cancel every running head in this window.</div></div><div class="row-action"><button class="danger" id="hd-stop-all">Stop all</button></div></div>
    </div>
    <div class="group">
      <h2>Learn more</h2>
      <div class="row"><div class="row-text"><div class="row-title">Heads guide</div><div class="row-desc">How Hydra heads work and when to use them.</div></div><div class="row-action"><button id="hd-guide">Open</button></div></div>
    </div>
    `;
  },
  script: `
  const hdMax = document.getElementById('hd-max');
  hdMax?.addEventListener('change', () => { const value = Math.max(1, Math.min(8, Number(hdMax.value) || 1)); hdMax.value = String(value); send({type:'setMaxConcurrentHelpers', value}); });
  document.getElementById('hd-stop-all')?.addEventListener('click', () => send({type:'stopAllHeads'}));
  document.getElementById('hd-guide')?.addEventListener('click', () => send({type:'openHeadsGuide'}));
  window.addEventListener('message', event => { const message = event.data; if (message?.type === 'maxConcurrentHelpers' && hdMax) hdMax.value = String(message.value); });
  `,
  async onReady(ctx: SettingsContext): Promise<void> {
    const value = Math.max(1, Math.min(8, vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentHelpers', 3)));
    await ctx.post({ type: 'maxConcurrentHelpers', value });
  },
  async handle(message: Record<string, unknown>, ctx: SettingsContext): Promise<boolean> {
    switch (message.type) {
      case 'setMaxConcurrentHelpers': {
        const value = Math.max(1, Math.min(8, Math.round(Number(message.value))));
        if (!Number.isFinite(value)) throw new Error('Enter a number between 1 and 8.');
        await vscode.workspace.getConfiguration('hydra').update('maxConcurrentHelpers', value, vscode.ConfigurationTarget.Global);
        await ctx.post({ type: 'status', text: `Heads at a time set to ${value}.` });
        return true;
      }
      case 'stopAllHeads':
        await vscode.commands.executeCommand('hydra.stopAllHelpers');
        await ctx.post({ type: 'status', text: 'Stopped all running heads.' });
        return true;
      case 'openHeadsGuide':
        await vscode.env.openExternal(vscode.Uri.parse(headsGuideUrl));
        return true;
      default:
        return false;
    }
  },
};
