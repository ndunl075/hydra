import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatArgsText, formatEnvText, formatHeadersText, mcpAgentLabel,
  parseArgsText, parseEnvText, parseHeadersText, parseLines, summarizeSpec,
} from '../src/settings/pages/mcpServersHelpers';
import type { McpServerSpec } from '../src/core/mcpServers';

test('parseLines trims and drops blank lines', () => {
  assert.deepEqual(parseLines('  a  \n\n b\r\n\n\nc\n'), ['a', 'b', 'c']);
  assert.deepEqual(parseLines(''), []);
  assert.deepEqual(parseLines('   \n  \n'), []);
});

test('parseArgsText/formatArgsText round-trip one argument per line', () => {
  const text = '--root\nC:\\work ünï\nfoo bar\n';
  const args = parseArgsText(text);
  assert.deepEqual(args, ['--root', 'C:\\work ünï', 'foo bar']);
  assert.equal(formatArgsText(args), '--root\nC:\\work ünï\nfoo bar');
  assert.deepEqual(parseArgsText(''), []);
});

test('parseEnvText parses KEY=VALUE, keeps everything after the first "=", and flags bad lines', () => {
  const parsed = parseEnvText('API_TOKEN=sk-abc=def\nPLAIN=hello\n');
  assert.deepEqual(parsed, { values: { API_TOKEN: 'sk-abc=def', PLAIN: 'hello' }, errors: [] });
  const bad = parseEnvText('nope\n1BAD=x\n=novalue\nOK=1');
  assert.deepEqual(bad.values, { OK: '1' });
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors[0]!, /Line 1.*KEY=VALUE/);
  assert.match(bad.errors[1]!, /Line 2.*1BAD/);
});
test('formatEnvText renders KEY=VALUE per line', () => {
  assert.equal(formatEnvText({ A: '1', B: 'two' }), 'A=1\nB=two');
  assert.equal(formatEnvText({}), '');
});

test('parseHeadersText parses "Name: value", trims the value, and flags bad lines', () => {
  const parsed = parseHeadersText('Authorization: Bearer abc\nX-Region:eu\n');
  assert.deepEqual(parsed, { values: { Authorization: 'Bearer abc', 'X-Region': 'eu' }, errors: [] });
  const bad = parseHeadersText('no-colon-here\n: novalue\nX-Ok: 1');
  assert.deepEqual(bad.values, { 'X-Ok': '1' });
  assert.equal(bad.errors.length, 2);
});
test('formatHeadersText renders "Name: value" per line', () => {
  assert.equal(formatHeadersText({ Authorization: 'Bearer abc', 'X-Region': 'eu' }), 'Authorization: Bearer abc\nX-Region: eu');
});

test('summarizeSpec: stdio joins command and args, http shows the URL', () => {
  const stdio: McpServerSpec = { type: 'stdio', command: 'npx', args: ['-y', '@scope/server', '--flag'], env: {} };
  assert.equal(summarizeSpec(stdio), 'npx -y @scope/server --flag');
  const http: McpServerSpec = { type: 'http', url: 'https://mcp.example.com/mcp', headers: {} };
  assert.equal(summarizeSpec(http), 'https://mcp.example.com/mcp');
});
test('summarizeSpec truncates long text with an ellipsis', () => {
  const stdio: McpServerSpec = { type: 'stdio', command: 'x'.repeat(200), args: [], env: {} };
  const summary = summarizeSpec(stdio, 50);
  assert.equal(summary.length, 50);
  assert.ok(summary.endsWith('…'));
});

test('mcpAgentLabel', () => {
  assert.equal(mcpAgentLabel('claude'), 'Claude Code');
  assert.equal(mcpAgentLabel('codex'), 'Codex');
});
