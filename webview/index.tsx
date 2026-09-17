import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
declare function acquireVsCodeApi(): { postMessage(message: { type: string }): void };
const api = acquireVsCodeApi();
function App() {
  return <main className="app">
    <header className="topbar">
      <div className="wordmark"><span className="logo" aria-hidden="true">h</span>hydra<span className="build">PROTOTYPE</span></div>
      <div className="mode-switch" aria-label="Workspace mode"><button onClick={() => api.postMessage({ type: 'editor' })}>Editor</button><button className="current" aria-current="page">Agents</button></div>
    </header>
    <div className="workspace">
      <aside className="task-rail" aria-label="Tasks">
        <div className="rail-header"><h1>Tasks <span>0</span></h1></div>
        <div className="task-list"><p className="rail-empty">Your tasks will appear here.</p></div>
        <div className="rail-bottom"><span><span className="status-dot idle" />No active tasks</span></div>
      </aside>
      <section className="conversation" aria-label="Agent manager">
        <div className="conversation-header"><span>Agent manager</span><span>M0 · Mode toggle</span></div>
        <div className="new-task-body"><div className="eyebrow">EDITOR + AGENTS</div><h2>A place to manage the work.</h2><p className="intro">Move between your editor and agent workspace without closing your files or terminals.</p>
          <div className="milestone-lines"><div><span>01</span><p>Editor / Agents toggle <small>Available now</small></p><span className="available">Ready</span></div><div><span>02</span><p>Isolated worktrees + terminals <small>Next feature · M1</small></p></div><div><span>03</span><p>Conversation + review <small>Structured providers · M3 / M4</small></p></div></div>
          <p className="form-note">Use the status bar or <kbd>Ctrl + Alt + A</kbd> to switch modes. Your native editor and terminals stay available.</p>
        </div>
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
