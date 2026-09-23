/**
 * The home directory is never a repo.
 *
 * Every per-repo write graft makes lands under `<repo>/.claude/`, `<repo>/.mcp.json`,
 * `<repo>/.codex/`, … and at `$HOME` those ARE the user-level config files. So a
 * "repo" of `~` turns init's project writes into machine-wide ones: a hooks block
 * with no graph gate in `~/.claude/settings.json`, a rewritten
 * `~/.claude/skills/graft/SKILL.md`, a `~/.mcp.json`.
 *
 * It is also easy to reach by accident. An agent started from `~` boots `graft
 * mcp` with root `~`, and the upkeep that runs at boot asks `wiredHostIds(~)`,
 * which finds `~/.claude/helpers/graft-hooks.cjs` — the user-level shim that
 * `claude-global` installs — and reads that as "claude is wired in this repo".
 * Observed: the replay then wrote five duplicate hooks into the user settings,
 * and every tool call in every repo ran graft's hooks twice.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function isHomeDir(dir: string, home: string = homedir()): boolean {
  return canonical(dir) === canonical(home);
}
