// A local Claude CLI fixture for the smoke test: version/help probes only.
// Never contacts a model or reads provider credentials.
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '--help') {
  fs.appendFileSync('hydra-probes.jsonl', JSON.stringify(args) + '\n');
  console.log(args[0] === '--version' ? '2.1.270 (Claude Code)' : '--input-format stream-json --output-format stream-json --resume --permission-prompt-tool --permission-prompts');
} else { console.error('Unsupported fixture invocation'); process.exit(2); }
