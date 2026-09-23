import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isClean, probeDrift } from '../graph/fingerprint.js';
import { readWiring, computeStats } from './stats.js';
import { acquireLock, patchStats, readStats, releaseLock, resolveContextDir } from './state.js';
import { graftCliPath } from './paths.js';

/** MONEY GUARD: plain `graft build` only — structural, $0, offline. Never --deep. */
function realBuild(dir: string): void {
  // GRAFT_TEST_CLI is the same seam hooks.ts's graftJson uses, so a test can
  // point this at a stub and inspect the exact argv it was invoked with.
  const cliPath = process.env.GRAFT_TEST_CLI ?? graftCliPath();
  const args = [cliPath, 'build', '.'];
  // Mirrors `withContextDirArg` in hooks.ts: a no-op unless GRAFT_DIR is set, so an
  // unconfigured repo's rebuild sees byte-identical argv to before this existed.
  if (process.env.GRAFT_DIR) args.push('--dir', resolveContextDir(dir));
  execFileSync(process.execPath, args, { cwd: dir, stdio: 'ignore', timeout: 120000 });
}

/**
 * Is there anything to rebuild? `dirty` is the agent's own edits, set by the
 * post-edit hook. The probe catches everything else — a branch switch, an editor
 * save, a `git pull` — which sets no flag and used to be repaired only by a query's
 * inline refresh. No hook refreshes inline any more (a rebuild has no place inside a
 * budget of seconds), so this detached process is where that drift gets fixed. A
 * missing fingerprint is a graph from before probes existed: build once, it lays one
 * down.
 */
function needsBuild(dir: string): boolean {
  if (readStats(dir)?.dirty) return true;
  const drift = probeDrift(dir, resolveContextDir(dir));
  return drift === null || !isClean(drift);
}

export function runSync(dir: string, build: (d: string) => void = realBuild): void {
  // Never a repo's first build: that is the user's own `graft build`, opted into.
  if (!existsSync(resolveContextDir(dir))) return;
  // Under this process's pid, so a lock it leaves behind is reclaimed the moment it
  // is gone (`acquireLockIn`). A refusal means another sync, or a query's refresh,
  // holds it and will fix the same drift: nothing to wait for.
  if (!acquireLock(dir)) return;
  try {
    if (!needsBuild(dir)) return;
    patchStats(dir, { syncing: true });
    build(dir);
    const w = readWiring(dir);
    if (!w) { patchStats(dir, { syncing: false }); return; } // build ran but output unreadable — stay dirty, retry
    patchStats(dir, {
      dirty: false, staleCount: 0, syncing: false, syncedAt: new Date().toISOString(),
      ...computeStats(w),
    });
  } catch {
    patchStats(dir, { syncing: false }); // leave dirty=true; retry next turn
  } finally {
    releaseLock(dir);
  }
}

export function main(): void {
  const dir = process.argv[2];
  if (dir) runSync(dir);
}

// Run only when executed directly (node dist/claude/sync-run.js <dir>), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
