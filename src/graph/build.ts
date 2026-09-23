/**
 * `graph` — build `.context/graph.json` from a code repository.
 *
 * M1 pipeline (Tier-1 only, deterministic, no LLM):
 *   1. Walk the repo for TS/Python source files.
 *   2. Parse each with tree-sitter and emit one NodeV1 per definition.
 *   3. Write a sorted graph.json.
 * Edges (M2) and LLM summary/crux (M3) layer onto this without changing it.
 *
 * Step 2 is memoized per file (`extract-cache.ts`): a file whose bytes haven't
 * moved replays its last parse instead of re-running tree-sitter, so a rebuild
 * costs ~the files that changed. Everything after extraction still runs over the
 * whole node set, so an incremental build's output is byte-identical to a cold
 * one — the invariant `test/graph-incremental.test.ts` pins down.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { walkDir } from "../ingest/fs.js";
import { contextDirFor, ensureGitignored, ensureSearchable } from "../context/node-file.js";
import { extractFile, languageLabelOf, languageOf, type Language, type RawEdge } from "./extract.js";
import { extractGeneric, genericLangOf, warmGenericGrammars } from "./generic.js";
import { containerLangOf, extractContainer, warmContainerGrammars } from "./container.js";
import { parseInPool, poolEnabled, type ParseOutcome } from "./parse-pool.js";
import { contentHash } from "../util/id.js";
import { relPosix } from "../util/paths.js";
import { readSourceFile } from "../util/source.js";
import { readFollowNestedRepos, readFollowSubmodules, readIncludeDirs } from "../util/state.js";
import {
  emptyExtractCache,
  readExtractCache,
  writeExtractCache,
  type ExtractEntry,
} from "./extract-cache.js";
import { writeFingerprint } from "./fingerprint.js";
import { seedGraph, type SeedResult } from "./seed.js";
import { filterByOnlyDirs, listSourceStats } from "./source-files.js";
import { resolveEdges, type GoModule } from "./resolve.js";
import { enrichGraph, type EnrichStats } from "./enrich.js";
import { readGraph, writeGraph, wiringPath } from "./write.js";
import { writeCards, writeIndex, writeCovers, type CardStats } from "./cards.js";
import { writeAskIndex } from "../ask/index-file.js";
import { discoverScopes, scopeOf } from "./scopes.js";
import type { GraphV1, Kind, NodeV1, Relation, ScopeV1 } from "./types.js";
import type { CruxSummarizer } from "../ai/crux.js";

export { listSourceFiles } from "./source-files.js";

/** Minimum non-file node count for a discovered sub-scope to stand on its own
 * (over-split guard 3). A scope with fewer nodes than this is folded into the
 * root scope — node counts aren't known until after the graph is assembled,
 * so this runs here rather than in `discoverScopes`. */
const MIN_SCOPE_NODES = 5;

/** Guard 5: merge scopes with too few non-file nodes into the root scope, then
 * re-apply the canonical single-scope collapse (rule 6) if only root is left. */
function applyMinSubstanceGuard(scopes: ScopeV1[], nodes: NodeV1[]): ScopeV1[] {
  if (scopes.length <= 1) return scopes;
  const counts = new Map<string, number>();
  for (const scope of scopes) counts.set(scope.prefix, 0);
  for (const node of nodes) {
    if (node.kind === "file") continue;
    const scope = scopeOf(node.path, scopes);
    counts.set(scope.prefix, (counts.get(scope.prefix) ?? 0) + 1);
  }
  const kept = scopes.filter((s) => s.prefix === "" || (counts.get(s.prefix) ?? 0) >= MIN_SCOPE_NODES);
  if (kept.length === 0) return [{ prefix: "", label: "", markers: [] }];
  if (kept.length === 1 && kept[0].prefix === "") {
    return [{ prefix: "", label: "", markers: kept[0].markers }];
  }
  return kept;
}

