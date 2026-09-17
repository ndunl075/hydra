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
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', text => { prompt += text; });
  process.stdin.on('end', () => {
    fs.appendFileSync('requests.jsonl', JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\n');
    const emit = value => console.log(JSON.stringify(value));
    const sessionId = '12345678-1234-1234-1234-123456789abc';
    emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), permissionMode: 'default', claude_code_version: '2.1.270' });
    if (prompt === 'malformed') { console.log('not-json'); setInterval(() => {}, 1000); return; }
    emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Streaming ü' } } });
    if (prompt === 'hold') {
      cp.spawn(process.execPath, ['-e', "const fs=require('node:fs');setInterval(()=>fs.writeFileSync('heartbeat.txt',String(Date.now())),25)"], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
      return;
    }
    if (prompt === 'noresult') return;
    setTimeout(() => {
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'Hello ü', usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 }, total_cost_usd: 0.01, permission_denials: [{ tool_name: 'Edit' }] });
      if (prompt === 'badexit') process.exitCode = 7;
    }, 100);
  });
} else process.exitCode = 9;
