import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('delivery check scans staged bytes and never prints matching secret values', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'head-secrets-'));
  const script = fileURLToPath(new URL('../scripts/check_secrets.mjs', import.meta.url));
  const secret = ['private', 'fixture', 'credential', 'only'].join('-');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init');
    await writeFile(path.join(dir, 'config.example.yaml'), 'regions: {}\n');
    git('add', 'config.example.yaml');
    assert.equal(run().status, 0);
    await writeFile(path.join(dir, 'config.local.yaml'), `regions:\n  cn:\n    api_key: ${secret}\n`);
    await writeFile(path.join(dir, 'payload.bin'), Buffer.from(`bytes:${secret}:end`));
    git('add', 'payload.bin');
    // Clean working copy must not hide a secret already staged in the index.
    await writeFile(path.join(dir, 'payload.bin'), 'clean working copy');
    const result = run('--secrets-from', path.join(dir, 'config.local.yaml'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /known credential/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    git('add', 'payload.bin', 'config.local.yaml');
    const denied = run();
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /forbidden delivery path/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