export interface GraphBuildOptions {
  /** Override the output dir (default: `<root>/.context`). */
  contextDir?: string;
  /** Replay unchanged files from the extraction cache instead of re-parsing them
   * (default true). False forces a cold parse of the whole repo. */
  reuse?: boolean;
  /** Write only what a query reads — the graph, the `ask` sidecar, the freshness
   * record — and skip the markdown projections and the `.gitignore` touch. Set by
   * the pre-query refresh (`graph/refresh.ts`); an explicit `graft build` never
   * sets it. See the write block in {@link buildGraph} for why the split exists. */
  graphOnly?: boolean;
  /** Opt-in compiler-grade edge enrichment via a language server (`graft build
   * --lsp`): adds `lsp_resolved` call edges the AST resolver couldn't (member
   * calls, breadth-tier calls). Off by default — needs a server on PATH and is
   * slower; the graph is fully functional without it. */
  lsp?: boolean;
  /** Run the Tier-2 LLM meaning pass. Absent → Tier-1 only (cache is still preserved). */
  summarizer?: CruxSummarizer;
  /** Max files summarized in parallel during the Tier-2 pass. Default is set in enrich. */
  concurrency?: number;
  /** Repo-relative directory prefixes to limit the build to (`--only-dir`). When
   * set, only files under these prefixes are indexed; the list is recorded in the
   * fingerprint so the freshness probe enumerates the same set. */
  onlyDirs?: string[];
  onProgress?: (info: {
    /** `read` walks every file to hash it and decide replay-vs-parse; `parse` is the
     * extraction that follows, which may run across worker threads (see parse-pool).
     * They are reported separately because a single "parsing" counter that completes
     * during the read pass would sit at N/N for the whole of the actual parse. */
    phase: "read" | "parse" | "enrich";
    index: number;
    total: number;
    file: string;
  }) => void;
}

export interface GraphBuildResult {
  contextDir: string;
  graphPath: string;
  /** Per-file wiring cards written (Tier-2 passive surface). */
  cards: number;
  files: number;
  /** Files re-parsed this run (the rest were replayed from the extraction cache). */
  parsed: number;
  /** Files replayed from the extraction cache. */
  reused: number;
  /** The parent checkout this build copied a starting graph from, when it was run in
   * a git worktree that had none of its own. See `./seed.ts`. */
  seededFrom?: string;
  nodes: number;
  edges: number;
  byKind: Record<Kind, number>;
  byRelation: Record<Relation, number>;
  languages: string[];
  meaning: EnrichStats;
  errors: string[];
}

/** Every Go module in the repo: each `go.mod`'s declared `module` path and the repo
 * directory it lives in (posix, `.` for the root). Found anywhere in the tree, so a
 * monorepo whose module is in a subdir (e.g. `backend/go.mod`) resolves too. Lets edge
 * resolution map Go import paths to in-repo files.
 *
 * `repoFiles` is buildGraph's single enumeration, which already carries root's
 * persisted `--include-dir` override — so a `go.mod` living under an included
 * dir (e.g. `build/go.mod`) is found here exactly when its `.go` files are
 * indexed, and its intra-module imports resolve. */
function readGoModules(root: string, repoFiles: string[]): GoModule[] {
  const mods: GoModule[] = [];
  for (const f of repoFiles) {
    if (basename(f) !== "go.mod") continue;
    try {
      const m = readFileSync(f, "utf8").match(/^\s*module\s+(\S+)/m);
      if (!m) continue;
      const rel = relPosix(root, dirname(f));
      mods.push({ module: m[1], dir: rel === "" ? "." : rel });
    } catch {
      /* unreadable go.mod — skip this module */
    }
  }
  return mods;
}

/** Depth-tier extraction with the failure recorded rather than thrown — the shape
 * both the in-thread path and the pool's fallback need. */
