import { pageOrder } from '../pageOrder';
import type { SettingsPage } from '../types';
import { appearancePage } from './appearance';
import { connectorsPage } from './connectors';
import { docsPage } from './docs';
import { gatesPage } from './gates';
import { generalPage } from './general';
import { headsPage } from './heads';
import { mcpServersPage } from './mcpServers';
import { packsPage } from './packs';

const byId: Record<string, SettingsPage> = {
  general: generalPage,
  connectors: connectorsPage,
  mcpServers: mcpServersPage,
  heads: headsPage,
  gates: gatesPage,
  packs: packsPage,
  appearance: appearancePage,
  docs: docsPage,
};

/** Pages in nav order (src/settings/pageOrder.ts). */
export const settingsPages: SettingsPage[] = pageOrder.map(id => byId[id]!);
