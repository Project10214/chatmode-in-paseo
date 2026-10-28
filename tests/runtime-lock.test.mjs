import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, inspectLock } from '../server/runtime.mjs';

// One teardown hook per test, closing runtimes before the directory is removed:
// the store flushes on close, so removing the directory first would fail the flush.
async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cip-lock-'));
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes.reverse()) await runtime.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, track: runtime => { runtimes.push(runtime); return runtime; } };
}
async function openRuntime(space) {
  return space.track(await createRuntime({ directory: space.directory, port: 0 }));
}
function spawnChild(code = 'setTimeout(() => {}, 60000)') {
  return spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
}
async function childPid(t, code) {
  const child = spawnChild(code);
  t.after(() => child.kill('SIGKILL'));
  await new Promise(resolve => child.once('spawn', resolve));
  return child;
}
async function waitExit(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => child.once('exit', resolve));
}

test('a fresh runtime writes an identifying lock and removes it on close', async t => {
  const space = await workspace(t); const directory = space.directory;
  const runtime = await openRuntime(space);
  const lock = JSON.parse(await readFile(path.join(directory, 'runtime.lock'), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.hostname, os.hostname());
  assert.match(lock.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(lock.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  await runtime.close();
  await assert.rejects(readFile(path.join(directory, 'runtime.lock'), 'utf8'), /ENOENT/);
});

test('a lock left by a dead process is reclaimed and parked, never silently dropped', async t => {
  const space = await workspace(t); const directory = space.directory;
  const dead = spawnChild('process.exit(0)');
  await waitExit(dead);
  await writeFile(path.join(directory, 'runtime.lock'), JSON.stringify({ pid: dead.pid, hostname: os.hostname(), at: new Date().toISOString() }), { mode: 0o600 });
  assert.equal((await inspectLock(path.join(directory, 'runtime.lock'))).reason, 'holder-gone');
  await openRuntime(space);
  const names = await readdir(directory);
  assert.ok(names.some(name => name.startsWith(`runtime.lock.stale-${dead.pid}-`)), 'stale lock should be parked');
  assert.match(await readFile(path.join(directory, 'runtime.lock.recovered.log'), 'utf8'), /holder-gone/);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'runtime.lock'), 'utf8')).pid, process.pid);
});

test('an unreadable lock file does not wedge startup', async t => {
  const space = await workspace(t); const directory = space.directory;
  await writeFile(path.join(directory, 'runtime.lock'), '', { mode: 0o600 });
  await openRuntime(space);
  assert.equal((await readdir(directory)).some(name => name.startsWith('runtime.lock.stale-unknown-')), true);
});

test('a live holder is never displaced', async t => {
  const space = await workspace(t); const directory = space.directory;
  const holder = await childPid(t);
  const original = JSON.stringify({ pid: holder.pid, hostname: os.hostname(), at: new Date().toISOString() });
  await writeFile(path.join(directory, 'runtime.lock'), original, { mode: 0o600 });
  await assert.rejects(createRuntime({ directory, port: 0 }), /RUNTIME_LOCKED/);
  assert.equal(await readFile(path.join(directory, 'runtime.lock'), 'utf8'), original, 'lock must stay untouched');
  assert.equal((await readdir(directory)).some(name => name.startsWith('runtime.lock.stale')), false);
});

test('the same process cannot open the state directory twice', async t => {
  const space = await workspace(t); const directory = space.directory;
  await openRuntime(space);
  assert.equal((await inspectLock(path.join(directory, 'runtime.lock'))).reason, 'same-process');
  await assert.rejects(createRuntime({ directory, port: 0 }), /RUNTIME_LOCKED/);
});

test('a recycled pid is recognised by start time and reclaimed', async t => {
  const space = await workspace(t); const directory = space.directory;
  const recycled = await childPid(t);
  const writtenAt = new Date(Date.now() - 3600_000).toISOString();
  await writeFile(path.join(directory, 'runtime.lock'), JSON.stringify({ pid: recycled.pid, hostname: os.hostname(), at: writtenAt }), { mode: 0o600 });
  assert.equal((await inspectLock(path.join(directory, 'runtime.lock'))).reason, 'pid-reused');
  await openRuntime(space);
  assert.equal((await readdir(directory)).some(name => name.startsWith(`runtime.lock.stale-${recycled.pid}-`)), true);
});

test('recent parked locks are kept, week-old surplus beyond the newest ten is pruned', async t => {
  const space = await workspace(t); const directory = space.directory;
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  for (let i = 0; i < 12; i++) {
    const file = path.join(directory, `runtime.lock.stale-${1000 + i}-${i}`);
    await writeFile(file, '{}', { mode: 0o600 });
    await utimes(file, old, old);
  }
  await openRuntime(space);
  await new Promise(resolve => setTimeout(resolve, 200));
  const parked = (await readdir(directory)).filter(name => name.startsWith('runtime.lock.stale-'));
  assert.ok(parked.length >= 10, `newest ten are kept, got ${parked.length}`);
  assert.ok(parked.length < 12, 'week-old surplus is pruned');
});

test('a stale lock file alone is enough for the plugin to recover without a reload', async t => {
  const space = await workspace(t); const directory = space.directory;
  const holder = await childPid(t);
  await writeFile(path.join(directory, 'runtime.lock'), JSON.stringify({ pid: holder.pid, hostname: os.hostname(), at: new Date().toISOString() }), { mode: 0o600 });
  process.env.CIP_STATE_DIR = directory; process.env.CIP_PORT = '0';
  register('./ts-resolve-hooks.mjs', import.meta.url);
  const { default: contribute } = await import('../index.server.ts');
  let provider;
  const stop = contribute({ before: () => () => {}, on: () => () => {}, registerProvider: value => { provider = value; }, handle: () => {} });
  space.track({ close: stop });
  const blocked = await provider.status();
  assert.equal(blocked.available, false);
  assert.match(blocked.diagnostic, /RUNTIME_LOCKED/);
  // The holder dies as a crashed daemon would; no plugin reload happens here.
  holder.kill('SIGKILL'); await waitExit(holder);
  await new Promise(resolve => setTimeout(resolve, 3200));
  const recovered = await provider.status();
  assert.equal(/RUNTIME_LOCKED/.test(recovered.diagnostic ?? ''), false, `still locked: ${recovered.diagnostic}`);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'runtime.lock'), 'utf8')).pid, process.pid);
});