function extractOrError(
  rel: string,
  source: string,
  lang: Language,
): { nodes: NodeV1[]; rawEdges: RawEdge[] } | { error: string } {
  try {
    const { nodes, rawEdges } = extractFile(rel, source, lang);
    return { nodes, rawEdges };
  } catch (err) {
    return { error: `${rel}: parse failed — ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function buildGraph(
  dir: string,
  opts: GraphBuildOptions = {},
): Promise<GraphBuildResult> {
  const root = resolve(dir);
  const outDir = contextDirFor(root, opts.contextDir);
  // Enumerate once: source extraction, scope discovery, and Go module
  // resolution must agree on the same Git-ignore-aware working-tree view —
  // including the repo's persisted directory and submodule choices.
  const walked = walkDir(root, readIncludeDirs(root), {
    followSubmodules: readFollowSubmodules(root),
    followNestedRepos: readFollowNestedRepos(root),
  });
  const onlyDirs = opts.onlyDirs && opts.onlyDirs.length > 0 ? new Set(opts.onlyDirs) : undefined;
  const repoFiles = filterByOnlyDirs(walked, root, onlyDirs);
  const files = listSourceStats(root, outDir, repoFiles);
  const discoveredScopes = discoverScopes(root, repoFiles);

  const nodes: NodeV1[] = [];
  const rawEdges: RawEdge[] = [];
  const sources = new Map<string, string>();
  /** Display labels, not grammars — `.mjs` is parsed as typescript but reported as
   * javascript, or the banner claims a repo's JavaScript went unindexed. */
  const langs = new Set<string>();
  const errors: string[] = [];

  // In a git worktree there is nothing to reuse *yet* — `graft/` is gitignored, so
  // git never checked it out — but the parent checkout's graph is one directory away.
  // Copy it in before reading the priors below and this build is incremental and
  // keeps its paid-for summaries, instead of being a cold parse of the whole repo.
  // No-ops everywhere else, including on an explicit cold build (`reuse: false`).
  const seed: SeedResult =
    opts.reuse === false ? { seeded: false } : seedGraph(root, { contextDir: opts.contextDir });

  // Tier-1 memo: unchanged files replay their last parse. `entries` is rebuilt
  // from scratch each run and keyed only by files currently on disk, so deletions
  // fall out of both the cache and the fingerprint with no separate pruning pass.
  const priorExtract = opts.reuse === false ? emptyExtractCache() : readExtractCache(outDir);
  const entries: Record<string, ExtractEntry> = {};
  let parsed = 0;
  let reused = 0;

  // Breadth tier: WASM grammars load asynchronously, so warm the ones this repo
  // needs ONCE here (buildGraph is async) before the synchronous parse loop below
  // can call extractGeneric. Depth-tier (native) grammars need no warmup.
  await warmGenericGrammars(
    new Set(files.map((f) => genericLangOf(f.abs)?.name).filter((n): n is string => !!n)),
  );
  // Container tier (.vue and friends) loads its wrapper grammars the same way,
  // for the same reason: extractContainer runs inside the sync loop below.
  await warmContainerGrammars(
    new Set(files.map((f) => containerLangOf(f.abs)?.name).filter((n): n is string => !!n)),
  );

  // A file's outcome, decided during the first (always synchronous) pass below.
  // Depth-tier files needing a parse start with `result: undefined`, filled in once
  // the pool (or its serial fallback) resolves; every other outcome is complete the
  // moment it is recorded. Storing one slot per file, by original index, is what
  // lets the merge pass below reassemble `nodes`/`rawEdges` in exact file-walk order
  // regardless of which files went through the pool — order matters downstream:
  // `resolveEdges` breaks name-collision ties by array position (see graph/resolve.ts),
  // so reordering nodes would silently change which of two same-named symbols a call
  // resolves to. Splitting depth-tier work into a pool must never do that.
  type FileOutcome =
    | { kind: "read-error"; message: string }
    | { kind: "unsupported-encoding" }
    | { kind: "reuse"; source: string; label: string; cached: ExtractEntry }
    | {
        kind: "parsed";
        source: string;
        hash: string;
        label: string;
        result?: { nodes: NodeV1[]; rawEdges: RawEdge[] } | { error: string };
      };

  const outcomes: FileOutcome[] = new Array(files.length);
  const depthJobs: { index: number; rel: string; source: string; lang: Language }[] = [];

  files.forEach((f, i) => {
    const rel = f.rel;
    opts.onProgress?.({ phase: "read", index: i, total: files.length, file: rel });
    // Depth tier (hand-written, native grammar) if a language claims the file;
    // otherwise the breadth tier (generic tags.scm over a WASM grammar).
    const lang = languageOf(f.abs);
    // A container is neither tier: its wrapper grammar only locates the embedded
    // block, which then goes to the depth-tier extractor. Checked before the
    // breadth tier so a future grammar claiming .vue can't shadow it.
    const container = lang ? null : containerLangOf(f.abs);
    const generic = lang || container ? null : genericLangOf(f.abs);
    const label = languageLabelOf(f.abs) ?? container?.name ?? generic?.name ?? "unknown";
    const cached = priorExtract.files[rel];

    // Every file is read and hashed, every build — only the *parse* is memoized.
    // The tempting optimization is to trust the probe's `(size, mtimeMs)` and skip
    // the read too, but then `graft build` inherits the probe's blind spot: on a
    // filesystem with coarse mtime granularity, a same-length edit inside the same
    // second is invisible, so `graft check` reports drift (it always re-hashes) and
    // the `graft build` it tells you to run refuses to repair it — forever. A stat
    // may decide whether a *query* bothers rebuilding; it may not decide what the
    // rebuild itself looks at. Reading is ~0.05ms/file against the ~4.6ms parse
    // this still skips.
    let source: string | null;
    try {
      source = readSourceFile(f.abs);
    } catch (err) {
      const message = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
      outcomes[i] = { kind: "read-error", message };
      return;
    }
    if (source === null) {
      // Unsupported encoding (UTF-16BE) — a skip, never an error: recorded with
      // an empty entry so the freshness probe doesn't treat it as new every run.
      outcomes[i] = { kind: "unsupported-encoding" };
      return;
    }

    const hash = contentHash(source);
    if (cached && hash === cached.hash) {
      outcomes[i] = { kind: "reuse", source, label, cached };
      return;
    }

    if (lang) {
      // Depth tier: defer to the pool (or its serial fallback below), never parsed
      // inline here — see the merge pass for why order still comes out identical.
      depthJobs.push({ index: i, rel, source, lang });
      outcomes[i] = { kind: "parsed", source, hash, label };
      return;
    }

    // Breadth tier / container: parse inline immediately, exactly as before this
    // pool existed. Neither goes through workers — the breadth tier's WASM grammars
    // need the async warmup already done above, and containers are a small minority.
    try {
      const { nodes: fileNodes, rawEdges: fileEdges } = container
        ? extractContainer(rel, source, container)
        : extractGeneric(rel, source, generic!.name);
      outcomes[i] = { kind: "parsed", source, hash, label, result: { nodes: fileNodes, rawEdges: fileEdges } };
    } catch (err) {
      const message = `${rel}: parse failed — ${err instanceof Error ? err.message : String(err)}`;
      outcomes[i] = { kind: "parsed", source, hash, label, result: { error: message } };
    }
  });

  // Resolve every deferred depth-tier job. Below MIN_FILES_FOR_POOL, or with
  // GRAFT_PARSE_WORKERS=0/1, this is the exact inline extractFile call it replaced —
  // parseInPool never spawns a thread for a job poolEnabled() would refuse.
  if (depthJobs.length > 0) {
    let byIndex: Map<number, { nodes: NodeV1[]; rawEdges: RawEdge[] } | { error: string }>;
    let done = 0;
    const tick = (file: string, n = 1) => {
      done += n;
      opts.onProgress?.({ phase: "parse", index: done - 1, total: depthJobs.length, file });
    };
    if (poolEnabled(depthJobs.length)) {
      const results = await parseInPool(
        depthJobs.map((j) => ({ rel: j.rel, source: j.source, lang: j.lang })),
        // One tick per worker batch, not per file: the workers report back in
        // batches by design, and a caller watching a progress line needs to see
        // that the pool is moving rather than a number frozen at the read total.
        (chunk) => tick(chunk.lastFile, chunk.count),
      );
      const byRel = new Map<string, ParseOutcome>(results.map((r) => [r.rel, r]));
      byIndex = new Map(
        depthJobs.map((j): [number, { nodes: NodeV1[]; rawEdges: RawEdge[] } | { error: string }] => {
          const r = byRel.get(j.rel);
          // Never run (no worker, a crash, a missing reply): parse it here instead.
          // The pool is an optimization, so anything it did not do falls back to the
          // path that existed before it, and the graph comes out the same either way.
          if (!r || r.unrun) return [j.index, extractOrError(j.rel, j.source, j.lang)];
          if (r.error) return [j.index, { error: `${j.rel}: parse failed — ${r.error}` }];
          return [j.index, { nodes: r.nodes!, rawEdges: r.rawEdges! }];
        }),
      );
    } else {
      byIndex = new Map(
        depthJobs.map((j): [number, { nodes: NodeV1[]; rawEdges: RawEdge[] } | { error: string }] => {
          tick(j.rel);
          return [j.index, extractOrError(j.rel, j.source, j.lang)];
        }),
      );
    }
    for (const j of depthJobs) {
      (outcomes[j.index] as Extract<FileOutcome, { kind: "parsed" }>).result = byIndex.get(j.index);
    }
  }

  // Merge pass, in ORIGINAL FILE-WALK ORDER — identical order to the single loop
  // this replaced, whatever mix of reuse/pool/inline produced each outcome.
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const rel = f.rel;
    const o = outcomes[i]!;

    if (o.kind === "read-error") {
      errors.push(o.message);
      // Record it anyway (with the stat we do have) so the freshness probe's
      // fast path doesn't report this file as new on every single query.
      entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [], error: o.message };
      continue;
    }
    if (o.kind === "unsupported-encoding") {
      entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [] };
      continue;
    }
    if (o.kind === "reuse") {
      entries[rel] = { ...o.cached, size: f.size, mtimeMs: f.mtimeMs };
      sources.set(rel, o.source);
      reused++;
      if (o.cached.error) {
        errors.push(o.cached.error); // this file failed to parse last time too
        continue;
      }
      nodes.push(...o.cached.nodes);
      rawEdges.push(...o.cached.rawEdges);
      langs.add(o.label);
      continue;
    }

    // o.kind === "parsed"
    parsed++;
    const result = o.result!;
    if ("error" in result) {
      errors.push(result.error);
      entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: o.hash, nodes: [], rawEdges: [], error: result.error };
      continue;
    }
    nodes.push(...result.nodes);
    rawEdges.push(...result.rawEdges);
    sources.set(rel, o.source);
    langs.add(o.label);
    entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: o.hash, nodes: result.nodes, rawEdges: result.rawEdges };
  }

  // Persist the memo BEFORE enrichment, because `enrichGraph` mutates these very
  // node objects (summary/crux/summary_state) and the cache must only ever hold
  // pristine Tier-1 output — otherwise a replayed node would arrive pre-enriched
  // and a cold build and an incremental build could disagree. The meaning layer
  // has its own cache (wiring.json itself, keyed on body_hash); this one is
  // strictly about not re-parsing.
  writeExtractCache(outDir, {
    ...emptyExtractCache(),
    files: entries,
  });

  const edges = resolveEdges(nodes, rawEdges, { goModules: readGoModules(root, repoFiles) });

  // Guard 5 (minimum-substance): node counts aren't known until nodes are
  // assembled, so the merge-tiny-scopes-into-root guard runs here.
  const scopes = applyMinSubstanceGuard(discoveredScopes, nodes);

  // Assemble the graph BEFORE the meaning pass, so the crux pass can checkpoint it to
  // disk periodically (#128): crux/summary mutate node objects in place and never
  // change the node/edge SET, so `meta` stays valid; the opt-in LSP pass below is the
  // only thing that adds edges, and it runs before the final write.
  const graph: GraphV1 = {
    meta: {
      version: 1,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      languages: [...langs].sort(),
      scopes,
    },
    nodes,
    edges,
  };

  // graph.json is its own Tier-2 cache: fold in the prior meaning layer so an
  // unchanged body is never re-summarized (and a Tier-1-only run never wipes it).
  // Read BEFORE the first checkpoint can overwrite wiring.json.
  const prior = readGraph(wiringPath(outDir));
  const priorById = new Map((prior?.nodes ?? []).map((n) => [n.id, n]));
  const meaning = await enrichGraph(nodes, priorById, sources, {
    summarizer: opts.summarizer,
    concurrency: opts.concurrency,
    onProgress: ({ index, total, node }) =>
      opts.onProgress?.({ phase: "enrich", index, total, file: node }),
    // Periodic durability flush of partial crux; the next run folds it back in by
    // body_hash, so an interrupted --deep run never repays the crux it computed.
    checkpoint: () => writeGraph(graph, outDir),
  });
  errors.push(...meaning.errors);

  // Opt-in compiler-grade enrichment (adds lsp_resolved call edges in place).
  // Runs on the assembled graph so callee positions map back to nodes; never
  // touches the extraction cache (Tier-1 stays pristine, cold==incremental).
  if (opts.lsp) {
    const { enrichWithLsp } = await import("./lsp/enrich.js");
    const r = await enrichWithLsp(graph, root);
    graph.meta.edgeCount = graph.edges.length;
    opts.onProgress?.({ phase: "enrich", index: r.added, total: r.queried, file: `lsp:${r.server ?? "none"}` });
  }

  const graphPath = writeGraph(graph, outDir);
  // `ask`'s token/IDF sidecar — moves per-query corpus tokenization to build
  // time (~45% of query time on a 32k-node graph, profiled). Lives in the
  // cache dir; `ask` falls back to live tokenization when it's absent/stale.
  // Best-effort: wiring.json is already on disk at this point, so a sidecar
  // write failure (e.g. an unwritable cache dir) must not abort cards/index/
  // covers below — record it and keep going, same as other recoverable errors.
  //
  // MUST pass the in-memory `graph` here, never a re-read of wiringPath(outDir):
  // `writeGraph` strips `body_text` from what it serializes (dead weight once
  // this sidecar exists), so the nodes on disk no longer carry it — only this
  // in-memory object, still holding what `extractFile` populated, does.
  try {
    writeAskIndex(outDir, graph);
  } catch (err) {
    errors.push(`ask-index: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The fingerprint claims exactly one thing: "the graph on disk was built from
  // these source bytes." Nothing about the projections below — which is why it is
  // safe to write here, and why `graphOnly` builds (the query path, which stops
  // right after this line) are still recorded as fresh.
  writeFingerprint(outDir, entries, opts.onlyDirs);

  // Tier-2 passive surface: project the nodes into per-file markdown cards, and
  // refresh the INDEX roster. Pure projection — no LLM, no network.
  //
  // Skipped entirely on the query path (`graphOnly`). Retrieval answers from
  // wiring.json and the ask sidecar; the markdown surface is for humans and for
  // the agent's own greps, and it is rebuilt by an explicit `graft build` — which
  // is what the Claude Code `Stop` hook already runs at the end of a turn. Keeping
  // it off the query path is what makes a refresh cheap, leaves the repo untouched
  // (`ensureGitignored` writes `.gitignore`, which a read has no business doing),
  // and means a failure here can never be triggered by a query.
  let cardStats: CardStats = { written: 0, pruned: 0, files: [] };
  if (!opts.graphOnly) {
    // The graph is a local, regenerable cache — make sure git ignores it. Cheap and
    // idempotent, so a fresh clone's first build self-ignores.
    ensureGitignored(root, outDir);
    // …and that gitignoring it doesn't hide the cards from search: ripgrep honours
    // .gitignore, so without this the cards can never be grepped, which is the one
    // way an agent was supposed to stumble onto them.
    ensureSearchable(root, outDir);
    cardStats = writeCards(graph, outDir);
    writeIndex(outDir, cardStats.files);
    // Backfill concept nodes with their `covers:` symbol/file:line list (the
    // OKF↔Wiring link). No-op when there are no concept nodes (a $0 build).
    writeCovers(graph, outDir);
  }

  const byKind = {} as Record<Kind, number>;
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  const byRelation = {} as Record<Relation, number>;
  for (const e of edges) byRelation[e.relation] = (byRelation[e.relation] ?? 0) + 1;

  return {
    contextDir: outDir,
    graphPath,
    cards: cardStats.written,
    files: files.length,
    parsed,
    reused,
    seededFrom: seed.from,
    nodes: nodes.length,
    edges: edges.length,
    byKind,
    byRelation,
    languages: [...langs].sort(),
    meaning,
    errors,
  };
}
