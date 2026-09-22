import React from 'react';

// The extension passes the bundled logo's webview URI on <body>, because the
// webview CSP only permits images served from its own resource root.
const source = typeof document === 'undefined' ? '' : document.body.dataset.logo || '';

export function HydraMark({ className }: { className?: string }) {
  if (!source) return <span className={className} aria-hidden="true">h</span>;
  return <span className={className} aria-hidden="true"><img src={source} alt="" /></span>;
}
