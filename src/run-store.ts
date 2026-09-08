/** Provenance-backed run storage. No VS Code dependency; all paths are explicit. */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import type { CodeBlock, BlockResult, ResolvedInterpreter } from "./runner";
import type { ProcessOutcome } from "./run-process";
import { BLOCK_ID_PATTERN, blockIdentityErrors } from "./run-attributes";
import { containedRunPath, relativeRunPath } from "./run-paths";
import { DEFAULT_RUN_LIMITS, RunLimits } from "./run-limits";

export const RUN_SCHEMA_VERSION = 1;
export const sha256 = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
const digest = (value: unknown): string => sha256(JSON.stringify(value));
const safeId = (value: string): string => `${value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "block"}-${sha256(value).slice(0, 12)}`;

export interface FileMetadata { path: string; mediaType: string; bytes: number; sha256: string }
export interface RunFingerprint {
  hash: string;
  sourceHash: string;
  sourcePath: string;
  inputs: Record<string, string>;
  upstream: Record<string, string>;
  interpreter: { path: string; version: string; identity: string };
  environmentHash: string;
  lockfiles: Record<string, string>;
}
export interface RunManifest {
  schemaVersion: 1;
  generation: string;
  runId: string;
  documentId: string;
  blockId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  fingerprint: RunFingerprint;
  source: { path: string; sha256: string };
  argv: string[];
  status: "success" | "failed" | "cancelled";
  process: Omit<ProcessOutcome, "stdout" | "stderr">;
  stdout: FileMetadata;
  stderr: FileMetadata;
  artifacts: FileMetadata[];
}
export interface RunAttempt { generation: string; runId: string; blockId: string; directory: string; artifactsDir: string; startedAt: string; persistent: boolean }
interface RunPointer { schemaVersion: 1; runId: string; manifestHash: string }
interface VerifiedRun { manifest: RunManifest; path: string; stdout: string; stderr: string; artifacts: Map<string, string> }
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[a-f0-9-]{36}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === "string" && HASH_PATTERN.test(value);
const hashes = (value: unknown, allowMissing = false): boolean => object(value) && Object.values(value).every(item => hash(item) || (allowMissing && item === "missing"));

function successfulManifest(value: unknown, documentId: string, blockId: string, runId: string, generation: string): value is RunManifest {
  if (!object(value) || value.schemaVersion !== 1 || value.generation !== generation || value.documentId !== documentId || value.blockId !== blockId || value.runId !== runId || value.status !== "success") return false;
  if (typeof value.startedAt !== "string" || typeof value.endedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.endedAt)) || Date.parse(value.endedAt) < Date.parse(value.startedAt) || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) return false;
  const process = value.process;
  if (!object(process) || process.exitCode !== 0 || process.rawExitCode !== 0 || process.signal !== null || process.timedOut !== false || process.cancelled !== false || process.maxBufferExceeded !== false || (process.error !== undefined && process.error !== "")) return false;
  const fingerprint = value.fingerprint;
  if (!object(fingerprint) || !hash(fingerprint.hash) || !hash(fingerprint.sourceHash) || typeof fingerprint.sourcePath !== "string" || !fingerprint.sourcePath || !hash(fingerprint.environmentHash) || !hashes(fingerprint.inputs) || !hashes(fingerprint.upstream) || !hashes(fingerprint.lockfiles, true)) return false;
  const interpreter = fingerprint.interpreter;
  if (!object(interpreter) || typeof interpreter.path !== "string" || !interpreter.path || typeof interpreter.version !== "string" || !interpreter.version || !hash(interpreter.identity)) return false;
  if (!object(value.source) || typeof value.source.path !== "string" || !value.source.path || value.source.sha256 !== fingerprint.sourceHash || !Array.isArray(value.argv) || !value.argv.length || !value.argv.every(argument => typeof argument === "string") || !Array.isArray(value.artifacts)) return false;
  return object(value.stdout) && value.stdout.path === "stdout.txt" && object(value.stderr) && value.stderr.path === "stderr.txt";
}

function atomicJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx" }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function regularFile(file: string): boolean {
  try { return fs.lstatSync(file).isFile(); } catch { return false; }
}
function hashFile(file: string): string {
  let descriptor: number | undefined;
  try {
    if (!fs.statSync(file).isFile()) return "missing";
    descriptor = fs.openSync(file, "r");
    const hash = crypto.createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes: number;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function listFiles(dir: string, root: string, limit = 100_000): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  containedRunPath(root, dir, false, true);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    containedRunPath(root, full, false, true);
    if (entry.isFile()) files.push(full);
    else if (entry.isDirectory()) files.push(...listFiles(full, root, limit - files.length));
    if (files.length > limit) throw new Error("Run file expansion exceeds the safe traversal limit.");
  }
  return files;
}
function containedFile(projectRoot: string, dir: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined;
  const full = path.resolve(dir, relative);
  if (!full.startsWith(path.resolve(dir) + path.sep)) return undefined;
  containedRunPath(projectRoot, full, false, true);
  // Every component must be real, so symlinks cannot escape a manifest's history.
  let cursor = full;
  while (cursor !== path.resolve(dir)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) return undefined; } catch { return undefined; }
    cursor = path.dirname(cursor);
  }
  return regularFile(full) ? full : undefined;
}
function mediaType(file: string): string {
  const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".csv": "text/csv", ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html" };
  return types[path.extname(file).toLowerCase()] || "application/octet-stream";
}
function metadata(projectRoot: string, directory: string, file: string): FileMetadata {
  containedRunPath(projectRoot, file, false, true);
  return { path: path.relative(directory, file).split(path.sep).join("/"), mediaType: mediaType(file), bytes: fs.statSync(file).size, sha256: hashFile(file) };
}
function validateMetadata(projectRoot: string, dir: string, item: unknown, limit: number, capture = false): { path: string; text: string } | undefined {
  if (!object(item) || typeof item.path !== "string" || !hash(item.sha256) || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > limit) return undefined;
  const full = containedFile(projectRoot, dir, item.path);
  if (!full) return undefined;
  if (item.mediaType !== mediaType(full)) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size !== item.bytes) return undefined;
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, item.bytes + 1));
    const chunks: Buffer[] = [];
    let bytes = 0; let count: number;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > item.bytes) return undefined;
      digest.update(buffer.subarray(0, count));
      if (capture) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fs.fstatSync(descriptor);
    containedRunPath(projectRoot, full, false, true);
    const current = fs.lstatSync(full);
    if (bytes !== item.bytes || digest.digest("hex") !== item.sha256 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== after.ino || current.dev !== after.dev) return undefined;
    return { path: full, text: capture ? Buffer.concat(chunks).toString("utf8") : "" };
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

