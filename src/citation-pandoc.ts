import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { stringify } from "yaml";
import MarkdownIt from "markdown-it";
import { resolveContainedPath } from "./bundled-assets";
import { buildTexInvocationPath } from "./shell-env";
import { executeRunProcess, ProcessOutcome } from "./run-process";
import { bibliographyMetadata, bibliographyService, BibliographySnapshot, ResolvedReferences, validateReferencePath } from "./bibliography-service";
import type { CitationRenderResult } from "./citations";

interface PandocIdentity { binary: string; version: string; signature: string }
interface CitationCache {
  schemaVersion: 2; engine: "pandoc"; fingerprint: string; body: string; resolved: string[]; missing: string[];
}
interface CitationPandocDependencies {
  environment?: () => NodeJS.ProcessEnv;
  findBinary?: (environment: NodeJS.ProcessEnv) => string | undefined;
  run?: typeof executeRunProcess;
  now?: () => number;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const decodeHtml = new MarkdownIt().utils.unescapeAll;
const successful = (result: ProcessOutcome) => result.exitCode === 0 && !result.signal && !result.error && !result.cancelled && !result.timedOut && !result.maxBufferExceeded;
function findPandoc(environment: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (environment.PATH || "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(directory, process.platform === "win32" ? "pandoc.exe" : "pandoc");
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch {}
  }
  return undefined;
}
function signature(file: string): string {
  try { const stat = fs.statSync(file); return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
  catch { return `${file}:missing`; }
}
function decodeCache(value: unknown, fingerprint: string): CitationCache | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as CitationCache;
  if (candidate.schemaVersion !== 2 || candidate.engine !== "pandoc" || candidate.fingerprint !== fingerprint || typeof candidate.body !== "string"
    || !Array.isArray(candidate.resolved) || !Array.isArray(candidate.missing) || ![...candidate.resolved, ...candidate.missing].every(key => typeof key === "string")) return undefined;
  return candidate;
}
/** One bounded in-flight render per exact content/config/tool fingerprint. */
export class CitationPandocEngine {
  private identity?: PandocIdentity;
  private probe?: Promise<PandocIdentity | undefined>;
  private environmentKey?: string;
  private negativeUntil = 0;
  private epoch = 0;
  private readonly inFlight = new Map<string, Promise<CitationCache | undefined>>();
  private readonly memory = new Map<string, CitationCache>();
  private readonly failures = new Map<string, string>();
  constructor(private readonly dependencies: CitationPandocDependencies = {}) {}
  invalidate(): void { this.epoch++; this.identity = undefined; this.probe = undefined; this.environmentKey = undefined; this.negativeUntil = 0; this.memory.clear(); this.failures.clear(); this.inFlight.clear(); bibliographyService.invalidate(); }
  private async locate(root: string): Promise<PandocIdentity | undefined> {
    const environment = this.dependencies.environment?.() || { ...process.env, PATH: buildTexInvocationPath() };
    const envKey = [environment.PATH, environment.PATHEXT, environment.SHELL].join("\0");
    if (this.environmentKey !== envKey) { this.invalidate(); this.environmentKey = envKey; }
    const now = (this.dependencies.now || Date.now)();
    if (this.identity && signature(this.identity.binary) === this.identity.signature) return this.identity;
    if (now < this.negativeUntil) return undefined;
    if (this.probe) return this.probe;
    const epoch = this.epoch;
    const promise = (async () => {
      const binary = (this.dependencies.findBinary || findPandoc)(environment);
      if (!binary) { if (epoch === this.epoch) this.negativeUntil = now + 2000; return undefined; }
      const result = await (this.dependencies.run || executeRunProcess)(binary, ["--version"], { cwd: root, env: environment, timeoutMs: 5000, maxBuffer: 65536 });
      const version = result.stdout.match(/^pandoc\s+[^\r\n]+/i)?.[0];
      if (!successful(result) || !version) { if (epoch === this.epoch) this.negativeUntil = now + 2000; return undefined; }
      const identity = { binary, version, signature: signature(binary) };
      if (epoch === this.epoch) { this.identity = identity; this.negativeUntil = 0; }
      return epoch === this.epoch ? identity : undefined;
    })();
    this.probe = promise;
    try { return await promise; } finally { if (this.probe === promise) this.probe = undefined; }
  }
  async render(markdown: string, references: ResolvedReferences, projectRoot: string, reportFailure?: (reason: string) => void): Promise<CitationRenderResult | undefined> {
    if (!markdown.includes("@") && !references.nocite.length) return undefined;
    const identity = await this.locate(projectRoot);
    if (!identity) { reportFailure?.("Pandoc is unavailable or its version check failed. Run Setup / Repair."); return undefined; }
    const epoch = this.epoch;
    const snapshot = await bibliographyService.snapshot(references, identity.version);
    if (snapshot.diagnostics.some(item => item.severity === "error")) { reportFailure?.(snapshot.diagnostics.filter(item => item.severity === "error").map(item => item.message).join("\n")); return undefined; }
    const filters = path.join(__dirname, "..", "filters");
    const filterNames = ["reference-common.lua", "reference-prepare.lua", "reference-render.lua", "section-bibliographies.lua", "table-common.lua"];
    const filterHashes = await Promise.all(filterNames.map(async name => digest(await fs.promises.readFile(path.join(filters, name), "utf8"))));
    const fingerprint = digest(JSON.stringify([3, markdown, snapshot.fingerprint, identity.signature, filterHashes]));
    if (epoch !== this.epoch) return undefined;
    let result = this.memory.get(fingerprint);
    if (!result) {
      let pending = this.inFlight.get(fingerprint);
      if (!pending) {
        pending = this.renderOnce(markdown, references, snapshot, projectRoot, identity, fingerprint, filters, epoch);
        this.inFlight.set(fingerprint, pending);
      }
      try { result = await pending; } finally { if (this.inFlight.get(fingerprint) === pending) this.inFlight.delete(fingerprint); }
      if (epoch !== this.epoch) return undefined;
    }
    if (result) {
      // Cached results need the same final input check as newly rendered ones:
      // a bibliography can change while an asynchronous cache read is pending.
      const latest = await bibliographyService.snapshot(references, identity.version);
      if (epoch !== this.epoch) return undefined;
      if (latest.fingerprint !== snapshot.fingerprint || signature(identity.binary) !== identity.signature) {
        reportFailure?.("Bibliography, CSL, or Pandoc changed while citations were being read. Retry the preview.");
        return undefined;
      }
      this.memory.set(fingerprint, result);
      while (this.memory.size > 32) this.memory.delete(this.memory.keys().next().value!);
    }
    if (!result) reportFailure?.(this.failures.get(fingerprint) || "Pandoc could not render the selected bibliography and CSL.");
    return result ? { body: result.body, resolvedKeys: new Set(result.resolved), missingKeys: new Set(result.missing), engine: "pandoc", referencesEmbedded: true } : undefined;
  }
  private async renderOnce(markdown: string, references: ResolvedReferences, snapshot: BibliographySnapshot, root: string, identity: PandocIdentity, fingerprint: string, filters: string, epoch: number): Promise<CitationCache | undefined> {
    const realRoot = fs.realpathSync(root), directory = ".inkwell/.cache/preview-cites", cache = `${directory}/${fingerprint}.json`;
    const contained = (relative: string): string => {
      if (fs.realpathSync(root) !== realRoot) throw new Error("The citation cache project root changed during rendering.");
      const file = resolveContainedPath(root, relative);
      try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Citation cache files must not be symbolic links."); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
      return file;
    };
    // Reject an unsafe cache before even attempting a read. A failed read may
    // otherwise hide an outward symlink and turn a cache miss into an escape.
    contained(cache);
    try {
      if ((await fs.promises.stat(contained(cache))).size <= 32 * 1024 * 1024) {
        const result = decodeCache(JSON.parse(await fs.promises.readFile(contained(cache), "utf8")), fingerprint); if (result) return result;
      }
    } catch {}
    await fs.promises.mkdir(contained(directory), { recursive: true });
    const staging = `${directory}/${fingerprint}.${randomUUID()}`, input = `${staging}/input.md`, temporary = `${cache}.${randomUUID()}.tmp`;
    await fs.promises.mkdir(contained(staging));
    const fail = (message: string): undefined => {
      this.failures.set(fingerprint, message.slice(0, 3000));
      while (this.failures.size > 32) this.failures.delete(this.failures.keys().next().value!);
      return undefined;
    };
    try {
      const copyInput = async (source: string, relative: string, expectedHash: string | undefined, builtin = false): Promise<string> => {
        if (!builtin) validateReferencePath(root, source);
        const bytes = await fs.promises.readFile(source);
        if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("Bibliography or CSL changed while citation inputs were being staged. Retry the preview.");
        await fs.promises.writeFile(contained(relative), bytes, { flag: "wx" });
        return contained(relative);
      };
      const bibliography = [];
      for (let i = 0; i < references.bibliography.length; i++) {
        const source = references.bibliography[i];
        bibliography.push(await copyInput(source, `${staging}/bibliography-${i}${path.extname(source) || ".bib"}`, snapshot.contentHashes[source]));
      }
      const csl = references.csl ? await copyInput(references.csl, `${staging}/style.csl`, snapshot.cslHash, references.cslSource?.source === "builtin") : undefined;
      if (epoch !== this.epoch) return undefined;
      await fs.promises.writeFile(contained(input), `---\n${stringify({ ...bibliographyMetadata({ ...references, bibliography, csl }), "inkwell-preview-citations": true })}---\n\n${markdown}`, { flag: "wx" });
      const args = ["--from=markdown", "--to=commonmark_x-raw_attribute", "--wrap=none"];
      if (references.scope === "section") args.push("--lua-filter", path.join(filters, "section-bibliographies.lua"));
      else args.push("--lua-filter", path.join(filters, "reference-prepare.lua"), "--citeproc");
      args.push("--lua-filter", path.join(filters, "reference-render.lua"), contained(input));
      const outcome = await (this.dependencies.run || executeRunProcess)(identity.binary, args, {
        cwd: root, env: this.dependencies.environment?.() || { ...process.env, PATH: buildTexInvocationPath() }, timeoutMs: 15000, maxBuffer: 32 * 1024 * 1024,
      });
      if (!successful(outcome)) {
        return fail(outcome.stderr || outcome.error || "Pandoc did not finish successfully.");
      }
      if (epoch !== this.epoch) return undefined;
      const latest = await bibliographyService.snapshot(references, identity.version);
      if (latest.fingerprint !== snapshot.fingerprint || signature(identity.binary) !== identity.signature) return fail("Bibliography, CSL, or Pandoc changed during citation rendering. Retry the preview.");
      const missing = [...new Set([...outcome.stderr.matchAll(/Citeproc: citation ([^\r\n]+?) not found/g)].map(match => match[1]))];
      const keys = new Set([...outcome.stdout.matchAll(/data-cites="([^"]*)"/g)].flatMap(match => decodeHtml(match[1]).split(/\s+/)).filter(Boolean));
      const result: CitationCache = { schemaVersion: 2, engine: "pandoc", fingerprint, body: outcome.stdout,
        resolved: [...keys].filter(key => !missing.includes(key)), missing };
      await fs.promises.writeFile(contained(temporary), JSON.stringify(result), { flag: "wx" });
      if (epoch !== this.epoch) return undefined;
      await fs.promises.rename(contained(temporary), contained(cache));
      return result;
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    finally {
      // Recheck containment during cleanup too; a replaced parent must never
      // make recursive removal touch another directory.
      await Promise.allSettled([staging, temporary].map(async relative => fs.promises.rm(contained(relative), { recursive: relative === staging, force: true })));
    }
  }
}
export const citationPandocEngine = new CitationPandocEngine();
export const invalidateCitationPandoc = () => citationPandocEngine.invalidate();
