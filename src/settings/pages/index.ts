import { pageOrder } from '../pageOrder';
import type { SettingsPage } from '../types';
import { appearancePage } from './appearance';
import { connectorsPage } from './connectors';
import { docsPage } from './docs';
import { generalPage } from './general';
import { headsPage } from './heads';
import { mcpServersPage } from './mcpServers';

const byId: Record<string, SettingsPage> = {
  general: generalPage,
  connectors: connectorsPage,
  mcpServers: mcpServersPage,
  heads: headsPage,
  appearance: appearancePage,
  docs: docsPage,
};

/** Pages in nav order (src/settings/pageOrder.ts). */
export const settingsPages: SettingsPage[] = pageOrder.map(id => byId[id]!);
