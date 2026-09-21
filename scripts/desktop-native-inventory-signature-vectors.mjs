import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { parseInstalledInventory } from './desktop-installed-inventory.mjs';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Fixture output must be an absolute directory.');
await fs.mkdir(output, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest();
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = pair.publicKey.export({ format: 'jwk' });
const publicXY = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
if (publicXY.length !== 64) throw new Error('P-256 fixture public key is invalid.');
const hex = bytes => [...bytes].map(byte => `0x${byte.toString(16).padStart(2, '0')}`).join(', ');
await fs.writeFile(path.join(output, 'fixture-public-key.h'),
  `#pragma once\n#include <array>\ninline constexpr std::array<unsigned char, 64> fixture_public_key{ ${hex(publicXY)} };\n` +
  `inline constexpr std::array<unsigned char, 64> fixture_invalid_public_key{};\n`);

const inventory = {
  schemaVersion: 1, purpose: 'hydra-installed-code-inventory', product: 'Hydra', version: '0.22.0',
  target: { platform: 'win32', architecture: 'x64', installTarget: 'user' },
  layout: 'inno-user-unversioned-v1', sourceCommit: 'a'.repeat(40), upstreamCommit: 'b'.repeat(40),
  files: [{ path: 'Hydra.exe', bytes: 3, sha256: sha256(Buffer.from('app')).toString('hex') }]
};
const payload = Buffer.from(JSON.stringify(inventory));
parseInstalledInventory(payload);
const domain = Buffer.from('Hydra installed-code inventory signature v1\0');
const header = Buffer.concat([Buffer.from('HYDRINV1'), sha256(publicXY)]);
const preimage = (bytes, prefix = domain) => {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([prefix, header, length, bytes]);
};
const detached = (bytes, key = pair.privateKey, prefix = domain) =>
  Buffer.concat([header, sign('sha256', preimage(bytes, prefix), { key, dsaEncoding: 'ieee-p1363' })]);
const validRecord = detached(payload);
if (validRecord.length !== 104) throw new Error('Fixture detached record is invalid.');
const write = async (name, bytes) => fs.writeFile(path.join(output, name), bytes);
await write('valid.json', payload);
await write('valid.sig', validRecord);
await write('tampered.json', Buffer.from(payload.toString().replace('Hydra.exe', 'Hydrb.exe')));
await write('appended.json', Buffer.concat([payload, Buffer.from(' ')]));
await write('alternate.json', Buffer.from(JSON.stringify({ ...inventory, version: '0.23.0' })));
await write('wrong-key.sig', detached(payload, other.privateKey));
const wrongId = Buffer.from(validRecord);
wrongId[8] ^= 1;
await write('wrong-id.sig', wrongId);
const wrongSignature = Buffer.from(validRecord);
wrongSignature[40] ^= 1;
await write('wrong-signature.sig', wrongSignature);
await write('wrong-domain.sig', detached(payload, pair.privateKey, Buffer.from('Wrong inventory domain\0')));
await write('truncated.sig', validRecord.subarray(0, 103));
await write('overlong.sig', Buffer.concat([validRecord, Buffer.from([0])]));
const wrongFormat = Buffer.from(validRecord);
wrongFormat[0] ^= 1;
await write('wrong-format.sig', wrongFormat);
await write('der.sig', Buffer.concat([header, sign('sha256', preimage(payload), pair.privateKey)]));
await write('empty.json', Buffer.alloc(0));
await write('oversized.json', Buffer.alloc(4 * 1024 * 1024 + 1, 65));
const malformed = Buffer.from('{"malformed":true}');
try { parseInstalledInventory(malformed); throw new Error('Malformed inventory unexpectedly parsed.'); }
catch (error) { if (!/Installed inventory refused/.test(String(error))) throw error; }
await write('malformed.json', malformed);
await write('malformed.sig', detached(malformed));
console.log(`Generated ephemeral P-256 fixture vectors in ${output}`);
