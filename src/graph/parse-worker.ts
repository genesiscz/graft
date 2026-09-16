/**
 * Runs inside one worker thread spawned by `parse-pool.ts`. Extracts every job it
 * was handed with a plain synchronous loop and posts the whole batch back at once —
 * one message, not one per file, so the main thread isn't woken up thousands of
 * times for a large repo.
 */
import { parentPort, workerData } from "node:worker_threads";
import { extractFile } from "./extract.js";
import type { ParseJob, ParseOutcome } from "./parse-pool.js";

const jobs: ParseJob[] = workerData.jobs;
const outcomes: ParseOutcome[] = [];

for (const job of jobs) {
  try {
    const { nodes, rawEdges } = extractFile(job.rel, job.source, job.lang);
    outcomes.push({ rel: job.rel, nodes, rawEdges });
  } catch (err) {
    outcomes.push({ rel: job.rel, error: err instanceof Error ? err.message : String(err) });
  }
}

parentPort!.postMessage(outcomes);
