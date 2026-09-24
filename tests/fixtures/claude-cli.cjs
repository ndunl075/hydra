// A local protocol fixture. Never contacts a model or reads provider credentials.
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (!args.length) {
  fs.writeFileSync('hydra-terminal-cwd.txt', process.cwd());
  setInterval(() => {}, 1000);
} else if (args[0] === '--version' || args[0] === '--help') {
  fs.appendFileSync('hydra-probes.jsonl', JSON.stringify(args) + '\n');
  console.log(args[0] === '--version' ? '2.1.270 (Claude Code)' : '--input-format stream-json --output-format stream-json --resume --permission-prompt-tool --permission-prompts');
} else if (args[0] === '-p') {
  const scenario = fs.existsSync('claude-scenario.json') ? JSON.parse(fs.readFileSync('claude-scenario.json', 'utf8')) : {};
  const emit = value => console.log(JSON.stringify(value));
  const sessionId = '12345678-1234-1234-1234-123456789abc';
  const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const requested = flag('--model') || 'claude-fixture-model';
  const canonical = requested === 'opus[1m]' ? 'claude-fixture-model' : requested;
  const applied = scenario.applied || { model: canonical, effort: flag('--effort') || 'xhigh' };
  let buffer = '', prompted = false, approvalPrompt;
  process.stdin.setEncoding('utf8');
  const finish = prompt => {
    if (prompt === 'noresult') { process.exit(0); return; }
    setTimeout(() => {
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'Hello ü', usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 }, total_cost_usd: 0.01, permission_denials: [{ tool_name: 'Edit' }] });
      if (prompt === 'badexit') process.exitCode = 7;
    }, 100);
  };
  const start = prompt => {
    if (prompted) throw new Error('Duplicate fixture turn'); prompted = true;
    fs.appendFileSync('requests.jsonl', JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\n');
    if (prompt.includes('HYDRA_DELEGATION_V1:')) prompt = prompt.split('\n\nHydra planning receipt: ')[0];
    emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: scenario.initModel || applied.model, permissionMode: 'default', claude_code_version: '2.1.270' });
    if (prompt === 'malformed') { console.log('not-json'); setInterval(() => {}, 1000); return; }
    emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Streaming ü' } } });
    if (prompt.startsWith('approve:')) {
      approvalPrompt = prompt;
      const request = { subtype: 'can_use_tool', tool_name: prompt.split(':')[1], tool_use_id: 'fixture-tool-id', input: { command: 'literal "$(keep)" ü', file_path: 'fixture.txt', content: 'fixture' }, permission_suggestions: [{ type: 'addRules', destination: 'userSettings' }], ...scenario.approval };
      emit({ type: 'control_request', request_id: 'fixture-approval', request });
      if (scenario.duplicateApproval) emit({ type: 'control_request', request_id: 'fixture-approval', request });
      if (scenario.cancelApproval) setTimeout(() => { emit({ type: 'control_cancel_request', request_id: 'fixture-approval' }); finish(prompt); }, 100);
      return;
    }
    if (prompt === 'hold') {
      cp.spawn(process.execPath, ['-e', "const fs=require('node:fs');setInterval(()=>fs.writeFileSync('heartbeat.txt',String(Date.now())),25)"], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
      return;
    }
    finish(prompt);
  };
  process.stdin.on('data', text => {
    buffer += text;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (message.type === 'control_request') {
        fs.appendFileSync('claude-controls.jsonl', JSON.stringify({ args, request: message.request }) + '\n');
        const subtype = message.request.subtype;
        const response = subtype === 'initialize' ? { current_permission_mode: scenario.permissionMode || 'default', account: { email: 'PRIVATE_ACCOUNT_MARKER' }, models: scenario.models || [{ value: 'claude-fixture-model', resolvedModel: 'claude-fixture-model', displayName: 'Claude fixture', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, { value: 'opus[1m]', resolvedModel: 'claude-fixture-model', displayName: 'Opus alias', supportsEffort: true, supportedEffortLevels: ['high', 'max'] }] } : subtype === 'get_settings' ? { applied, effective: { apiKeyHelper: 'PRIVATE_SETTINGS_MARKER' }, sources: [] } : subtype === 'get_binary_version' ? { version: scenario.version || '2.1.270' } : subtype === 'get_context_usage' && message.request.detail === 'summary' ? (scenario.contextUsage === 'malformed' ? { totalTokens: 'lots' } : { categories: [], totalTokens: 24000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 12, gridRows: [], model: 'claude-fixture-model', memoryFiles: [], mcpTools: [] }) : undefined;
        if (response === undefined) throw new Error('Unexpected mutation/control request');
        if (subtype === 'initialize' && scenario.sessionStartHooks) for (const sub of ['hook_started', 'hook_response']) emit({ type: 'system', subtype: sub, hook_id: 'fixture-hook', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', exit_code: 1, output: 'Error: Bun not found.' });
        if (subtype === 'initialize' && scenario.unexpectedEarlyEvent) emit({ type: 'system', subtype: 'status', status: 'fixture' });
        if (subtype === 'get_context_usage' && scenario.contextUsage === 'silent') return;
        if (subtype === 'get_context_usage' && scenario.contextUsage === 'rejected') { emit({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'unsupported' } }); return; }
        const reply = () => emit({ type: 'control_response', response: { subtype: 'success', request_id: scenario.badCorrelation ? 'unknown' : message.request_id, response } });
        if (scenario.delaySettings && subtype === 'get_settings') setTimeout(reply, 30000); else reply();
      } else if (message.type === 'user') start(message.message.content);
      else if (message.type === 'control_response') {
        fs.appendFileSync('claude-decisions.jsonl', JSON.stringify(message) + '\n');
        if (message.response.response.updatedPermissions) throw new Error('Persistent grant forbidden');
        finish(approvalPrompt);
      } else throw new Error('Unexpected fixture input');
    }
  });
  process.stdin.on('end', () => { if (!prompted && !scenario.delaySettings) process.exit(0); });
} else process.exitCode = 9;
