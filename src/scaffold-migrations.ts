import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { BUNDLED_ASSET_PATHS, resolveContainedPath, validateBundledAssets, AssetDiagnostic } from "./bundled-assets";
import { DEFAULT_REQUIREMENTS, GITIGNORE, STARTER_BIB, SINE_PLOT_PY, SCATTER_PY, CONVERGENCE_TABLE_PY } from "./scaffold-assets";
import { normalizeManifestDefaults } from "./document-config";

export const SCAFFOLD_VERSION = 4;
export interface MigrationOperation {
  kind: "write" | "proposal" | "backup";
  path: string;
  content: string;
  expectedHash: string | null;
  contentHash: string;
}
export interface MigrationConflict { path: string; message: string; proposalPath?: string }
export interface MigrationPlan {
  root: string;
  realRoot: string;
  assetRoot: string;
  planId: string;
  fromVersion: number;
  toVersion: number;
  migrationSteps: number[];
  operations: MigrationOperation[];
  conflicts: MigrationConflict[];
  diagnostics: AssetDiagnostic[];
  blocked: boolean;
  manifestBefore: string | null;
  observedPaths: string[];
  resumed?: boolean;
}
export interface MigrationResult {
  success: boolean;
  status: "applied" | "up-to-date" | "blocked" | "conflict";
  writes: string[];
  conflicts: MigrationConflict[];
  diagnostics: AssetDiagnostic[];
}
interface MigrationJournal { schemaVersion: 1; state: "applying" | "complete"; plan: MigrationPlan; applied: string[] }
const MANIFEST = ".inkwell/manifest.json";
const JOURNALS = ".inkwell/.migrations";
const hash = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function currentHash(root: string, relative: string): string | null {
  const file = resolveContainedPath(root, relative);
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error(`Refusing to replace a nonregular file: ${file}`);
  return hash(fs.readFileSync(file));
}

function numberedProposal(root: string, relative: string, contentHash: string, suffix = "new"): string {
  for (let number = 1; number <= 10_000; number++) {
    const candidate = `${relative}.v4.${number}.${suffix}`;
    const existing = currentHash(root, candidate);
    if (existing === null || existing === contentHash) return candidate;
  }
  throw new Error(`Too many existing proposals for ${relative}`);
}

function seedFiles(assetRoot: string): Array<{ path: string; content: string; userOwned?: boolean }> {
  const seeds = [
    { path: ".inkwell/scripts/sine_plot.py", content: SINE_PLOT_PY },
    { path: ".inkwell/scripts/scatter.py", content: SCATTER_PY },
    { path: ".inkwell/scripts/convergence_table.py", content: CONVERGENCE_TABLE_PY },
    { path: ".inkwell/references/refs.bib", content: STARTER_BIB, userOwned: true },
    { path: "requirements.txt", content: DEFAULT_REQUIREMENTS, userOwned: true },
    { path: ".inkwell/figures/.gitkeep", content: "", userOwned: true },
    { path: ".inkwell/guide.md", content: fs.readFileSync(resolveContainedPath(assetRoot, "guide.md"), "utf8") },
    { path: ".cursor/agents/inkwell-guide.md", content: fs.readFileSync(resolveContainedPath(assetRoot, ".cursor/agents/inkwell-guide.md"), "utf8") },
  ];
  for (const relative of BUNDLED_ASSET_PATHS.filter((value) => /^examples\/.*\.md$/.test(value)).sort()) {
    seeds.push({ path: `.inkwell/${relative}`, content: fs.readFileSync(resolveContainedPath(assetRoot, relative), "utf8") });
  }
  return seeds;
}

function validateManifest(value: unknown): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new Error("Manifest must be a JSON object.");
  for (const key of ["schemaVersion", "scaffoldVersion"]) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 4)) {
      throw new Error(`${key} must be a supported version from 0 to 4.`);
    }
  }
  for (const key of ["defaults", "settings", "documentSettings", "managedFiles"]) {
    if (value[key] !== undefined && !isObject(value[key])) throw new Error(`${key} must be a JSON object.`);
  }
  if (value.template !== undefined && typeof value.template !== "string") throw new Error("template must be a string.");
  if (isObject(value.defaults)) {
    for (const section of ["typography", "tables", "references", "runs"]) {
      if (value.defaults[section] !== undefined && !isObject(value.defaults[section])) throw new Error(`defaults.${section} must be a JSON object.`);
    }
  }
}

