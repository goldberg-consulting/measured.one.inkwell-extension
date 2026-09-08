// Passive caches: construction performs no filesystem work. Watchers only retire
// entries; synchronous inventory/content guards close the gap before watch events arrive.
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

interface Observation { signature: string; identitySignature: string; trackContent: boolean; unavailable?: boolean; directory: boolean; realPath?: string; stat?: fs.Stats }
function observe(file: string, trackContent = true): Observation {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { signature: "missing", identitySignature: "missing", trackContent, directory: false };
    return { signature: `unavailable:${code}`, identitySignature: `unavailable:${code}`, trackContent, directory: false, unavailable: true };
  }
  let realPath: string | undefined;
  try { realPath = fs.realpathSync(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return { signature: `unavailable:${code}`, identitySignature: `unavailable:${code}`, trackContent, directory: false, unavailable: true };
  }
  // A dangling link has an identity of its own. Treating it as an absent
  // ordinary directory would infer containment through the wrong ancestor.
  const identitySignature = [stat.dev, stat.ino, stat.mode, realPath].join(":");
  const directory = !!realPath && stat.isDirectory() && !stat.isSymbolicLink();
  let inventory: string | undefined, unavailable = false;
  if (trackContent && directory) {
    try {
      // Linux overlay and other coarse clocks can report identical metadata
      // after a real entry change. Check shallow names/types, not timestamps
      // alone; parsed manifests and reconstructed template objects stay cached.
      inventory = JSON.stringify(fs.readdirSync(file, { withFileTypes: true })
        .map(entry => [entry.name, entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"])
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    } catch (error) {
      unavailable = true;
      inventory = `unavailable:${(error as NodeJS.ErrnoException).code}`;
    }
  }
  return { stat, realPath, trackContent, identitySignature, directory, unavailable,
    signature: trackContent ? [identitySignature, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs, inventory].join(":") : identitySignature };
}

export function isPathWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export class ResolutionSnapshot {
  readonly observations = new Map<string, Observation>();
  private readonly contentDigests = new Map<string, string>();
  cacheable = true;
  private consistent = true;

  inspect(file: string, trackContent = true): Observation {
    const normalized = path.resolve(file);
    try {
      const previous = this.observations.get(normalized);
      const current = observe(normalized, trackContent || previous?.trackContent === true);
      if (previous && (previous.trackContent ? previous.signature !== current.signature : previous.identitySignature !== current.identitySignature)) { this.cacheable = false; this.consistent = false; }
      if (current.unavailable) this.cacheable = false;
      this.observations.set(normalized, current);
      return current;
    } catch {
      this.cacheable = false; this.consistent = false;
      return { signature: "unreadable", identitySignature: "unreadable", trackContent, directory: false };
    }
  }

  directory(file: string, boundary?: string, trackContent = true): boolean {
    const item = this.inspect(file, trackContent);
    if (!item.directory || !item.realPath) return false;
    if (!boundary) return true;
    const root = this.inspect(boundary, false);
    return root.directory && !!root.realPath && isPathWithin(root.realPath, item.realPath);
  }

  file(file: string, boundary: string): boolean {
    const item = this.inspect(file), root = this.inspect(boundary, false);
    return !!item.stat?.isFile() && !item.stat.isSymbolicLink() && !!item.realPath && root.directory && !!root.realPath && isPathWithin(root.realPath, item.realPath);
  }

  /** Register the exact bytes consumed by a parser, including invalid input.
   * Only content-derived values need this guard; font/image paths do not.
   */
  content(file: string, bytes: string | Buffer): void {
    const normalized = path.resolve(file), digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const previous = this.contentDigests.get(normalized);
    if (previous !== undefined && previous !== digest) { this.cacheable = false; this.consistent = false; }
    this.contentDigests.set(normalized, digest);
  }

  matches(): boolean {
    if (!this.consistent) return false;
    try {
      for (const [file, expected] of this.contentDigests) {
        const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        try {
          if (!fs.fstatSync(descriptor).isFile() || crypto.createHash("sha256").update(fs.readFileSync(descriptor)).digest("hex") !== expected) return false;
        } finally { fs.closeSync(descriptor); }
      }
      // Recheck containment/identity after descriptor reads, so a directory
      // replacement during a manifest read cannot publish its escaping paths.
      for (const [file, expected] of this.observations) if (observe(file, expected.trackContent).signature !== expected.signature) return false;
      return true;
    } catch { return false; }
  }

  watchDirectories(): Set<string> {
    const directories = new Set<string>();
    for (const [file, observed] of this.observations) {
      let candidate = observed.directory ? file : path.dirname(file);
      while (true) {
        const item = this.inspect(candidate, false);
        if (item.directory) { directories.add(candidate); break; }
        const parent = path.dirname(candidate);
        if (parent === candidate) { this.cacheable = false; break; }
        candidate = parent;
      }
    }
    return directories;
  }
}

interface Entry { value: unknown; snapshot: ResolutionSnapshot; directories: Set<string> }
interface Watch { watcher: fs.FSWatcher; keys: Set<string> }
export interface ResolutionCacheOptions { maxEntries?: number; maxWatchers?: number; maxDependencies?: number; watch?: typeof fs.watch; enabled?: boolean }

export class ResolutionCache {
  private readonly entries = new Map<string, Entry>();
  private readonly watches = new Map<string, Watch>();
  private disposed = false;
  private enabled: boolean;
  private generation = 0;
  private readonly maxEntries: number;
  private readonly maxWatchers: number;
  private readonly maxDependencies: number;
  private readonly watch: typeof fs.watch;

  constructor(options: ResolutionCacheOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.maxEntries = options.maxEntries ?? 64;
    this.maxWatchers = options.maxWatchers ?? 256;
    this.maxDependencies = options.maxDependencies ?? 8192;
    this.watch = options.watch ?? fs.watch;
  }

  /** Opt in after a user-facing resolution request, never from registration. */
  start(): void { if (!this.disposed) this.enabled = true; }

  get<T>(key: string, resolve: (snapshot: ResolutionSnapshot) => T): T {
    const cached = this.entries.get(key);
    if (cached?.snapshot.matches()) {
      this.entries.delete(key); this.entries.set(key, cached);
      return cached.value as T;
    }
    this.remove(key);
    // Validate even uncached/disabled lookups. A scan that raced a directory
    // replacement must never return its observed paths merely because it was
    // refused admission to the cache.
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = new ResolutionSnapshot();
      const value = resolve(snapshot);
      if (!snapshot.matches()) continue;
      if (!snapshot.cacheable || !this.enabled || this.disposed || this.maxEntries < 1 || snapshot.observations.size > this.maxDependencies) return value;
      const directories = snapshot.watchDirectories();
      if (!snapshot.matches()) continue;
      if (!snapshot.cacheable || directories.size > this.maxWatchers || snapshot.observations.size > this.maxDependencies) return value;
      while (this.entries.size >= this.maxEntries) this.remove(this.entries.keys().next().value!);
      while (this.watches.size + [...directories].filter(dir => !this.watches.has(dir)).length > this.maxWatchers && this.entries.size) this.remove(this.entries.keys().next().value!);
      const generation = this.generation;
      let watching = true;
      try {
        for (const dir of directories) {
          let existing = this.watches.get(dir);
          if (!existing) {
            const watcher = this.watch(dir, { persistent: false }, () => this.invalidateDirectory(dir));
            existing = { watcher, keys: new Set() };
            this.watches.set(dir, existing);
            watcher.on("error", () => this.invalidateDirectory(dir));
            watcher.on("close", () => { if (this.watches.get(dir)?.watcher === watcher) this.invalidateDirectory(dir); });
          }
          existing.keys.add(key);
        }
      } catch { watching = false; }
      const stable = snapshot.matches();
      if (watching && stable && !this.disposed && generation === this.generation) this.entries.set(key, { value, snapshot, directories });
      else this.release(key, directories);
      // Unsupported watchers affect admission, never an otherwise safe result.
      if (stable) return value;
    }
    throw new Error("Inkwell resolution changed while reading the filesystem. Retry after the files stop changing.");
  }

  clear(): void {
    this.generation++;
    for (const key of [...this.entries.keys()]) this.remove(key);
  }

  dispose(): void { this.disposed = true; this.clear(); }

  private invalidateDirectory(directory: string): void {
    this.generation++;
    const watch = this.watches.get(directory);
    if (!watch) return;
    for (const key of [...watch.keys]) this.remove(key);
    // An error can arrive while an entry is still acquiring its watchers.
    if (this.watches.get(directory) === watch) { this.watches.delete(directory); watch.watcher.close(); }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.release(key, entry.directories);
  }

  private release(key: string, directories: Set<string>): void {
    for (const dir of directories) {
      const watch = this.watches.get(dir);
      if (!watch) continue;
      watch.keys.delete(key);
      if (!watch.keys.size) { this.watches.delete(dir); watch.watcher.close(); }
    }
  }
}

/** Freeze objects/arrays, not Map containers (callers receive a new Map). */
export function freezeResolution<T>(value: T): T {
  const pending: unknown[] = [value], seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item); for (const child of Object.values(item)) pending.push(child); Object.freeze(item);
  }
  return value;
}

export const resolutionCache = new ResolutionCache({ enabled: false });
/** Register this with extension subscriptions; calling it never starts watchers. */
export function disposeResolutionCaches(): void { resolutionCache.dispose(); }
