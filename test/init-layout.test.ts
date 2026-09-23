/**
 * `graft init --layout global` and `--ignore exclude`: wiring Claude Code without
 * putting anything in the repo, and wiring it in the repo without anything to commit.
 * Driven through the real CLI with a scratch home, because both promises are about
 * which files land where.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A developer's shell may carry either switch (a Claude Code settings `env` block did),
// and runCli passes process.env through. These tests own the ignore mode.
delete process.env.GRAFT_NO_GITIGNORE;
delete process.env.GRAFT_IGNORE;
process.env.GRAFT_MCP_NPX = '1';

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { USER_SKILL_MARKER } from '../src/claude/skill-template.js';
import { ensureGitignored } from '../src/context/node-file.js';
import { gitExcludePath } from '../src/util/ignore.js';
import { readStamp } from '../src/upkeep.js';
import { runCli, tmpRepo } from './helpers.js';

const git = (d: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd: d,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });

function gitRepo(tag: string): string {
  const d = tmpRepo(tag);
  git(d, 'init', '-q', '-b', 'main');
  writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
  return d;
}

const skillOf = (home: string): string => join(home, '.claude', 'skills', 'graft', 'SKILL.md');

test('--layout global writes only under the home, and records the layout for replays', () => {
  const home = tmpRepo('layout-home');
  const repo = gitRepo('layout-repo');
  // With --ignore exclude, the combination that leaves the repo untouched in git terms.
  const res = runCli(['init', repo, '--no-build', '--agents', 'claude', '--layout', 'global', '--ignore', 'exclude'], { home });
  assert.equal(res.status, 0, res.describe());

  assert.equal(existsSync(join(repo, '.claude')), false, 'no repo .claude/');
  assert.equal(existsSync(join(repo, '.gitignore')), false, 'no .gitignore');
  assert.equal(existsSync(join(repo, '.mcp.json')), false, 'no repo .mcp.json');
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /graft-hooks\.cjs" prompt$/);
  assert.equal(settings.statusLine, undefined, 'no global statusline');
  assert.ok(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.graft);
  const skill = readFileSync(skillOf(home), 'utf8');
  assert.ok(skill.includes(USER_SKILL_MARKER));
  assert.match(skill, /Use in any repo that has a graft\/ directory/);
  assert.equal(readStamp(repo)?.opts?.layout, 'global');
  // graft/ exists (it holds the stamp) and is excluded, even with no build.
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/graft\/$/m);
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '?? a.ts\n', 'the repo shows only its own file');
});

test('--layout global never rewrites a user-level skill it does not own', () => {
  const home = tmpRepo('layout-own-skill');
  mkdirSync(join(home, '.claude', 'skills', 'graft'), { recursive: true });
  writeFileSync(skillOf(home), '---\nname: graft\ndescription: my own words\n---\n');
  const res = runCli(['init', gitRepo('layout-own'), '--no-build', '--agents', 'claude', '--layout', 'global'], { home });
  assert.equal(res.status, 0, res.describe());
  assert.match(res.stderr, /kept your own/);
  assert.equal(readFileSync(skillOf(home), 'utf8'), '---\nname: graft\ndescription: my own words\n---\n');
});

test('--layout global refreshes a skill graft wrote itself', () => {
  const home = tmpRepo('layout-owned-skill');
  mkdirSync(join(home, '.claude', 'skills', 'graft'), { recursive: true });
  writeFileSync(skillOf(home), `old text\n${USER_SKILL_MARKER}\n`);
  runCli(['init', gitRepo('layout-owned'), '--no-build', '--agents', 'claude', '--layout', 'global'], { home });
  assert.match(readFileSync(skillOf(home), 'utf8'), /graft ask/);
});

test('--ignore exclude: the repo layout leaves nothing to commit and no .gitignore change', () => {
  const home = tmpRepo('exclude-home');
  const repo = gitRepo('exclude-repo');
  const res = runCli(['init', repo, '--no-build', '--agents', 'claude', '--ignore', 'exclude'], { home });
  assert.equal(res.status, 0, res.describe());

  assert.ok(existsSync(join(repo, '.claude', 'settings.json')), 'the repo layout still writes its files');
  assert.equal(existsSync(join(repo, '.gitignore')), false, 'no .gitignore created');
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/\.graft\/$/m, 'the persisted config itself is excluded');
  assert.match(exclude, /^\/\.mcp\.json$/m);
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '?? a.ts\n');
  assert.equal(JSON.parse(readFileSync(join(repo, '.graft', 'config.json'), 'utf8')).ignore, 'exclude', 'remembered');
});

test('a later build in an exclude-mode repo keeps writing to the exclude file', () => {
  const repo = gitRepo('exclude-build');
  mkdirSync(join(repo, '.graft'), { recursive: true });
  writeFileSync(join(repo, '.graft', 'config.json'), JSON.stringify({ ignore: 'exclude' }));
  ensureGitignored(repo, join(repo, 'graft'));
  assert.equal(existsSync(join(repo, '.gitignore')), false);
  assert.match(readFileSync(gitExcludePath(repo)!, 'utf8'), /^\/graft\/$/m);
});

test('gitExcludePath follows a linked worktree to the shared git dir', () => {
  const repo = gitRepo('exclude-wt');
  git(repo, 'add', 'a.ts');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const wt = `${repo}-wt`;
  git(repo, 'worktree', 'add', '-q', wt);
  assert.equal(gitExcludePath(wt), join(repo, '.git', 'info', 'exclude'));
});

test('an unknown --layout or --ignore value exits 1 before writing', () => {
  const home = tmpRepo('layout-bad');
  const repo = gitRepo('layout-bad-repo');
  assert.equal(runCli(['init', repo, '--no-build', '--agents', 'claude', '--layout', 'nope'], { home }).status, 1);
  assert.equal(runCli(['init', repo, '--no-build', '--agents', 'claude', '--ignore', 'nope'], { home }).status, 1);
  assert.equal(existsSync(join(repo, '.claude')), false);
});