function validateOperation(root: string, operation: MigrationOperation): void {
  if (!["write", "proposal", "backup"].includes(operation.kind) || typeof operation.content !== "string" ||
      operation.contentHash !== hash(operation.content) ||
      (operation.expectedHash !== null && !/^[a-f0-9]{64}$/.test(operation.expectedHash))) throw new Error("Invalid migration operation.");
  if (!(operation.path.startsWith(".inkwell/") || operation.path === ".gitignore" || operation.path === "requirements.txt" ||
        operation.path.startsWith(".cursor/agents/inkwell-guide.md"))) throw new Error(`Unsupported scaffold destination: ${operation.path}`);
  if (operation.path.startsWith(".inkwell/templates/")) throw new Error("Local templates are user-owned.");
  resolveContainedPath(root, operation.path);
}

function readPendingPlan(root: string, assetRoot: string): MigrationPlan | undefined {
  const journalDir = resolveContainedPath(root, JOURNALS);
  if (!fs.existsSync(journalDir)) return undefined;
  for (const name of fs.readdirSync(journalDir).filter((value) => /^v4-[a-f0-9]+\.json$/.test(value)).sort()) {
    const file = resolveContainedPath(root, `${JOURNALS}/${name}`);
    const journal = JSON.parse(fs.readFileSync(file, "utf8")) as MigrationJournal;
    if (journal.state === "complete") continue;
    if (journal.schemaVersion !== 1 || journal.state !== "applying" || journal.plan?.root !== root ||
        journal.plan.realRoot !== fs.realpathSync(root) || !Array.isArray(journal.plan.operations)) throw new Error(`Invalid migration journal: ${file}`);
    for (const operation of journal.plan.operations) validateOperation(root, operation);
    const resumed: MigrationPlan = { ...journal.plan, assetRoot, resumed: true,
      operations: [], conflicts: [...journal.plan.conflicts], observedPaths: [...journal.plan.observedPaths] };
    for (const operation of journal.plan.operations) {
      const actual = currentHash(root, operation.path);
      if (actual !== operation.expectedHash && actual !== operation.contentHash) {
        if (operation.path === MANIFEST) throw new Error("The manifest changed during an interrupted migration. Preserve the migration journal and reconcile the manifest before resuming.");
        const proposalPath = numberedProposal(root, operation.path, operation.contentHash);
        resumed.conflicts.push({ path: operation.path, proposalPath, message: `Preserved a user edit made during migration: ${operation.path}.` });
        resumed.observedPaths.push(proposalPath);
        const proposalHash = currentHash(root, proposalPath);
        if (proposalHash !== operation.contentHash) resumed.operations.push({ ...operation, kind: "proposal", path: proposalPath, expectedHash: proposalHash });
      } else {
        resumed.operations.push(operation);
      }
    }
    return resumed;
  }
  return undefined;
}

