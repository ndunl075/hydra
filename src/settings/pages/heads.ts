import * as vscode from 'vscode';
import type { SettingsContext, SettingsPage } from '../types';

const headsGuideUrl = 'https://github.com/ndunl075/hydra/blob/main/docs/Heads.md';

/**
 * Heads: hydra.maxConcurrentHelpers, the default per-head caps
 * (hydra.heads.defaultMinutes/defaultMaxTurns/defaultBudgetUsd, applied to a
 * head started without its own limits — src/core/jobs.ts resolveHeadDefaults),
 * Stop all heads (the existing hydra.stopAllHelpers command), and a link to
 * the Heads guide.
 */
export const headsPage: SettingsPage = {
  id: 'heads',
  title: 'Heads',
  rows: [
    { title: 'Heads at a time', description: 'Maximum Hydra heads running at once in this window. More wait in a queue.' },
    { title: 'Default caps', description: 'Minutes, turns, and budget a head gets when it is started without its own limits.' },
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
      <div class="row"><div class="row-text"><div class="row-title">Default caps</div><div class="row-desc">Minutes, turns, and budget a head gets when it is started without its own limits.</div></div>
        <div class="row-action" style="display:flex;gap:10px;align-items:center">
          <label for="hd-default-minutes" style="font-size:12px">Minutes</label><input type="number" id="hd-default-minutes" min="1" max="480" step="1" style="width:64px" aria-label="Default minutes">
          <label for="hd-default-turns" style="font-size:12px">Turns</label><input type="number" id="hd-default-turns" min="1" max="500" step="1" style="width:64px" aria-label="Default turns">
          <label for="hd-default-budget" style="font-size:12px">Budget (USD)</label><input type="number" id="hd-default-budget" min="0.5" max="100" step="0.5" style="width:72px" aria-label="Default budget in USD">
        </div></div>
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
  const hdMinutes = document.getElementById('hd-default-minutes');
  const hdTurns = document.getElementById('hd-default-turns');
  const hdBudget = document.getElementById('hd-default-budget');
  hdMinutes?.addEventListener('change', () => { const value = Math.max(1, Math.min(480, Math.round(Number(hdMinutes.value)) || 30)); hdMinutes.value = String(value); send({type:'setDefaultHeadMinutes', value}); });
  hdTurns?.addEventListener('change', () => { const value = Math.max(1, Math.min(500, Math.round(Number(hdTurns.value)) || 60)); hdTurns.value = String(value); send({type:'setDefaultHeadMaxTurns', value}); });
  hdBudget?.addEventListener('change', () => { const value = Math.max(0.5, Math.min(100, Number(hdBudget.value) || 5)); hdBudget.value = String(value); send({type:'setDefaultHeadBudgetUsd', value}); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'maxConcurrentHelpers' && hdMax) hdMax.value = String(message.value);
    if (message?.type === 'defaultHeadCaps') {
      if (hdMinutes) hdMinutes.value = String(message.minutes);
      if (hdTurns) hdTurns.value = String(message.maxTurns);
      if (hdBudget) hdBudget.value = String(message.budgetUsd);
    }
  });
  `,
  async onReady(ctx: SettingsContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('hydra');
    const value = Math.max(1, Math.min(8, config.get<number>('maxConcurrentHelpers', 3)));
    await ctx.post({ type: 'maxConcurrentHelpers', value });
    await ctx.post({
      type: 'defaultHeadCaps',
      minutes: Math.max(1, Math.min(480, config.get<number>('heads.defaultMinutes', 30))),
      maxTurns: Math.max(1, Math.min(500, config.get<number>('heads.defaultMaxTurns', 60))),
      budgetUsd: Math.max(0.5, Math.min(100, config.get<number>('heads.defaultBudgetUsd', 5))),
    });
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
      case 'setDefaultHeadMinutes': {
        const value = Math.max(1, Math.min(480, Math.round(Number(message.value))));
        if (!Number.isFinite(value)) throw new Error('Enter a number between 1 and 480.');
        await vscode.workspace.getConfiguration('hydra').update('heads.defaultMinutes', value, vscode.ConfigurationTarget.Global);
        await ctx.post({ type: 'status', text: `Default head time cap set to ${value} minutes.` });
        return true;
      }
      case 'setDefaultHeadMaxTurns': {
        const value = Math.max(1, Math.min(500, Math.round(Number(message.value))));
        if (!Number.isFinite(value)) throw new Error('Enter a number between 1 and 500.');
        await vscode.workspace.getConfiguration('hydra').update('heads.defaultMaxTurns', value, vscode.ConfigurationTarget.Global);
        await ctx.post({ type: 'status', text: `Default head turn cap set to ${value}.` });
        return true;
      }
      case 'setDefaultHeadBudgetUsd': {
        const value = Math.max(0.5, Math.min(100, Number(message.value)));
        if (!Number.isFinite(value)) throw new Error('Enter a number between 0.5 and 100.');
        await vscode.workspace.getConfiguration('hydra').update('heads.defaultBudgetUsd', value, vscode.ConfigurationTarget.Global);
        await ctx.post({ type: 'status', text: `Default head budget cap set to $${value}.` });
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