const interpreterCache = new Map<string, { version: string; identity: string }>();
function interpreterIdentity(interpreter: ResolvedInterpreter): RunFingerprint["interpreter"] {
  const searchPath = interpreter.envVars.PATH || process.env.PATH || "";
  let executable = interpreter.cmd;
  if (!path.isAbsolute(executable)) {
    const found = searchPath.split(path.delimiter).map(dir => path.join(dir, executable)).find(file => {
      try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
    });
    if (found) executable = path.resolve(found);
  }
  let identity = "missing";
  try {
    const resolved = fs.realpathSync(executable); const stat = fs.statSync(resolved);
    identity = digest([resolved, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch {}
  let cached = interpreterCache.get(identity);
  if (!cached) {
    let version = "unavailable";
    try { version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, stdio: "pipe", env: { ...process.env, ...interpreter.envVars } }).trim(); } catch {}
    cached = { version, identity }; interpreterCache.set(identity, cached);
  }
  return { path: executable, ...cached };
}

function globRegex(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index++;
      if (pattern[index + 1] === "/") { index++; expression += "(?:.*/)?"; }
      else expression += ".*";
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}
function inputHashes(patterns: string[], projectRoot: string, limits: RunLimits): Record<string, string> {
  const matched = new Set<string>();
  const hashes: Record<string, string> = {};
  for (const pattern of patterns) {
    relativeRunPath(pattern);
    const absolute = path.resolve(projectRoot, pattern);
    const wildcard = /[?*]/.test(pattern);
    if (!wildcard) {
      containedRunPath(projectRoot, absolute, true);
      if (!fs.existsSync(absolute)) { hashes[pattern] = "missing"; continue; }
      if (!fs.statSync(absolute).isFile()) throw new Error(`Declared input is not a regular file: ${pattern}`);
      matched.add(absolute);
    } else {
      const fixed = absolute.slice(0, absolute.search(/[?*]/));
      const searchRoot = path.dirname(fixed.endsWith(path.sep) ? fixed + "_" : fixed);
      containedRunPath(projectRoot, searchRoot, true);
      const matcher = globRegex(absolute.split(path.sep).join("/"));
      let count = 0;
      const walk = (directory: string): void => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (++count > 100_000) throw new Error("Input glob exceeds the safe traversal limit; use a narrower pattern.");
          const candidate = path.join(directory, entry.name);
          const relative = path.relative(projectRoot, candidate).split(path.sep).join("/");
          if (relative.split("/").includes(".git") || /^\.inkwell\/(runs|outputs|compiled|mermaid|\.cache|venv)(\/|$)/.test(relative)) continue;
          containedRunPath(projectRoot, candidate);
          // Do not recurse through input symlinks, which can form directory cycles.
          if (entry.isDirectory()) walk(candidate);
          else if (matcher.test(candidate.split(path.sep).join("/"))) {
            if (!fs.statSync(candidate).isFile()) throw new Error(`Declared input is not a regular file: ${candidate}`);
            matched.add(candidate);
            if (matched.size > limits.maxInputPaths) throw new Error(`Declared inputs exceed ${limits.maxInputPaths} paths.`);
          }
        }
      };
      walk(searchRoot);
      if (![...matched].some(file => matcher.test(file.split(path.sep).join("/")))) hashes[pattern] = "missing";
    }
    if (matched.size > limits.maxInputPaths) throw new Error(`Declared inputs exceed ${limits.maxInputPaths} paths.`);
  }
  let bytes = 0;
  for (const file of [...matched].sort()) {
    containedRunPath(projectRoot, file);
    bytes += fs.statSync(file).size;
    if (bytes > limits.maxInputBytes) throw new Error(`Declared input content exceeds ${limits.maxInputBytes} bytes.`);
    hashes[path.relative(projectRoot, file).split(path.sep).join("/")] = hashFile(file);
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

/** Legacy document-relative scripts remain supported; every selection is contained. */
export function resolveRunSource(file: string, docDir: string, projectRoot: string): string {
  relativeRunPath(file);
  const canonical = file.replaceAll("\\", "/").replace(/^\.\//, "").startsWith(".inkwell/scripts/");
  const candidates = canonical ? [path.resolve(projectRoot, file)] : [path.resolve(docDir, file), path.resolve(projectRoot, file)];
  const selected = candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
  containedRunPath(projectRoot, selected, true);
  if (fs.existsSync(selected) && !fs.statSync(selected).isFile()) throw new Error(`Run source is not a regular file: ${file}`);
  return selected;
}

const pythonSiteCache = new Map<string, string[]>();
function pythonPackagePaths(interpreter: RunFingerprint["interpreter"], environment: NodeJS.ProcessEnv): string[] {
  const key = digest([interpreter.path, interpreter.identity, environment.PYTHONHOME, environment.PYTHONPATH, environment.VIRTUAL_ENV]);
  let paths = pythonSiteCache.get(key);
  if (!paths) {
    paths = [];
    try {
      const output = execFileSync(interpreter.path, ["-c", "import json,site; print(json.dumps(site.getsitepackages()+[site.getusersitepackages()]))"], {
        encoding: "utf8", timeout: 5000, stdio: "pipe", env: environment,
      });
      const parsed: unknown = JSON.parse(output);
      if (Array.isArray(parsed)) paths = parsed.filter((value): value is string => typeof value === "string" && path.isAbsolute(value));
    } catch {}
    pythonSiteCache.set(key, paths);
  }
  return paths;
}
function recordPythonPackages(site: string, lockfiles: Record<string, string>): void {
  if (!fs.existsSync(site)) return;
  for (const entry of fs.readdirSync(site).sort()) {
    if (entry.endsWith(".dist-info") || entry.endsWith(".egg-info")) {
      const candidate = path.join(site, entry);
      const file = fs.statSync(candidate).isDirectory() ? path.join(candidate, entry.endsWith(".dist-info") ? "METADATA" : "PKG-INFO") : candidate;
      lockfiles[file] = hashFile(file);
    }
  }
}

export function fingerprintBlock(block: CodeBlock, docDir: string, projectRoot: string,
  interpreter: ResolvedInterpreter, upstream: Record<string, string> = {}, limits: RunLimits = DEFAULT_RUN_LIMITS): RunFingerprint {
  let sourcePath = "inline";
  if (block.file) {
    sourcePath = resolveRunSource(block.file, docDir, projectRoot);
  }
  const sourceHash = block.file ? hashFile(sourcePath) : sha256(block.source);
  const inputs = inputHashes(block.inputs || [], projectRoot, limits);
  const lockNames = ["requirements.txt", "requirements.lock", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "renv.lock", "environment.yml"];
  const lockfiles: Record<string, string> = {};
  for (const base of [...new Set([projectRoot, docDir, path.join(projectRoot, ".inkwell")])].sort()) {
    for (const name of lockNames) { const file = path.join(base, name); containedRunPath(projectRoot, file, true); lockfiles[file] = hashFile(file); }
  }
  const resolvedInterpreter = interpreterIdentity(interpreter);
  const virtualRoot = interpreter.envVars.VIRTUAL_ENV;
  if (virtualRoot) {
    lockfiles[path.join(virtualRoot, "pyvenv.cfg")] = hashFile(path.join(virtualRoot, "pyvenv.cfg"));
    // Installed distribution metadata changes when packages are added, removed, or upgraded.
    const lib = path.join(virtualRoot, "lib");
    if (fs.existsSync(lib)) for (const version of fs.readdirSync(lib).sort()) {
      const site = path.join(lib, version, "site-packages");
      recordPythonPackages(site, lockfiles);
    }
  }
  if (block.lang.toLowerCase().startsWith("python")) {
    for (const site of pythonPackagePaths(resolvedInterpreter, { ...process.env, ...interpreter.envVars })) recordPythonPackages(site, lockfiles);
  }
  const allowedEnvironment = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "PYTHONPATH", "PYTHONHOME", "PYTHONHASHSEED", "VIRTUAL_ENV", "CONDA_PREFIX", "NODE_PATH", "NODE_OPTIONS", "R_HOME", "R_LIBS", "R_LIBS_USER"]);
  const environment = Object.entries({ ...process.env, ...interpreter.envVars }).filter(([key]) => allowedEnvironment.has(key)).sort(([a], [b]) => a.localeCompare(b));
  const environmentHash = digest(environment); // Store hashes only; never persist environment values/secrets.
  const values = { sourceHash, sourcePath, inputs, upstream, interpreter: resolvedInterpreter, environmentHash, lockfiles };
  const hash = digest({ ...values, language: block.lang, env: block.env, output: block.output,
    args: interpreter.args, ordinal: block.index });
  return { hash, ...values };
}

