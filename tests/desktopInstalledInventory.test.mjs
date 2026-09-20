import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { root, installerInventorySource } from '../scripts/desktop.mjs';
import { assertPinnedInnoFiles, innoFilesContract, createInstalledInventory,
  parseInstalledInventory, compareInventoryToInputs, compareInventoryToTree } from '../scripts/desktop-installed-inventory.mjs';

async function fixture(run) {
  const parent = path.join(root, '.test-build');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'installed-inventory-'));
  const sourceDirectory = path.join(directory, 'source');
  const installedDirectory = path.join(directory, 'installed');
  const stagedProductPath = path.join(directory, 'product.json');
  const innoSource = path.join(directory, 'code.iss');
  const sourceProduct = { nameShort: 'Hydra', applicationName: 'hydra', tunnelApplicationName: 'hydra-tunnel', hydraVersion: '0.22.0' };
  const write = async (file, content) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  try {
    await write(path.join(sourceDirectory, 'Hydra.exe'), 'signed executable');
    await write(path.join(sourceDirectory, 'Hydra.VisualElementsManifest.xml'), '<visual/>');
    await write(path.join(sourceDirectory, 'bin/hydra'), '#!/bin/sh');
    await write(path.join(sourceDirectory, 'bin/hydra.cmd'), '@echo off');
    await write(path.join(sourceDirectory, 'tools/HydraUpdateVerify.exe'), 'helper');
    await write(path.join(sourceDirectory, 'tools/inno_updater.exe'), 'updater');
    await write(path.join(sourceDirectory, 'tools/vcruntime140.dll'), 'runtime');
    await write(path.join(sourceDirectory, 'policies/workspace.json'), '{}');
    await write(path.join(sourceDirectory, 'resources/app/product.json'), JSON.stringify(sourceProduct));
    await write(path.join(sourceDirectory, 'resources/app/out/main.js'), 'main code');
    await write(path.join(sourceDirectory, 'resources/app/extensions/hydra/dist/extension.cjs'), 'agent code');
    await write(path.join(sourceDirectory, 'resources/app/out/media/logo.png'), 'image');
    await write(path.join(sourceDirectory, 'native.dll'), 'native code');
    await write(path.join(sourceDirectory, 'CodeSignSummary-build.md'), 'not installed');
    await write(stagedProductPath, JSON.stringify({ ...sourceProduct, target: 'user' }));
    await write(innoSource, `${innoFilesContract}\n\n[Code]\n`);
    const options = { sourceDirectory, stagedProductPath, innoSource, version: '0.22.0',
      sourceCommit: 'a'.repeat(40), upstreamCommit: 'b'.repeat(40) };
    await run({ directory, sourceDirectory, installedDirectory, stagedProductPath, innoSource, options, write });
  } finally {
    if (!directory.startsWith(parent + path.sep)) throw new Error('Unsafe inventory fixture cleanup.');
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('complete installer inputs produce a deterministic, strictly parsed inventory', async () => fixture(async ({ options }) => {
  const first = await createInstalledInventory(options);
  const second = await createInstalledInventory(options);
  assert.deepEqual(first, second);
  const paths = first.files.map(file => file.path);
  for (const required of ['Hydra.exe', 'tools/HydraUpdateVerify.exe', 'tools/inno_updater.exe',
    'tools/vcruntime140.dll', 'resources/app/out/main.js',
    'resources/app/extensions/hydra/dist/extension.cjs', 'resources/app/out/media/logo.png', 'native.dll'])
    assert.ok(paths.includes(required), required);
  assert.ok(!paths.includes('CodeSignSummary-build.md'));
  assert.equal(first.files.find(file => file.path === 'resources/app/product.json').bytes,
    Buffer.byteLength(JSON.stringify({ nameShort: 'Hydra', applicationName: 'hydra',
      tunnelApplicationName: 'hydra-tunnel', hydraVersion: '0.22.0', target: 'user' })));
  const saved = Buffer.from(JSON.stringify(first));
  assert.deepEqual(parseInstalledInventory(saved), first);
  await compareInventoryToInputs(saved, options);
  for (const changed of ['resources/app/out/main.js', 'native.dll',
    'resources/app/extensions/hydra/dist/extension.cjs', 'resources/app/out/media/logo.png']) {
    const item = first.files.find(file => file.path === changed);
    assert.ok(item && item.sha256);
  }
}));

test('changed installer inputs and installed payload bytes refuse', async () => fixture(async ({ options, sourceDirectory, installedDirectory, stagedProductPath, write }) => {
  const original = Buffer.from(JSON.stringify(await createInstalledInventory(options)));
  for (const name of ['resources/app/out/main.js', 'native.dll',
    'resources/app/extensions/hydra/dist/extension.cjs', 'resources/app/out/media/logo.png']) {
    const file = path.join(sourceDirectory, name);
    const saved = await fs.readFile(file);
    await fs.writeFile(file, 'tampered');
    await assert.rejects(compareInventoryToInputs(original, options), /differ/);
    await fs.writeFile(file, saved);
  }
  await fs.cp(sourceDirectory, installedDirectory, { recursive: true });
  await fs.rm(path.join(installedDirectory, 'CodeSignSummary-build.md'));
  await fs.copyFile(stagedProductPath, path.join(installedDirectory, 'resources/app/product.json'));
  await compareInventoryToTree(original, installedDirectory);
  await write(path.join(installedDirectory, 'resources/app/out/unexpected.js'), 'extra');
  await assert.rejects(compareInventoryToTree(original, installedDirectory), /count differs/);
  await fs.rm(path.join(installedDirectory, 'resources/app/out/unexpected.js'));
  await fs.rm(path.join(installedDirectory, 'native.dll'));
  await assert.rejects(compareInventoryToTree(original, installedDirectory), /count differs/);
}));

test('unsafe layouts, links, schema drift, and pinned Inno drift refuse', async () => fixture(async ({ options, sourceDirectory, stagedProductPath, innoSource, write }) => {
  const inventory = await createInstalledInventory(options);
  const duplicate = structuredClone(inventory);
  duplicate.files.splice(1, 0, { ...duplicate.files[0], path: duplicate.files[0].path.toLowerCase() });
  assert.throws(() => parseInstalledInventory(Buffer.from(JSON.stringify(duplicate))), /invalid/);
  const traversal = structuredClone(inventory);
  traversal.files[0].path = '../escape.exe';
  assert.throws(() => parseInstalledInventory(Buffer.from(JSON.stringify(traversal))), /unsafe/);
  for (const field of ['version', 'sourceCommit', 'upstreamCommit']) {
    const malformed = structuredClone(inventory);
    malformed[field] = [malformed[field]];
    assert.throws(() => parseInstalledInventory(Buffer.from(JSON.stringify(malformed))), /schema/);
  }
  await assert.rejects(createInstalledInventory({ ...options, sourceCommit: [options.sourceCommit] }), /provenance/);
  await write(innoSource, `${innoFilesContract.replace('tools\\*', 'tools\\**')}\n\n[Code]\n`);
  await assert.rejects(createInstalledInventory(options), /mapping changed/);
  await write(innoSource, `${innoFilesContract}\n\n[Code]\n`);
  const staged = JSON.parse(await fs.readFile(stagedProductPath, 'utf8'));
  await write(stagedProductPath, JSON.stringify({ ...staged, quality: 'stable' }));
  await assert.rejects(createInstalledInventory(options), /unsupported/);
  await write(stagedProductPath, JSON.stringify(staged));
  const file = path.join(sourceDirectory, 'native.dll');
  await fs.link(file, path.join(sourceDirectory, 'second-native.dll'));
  await assert.rejects(createInstalledInventory(options), /link count/);
}));

test('the pinned installer hook runs after product staging and refuses source drift', () => {
  const source = "fs.writeFileSync(productJsonPath, JSON.stringify(productJson, undefined, '\\t'));\n\t\tpackageInnoSetup(issPath, { definitions }, cb as (err?: Error | null) => void);";
  const pinned = 'b'.repeat(40);
  const inherited = process.env.BUILD_SOURCEVERSION;
  process.env.BUILD_SOURCEVERSION = 'c'.repeat(40);
  let patched;
  try { patched = installerInventorySource(source, 'C:/Hydra/scripts/desktop-installed-inventory.mjs', pinned); }
  finally {
    if (inherited === undefined) delete process.env.BUILD_SOURCEVERSION;
    else process.env.BUILD_SOURCEVERSION = inherited;
  }
  assert.ok(patched.indexOf('HydraInstalledInventory.json') > patched.indexOf('fs.writeFileSync(productJsonPath'));
  assert.ok(patched.indexOf('HydraInstalledInventory.json') < patched.indexOf('packageInnoSetup(issPath'));
  assert.match(patched, /--upstream-commit', "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/);
  assert.doesNotMatch(patched, /--upstream-commit', commit/);
  assert.throws(() => installerInventorySource(patched, 'C:/Hydra/scripts/desktop-installed-inventory.mjs', pinned), /hook changed/);
  assert.throws(() => installerInventorySource(source.replace('productJsonPath', 'wrongPath'), 'C:/Hydra/scripts/desktop-installed-inventory.mjs', pinned), /hook changed/);
  assert.doesNotThrow(() => assertPinnedInnoFiles(`${innoFilesContract}\n\n[Code]\n`));
});