/** Planning is deterministic and performs no writes, including for malformed JSON. */
export function planMigration(rootInput: string, assetRootInput = path.join(__dirname, ".."), options: { template?: string } = {}): MigrationPlan {
  const root = path.resolve(rootInput);
  const assetRoot = path.resolve(assetRootInput);
  const plan: MigrationPlan = {
    root, realRoot: "", assetRoot, planId: "", fromVersion: 0, toVersion: 4, migrationSteps: [],
    operations: [], conflicts: [], diagnostics: [], blocked: false, manifestBefore: null, observedPaths: [],
  };
  const add = (relative: string, content: string, kind: MigrationOperation["kind"] = "write"): void => {
    plan.observedPaths.push(relative);
    const before = currentHash(root, relative);
    const contentHash = hash(content);
    if (before !== contentHash) plan.operations.push({ kind, path: relative, content, expectedHash: before, contentHash });
  };
  try {
    plan.realRoot = fs.realpathSync(root);
    if (!fs.statSync(root).isDirectory()) throw new Error("The project root must be a directory.");
    const pending = readPendingPlan(root, assetRoot);
    if (pending) {
      const assetDiagnostics = validateBundledAssets(assetRoot);
      return { ...pending, diagnostics: [...pending.diagnostics, ...assetDiagnostics], blocked: pending.blocked || assetDiagnostics.length > 0 };
    }
    const manifestPath = resolveContainedPath(root, MANIFEST);
    plan.observedPaths.push(MANIFEST, JOURNALS);
    let manifest: Record<string, unknown> = {};
    if (fs.existsSync(manifestPath)) {
      currentHash(root, MANIFEST);
      plan.manifestBefore = fs.readFileSync(manifestPath, "utf8");
      try {
        const parsed = JSON.parse(plan.manifestBefore);
        validateManifest(parsed);
        manifest = parsed;
      } catch (error: any) {
        plan.blocked = true;
        plan.diagnostics.push({ path: MANIFEST, severity: "error", message: `Manifest is malformed or unsupported: ${error.message || String(error)}. The original will be preserved; repair it before setup.` });
        const backup = numberedProposal(root, MANIFEST, hash(plan.manifestBefore), "bak");
        add(backup, plan.manifestBefore, "backup");
        return finalizePlan(plan);
      }
    }
    plan.fromVersion = Number(manifest.scaffoldVersion ?? manifest.schemaVersion ?? 0);
    plan.migrationSteps = Array.from({ length: Math.max(0, 4 - plan.fromVersion) }, (_, index) => plan.fromVersion + index + 1);
    plan.diagnostics.push(...validateBundledAssets(assetRoot));
    if (plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      plan.blocked = true;
      return finalizePlan(plan);
    }
    const normalized = normalizeManifestDefaults(manifest);
    for (const diagnostic of normalized.diagnostics) {
      plan.diagnostics.push({ path: MANIFEST, severity: diagnostic.severity === "error" ? "error" : "warning", message: diagnostic.message });
    }
    if (plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      plan.blocked = true;
      return finalizePlan(plan);
    }
    const managed = { ...(manifest.managedFiles as Record<string, unknown> || {}) };
    for (const seed of seedFiles(assetRoot)) {
      plan.observedPaths.push(seed.path);
      const before = currentHash(root, seed.path);
      const desired = hash(seed.content);
      const previous = managed[seed.path];
      const prior = isObject(previous) ? previous : {};
      const installed = typeof previous === "string" ? previous : prior.sha256 ?? prior.hash ?? prior.installedHash;
      if (seed.userOwned || prior.ownership === "user") {
        if (before === null) add(seed.path, seed.content);
        continue;
      }
      if (before === null || before === desired || before === installed) {
        add(seed.path, seed.content);
        managed[seed.path] = { ...prior, sha256: desired, version: 4 };
      } else {
        const proposalPath = numberedProposal(root, seed.path, desired);
        add(proposalPath, seed.content, "proposal");
        plan.conflicts.push({ path: seed.path, proposalPath, message: `Preserved ${seed.path}; compare the proposed replacement before continuing.` });
      }
    }
    const ignorePath = resolveContainedPath(root, ".gitignore");
    const existingIgnore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
    const ignoreLines = new Set(existingIgnore.split(/\r?\n/).map((line) => line.trim()));
    const requiredIgnores = [...GITIGNORE.split("\n"), ".inkwell/history/"].filter(Boolean);
    const missingIgnores = requiredIgnores.filter((line) => !ignoreLines.has(line));
    if (missingIgnores.length) add(".gitignore", existingIgnore + (existingIgnore && !existingIgnore.endsWith("\n") ? "\n" : "") + missingIgnores.join("\n") + "\n");
    else plan.observedPaths.push(".gitignore");
    const next = { ...manifest, schemaVersion: 4, scaffoldVersion: 4, template: manifest.template ?? options.template ?? "default",
      defaults: { typography: {}, tables: {}, references: {}, runs: {}, ...normalized.defaults }, managedFiles: managed };
    // Manifest is the last operation and the only version checkpoint.
    add(MANIFEST, JSON.stringify(next, null, 2) + "\n");
  } catch (error: any) {
    plan.blocked = true;
    plan.operations = [];
    plan.diagnostics.push({ path: root, severity: "error", message: error.message || String(error) });
  }
  return finalizePlan(plan);
}