export class RunStore {
  readonly documentId: string;
  readonly directory: string;
  private generation?: string;
  private readonly publications = new Map<string, { blockId: string; previous?: RunPointer }>();
  constructor(readonly projectRoot: string, readonly sourceFile: string, readonly limits: RunLimits = DEFAULT_RUN_LIMITS) {
    containedRunPath(projectRoot, sourceFile, true);
    this.documentId = safeId(path.relative(projectRoot, path.resolve(sourceFile)).split(path.sep).join("/"));
    this.directory = path.join(projectRoot, ".inkwell", "runs", this.documentId);
    this.guard(this.directory, true);
  }
  private guard(file: string, allowMissing = false): string {
    return containedRunPath(this.projectRoot, file, allowMissing, true);
  }
  private documentGeneration(): string | undefined {
    try {
      const document: unknown = JSON.parse(fs.readFileSync(this.guard(path.join(this.directory, "document.json")), "utf8"));
      return object(document) && document.schemaVersion === 1 && document.sourceFile === path.resolve(this.sourceFile)
        && typeof document.generation === "string" && RUN_ID_PATTERN.test(document.generation) ? document.generation : undefined;
    } catch { return undefined; }
  }
  assignBlockIds(blocks: CodeBlock[], persist = false): string[] {
    const errors = blockIdentityErrors(blocks);
    if (errors.size) throw new Error([...errors].map(([line, messages]) => `Line ${line}: ${messages.join(" ")}`).join("\n"));
    const mapFile = this.guard(path.join(this.directory, "document.json"), true);
    let generation = crypto.randomUUID();
    if (fs.existsSync(mapFile)) {
      const document = JSON.parse(fs.readFileSync(mapFile, "utf8"));
      if (document.schemaVersion !== 1 || typeof document.generation !== "string" || document.sourceFile !== path.resolve(this.sourceFile)) throw new Error(`Invalid run identity mapping: ${mapFile}`);
      generation = document.generation;
    }
    // Anonymous results are session-only and never share an identity across reads.
    const ids = blocks.map(block => block.id || block.label || `session-${crypto.randomUUID()}`);
    this.generation = generation;
    if (persist) atomicJson(mapFile, { schemaVersion: 1, generation, sourceFile: path.resolve(this.sourceFile) });
    return ids;
  }
  isCurrentGeneration(): boolean {
    return Boolean(this.generation) && this.documentGeneration() === this.generation;
  }
  begin(blockId: string, persistent = true): RunAttempt {
    if (!BLOCK_ID_PATTERN.test(blockId)) throw new Error("Invalid block ID.");
    if (!this.isCurrentGeneration()) throw new Error("Run cache was cleared; start a new run.");
    const generation = this.generation!;
    const runId = crypto.randomUUID();
    const directory = path.join(this.directory, blockId, "staging", runId);
    const artifactsDir = path.join(directory, "artifacts");
    this.guard(artifactsDir, true);
    fs.mkdirSync(artifactsDir, { recursive: true });
    atomicJson(this.guard(path.join(this.directory, blockId, "latest-attempt.json"), true), { schemaVersion: 1, generation, runId });
    return { generation, runId, blockId, directory, artifactsDir, startedAt: new Date().toISOString(), persistent };
  }
  private isLatestAttempt(attempt: RunAttempt): boolean {
    try {
      const latest: unknown = JSON.parse(fs.readFileSync(this.guard(path.join(this.directory, attempt.blockId, "latest-attempt.json")), "utf8"));
      return object(latest) && latest.schemaVersion === 1 && latest.generation === attempt.generation && latest.runId === attempt.runId;
    } catch { return false; }
  }
  finish(attempt: RunAttempt, fingerprint: RunFingerprint, argv: string[], outcome: ProcessOutcome): RunManifest {
    this.guard(attempt.directory);
    const currentGeneration = this.documentGeneration();
    if (!currentGeneration || currentGeneration !== attempt.generation) {
      fs.rmSync(attempt.directory, { recursive: true, force: true });
      throw new Error("Run cache was cleared during execution; result was discarded.");
    }
    if (!this.isLatestAttempt(attempt)) {
      outcome.exitCode = 1; outcome.error = "A newer run attempt superseded this result.";
      outcome.stderr = outcome.error;
    }
    let artifactFiles: string[] = [];
    try {
      this.guard(attempt.artifactsDir);
      artifactFiles = listFiles(attempt.artifactsDir, this.projectRoot);
      let bytes = 0;
      for (const file of artifactFiles) {
        const size = fs.statSync(this.guard(file)).size; bytes += size;
        if (size > this.limits.maxArtifactBytes || bytes > this.limits.maxArtifactTotalBytes) throw new Error("Generated artifacts exceed the configured per-file or total byte limit.");
      }
    } catch (error) { outcome.exitCode = 1; outcome.error = String(error); }
    for (const [stream, limit] of [["stdout", this.limits.maxStdoutBytes], ["stderr", this.limits.maxStderrBytes]] as const) {
      if (Buffer.byteLength(outcome[stream]) > limit) {
        outcome[stream] = Buffer.from(outcome[stream]).subarray(0, limit).toString("utf8");
        outcome.exitCode = 1; outcome.maxBufferExceeded = true; outcome.error = `${stream} exceeded ${limit} bytes.`;
      }
    }
    const names = artifactFiles.map(file => path.basename(file, path.extname(file)));
    if (outcome.exitCode === 0 && outcome.rawExitCode !== 0) {
      outcome.exitCode = 1; outcome.error = "No clean process exit was recorded.";
    }
    if (new Set(names).size !== names.length && outcome.exitCode === 0) {
      outcome.exitCode = 1; outcome.error = "Generated artifacts have duplicate names; give each artifact a unique filename.";
    }
    if (outcome.error && !outcome.stderr) outcome.stderr = outcome.error;
    fs.writeFileSync(this.guard(path.join(attempt.directory, "stdout.txt"), true), outcome.stdout);
    fs.writeFileSync(this.guard(path.join(attempt.directory, "stderr.txt"), true), outcome.stderr);
    const processResult = { exitCode: outcome.exitCode, rawExitCode: outcome.rawExitCode ?? null, signal: outcome.signal, timedOut: outcome.timedOut,
      cancelled: outcome.cancelled, maxBufferExceeded: outcome.maxBufferExceeded, error: outcome.error };
    const success = outcome.exitCode === 0 && outcome.rawExitCode === 0 && !outcome.signal && !outcome.cancelled && !outcome.timedOut && !outcome.maxBufferExceeded && !outcome.error;
    const manifest: RunManifest = {
      schemaVersion: 1, generation: attempt.generation, runId: attempt.runId, documentId: this.documentId, blockId: attempt.blockId,
      startedAt: attempt.startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(attempt.startedAt),
      fingerprint, source: { path: fingerprint.sourcePath === "inline" ? path.relative(attempt.directory, argv[argv.length - 1]) : fingerprint.sourcePath, sha256: fingerprint.sourceHash }, argv: redactRunArgv(argv), status: success ? "success" : outcome.cancelled ? "cancelled" : "failed", process: processResult,
      stdout: metadata(this.projectRoot, attempt.directory, path.join(attempt.directory, "stdout.txt")),
      stderr: metadata(this.projectRoot, attempt.directory, path.join(attempt.directory, "stderr.txt")),
      artifacts: success ? artifactFiles.map(file => metadata(this.projectRoot, attempt.directory, file)) : [],
    };
    atomicJson(this.guard(path.join(attempt.directory, "run.json"), true), manifest);
    const history = path.join(this.directory, attempt.blockId, "history", attempt.runId);
    this.guard(history, true);
    fs.mkdirSync(path.dirname(history), { recursive: true }); fs.renameSync(attempt.directory, history);
    if (success && (!this.isLatestAttempt(attempt) || !this.verifiedHistory(attempt.blockId, attempt.runId, digest(manifest)))) {
      outcome.exitCode = 1; outcome.error = "The completed run was superseded or failed provenance or file validation.";
      manifest.status = "failed";
      manifest.process.exitCode = 1; manifest.process.error = outcome.error;
      manifest.artifacts = [];
      atomicJson(this.guard(path.join(history, "run.json")), manifest);
    } else if (success && attempt.persistent) {
      const previous = this.currentDetails(attempt.blockId)?.manifest;
      this.publications.set(manifest.runId, { blockId: attempt.blockId, previous: previous
        ? { schemaVersion: 1, runId: previous.runId, manifestHash: digest(previous) } : undefined });
      atomicJson(this.guard(path.join(this.directory, attempt.blockId, "current.json"), true), {
        schemaVersion: 1, runId: manifest.runId, manifestHash: digest(manifest),
      });
    }
    this.prune(attempt.blockId);
    return manifest;
  }
  current(block: CodeBlock, blockId: string, fingerprint: RunFingerprint): BlockResult | undefined {
    if (!block.id && !block.label) return undefined;
    const details = this.currentDetails(blockId);
    return details ? this.resultForManifest(block, details.manifest, fingerprint) : undefined;
  }
  currentDetails(blockId: string): { manifest: RunManifest; path: string } | undefined {
    try {
      if (!BLOCK_ID_PATTERN.test(blockId)) return undefined;
      const pointer = JSON.parse(fs.readFileSync(this.guard(path.join(this.directory, blockId, "current.json")), "utf8"));
      if (!object(pointer) || pointer.schemaVersion !== 1 || typeof pointer.runId !== "string" || !RUN_ID_PATTERN.test(pointer.runId) || !hash(pointer.manifestHash)) return undefined;
      const verified = this.verifiedHistory(blockId, pointer.runId, pointer.manifestHash);
      return verified ? { manifest: verified.manifest, path: verified.path } : undefined;
    } catch { return undefined; }
  }
  private verifiedHistory(blockId: string, runId: string, expectedHash: string): VerifiedRun | undefined {
    try {
      if (!BLOCK_ID_PATTERN.test(blockId) || !RUN_ID_PATTERN.test(runId)) return undefined;
      const directory = this.guard(path.join(this.directory, blockId, "history", runId));
      const file = this.guard(path.join(directory, "run.json"));
      const generation = this.documentGeneration();
      if (!generation) return undefined;
      const manifest: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!successfulManifest(manifest, this.documentId, blockId, runId, generation) || digest(manifest) !== expectedHash) return undefined;
      if (manifest.fingerprint.sourcePath === "inline") {
        relativeRunPath(manifest.source.path);
        const source = this.guard(path.resolve(directory, manifest.source.path));
        const sourceMetadata = { path: manifest.source.path, sha256: manifest.source.sha256, bytes: fs.statSync(source).size, mediaType: mediaType(source) };
        if (!validateMetadata(this.projectRoot, directory, sourceMetadata, this.limits.maxInputBytes)) return undefined;
      } else if (manifest.source.path !== manifest.fingerprint.sourcePath || !path.isAbsolute(manifest.source.path)) return undefined;
      else containedRunPath(this.projectRoot, manifest.source.path, true);
      const stdout = validateMetadata(this.projectRoot, directory, manifest.stdout, this.limits.maxStdoutBytes, true);
      const stderr = validateMetadata(this.projectRoot, directory, manifest.stderr, this.limits.maxStderrBytes, true);
      if (!stdout || !stderr) return undefined;
      const artifacts = new Map<string, string>();
      let bytes = 0;
      for (const item of manifest.artifacts) {
        if (!object(item) || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.path !== "string" || !item.path.startsWith("artifacts/")) return undefined;
        bytes += item.bytes;
        if (bytes > this.limits.maxArtifactTotalBytes) return undefined;
        const artifact = validateMetadata(this.projectRoot, directory, item, this.limits.maxArtifactBytes);
        if (!artifact) return undefined;
        const name = path.basename(artifact.path, path.extname(artifact.path));
        if (artifacts.has(name)) return undefined;
        artifacts.set(name, artifact.path);
      }
      return this.documentGeneration() === generation ? { manifest, path: file, stdout: stdout.text, stderr: stderr.text, artifacts } : undefined;
    } catch { return undefined; }
  }
  resultForManifest(block: CodeBlock, manifest: RunManifest, fingerprint: RunFingerprint): BlockResult | undefined {
    try {
      const verified = this.verifiedHistory(manifest.blockId, manifest.runId, digest(manifest));
      if (!verified || manifest.fingerprint.hash !== fingerprint.hash) return undefined;
      return { block, stdout: verified.stdout, stderr: verified.stderr, exitCode: 0,
        artifacts: verified.artifacts, cached: true, cacheStatus: "hit", runId: manifest.runId, blockId: manifest.blockId,
        fingerprint: fingerprint.hash, resultHash: digest([fingerprint.hash, manifest.stdout, manifest.artifacts]),
        interpreter: manifest.fingerprint.interpreter.path };
    } catch { return undefined; }
  }
  /** Accept an immediately verified publication, allowing retention to release its predecessor. */
  confirmPublished(manifest: RunManifest): void {
    if (this.publications.delete(manifest.runId)) this.prune(manifest.blockId);
  }
  /** Restore last-good only while the rejected attempt still owns the current pointer. */
  discardPublished(manifest: RunManifest): boolean {
    const publication = this.publications.get(manifest.runId);
    if (!publication || publication.blockId !== manifest.blockId) return false;
    this.publications.delete(manifest.runId);
    const file = this.guard(path.join(this.directory, manifest.blockId, "current.json"), true);
    let pointer: unknown;
    try { pointer = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
    if (!object(pointer) || pointer.runId !== manifest.runId || pointer.manifestHash !== digest(manifest)) return false;
    const previous = publication.previous;
    if (previous && this.verifiedHistory(manifest.blockId, previous.runId, previous.manifestHash)) atomicJson(this.guard(file), previous);
    else fs.unlinkSync(this.guard(file));
    this.prune(manifest.blockId);
    return true;
  }
  /** Keep current even when the last ten attempts have all failed. */
  private prune(blockId: string): void {
    const history = this.guard(path.join(this.directory, blockId, "history"));
    const current = this.currentDetails(blockId)?.manifest.runId;
    const attempts = fs.readdirSync(history, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
      .map(entry => ({ name: entry.name, modified: fs.statSync(this.guard(path.join(history, entry.name))).mtimeMs }))
      .sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    const keep = new Set(attempts.slice(0, this.limits.retentionCount).map(attempt => attempt.name));
    if (current) keep.add(current);
    for (const publication of this.publications.values()) if (publication.blockId === blockId && publication.previous) keep.add(publication.previous.runId);
    for (const attempt of attempts) if (!keep.has(attempt.name)) fs.rmSync(this.guard(path.join(history, attempt.name)), { recursive: true, force: true });
  }

}

export function redactRunArgv(argv: string[]): string[] {
  let redactNext = false;
  return argv.map(argument => {
    if (redactNext) { redactNext = false; return "[redacted]"; }
    if (/^--?(?:.*[-_])?(?:token|password|passwd|secret|api[-_]?key|credential)(?:=|$)/i.test(argument)) {
      if (argument.includes("=")) return argument.slice(0, argument.indexOf("=") + 1) + "[redacted]";
      redactNext = true; return argument;
    }
    return argument.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@");
  });
}

/** The old UI passes an outputs/<document-key> scope. Remove generated history for that scope. */
export function clearGeneratedRuns(cacheDir: string, sourceFile?: string): void {
  const outputsRoot = path.dirname(path.resolve(cacheDir));
  if (path.basename(outputsRoot) !== "outputs" || path.basename(path.dirname(outputsRoot)) !== ".inkwell") throw new Error("Invalid code-run cache scope");
  const projectRoot = path.dirname(path.dirname(outputsRoot));
  const runsRoot = path.join(projectRoot, ".inkwell", "runs");
  containedRunPath(projectRoot, cacheDir, true, true);
  containedRunPath(projectRoot, runsRoot, true, true);
  if (sourceFile) fs.rmSync(new RunStore(projectRoot, sourceFile).directory, { recursive: true, force: true });
  if (!sourceFile && fs.existsSync(runsRoot)) for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = containedRunPath(projectRoot, path.join(runsRoot, entry.name), false, true);
    let document: { sourceFile?: string };
    try { document = JSON.parse(fs.readFileSync(path.join(dir, "document.json"), "utf8")); } catch { continue; }
    if (!document.sourceFile) continue;
    const relative = path.relative(projectRoot, document.sourceFile).replace(/\\/g, "/");
    const ext = path.extname(relative); const key = (ext ? relative.slice(0, -ext.length) : relative).replace(/\//g, "--");
    if (key === path.basename(cacheDir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(cacheDir, { recursive: true, force: true });
}
