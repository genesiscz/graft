/**
 * Parallel Tier-1 extraction for depth-tier (native-grammar) files, across worker
 * threads.
 *
 * tree-sitter's native bindings load and parse correctly inside a `worker_thread`:
 * verified, a fresh `Parser` + `setLanguage` in a worker returns a correct tree in
 * ~19ms cold. `extractFile` itself needs no change to run there — its `Parser` is a
 * module-level singleton (`extract.ts`), which is exactly the pattern that already
 * works in the caller's thread; a worker gets its OWN module instance (workers never
 * share module state), so nothing here is shared or synchronized across workers,
 * only reused within one, the same way the serial loop reuses it across files.
 *
 * Only the depth tier goes through the pool. The breadth tier's WASM grammars need
 * an async warmup this module does not replicate, and containers (`.vue` and
 * friends) are a small minority — both stay on the caller's thread, unchanged, in
 * `build.ts`.
 *
 * Gated by `GRAFT_PARSE_WORKERS` (default 8; `0` or `1` = serial, the exact code path
 * `buildGraph` used before this existed). Below `MIN_FILES_FOR_POOL` the pool never
 * spawns regardless of the env var: loading 9 native grammars per worker thread costs
 * real time, and a job too small to amortize that would only get slower. That
 * threshold is also what keeps this invisible to the test suite's many small
 * fixture repos — nobody has to opt out per-test.
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { Language, RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";

export interface ParseJob {
  rel: string;
  source: string;
  lang: Language;
}

export interface ParseOutcome {
  rel: string;
  nodes?: NodeV1[];
  rawEdges?: RawEdge[];
  /** The file was extracted and the extraction itself failed — a real parse error,
   * recorded against the file the same way the serial path records one. */
  error?: string;
  /** The pool never ran this job: a worker could not start, crashed, or exited
   * before reporting. Distinct from `error` on purpose — the caller re-parses these
   * itself rather than recording a failure, so no environment quirk can cost a build
   * its nodes. */
  unrun?: true;
}

/** Below this many depth-tier files needing a parse, run serially instead: measured
 * on this repo, one worker's native-grammar warmup is single-digit milliseconds per
 * language actually used, but paying it across 8 threads for a handful of files
 * costs more than the parse itself would. */
export const MIN_FILES_FOR_POOL = 64;

function workerCount(): number {
  const env = process.env.GRAFT_PARSE_WORKERS;
  if (env === undefined || env === "") return 8;
  const n = Number(env);
  if (!Number.isFinite(n) || n < 0) return 8;
  return Math.floor(n);
}

/** Whether `parseInPool` would actually spawn workers for a job of this size —
 * exported so `build.ts` can decide, before building the job list, whether it is
 * worth splitting `toParse` into a pool batch and a serial remainder at all. */
export function poolEnabled(jobCount: number): boolean {
  return workerCount() > 1 && jobCount >= MIN_FILES_FOR_POOL;
}

const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "parse-worker.js");

/** Flags that carry a module loader, and the only ones worth forwarding to a worker. */
const LOADER_FLAGS = new Set(["--import", "--loader", "--experimental-loader", "--require", "-r"]);

/**
 * The loader flags from this process's `execArgv`, and nothing else.
 *
 * A worker needs the parent's loader or a `.ts` worker script cannot resolve (tsx
 * under test; the built dist needs nothing). It must NOT get the parent's whole
 * `execArgv`: `new Worker` rejects most runtime flags outright with
 * ERR_WORKER_INVALID_EXEC_ARGV, and a developer with `NODE_OPTIONS` set — say
 * `--stack-trace-limit` or `--tls-cipher-list`, both common — would have every
 * worker fail to start. Caught by graph-parse-pool.test.ts, which runs under exactly
 * such a parent.
 */
export function loaderExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      if (LOADER_FLAGS.has(arg.slice(0, eq))) out.push(arg);
      continue;
    }
    if (!LOADER_FLAGS.has(arg)) continue;
    out.push(arg);
    // The loader's value is the next argv entry; without it the flag is meaningless
    // and would itself be rejected.
    if (i + 1 < execArgv.length) out.push(execArgv[++i]!);
  }
  return out;
}

/**
 * Split `jobs` across N worker threads (round-robin, so a run of large files in one
 * language doesn't stack onto a single worker), each running `extractFile` in a
 * plain loop, and resolve once every worker has reported back.
 *
 * Never rejects: a worker that errors or exits non-zero mid-batch reports every job
 * still assigned to it as a per-file error, the same shape `build.ts` already
 * handles for a parse failure — a crashed worker costs those files' nodes, not the
 * whole build.
 */
export function parseInPool(
  jobs: ParseJob[],
  onChunk?: (progress: { count: number; lastFile: string }) => void,
): Promise<ParseOutcome[]> {
  const n = Math.max(1, Math.min(workerCount(), jobs.length));
  const chunks: ParseJob[][] = Array.from({ length: n }, () => []);
  jobs.forEach((job, i) => chunks[i % n].push(job));

  return Promise.all(chunks.map((chunk) => runChunk(chunk, onChunk))).then((results) => results.flat());
}

function runChunk(
  chunk: ParseJob[],
  onChunk?: (progress: { count: number; lastFile: string }) => void,
): Promise<ParseOutcome[]> {
  return new Promise((resolveChunk) => {
    if (chunk.length === 0) {
      resolveChunk([]);
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SCRIPT, {
        workerData: { jobs: chunk },
        // The parent's LOADER only (see loaderExecArgv) so a .ts worker script
        // resolves the way its spawner did, without inheriting runtime flags a
        // worker refuses to start with.
        execArgv: loaderExecArgv(),
      });
    } catch (err) {
      // Could not even start one: report the chunk as unrun so the caller can parse
      // it itself. The pool is an optimization and must never be the reason a build
      // loses nodes.
      resolveChunk(chunk.map((j) => ({ rel: j.rel, unrun: true as const })));
      return;
    }
    let settled = false;
    const finish = (outcomes: ParseOutcome[]) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      onChunk?.({ count: chunk.length, lastFile: chunk[chunk.length - 1]!.rel });
      resolveChunk(outcomes);
    };
    // A worker that dies without reporting leaves its whole chunk unrun, never
    // "failed": the caller re-parses them in-thread, so a crash costs time, not nodes.
    const asUnrun = () => chunk.map((j) => ({ rel: j.rel, unrun: true as const }));
    worker.once("message", (outcomes: ParseOutcome[]) => finish(outcomes));
    worker.once("error", () => finish(asUnrun()));
    worker.once("exit", (code) => {
      if (code !== 0) finish(asUnrun());
    });
  });
}
