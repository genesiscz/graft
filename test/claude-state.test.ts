import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyStats, readStats, writeStats, patchStats,
  readSession, writeSession, acquireLock, releaseLock, cacheDir, LOCK_STALE_MS, writeJsonAtomic,
} from '../src/claude/state.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-state-')); }

test('stats round-trip and patch merge', () => {
  const d = fresh();
  assert.equal(readStats(d), null);
  writeStats(d, { ...emptyStats(), nodeCount: 319, edgeCount: 730 });
  assert.equal(readStats(d)!.nodeCount, 319);
  const patched = patchStats(d, { dirty: true, staleCount: 4 });
  assert.equal(patched.dirty, true);
  assert.equal(patched.staleCount, 4);
  assert.equal(readStats(d)!.edgeCount, 730, 'patch preserves other fields');
});

test('session defaults and round-trip', () => {
  const d = fresh();
  const s = readSession(d, 'abc');
  assert.deepEqual(s, { lastQuery: null, perAgentQuery: {}, graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [], nudges: 0 });
  s.lastQuery = 'pkce'; s.graftReads = 2;
  writeSession(d, 'abc', s);
  assert.equal(readSession(d, 'abc').lastQuery, 'pkce');
  assert.equal(readSession(d, 'xyz').graftReads, 0, 'other sessions isolated');
});

test('lock is exclusive then releasable', () => {
  const d = fresh();
  assert.equal(acquireLock(d), true);
  assert.equal(acquireLock(d), false, 'second acquire blocked while held');
  assert.ok(existsSync(join(cacheDir(d), '.sync.lock')));
  releaseLock(d);
  assert.equal(acquireLock(d), true, 'reacquire after release');
});

test('acquireLock reclaims a stale lock', () => {
  const d = fresh();
  assert.equal(acquireLock(d), true);
  const p = join(cacheDir(d), '.sync.lock');
  const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
  utimesSync(p, old, old);
  assert.equal(acquireLock(d), true, 'stale lock reclaimed');
});

/**
 * The lock names its pid. A holder dies without unwinding all the time — the host's
 * hard kill at a hook budget, a session closing over a detached sync — and until now
 * nothing could tell that file from a live rebuild for LOCK_STALE_MS: five minutes in
 * which every query answered stale and the background sync stood down.
 */
test('acquireLock reclaims a lock whose owner is dead, without waiting', () => {
  const d = fresh();
  mkdirSync(cacheDir(d), { recursive: true });
  // A pid that existed a moment ago and is gone now, exactly what a killed holder
  // leaves behind. A short-lived child is the honest way to get one.
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const p = join(cacheDir(d), '.sync.lock');
  writeFileSync(p, JSON.stringify({ pid: dead, at: new Date().toISOString() }));
  assert.equal(acquireLock(d), true, 'a dead owner does not hold the lock');
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).pid, process.pid, 'and it is ours now');
});

test('acquireLock honours a fresh lock held by a live process that is not us', () => {
  const d = fresh();
  mkdirSync(cacheDir(d), { recursive: true });
  const p = join(cacheDir(d), '.sync.lock');
  // The parent of this test process is alive for as long as we are.
  writeFileSync(p, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
  assert.equal(acquireLock(d), false, 'a live owner keeps the lock');
});

test('writeJsonAtomic leaves no scratch file behind when the write fails', () => {
  const d = fresh();
  const dir = join(d, 'locked');
  mkdirSync(dir, { recursive: true });

  // The failure is injected by putting a *directory* where the file belongs, so the
  // rename fails. This replaces a read-only parent dir (`chmod 0o500`), which was
  // both non-portable — Windows ignores it, and so does root, hence the skip this
  // test used to carry — and weaker: the tmp file was never created there, so there
  // was never anything that could have been left behind. Here it definitely is.
  const target = join(dir, 'out.json');
  mkdirSync(target);

  // Every CLI invocation is a new pid, so a repeatedly failing write would leave one
  // full-size `<path>.<pid>.tmp` per attempt, and nothing in graft ever lists these
  // directories to clean them up — on a nearly-full disk that accelerates the ENOSPC
  // that caused it.
  assert.throws(() => writeJsonAtomic(target, { pad: 'x'.repeat(1024) }));
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
    'no .tmp residue',
  );
});
