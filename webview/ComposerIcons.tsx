import React from 'react';

// Small line icons for the composer and conversation header. Each control gets a
// glyph so adjacent chips read as different kinds of setting at a glance, which
// matters because two of them (model and permission mode) can both say "default".
const paths = {
  plus: 'M8 3v10M3 8h10',
  shield: 'M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z',
  agents: 'M8 3v4M8 7l-4 3M8 7l4 3M4 10v3M12 10v3',
  history: 'M3 8a5 5 0 1 0 1.5-3.5M3 3v2.5h2.5M8 5.5V8l2 1.5',
  up: 'M8 13V3M4 7l4-4 4 4',
  chevron: 'M4 6l4 4 4-4'
} as const;

export function ComposerIcon({ name, size = 14 }: { name: keyof typeof paths; size?: number }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
