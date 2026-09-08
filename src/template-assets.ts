// Content-addressed copies of packaged support files. TeX receives read-only
// independent files, never hard links into the installed extension.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

export interface TemplateAssetLease {
  directory: string;
  fingerprint?: string;
  cacheHit: boolean;
  release(): void;
}

interface Asset { relative: string; bytes: Buffer; hash: string }
interface Entry { directory: string; fingerprint: string; assets: Asset[]; bytes: number; leases: number; retired: boolean }

function within(directory: string, file: string): string | undefined {
  const relative = path.relative(directory, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : undefined;
}
function hash(bytes: Buffer | string): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function readBounded(file: string): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("Template support file exceeds cache bounds");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    const after = fs.fstatSync(descriptor);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Template support file changed while reading");
    return buffer.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
}

export class TemplateAssetCache {
  private readonly entries = new Map<string, Entry>();
  private readonly retired = new Set<Entry>();
  private root: string | undefined;
  private rootReal: string | undefined;
  private bytes = 0;

  constructor(private readonly parentDirectory = os.tmpdir(), private readonly maxEntries = 16, private readonly maxBytes = 64 * 1024 * 1024) {}

  acquire(sourceDirectory: string, files: readonly string[]): TemplateAssetLease | undefined {
    let pendingDirectory: string | undefined;
    try {
      if (!files.length || files.length > MAX_FILES) return undefined;
      const sourceReal = fs.realpathSync(sourceDirectory);
      const assets: Asset[] = [];
      let bytes = 0;
      for (const file of [...files].sort()) {
        const relative = within(sourceDirectory, file);
        if (!relative || !within(sourceReal, fs.realpathSync(file))) return undefined;
        const data = readBounded(file);
        bytes += data.length;
        if (bytes > MAX_ENTRY_BYTES || bytes > this.maxBytes) return undefined;
        assets.push({ relative, bytes: data, hash: hash(data) });
      }
      const fingerprint = hash(JSON.stringify(assets.map(asset => [asset.relative, asset.hash])));
      let entry = this.entries.get(fingerprint);
      let cacheHit = !!entry;
      // A TeX process cannot normally modify these read-only files, but the
      // owning account can. Verify every reused copy before another document
      // can consume it, including links and permissions.
      if (entry && !this.matches(entry)) {
        this.entries.delete(fingerprint); this.retire(entry); entry = undefined; cacheHit = false;
      }
      if (!entry) {
        if (!this.makeRoom(bytes)) return undefined;
        if (!this.root) {
          this.root = fs.mkdtempSync(path.join(this.parentDirectory, "inkwell-template-assets-"));
          this.rootReal = fs.realpathSync(this.root);
        }
        if (!this.rootIsOriginal()) return undefined;
        pendingDirectory = fs.mkdtempSync(path.join(this.root, `${fingerprint.slice(0, 16)}-`));
        for (const asset of assets) {
          const destination = path.join(pendingDirectory, asset.relative);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, asset.bytes, { flag: "wx", mode: 0o400 });
        }
        this.readOnlyDirectories(pendingDirectory);
        entry = { directory: pendingDirectory, fingerprint, assets, bytes, leases: 0, retired: false };
        pendingDirectory = undefined;
        this.entries.set(fingerprint, entry); this.bytes += bytes;
      } else { this.entries.delete(fingerprint); this.entries.set(fingerprint, entry); }
      entry.leases++;
      const leased = entry;
      let released = false;
      return { directory: leased.directory, fingerprint, cacheHit,
        release: () => {
          if (released) return;
          released = true; leased.leases--;
          if (!leased.leases && leased.retired) this.remove(leased);
        } };
    } catch {
      if (pendingDirectory) this.removeDirectory(pendingDirectory);
      return undefined;
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) this.retire(entry);
    this.entries.clear();
    this.cleanupRoot();
  }

  private matches(entry: Entry): boolean {
    try {
      if (!this.rootIsOriginal() || !this.rootReal || fs.lstatSync(entry.directory).isSymbolicLink()) return false;
      const root = fs.realpathSync(entry.directory);
      if (path.dirname(root) !== this.rootReal || root !== path.join(this.rootReal, path.basename(entry.directory))) return false;
      const expected = new Set(entry.assets.map(asset => asset.relative));
      const walk = (directory: string): boolean => {
        if ((fs.statSync(directory).mode & 0o222) !== 0) return false;
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, item.name);
          if (item.isDirectory()) { if (!walk(file)) return false; }
          else if (!item.isFile() || !expected.delete(path.relative(entry.directory, file))) return false;
        }
        return true;
      };
      if (!walk(entry.directory) || expected.size) return false;
      for (const asset of entry.assets) {
        const file = path.join(entry.directory, asset.relative);
        if (!within(root, fs.realpathSync(file)) || (fs.statSync(file).mode & 0o222) !== 0 || hash(readBounded(file)) !== asset.hash) return false;
      }
      return true;
    } catch { return false; }
  }

  private rootIsOriginal(): boolean {
    if (!this.root || !this.rootReal) return false;
    return !fs.lstatSync(this.root).isSymbolicLink() && fs.realpathSync(this.root) === this.rootReal;
  }

  private makeRoom(bytes: number): boolean {
    for (const [key, entry] of this.entries) {
      if (this.entries.size + this.retired.size < this.maxEntries && this.bytes + bytes <= this.maxBytes) break;
      if (entry.leases) continue;
      this.entries.delete(key); this.retire(entry);
    }
    return this.entries.size + this.retired.size < this.maxEntries && this.bytes + bytes <= this.maxBytes;
  }

  private retire(entry: Entry): void {
    entry.retired = true; this.retired.add(entry);
    if (!entry.leases) this.remove(entry);
  }

  private remove(entry: Entry): void {
    if (this.removeDirectory(entry.directory)) { this.retired.delete(entry); this.bytes -= entry.bytes; this.cleanupRoot(); }
  }

  private cleanupRoot(): void {
    if (this.entries.size || this.retired.size) return;
    try {
      if (!this.rootIsOriginal()) return;
      fs.rmdirSync(this.root!); this.root = undefined; this.rootReal = undefined;
    } catch { /* A damaged/nonempty cache root is never removed recursively. */ }
  }

  private readOnlyDirectories(directory: string): void {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory()) this.readOnlyDirectories(path.join(directory, item.name));
    }
    fs.chmodSync(directory, 0o500);
  }

  private removeDirectory(directory: string): boolean {
    try {
      if (!this.rootIsOriginal() || path.dirname(directory) !== this.root) return false;
      // Only make our own real directories writable; never follow a link
      // introduced by external edits while retiring a damaged cache entry.
      const writable = (dir: string) => {
        if (!fs.lstatSync(dir).isDirectory()) return;
        fs.chmodSync(dir, 0o700);
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) writable(path.join(dir, item.name));
      };
      writable(directory); fs.rmSync(directory, { recursive: true, force: true });
      return true;
    } catch { return !fs.existsSync(directory); }
  }
}

export const templateAssetCache = new TemplateAssetCache();
process.once("exit", () => templateAssetCache.clear());
