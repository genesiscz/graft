/**
 * Where graft records "do not commit this" for the files it writes into a repo.
 *
 *   gitignore  the repo's root `.gitignore` (the default, and the historical behavior)
 *   exclude    `.git/info/exclude`: the same effect, but local to this clone and
 *              never itself a change to commit. For a repo whose `.gitignore` you do
 *              not own, or where graft should leave no trace in `git status` at all.
 *   none       nothing; you handle it.
 *
 * Chosen by `GRAFT_IGNORE` (per process), else persisted by `graft init --ignore`
 * in `.graft/config.json`, else `gitignore`. `GRAFT_NO_GITIGNORE=1`, the older
 * switch, still means `none`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readBuildConfig } from './state.js';

export const IGNORE_MODES = ['gitignore', 'exclude', 'none'] as const;
export type IgnoreMode = (typeof IGNORE_MODES)[number];

export function isIgnoreMode(v: unknown): v is IgnoreMode {
  return typeof v === 'string' && (IGNORE_MODES as readonly string[]).includes(v);
}

function envTruthy(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

export function ignoreMode(root: string): IgnoreMode {
  const env = process.env.GRAFT_IGNORE;
  if (isIgnoreMode(env)) return env;
  if (envTruthy('GRAFT_NO_GITIGNORE')) return 'none';
  const persisted = readBuildConfig(root)?.ignore;
  return isIgnoreMode(persisted) ? persisted : 'gitignore';
}

/**
 * `<common git dir>/info/exclude` for the repo holding `root`, or null outside git.
 * Read from disk rather than asked of `git`: this runs inside every build. A linked
 * worktree's `.git` is a `gitdir:` pointer whose `commondir` names the shared git
 * dir, and the exclude file there covers every worktree of the repo.
 */
export function gitExcludePath(root: string): string | null {
  let dir = resolve(root);
  for (;;) {
    const dot = join(dir, '.git');
    if (existsSync(dot)) {
      try {
        if (statSync(dot).isDirectory()) return join(dot, 'info', 'exclude');
        const line = readFileSync(dot, 'utf8').split('\n').find((l) => l.startsWith('gitdir:'));
        if (!line) return null;
        const target = line.slice('gitdir:'.length).trim();
        const gitdir = isAbsolute(target) ? target : resolve(dir, target);
        let common = gitdir;
        try { common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
        return join(common, 'info', 'exclude');
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Add one root-anchored pattern for `rel` (a repo-relative path, `graft` or
 * `.mcp.json`) to the file the mode selects, unless an equivalent is already there.
 * `dir` makes it `/rel/`; the unanchored and slashless forms count as present, so an
 * existing hand-written entry is never doubled. Best-effort, never throws: a build or
 * an init that already succeeded must not fail over an ignore line.
 */
export function ensureIgnored(root: string, rel: string, opts: { note: string; dir?: boolean; secret?: boolean }): void {
  // `secret`: a path that holds a credential is never left to chance. In `none` mode
  // it still goes to the local exclude file, which commits nothing either.
  let mode = ignoreMode(root);
  if (mode === 'none' && opts.secret) mode = 'exclude';
  if (mode === 'none') return;
  const path = mode === 'exclude' ? gitExcludePath(root) : join(root, '.gitignore');
  if (!path) return;
  const bare = rel.replace(/^\/+/, '').replace(/\/+$/, '');
  const entry = opts.dir ? `/${bare}/` : `/${bare}`;
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { /* none yet — we create it */ }
  const present = current.split('\n').some((l) => {
    const t = l.trim();
    return t === entry || t === `/${bare}` || t === `${bare}/` || t === bare;
  });
  if (present) return;
  const gap = current === '' ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${current}${gap}# ${opts.note}\n${entry}\n`);
  } catch { /* best-effort */ }
}