export function validateProjectName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Name is required";
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(name) || name.endsWith(".") ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || Buffer.byteLength(name, "utf8") > 240) {
    return "Use a single document name with letters, numbers, spaces, dots, apostrophes, hyphens, or underscores; paths and shell syntax are not allowed.";
  }
  return null;
}

/** Publish a complete new document without overwriting a concurrently created file. */
export function createScaffoldDocument(root: string, name: string, content: string): string {
  const invalid = validateProjectName(name);
  if (invalid) throw new Error(invalid);
  const relative = `${name.trim()}.md`;
  const file = resolveContainedPath(root, relative);
  if (fs.existsSync(file)) {
    currentHash(root, relative);
    return file;
  }
  const temporary = resolveContainedPath(root, `.${name.trim()}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" });
    resolveContainedPath(root, relative);
    try { fs.linkSync(temporary, file); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return file;
}

function finalizePlan(plan: MigrationPlan): MigrationPlan {
  plan.observedPaths = [...new Set(plan.observedPaths)].sort();
  plan.planId = hash(JSON.stringify({ root: plan.root, fromVersion: plan.fromVersion, operations: plan.operations, conflicts: plan.conflicts })).slice(0, 24);
  return plan;
}

function writeAtomic(root: string, relative: string, content: string, expectedHash?: string | null): void {
  const file = resolveContainedPath(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  resolveContainedPath(root, relative);
  const tempRelative = `${relative}.${crypto.randomUUID()}.tmp`;
  const temporary = resolveContainedPath(root, tempRelative);
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" });
    if (fs.existsSync(file)) fs.chmodSync(temporary, fs.statSync(file).mode & 0o777);
    resolveContainedPath(root, relative);
    if (expectedHash !== undefined && currentHash(root, relative) !== expectedHash) throw new Error(`File changed before atomic publication: ${relative}`);
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

/** Safe writes resume from recorded content hashes; user changes cause a stop. */
export function applyMigration(
  plan: MigrationPlan,
  options: { checkpoint?: (name: string, relative?: string) => void; resolveConflicts?: "keep-user-files" } = {},
): MigrationResult {
  if (options.resolveConflicts === "keep-user-files" && !plan.blocked && plan.conflicts.length) {
    try {
      const conflictedPaths = new Set(plan.conflicts.map((conflict) => conflict.path));
      const resolved: MigrationPlan = { ...plan, conflicts: [], operations: plan.operations
        .filter((operation) => !conflictedPaths.has(operation.path)).map((operation) => ({ ...operation })) };
      const manifestOperation = resolved.operations.find((operation) => operation.path === MANIFEST);
      if (!manifestOperation) throw new Error("The migration has no validated manifest checkpoint.");
      const manifest = JSON.parse(manifestOperation.content);
      validateManifest(manifest);
      const managed = { ...(manifest.managedFiles as Record<string, unknown> || {}) };
      for (const conflict of plan.conflicts) {
        const previous = managed[conflict.path];
        managed[conflict.path] = { ...(isObject(previous) ? previous : {}), ownership: "user" };
      }
      manifestOperation.content = JSON.stringify({ ...manifest, managedFiles: managed }, null, 2) + "\n";
      manifestOperation.contentHash = hash(manifestOperation.content);
      const finalized = finalizePlan(resolved);
      // An interrupted transaction keeps its journal identity through conflict
      // resolution so an abandoned journal cannot shadow the completed repair.
      if (plan.resumed) finalized.planId = plan.planId;
      return applyMigration(finalized, { checkpoint: options.checkpoint });
    } catch (error: any) {
      return { success: false, status: "blocked", writes: [], conflicts: plan.conflicts,
        diagnostics: [...plan.diagnostics, { path: MANIFEST, severity: "error", message: error.message || String(error) }] };
    }
  }
  const writes: string[] = [];
  const diagnostics = [...plan.diagnostics];
  const result = (success: boolean, status: MigrationResult["status"]): MigrationResult => ({ success, status, writes, diagnostics, conflicts: plan.conflicts });
  let journal: MigrationJournal | undefined;
  let manifestWritten = false;
  let lockFile: string | undefined;
  const journalPath = `${JOURNALS}/v4-${plan.planId}.json`;
  try {
    if (!plan.realRoot || fs.realpathSync(plan.root) !== plan.realRoot) throw new Error("The project root changed after migration planning.");
    for (const operation of plan.operations) validateOperation(plan.root, operation);
    const operations = plan.blocked ? plan.operations.filter((operation) => operation.kind === "backup") :
      plan.conflicts.length ? plan.operations.filter((operation) => operation.kind === "proposal") : plan.operations;
    if (!plan.blocked && !plan.conflicts.length && operations.length) {
      const candidate = resolveContainedPath(plan.root, `${JOURNALS}/active.lock`);
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      if (fs.existsSync(candidate)) {
        currentHash(plan.root, `${JOURNALS}/active.lock`);
        const prior = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (!Number.isInteger(prior.pid) || prior.pid < 1) throw new Error("The scaffold migration lock needs manual inspection.");
        try {
          process.kill(prior.pid, 0);
          throw new Error("Another scaffold migration is running; retry when it finishes.");
        } catch (error: any) {
          if (error.code !== "ESRCH") throw error;
          fs.unlinkSync(resolveContainedPath(plan.root, `${JOURNALS}/active.lock`));
        }
      }
      fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      lockFile = candidate;
    }
    // Validate every target before beginning; recheck each again at publication.
    for (const operation of operations) {
      const actual = currentHash(plan.root, operation.path);
      if (actual !== operation.expectedHash && actual !== operation.contentHash) throw new Error(`File changed after migration planning: ${operation.path}`);
    }
    if (!plan.blocked && !plan.conflicts.length && operations.length) {
      journal = { schemaVersion: 1, state: "applying", plan: { ...plan, resumed: undefined }, applied: [] };
      writeAtomic(plan.root, journalPath, JSON.stringify(journal, null, 2) + "\n");
      writes.push(journalPath);
      options.checkpoint?.("journal-created");
    }
    for (const operation of operations) {
      options.checkpoint?.("before-file", operation.path);
      const actual = currentHash(plan.root, operation.path);
      if (actual !== operation.contentHash) {
        if (actual !== operation.expectedHash) throw new Error(`File changed during migration: ${operation.path}`);
        writeAtomic(plan.root, operation.path, operation.content, actual);
        writes.push(operation.path);
      }
      if (operation.path === MANIFEST) manifestWritten = true;
      options.checkpoint?.(operation.path === MANIFEST ? "manifest-written" : "file-written", operation.path);
      if (journal) {
        journal.applied.push(operation.path);
        writeAtomic(plan.root, journalPath, JSON.stringify(journal, null, 2) + "\n");
      }
    }
    if (journal) {
      options.checkpoint?.("before-complete");
      journal.state = "complete";
      writeAtomic(plan.root, journalPath, JSON.stringify(journal, null, 2) + "\n");
    }
    if (plan.blocked) return result(false, "blocked");
    if (plan.conflicts.length) return result(false, "conflict");
    return result(true, writes.length ? "applied" : "up-to-date");
  } catch (error: any) {
    // Before the completion checkpoint, the public manifest still describes the
    // previous completed scaffold. Successfully seeded files are safe to resume.
    if (manifestWritten) {
      try {
        const operation = plan.operations.find((entry) => entry.path === MANIFEST);
        if (operation && currentHash(plan.root, MANIFEST) === operation.contentHash) {
          if (plan.manifestBefore === null) fs.unlinkSync(resolveContainedPath(plan.root, MANIFEST));
          else writeAtomic(plan.root, MANIFEST, plan.manifestBefore);
        }
      } catch (rollbackError: any) {
        diagnostics.push({ path: MANIFEST, severity: "error", message: `Manifest rollback needs attention: ${rollbackError.message || String(rollbackError)}` });
      }
    }
    diagnostics.push({ path: plan.root, severity: "error", message: error.message || String(error) });
    return result(false, "blocked");
  } finally {
    if (lockFile) { try { fs.unlinkSync(lockFile); } catch {} }
  }
}
