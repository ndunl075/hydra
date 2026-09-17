const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const threadId = '12345678-1234-7234-9234-123456789abc';
const turnId = 'aaaaaaaa-aaaa-7aaa-9aaa-aaaaaaaaaaaa';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => emit({ method, params });
let options = {};
try { options = JSON.parse(fs.readFileSync('fixture-options.json', 'utf8')); } catch {}
if (args.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(0); }
if (args.includes('--help')) { console.log('app-server generate-ts generate-json-schema --listen'); process.exit(0); }
if (!args.length) { fs.writeFileSync(path.join(process.cwd(), 'hydra-terminal-cwd.txt'), process.cwd()); setInterval(() => {}, 1000); }
else {
  let initialized = false, prompt = '', approval = false, holding = false;
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    const message = JSON.parse(line);
    fs.appendFileSync(path.join(process.cwd(), 'codex-requests.jsonl'), line + '\n');
    const reply = result => emit({ id: message.id, result });
    if (message.method === 'initialize') {
      if (message.params.capabilities.experimentalApi !== false) throw new Error('Unexpected experimental opt-in');
      reply({ userAgent: options.userAgent || 'hydra/0.154.0 (test)', platformFamily: 'test', platformOs: 'test' });
    } else if (message.method === 'initialized') initialized = true;
    else if (message.method === 'windowsSandbox/readiness') reply({ status: options.readiness || 'ready' });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      if (!initialized) throw new Error('Missing initialization handshake');
      const id = message.params.threadId || threadId;
      reply({ thread: { id: options.threadId || id, cliVersion: options.version || '0.154.0', cwd: process.cwd() }, cwd: options.cwd || process.cwd(), approvalPolicy: message.params.approvalPolicy, sandbox: { type: options.sandbox || 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false } });
    } else if (message.method === 'turn/start') {
      const params = message.params;
      if (params.threadId !== threadId || params.input[0].text_elements.length || params.cwd !== process.cwd() || params.sandboxPolicy.type !== 'workspaceWrite' || params.sandboxPolicy.writableRoots[0] !== process.cwd() || params.sandboxPolicy.networkAccess !== false) throw new Error('Invalid scoped turn');
      prompt = params.input[0].text;
      reply({ turn: { id: turnId, status: 'inProgress', items: [], error: null } });
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      notify('item/agentMessage/delta', { threadId: 'bbbbbbbb-bbbb-7bbb-9bbb-bbbbbbbbbbbb', turnId, itemId: 'other', delta: 'Never display a different thread' });
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'message', delta: 'Streaming ü' });
      if (prompt === 'malformed') { process.stdout.write('not-json\n'); holding = true; }
      else if (prompt === 'noresult') process.exit(0);
      else if (prompt === 'hold' || prompt === 'force-stop') {
        holding = true;
        if (prompt === 'force-stop') {
          const script = `const fs = require('node:fs'); setInterval(() => fs.appendFileSync('codex-heartbeat.txt', 'x'), 50);`;
          require('node:child_process').spawn(process.execPath, ['-e', script], { cwd: process.cwd(), stdio: 'ignore' });
        }
      } else if (prompt === 'approval' || prompt === 'decline' || prompt === 'network' || prompt === 'file' || prompt === 'file-no-details' || prompt === 'unsupported' || prompt === 'stale') {
        approval = true;
        const method = prompt.startsWith('file') ? 'item/fileChange/requestApproval' : prompt === 'unsupported' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval';
        if (prompt === 'file') notify('item/started', { threadId, turnId, item: { id: 'tool', type: 'fileChange', status: 'inProgress', changes: [{ path: 'example.txt', kind: { type: 'add' }, diff: '+proposed fixture content' }] } });
        emit({ id: 'server-request', method, params: { threadId, turnId: prompt === 'stale' ? 'bbbbbbbb-bbbb-7bbb-9bbb-bbbbbbbbbbbb' : turnId, itemId: 'tool', kind: 'command', command: 'echo literal $(data)', cwd: process.cwd(), reason: 'Fixture request', ...(prompt === 'network' ? { networkApprovalContext: { host: 'example.invalid', protocol: 'https' } } : {}) } });
      } else setTimeout(complete, 75);
    } else if (message.method === 'turn/interrupt') {
      if (prompt === 'force-stop') return;
      if (message.params.threadId !== threadId || message.params.turnId !== turnId) throw new Error('Interrupt targeted the wrong turn');
      holding = false; reply({});
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null } });
    } else if (message.id === 'server-request') {
      if (!approval) throw new Error('No pending approval');
      approval = false;
      fs.writeFileSync('approval-result.json', JSON.stringify(message));
      notify('serverRequest/resolved', { threadId, requestId: message.id });
      setTimeout(complete, 75);
    }
  });
  function complete() {
    notify('item/completed', { threadId, turnId, item: { id: 'message', type: 'agentMessage', text: 'Codex ü complete' } });
    const usage = { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3, cacheWriteInputTokens: 2 };
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: usage, total: usage } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: prompt === 'failed' ? 'failed' : 'completed', error: prompt === 'failed' ? { message: 'Fixture failure' } : null } });
    if (prompt === 'badexit') process.exit(7);
  }
  input.on('close', () => { if (!holding) process.exit(0); });
  setInterval(() => {}, 1000);
}
