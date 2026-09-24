// Entry point for dist/hydra-mcp.cjs, the stdio MCP bridge that Claude Code and
// Codex start (run by Hydra's own executable with ELECTRON_RUN_AS_NODE=1).
import { runBridgeOnStdio } from './core/mcpBridge';

declare const HYDRA_VERSION: string;
runBridgeOnStdio({ env: process.env, cwd: process.cwd(), version: typeof HYDRA_VERSION === 'string' ? HYDRA_VERSION : '0.0.0' });
