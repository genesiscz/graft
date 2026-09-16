/**
 * The parse pool must be invisible: the same graph, in the same order, whether the
 * depth tier was extracted on the caller's thread or across worker threads.
 *
 * Order is the part that matters and the part a casual implementation breaks.
 * `resolveEdges` indexes candidate symbols by array position, so two same-named
 * functions in different files resolve by which node landed first — reorder the
 * nodes and an edge silently points somewhere else. Every assertion here compares
 * the full serialized graph, not counts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { MIN_FILES_FOR_POOL, loaderExecArgv, poolEnabled, parseInPool } from "../src/graph/parse-pool.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

/** A repo of `n` TypeScript files, each with a function that calls the next one, so
 * the graph carries real cross-file edges rather than isolated nodes. Deliberately
 * larger than MIN_FILES_FOR_POOL by default, or the pool would decline the job. */
function repo(n: number): string {
  const d = mkdtempSync(join(tmpdir(), "graft-pool-"));
  mkdirSync(join(d, "src"), { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(
      join(d, "src", `mod${i}.ts`),
      `import { fn${(i + 1) % n} } from "./mod${(i + 1) % n}.js";\n` +
        `export function fn${i}(x: number): number {\n  return fn${(i + 1) % n}(x) + ${i};\n}\n`,
    );
  }
  return d;
}

function withWorkers<T>(value: string, fn: () => T): T {
  const previous = process.env.GRAFT_PARSE_WORKERS;
  process.env.GRAFT_PARSE_WORKERS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GRAFT_PARSE_WORKERS;
    else process.env.GRAFT_PARSE_WORKERS = previous;
  }
}

/**
 * `new Worker` accepts only a small subset of node flags in `execArgv` and throws
 * ERR_WORKER_INVALID_EXEC_ARGV on the rest. Forwarding the parent's whole execArgv
 * therefore breaks every worker for any developer with NODE_OPTIONS set — which is
 * how this was found: the suite itself runs under such a parent. Keep the loader,
 * drop the runtime flags.
 */
test("loaderExecArgv keeps loaders and drops flags a worker would refuse", () => {
  assert.deepEqual(loaderExecArgv(["--import", "tsx"]), ["--import", "tsx"]);
  assert.deepEqual(loaderExecArgv(["--loader=tsx/esm"]), ["--loader=tsx/esm"]);
  assert.deepEqual(loaderExecArgv(["-r", "ts-node/register"]), ["-r", "ts-node/register"]);
  assert.deepEqual(
    loaderExecArgv([
      "--stack-trace-limit=10",
      "--import",
      "tsx",
      "--tls-cipher-list=HIGH",
      "--v8-pool-size=4",
      "--secure-heap=0",
    ]),
    ["--import", "tsx"],
    "the real-world parent that broke this keeps only its loader",
  );
  assert.deepEqual(loaderExecArgv([]), []);
  // A trailing loader flag with no value must not emit a dangling flag.
  assert.deepEqual(loaderExecArgv(["--import"]), ["--import"]);
});

test("poolEnabled: off below the threshold, off when the env var disables it", () => {
  withWorkers("8", () => {
    assert.equal(poolEnabled(MIN_FILES_FOR_POOL - 1), false, "a small job never pays for threads");
    assert.equal(poolEnabled(MIN_FILES_FOR_POOL), true);
  });
  // The escape hatch has to actually work, or there is no way back to the old path.
  for (const off of ["0", "1"]) {
    withWorkers(off, () => assert.equal(poolEnabled(10_000), false, `GRAFT_PARSE_WORKERS=${off} must be serial`));
  }
  // Nonsense must not silently disable parallelism, nor crash.
  withWorkers("banana", () => assert.equal(poolEnabled(10_000), true, "an unparseable value falls back to the default"));
});

test("the pooled graph is byte-identical to the serial one, order included", async () => {
  const d = repo(MIN_FILES_FOR_POOL + 20);

  await withWorkers("1", () => buildGraph(d, { contextDir: join(d, "serial"), graphOnly: true, reuse: false }));
  await withWorkers("8", () => buildGraph(d, { contextDir: join(d, "pooled"), graphOnly: true, reuse: false }));

  const serial = readGraph(wiringPath(join(d, "serial")));
  const pooled = readGraph(wiringPath(join(d, "pooled")));

  assert.ok((serial?.nodes.length ?? 0) > MIN_FILES_FOR_POOL, "the fixture actually produced a graph");
  // Whole-document equality: node order, edge order, every field.
  assert.deepEqual(pooled, serial);
});

test("a build whose depth tier is too small to pool still produces the same graph", async () => {
  const d = repo(3);

  await withWorkers("1", () => buildGraph(d, { contextDir: join(d, "serial"), graphOnly: true, reuse: false }));
  // Workers are *requested* here, but poolEnabled refuses the job on size, so this
  // exercises the in-build serial fallback rather than the pool.
  await withWorkers("8", () => buildGraph(d, { contextDir: join(d, "fallback"), graphOnly: true, reuse: false }));

  assert.deepEqual(readGraph(wiringPath(join(d, "fallback"))), readGraph(wiringPath(join(d, "serial"))));
});

test("parseInPool reports every job back, and reports progress per batch", async () => {
  const jobs = Array.from({ length: MIN_FILES_FOR_POOL }, (_, i) => ({
    rel: `src/f${i}.ts`,
    source: `export function f${i}(): number { return ${i}; }\n`,
    lang: "typescript" as const,
  }));

  const batches: { count: number; lastFile: string }[] = [];
  const outcomes = await withWorkers("4", () => parseInPool(jobs, (p) => batches.push(p)));

  assert.equal(outcomes.length, jobs.length, "no job is lost or duplicated");
  assert.deepEqual(
    [...outcomes.map((o) => o.rel)].sort(),
    [...jobs.map((j) => j.rel)].sort(),
    "every requested file comes back exactly once",
  );
  assert.ok(
    outcomes.every((o) => !o.error && (o.nodes?.length ?? 0) > 0),
    `every job extracted nodes: ${outcomes.find((o) => o.error)?.error ?? "ok"}`,
  );
  assert.equal(
    batches.reduce((n, b) => n + b.count, 0),
    jobs.length,
    "the progress counts sum to the job count, so a caller's total never drifts",
  );
});

test("a job whose source cannot parse comes back as a per-file error, not a dead build", async () => {
  // One deliberately broken file among good ones: the pool must return outcomes for
  // all of them. tree-sitter is error-tolerant, so this asserts the shape rather
  // than requiring a thrown parse — a file that yields no symbols is still a result.
  const jobs = Array.from({ length: MIN_FILES_FOR_POOL }, (_, i) => ({
    rel: `src/f${i}.ts`,
    source: i === 3 ? "function ((((( unterminated" : `export function f${i}(): number { return ${i}; }\n`,
    lang: "typescript" as const,
  }));

  const outcomes = await withWorkers("4", () => parseInPool(jobs));

  assert.equal(outcomes.length, jobs.length, "the broken file does not take the batch down with it");
  const broken = outcomes.find((o) => o.rel === "src/f3.ts");
  assert.ok(broken, "the broken file still reports an outcome");
  assert.ok(broken.error === undefined || typeof broken.error === "string");
});
