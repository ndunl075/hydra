/**
 * Shared shell CSS: nav, search, card groups, rows, toggles, segmented
 * controls, disclosures and chips. Cursor-Settings style: quiet, dense,
 * rounded card groups, subtle borders. Uses VS Code theme variables only.
 */
export const settingsStyles = `
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); display: flex; flex-direction: column; height: 100vh; }
.shell { flex: 1; display: flex; min-height: 0; }
.nav { width: 208px; flex: none; border-right: 1px solid var(--vscode-panel-border); padding: 16px 10px; overflow-y: auto; }
.nav h1 { font-size: 13px; font-weight: 600; margin: 4px 8px 12px; letter-spacing: .01em; }
.search { display: flex; align-items: center; gap: 6px; margin: 0 4px 12px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-input-background); }
.search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: var(--vscode-input-foreground); font: inherit; }
.search input:focus-visible { outline: none; }
.search svg { flex: none; opacity: .6; }
.nav-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.nav-item { display: block; width: 100%; text-align: left; font: inherit; cursor: pointer; border: none; background: transparent; color: var(--vscode-foreground); padding: 6px 10px; border-radius: 6px; }
.nav-item:hover { background: var(--vscode-toolbar-hoverBackground); }
.nav-item[aria-current="page"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.nav-item:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
.nav-item[hidden] { display: none; }
.nav-empty { padding: 10px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.main { flex: 1; overflow-y: auto; }
.page { max-width: 760px; margin: 0 auto; padding: 36px 32px 60px; }
.page[hidden] { display: none; }
.page > h1 { font-size: 20px; font-weight: 550; margin: 0 0 6px; }
.page > .lede { color: var(--vscode-descriptionForeground); line-height: 1.6; margin: 0 0 24px; }
.group { border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin-bottom: 18px; overflow: hidden; }
.group h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 0; padding: 10px 14px 6px; }
.row { display: flex; align-items: center; gap: 16px; padding: 12px 14px; border-top: 1px solid var(--vscode-panel-border); }
.group h2 + .row, .row:first-of-type { border-top: none; }
.row-text { flex: 1; min-width: 0; }
.row-text .row-title { font-size: 13px; }
.row-text .row-desc { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.5; margin-top: 2px; }
.row-action { flex: none; display: flex; align-items: center; gap: 8px; }
/* Pack cards: the text keeps room to read, and the buttons move below it when the page is narrow. */
.pk-card > .row { flex-wrap: wrap; }
.pk-card > .row > .row-text { flex: 1 1 260px; }
.pk-card .chip { white-space: nowrap; }
.row[hidden] { display: none; }
mark { background: var(--vscode-editor-findMatchHighlightBackground, #ea5c0055); color: inherit; border-radius: 2px; }
button { cursor: pointer; font: inherit; border-radius: 4px; padding: 6px 12px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:focus-visible, [tabindex]:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
button:disabled { cursor: default; opacity: .5; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.quiet { background: transparent; border-color: transparent; }
button.danger { color: var(--vscode-errorForeground); }
.segmented { display: inline-flex; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
.segmented button { border: none; border-radius: 0; background: transparent; padding: 5px 12px; }
.segmented button + button { border-left: 1px solid var(--vscode-panel-border); }
.segmented button[aria-pressed="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.tiles { display: flex; gap: 10px; }
.tile { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 16px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: transparent; color: var(--vscode-foreground); }
.tile[aria-pressed="true"] { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); font-size: 11px; color: var(--vscode-descriptionForeground); }
details.disclosure { border-top: 1px solid var(--vscode-panel-border); }
details.disclosure summary { cursor: pointer; padding: 10px 14px; font-size: 12px; list-style: none; }
details.disclosure summary::-webkit-details-marker { display: none; }
details.disclosure summary::before { content: '▸'; display: inline-block; margin-right: 6px; transition: transform .1s; }
details.disclosure[open] summary::before { transform: rotate(90deg); }
details.disclosure pre { margin: 0 14px 12px; padding: 10px; border-radius: 6px; background: var(--vscode-textCodeBlock-background); overflow: auto; font-size: 12px; }
input[type="number"], input[type="text"], select { font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 4px 8px; }
#status { flex: none; min-height: 20px; color: var(--vscode-foreground); font-size: 12px; padding: 8px 32px; border-top: 1px solid var(--vscode-panel-border); }
[hidden] { display: none !important; }
@media (forced-colors: active) { .nav-item[aria-current="page"], button.primary, .segmented button[aria-pressed="true"], .tile[aria-pressed="true"] { forced-color-adjust: none; border: 1px solid Highlight; } }
@media (max-width: 640px) { .shell { flex-direction: column; } .nav { width: 100%; border-right: none; border-bottom: 1px solid var(--vscode-panel-border); } }

/* ---- MCP servers page (Settings plan, Phase 4) ---- */
textarea { font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 4px 8px; resize: vertical; width: 100%; }
textarea.mcp-masked { -webkit-text-security: disc; }
.mcp-hint { margin: 0 14px 12px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.mcp-hint.mcp-error { color: var(--vscode-errorForeground); }
.mcp-empty { margin: 0; padding: 14px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.mcp-row { flex-wrap: wrap; }
.mcp-differs { color: var(--vscode-descriptionForeground); font-style: italic; }
.mcp-lock { display: inline-flex; vertical-align: middle; margin-right: 2px; opacity: .75; }
.linklike { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); text-decoration: underline; font: inherit; }
.linklike:hover { color: var(--vscode-textLink-activeForeground); }
.mcp-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); font-size: 11px; background: transparent; color: var(--vscode-descriptionForeground); }
.mcp-chip[aria-checked="true"], .mcp-chip-on { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); background: var(--vscode-list-activeSelectionBackground); }
.mcp-chip-locked { opacity: .7; }
.mcp-caret { padding: 4px 6px; }
.mcp-details { flex-basis: 100%; border-top: 1px solid var(--vscode-panel-border); padding: 10px 0 4px; }
.mcp-details pre { margin: 0 0 8px; padding: 8px 10px; border-radius: 6px; background: var(--vscode-textCodeBlock-background); overflow: auto; font-size: 12px; }
.mcp-details-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; flex-wrap: wrap; }
.mcp-test-area { display: flex; align-items: center; gap: 8px; }
.mcp-test-result { font-size: 12px; color: var(--vscode-descriptionForeground); }
.mcp-test-result.mcp-error { color: var(--vscode-errorForeground); }
.mcp-confirm { display: flex; align-items: center; gap: 8px; font-size: 12px; }
details.mcp-add summary { list-style: none; padding: 12px 14px; cursor: pointer; }
details.mcp-add summary::-webkit-details-marker { display: none; }
details.mcp-add summary .row-title { display: block; }
details.mcp-add summary .row-desc { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.mcp-add-body { padding: 4px 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.mcp-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.mcp-field input, .mcp-field textarea { color: var(--vscode-input-foreground); font-size: 13px; }
.mcp-use-with { border: none; padding: 0; margin: 0; display: flex; gap: 16px; }
.mcp-use-with legend { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 0; margin-bottom: 4px; }
.mcp-show { font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 4px; }
.mcp-footer { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 4px 4px 0; }
/* ---- Connectors page (Phase 2): the .cards wrapper around one .group per
   agent, and the note under them. .group/.row/.chip/details.disclosure above
   already cover the card, row and "What Hydra wrote" styling. ---- */
.cards { display: flex; flex-direction: column; }
.connection-note { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.6; margin: 0 0 24px; }
`;
