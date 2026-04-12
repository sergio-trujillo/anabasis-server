// content-watcher — chokidar-based hot reload for anabasis-content/.
//
// In dev, `tsx watch` respawns the server whenever a file in
// anabasis-server/src changes. It does NOT watch anabasis-content/,
// so content edits have historically required a manual tsx-watch
// nudge (touch a server file) to make the content-loader re-read.
//
// This watcher sits alongside the server process and invalidates the
// content-loader caches whenever a JSON file under anabasis-content/
// is added, changed, or removed. The next API call re-reads from disk.
//
// Only starts in non-production environments — in prod the server is
// assumed immutable and content is baked at build time.

import chokidar, { type FSWatcher } from "chokidar";
import { invalidateContentCaches } from "./content-loader.js";

let activeWatcher: FSWatcher | null = null;

export function startContentWatcher(contentDir: string): FSWatcher | null {
  if (process.env.NODE_ENV === "production") return null;
  if (activeWatcher) return activeWatcher;

  // Debounce: a git checkout / mass-save can fire dozens of events in
  // rapid succession. Coalesce into a single invalidation.
  let pending: NodeJS.Timeout | null = null;
  let changesSinceLastInvalidation = 0;

  function scheduleInvalidation(kind: string, path: string) {
    changesSinceLastInvalidation++;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      invalidateContentCaches();
      // eslint-disable-next-line no-console
      console.log(
        `[content-watcher] invalidated caches (${changesSinceLastInvalidation} ${
          changesSinceLastInvalidation === 1 ? "change" : "changes"
        }, last: ${kind} ${path})`,
      );
      changesSinceLastInvalidation = 0;
      pending = null;
    }, 150);
  }

  const watcher = chokidar.watch(contentDir, {
    ignored: [
      /\/node_modules\//,
      /\/\.git\//,
      /\/_lib\//, // JUnit jar — huge, no need to watch
      /\/_helpers\//,
    ],
    ignoreInitial: true,
    // Don't trigger on every file-stat event; wait for writes to settle.
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
    persistent: true,
  });

  watcher
    .on("add", (p) => scheduleInvalidation("add", p))
    .on("change", (p) => scheduleInvalidation("change", p))
    .on("unlink", (p) => scheduleInvalidation("unlink", p))
    .on("ready", () => {
      // eslint-disable-next-line no-console
      console.log(`[content-watcher] watching ${contentDir}`);
    })
    .on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error(`[content-watcher] error`, err);
    });

  activeWatcher = watcher;
  return watcher;
}

export function stopContentWatcher(): Promise<void> {
  if (!activeWatcher) return Promise.resolve();
  const w = activeWatcher;
  activeWatcher = null;
  return w.close();
}
