/** Nav order, pure so tests can assert it without importing vscode-dependent page modules. */
export const pageOrder = ['general', 'connectors', 'mcpServers', 'heads', 'appearance', 'docs'] as const;
export type PageId = (typeof pageOrder)[number];
