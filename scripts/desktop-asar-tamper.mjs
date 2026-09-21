import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRawHeader, statFile } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.test-build', 'asar-compatibility');
const input = process.argv[2];
if (process.platform !== 'win32' || !input || !path.isAbsolute(input) || process.argv.length !== 3)
  throw new Error('Use on Windows with the absolute path to a disposable ASAR probe run.');

const run = await fs.realpath(input);
const scratchReal = await fs.realpath(scratch);
if (path.dirname(run).toLowerCase() !== scratchReal.toLowerCase() ||
    !/^run-[0-9a-f-]{36}$/i.test(path.basename(run)))
  throw new Error('Tamper target must be a direct disposable ASAR probe run.');
const report = JSON.parse(await fs.readFile(path.join(run, 'report.json'), 'utf8'));
const runtime = path.join(run, 'runtime');
if (report.output !== runtime || report.status !== 'diagnostic-blocked')
  throw new Error('Tamper target does not have the expected disposable probe report.');
const archive = path.join(runtime, 'resources', 'app.asar');
const archiveReal = await fs.realpath(archive);
if (archiveReal.toLowerCase() !== archive.toLowerCase())
  throw new Error('Archive path redirects outside the disposable runtime.');
const entrypoint = path.join('extensions', 'hydra-agent-manager', 'dist', 'extension.cjs');
const header = getRawHeader(archive);
const entry = statFile(archive, entrypoint);
if (entry.unpacked || !entry.integrity?.hash || entry.size < 200)
  throw new Error('Hydra entrypoint must be packed with an integrity hash.');
const backup = path.join(run, 'app.asar.before-tamper');
await fs.copyFile(archive, backup, fs.constants.COPYFILE_EXCL);
const byteOffset = 8 + header.headerSize + Number(entry.offset) + 100;
const handle = await fs.open(archive, 'r+');
try {
  const byte = Buffer.alloc(1);
  await handle.read(byte, 0, 1, byteOffset);
  byte[0] ^= 1;
  await handle.write(byte, 0, 1, byteOffset);
  await handle.sync();
} finally {
  await handle.close();
}
const record = { schemaVersion: 1, entrypoint, byteOffset,
  expectedEntrySha256: entry.integrity.hash, backup };
await fs.writeFile(path.join(run, 'tamper.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`Tampered only the disposable packed Hydra entrypoint: ${archive}`);
