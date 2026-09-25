import * as vscode from 'vscode';
import type { SettingsPage } from '../types';

const links = [
  { id: 'heads', title: 'Heads guide', description: 'How Hydra heads work and when to use them.', url: 'https://github.com/ndunl075/hydra/blob/main/docs/Heads.md' },
  { id: 'build', title: 'Build guide', description: 'Build Hydra from source.', url: 'https://github.com/ndunl075/hydra/blob/main/docs/Standalone_Build.md' },
  { id: 'readme', title: 'README', description: 'What Hydra is and how it fits together.', url: 'https://github.com/ndunl075/hydra/blob/main/README.md' },
];

/** Docs: links to the Heads guide, Build guide and README. Opened externally (GitHub) so they work from a packaged, docs-less install. */
export const docsPage: SettingsPage = {
  id: 'docs',
  title: 'Docs',
  rows: links.map(link => ({ title: link.title, description: link.description })),
  html(): string {
    return `
    <h1>Docs</h1>
    <p class="lede">Guides and reference for Hydra.</p>
    <div class="group">
      <h2>Guides</h2>
      ${links.map(link => `<div class="row"><div class="row-text"><div class="row-title">${link.title}</div><div class="row-desc">${link.description}</div></div><div class="row-action"><button data-doc="${link.id}">Open</button></div></div>`).join('')}
    </div>
    `;
  },
  script: `document.querySelectorAll('[data-doc]').forEach(button => button.addEventListener('click', () => send({type:'openDoc', id: button.dataset.doc})));`,
  async handle(message: Record<string, unknown>): Promise<boolean> {
    if (message.type !== 'openDoc') return false;
    const link = links.find(item => item.id === message.id);
    if (!link) throw new Error('Unknown doc.');
    await vscode.env.openExternal(vscode.Uri.parse(link.url));
    return true;
  },
};
