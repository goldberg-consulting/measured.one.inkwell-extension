/** Provenance-backed run storage. No VS Code dependency; all paths are explicit. */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import type { CodeBlock, BlockResult, ResolvedInterpreter } from "./runner";
import type { ProcessOutcome } from "./run-process";

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
export interface RunAttempt { generation: string; runId: string; blockId: string; directory: string; artifactsDir: string; startedAt: string }

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
  try { return fs.statSync(file).isFile() ? sha256(fs.readFileSync(file)) : "missing"; } catch { return "missing"; }
}
function listFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) files.push(full);
    else if (entry.isDirectory()) files.push(...listFiles(full));
  }
  return files;
}
function containedFile(dir: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined;
  const full = path.resolve(dir, relative);
  if (!full.startsWith(path.resolve(dir) + path.sep)) return undefined;
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
function metadata(directory: string, file: string): FileMetadata {
  return { path: path.relative(directory, file).split(path.sep).join("/"), mediaType: mediaType(file), bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) };
}
function validateMetadata(dir: string, item: FileMetadata): string | undefined {
  if (!item || typeof item.path !== "string" || typeof item.sha256 !== "string") return undefined;
  const full = containedFile(dir, item.path);
  if (!full) return undefined;
  return fs.statSync(full).size === item.bytes && hashFile(full) === item.sha256 ? full : undefined;
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
function inputHashes(patterns: string[], docDir: string, projectRoot: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const pattern of patterns) {
    const wildcard = /[?*]/.test(pattern);
    const staticRoot = (base: string): string => {
      const absolute = path.resolve(base, pattern);
      if (!wildcard) return absolute;
      const fixed = absolute.slice(0, absolute.search(/[?*]/));
      return path.dirname(fixed.endsWith(path.sep) ? fixed + "_" : fixed);
    };
    const base = fs.existsSync(staticRoot(docDir)) ? docDir : projectRoot;
    const absolute = path.resolve(base, pattern);
    if (!wildcard) { hashes[absolute] = hashFile(absolute); continue; }
    const matcher = globRegex(absolute.split(path.sep).join("/"));
    const generatedRoot = path.join(projectRoot, ".inkwell");
    const matched = listFiles(staticRoot(base)).filter(file => {
      const relative = path.relative(generatedRoot, file).split(path.sep);
      return !["runs", "outputs", "compiled", "mermaid", ".cache", "venv"].includes(relative[0])
        && !file.split(path.sep).includes(".git") && matcher.test(file.split(path.sep).join("/"));
    });
    if (!matched.length) hashes[absolute] = "missing";
    for (const file of matched) hashes[file] = hashFile(file);
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

/** The same selected path is fingerprinted and executed, including user-owned symlinks. */
export function resolveRunSource(file: string, docDir: string, projectRoot: string): string {
  const candidates = [path.resolve(docDir, file), path.resolve(projectRoot, file)];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
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
  interpreter: ResolvedInterpreter, upstream: Record<string, string> = {}): RunFingerprint {
  let sourcePath = "inline";
  if (block.file) {
    sourcePath = resolveRunSource(block.file, docDir, projectRoot);
  }
  const sourceHash = block.file ? hashFile(sourcePath) : sha256(block.source);
  const inputs = inputHashes(block.inputs || [], docDir, projectRoot);
  const lockNames = ["requirements.txt", "requirements.lock", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "renv.lock", "environment.yml"];
  const lockfiles: Record<string, string> = {};
  for (const base of [...new Set([projectRoot, docDir, path.join(projectRoot, ".inkwell")])].sort()) {
    for (const name of lockNames) { const file = path.join(base, name); lockfiles[file] = hashFile(file); }
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
  const environment = Object.entries({ ...process.env, ...interpreter.envVars }).filter(([key]) => !["INKWELL_OUTPUT_DIR", "INKWELL_BLOCK_INDEX"].includes(key)).sort(([a], [b]) => a.localeCompare(b));
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
  constructor(readonly projectRoot: string, readonly sourceFile: string) {
    this.documentId = safeId(path.relative(projectRoot, path.resolve(sourceFile)).split(path.sep).join("/"));
    this.directory = path.join(projectRoot, ".inkwell", "runs", this.documentId);
  }
  assignBlockIds(blocks: CodeBlock[], persist = false): string[] {
    const mapFile = path.join(this.directory, "document.json");
    let mapping: Record<string, string[]> = {};
    let generation = crypto.randomUUID();
    if (fs.existsSync(mapFile)) {
      const document = JSON.parse(fs.readFileSync(mapFile, "utf8"));
      if (document.schemaVersion !== 1 || typeof document.generation !== "string" || document.sourceFile !== path.resolve(this.sourceFile) || !document.legacyIds || typeof document.legacyIds !== "object") throw new Error(`Invalid run identity mapping: ${mapFile}`);
      for (const [signature, ids] of Object.entries(document.legacyIds)) {
        if (!/^[a-f0-9]{64}$/.test(signature) || !Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^legacy-[a-f0-9]{24}-[1-9][0-9]*$/.test(id))) throw new Error(`Invalid run identity mapping: ${mapFile}`);
      }
      mapping = document.legacyIds;
      generation = document.generation;
    }
    const seen = new Map<string, number>(); const explicit = new Set<string>();
    const ids = blocks.map(block => {
      const named = block.id || block.label;
      if (named) {
        if (explicit.has(named)) throw new Error(`Duplicate code block id or label: ${named}`);
        explicit.add(named); return `named-${safeId(named)}`;
      }
      // Source identity, not ordinal. Editing a legacy source creates a fresh ID.
      const signature = digest({ lang: block.lang, source: block.file ? undefined : block.source, file: block.file,
        env: block.env, output: block.output, inputs: block.inputs, dependsOn: block.dependsOn });
      const occurrence = seen.get(signature) || 0; seen.set(signature, occurrence + 1);
      const existing = mapping[signature] || [];
      const id = existing[occurrence] || `legacy-${signature.slice(0, 24)}-${occurrence + 1}`;
      existing[occurrence] = id; mapping[signature] = existing; return id;
    });
    this.generation = generation;
    if (persist) atomicJson(mapFile, { schemaVersion: 1, generation, sourceFile: path.resolve(this.sourceFile), legacyIds: mapping });
    return ids;
  }
  isCurrentGeneration(): boolean {
    try { return Boolean(this.generation) && JSON.parse(fs.readFileSync(path.join(this.directory, "document.json"), "utf8")).generation === this.generation; }
    catch { return false; }
  }
  begin(blockId: string): RunAttempt {
    if (!this.isCurrentGeneration()) throw new Error("Run cache was cleared; start a new run.");
    const generation = this.generation!;
    const runId = crypto.randomUUID();
    const directory = path.join(this.directory, blockId, "staging", runId);
    const artifactsDir = path.join(directory, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    return { generation, runId, blockId, directory, artifactsDir, startedAt: new Date().toISOString() };
  }
  finish(attempt: RunAttempt, fingerprint: RunFingerprint, argv: string[], outcome: ProcessOutcome): RunManifest {
    let currentGeneration: string | undefined;
    try { currentGeneration = JSON.parse(fs.readFileSync(path.join(this.directory, "document.json"), "utf8")).generation; } catch {}
    if (!currentGeneration || currentGeneration !== attempt.generation) {
      fs.rmSync(attempt.directory, { recursive: true, force: true });
      throw new Error("Run cache was cleared during execution; result was discarded.");
    }
    const artifactFiles = listFiles(attempt.artifactsDir);
    const names = artifactFiles.map(file => path.basename(file, path.extname(file)));
    if (outcome.exitCode === 0 && outcome.rawExitCode !== 0) {
      outcome.exitCode = 1; outcome.error = "No clean process exit was recorded.";
    }
    if (new Set(names).size !== names.length && outcome.exitCode === 0) {
      outcome.exitCode = 1; outcome.error = "Generated artifacts have duplicate names; give each artifact a unique filename.";
    }
    if (outcome.error && !outcome.stderr) outcome.stderr = outcome.error;
    fs.writeFileSync(path.join(attempt.directory, "stdout.txt"), outcome.stdout);
    fs.writeFileSync(path.join(attempt.directory, "stderr.txt"), outcome.stderr);
    const processResult = { exitCode: outcome.exitCode, rawExitCode: outcome.rawExitCode ?? null, signal: outcome.signal, timedOut: outcome.timedOut,
      cancelled: outcome.cancelled, maxBufferExceeded: outcome.maxBufferExceeded, error: outcome.error };
    const success = outcome.exitCode === 0 && outcome.rawExitCode === 0 && !outcome.signal && !outcome.cancelled && !outcome.timedOut && !outcome.maxBufferExceeded && !outcome.error;
    const manifest: RunManifest = {
      schemaVersion: 1, runId: attempt.runId, documentId: this.documentId, blockId: attempt.blockId,
      startedAt: attempt.startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(attempt.startedAt),
      fingerprint, source: { path: fingerprint.sourcePath === "inline" ? path.relative(attempt.directory, argv[argv.length - 1]) : fingerprint.sourcePath, sha256: fingerprint.sourceHash }, argv, status: success ? "success" : outcome.cancelled ? "cancelled" : "failed", process: processResult,
      stdout: metadata(attempt.directory, path.join(attempt.directory, "stdout.txt")),
      stderr: metadata(attempt.directory, path.join(attempt.directory, "stderr.txt")),
      artifacts: success ? artifactFiles.map(file => metadata(attempt.directory, file)) : [],
    };
    atomicJson(path.join(attempt.directory, "run.json"), manifest);
    const history = path.join(this.directory, attempt.blockId, "history", attempt.runId);
    fs.mkdirSync(path.dirname(history), { recursive: true }); fs.renameSync(attempt.directory, history);
    if (success) atomicJson(path.join(this.directory, attempt.blockId, "current.json"), {
      schemaVersion: 1, runId: manifest.runId, manifestHash: digest(manifest),
    });
    return manifest;
  }
  current(block: CodeBlock, blockId: string, fingerprint: RunFingerprint): BlockResult | undefined {
    try {
      const pointer = JSON.parse(fs.readFileSync(path.join(this.directory, blockId, "current.json"), "utf8"));
      if (pointer.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(pointer.runId)) return undefined;
      const dir = path.join(this.directory, blockId, "history", pointer.runId);
      const manifest: RunManifest = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
      if (pointer.manifestHash !== digest(manifest) || manifest.schemaVersion !== 1 || manifest.documentId !== this.documentId || manifest.blockId !== blockId || manifest.runId !== pointer.runId || manifest.status !== "success" || manifest.fingerprint.hash !== fingerprint.hash || manifest.process.exitCode !== 0 || manifest.process.rawExitCode !== 0 || manifest.process.signal || manifest.process.cancelled || manifest.process.timedOut || manifest.process.maxBufferExceeded || manifest.process.error) return undefined;
      const stdout = validateMetadata(dir, manifest.stdout); const stderr = validateMetadata(dir, manifest.stderr);
      if (!stdout || !stderr || !Array.isArray(manifest.artifacts)) return undefined;
      const artifacts = new Map<string, string>();
      for (const item of manifest.artifacts) {
        const file = validateMetadata(dir, item); if (!file || !item.path.startsWith("artifacts/")) return undefined;
        const name = path.basename(file, path.extname(file)); if (artifacts.has(name)) return undefined;
        artifacts.set(name, file);
      }
      return { block, stdout: fs.readFileSync(stdout, "utf8"), stderr: fs.readFileSync(stderr, "utf8"), exitCode: 0,
        artifacts, cached: true, cacheStatus: "hit", runId: manifest.runId, blockId,
        fingerprint: fingerprint.hash, resultHash: digest([manifest.stdout, manifest.artifacts]),
        interpreter: manifest.fingerprint.interpreter.path };
    } catch { return undefined; }
  }
}

/** The old UI passes an outputs/<document-key> scope. Remove generated history for that scope. */
export function clearGeneratedRuns(cacheDir: string, sourceFile?: string): void {
  const outputsRoot = path.dirname(path.resolve(cacheDir));
  if (path.basename(outputsRoot) !== "outputs" || path.basename(path.dirname(outputsRoot)) !== ".inkwell") throw new Error("Invalid code-run cache scope");
  const projectRoot = path.dirname(path.dirname(outputsRoot));
  const runsRoot = path.join(projectRoot, ".inkwell", "runs");
  if (sourceFile) fs.rmSync(new RunStore(projectRoot, sourceFile).directory, { recursive: true, force: true });
  if (!sourceFile && fs.existsSync(runsRoot)) for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsRoot, entry.name);
    let document: { sourceFile?: string };
    try { document = JSON.parse(fs.readFileSync(path.join(dir, "document.json"), "utf8")); } catch { continue; }
    if (!document.sourceFile) continue;
    const relative = path.relative(projectRoot, document.sourceFile).replace(/\\/g, "/");
    const ext = path.extname(relative); const key = (ext ? relative.slice(0, -ext.length) : relative).replace(/\//g, "--");
    if (key === path.basename(cacheDir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(cacheDir, { recursive: true, force: true });
}
