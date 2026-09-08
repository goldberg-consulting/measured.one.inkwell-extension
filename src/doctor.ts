// One observed, read-only health contract for the extension and headless tooling.
// Full checks use disposable fixtures; no probe repairs an installation or project.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { executeRunProcess, ProcessOutcome } from "./run-process";
import { BUNDLED_ASSET_PATHS, resolveContainedPath } from "./bundled-assets";
import { planMigration } from "./scaffold-migrations";
import { loadTexRequirements, TexRequirements, texFileProbeArguments } from "./tex-requirements";
import { detectEditors, editorCandidates } from "./editor-installation";
import { validatePdf } from "./pdf-publication";

export type DoctorCheckStatus = "ok" | "warning" | "error" | "skipped";
export type DoctorMode = "light" | "full";
export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  required: boolean;
  message: string;
  details?: unknown;
  durationMs?: number;
}
export interface DoctorTool { path?: string; version?: string; state: "ready" | "missing" | "broken"; exitCode?: number; signal?: string | null; error?: string }
export const DOCTOR_REQUIRED_ASSETS: readonly string[] = [...new Set([...BUNDLED_ASSET_PATHS, "out/doctor-cli.js", "out/install-cli.js", "out/smoke-cli.js", "schemas/doctor.schema.json"])];
export interface DoctorAssetsManifest { schemaVersion: 1; extensionVersion: string; files: Record<string, { sha256: string; size?: number }> }
export interface DoctorEditor { id: string; path?: string; version?: string; extensionVersion?: string; error?: string }
export interface TexOwnership {
  root: string;
  distribution: "mactex" | "basictex" | "tinytex" | "texlive" | "unknown";
  ownerUid: number;
  currentUid: number;
  writable: boolean;
  privilege: "user" | "system-admin" | "repair-required";
  message: string;
}
export interface DoctorReport {
  schemaVersion: 1;
  mode: DoctorMode;
  ready: boolean;
  status: "ok" | "warning" | "error";
  checks: DoctorCheck[];
  tools: Record<string, DoctorTool>;
  tex?: TexOwnership;
  missingPackages: string[];
  fingerprint: string;
  extensionVersion: string;
  cacheHit: boolean;
  durationMs: number;
  processCount: number;
  generatedAt: string;
}
export interface DoctorOptions {
  extensionRoot: string;
  mode: DoctorMode;
  workspaceRoot?: string;
  selectedEngine?: "xelatex" | "pdflatex" | "lualatex";
  expectedVersion?: string;
  expectedEditors?: readonly string[];
  requiredTools?: readonly string[];
  env?: NodeJS.ProcessEnv;
  assetsManifest?: DoctorAssetsManifest | string;
  cachedOnly?: boolean;
  forceRefresh?: boolean;
  cacheTtlMs?: number;
}
export interface DoctorSmokeContext {
  temporaryRoot: string;
  extensionRoot: string;
  tools: Readonly<Record<string, DoctorTool>>;
  env: NodeJS.ProcessEnv;
}
export interface DoctorSmokeResult { success: boolean; message: string; pdfPath?: string; log?: string }
export interface DoctorDependencies {
  executeProcess?: typeof executeRunProcess;
  findExecutable?: (name: string, env: NodeJS.ProcessEnv) => string | undefined;
  probeEditors?: (context: { expectedVersion: string; expectedEditors: readonly string[]; env: NodeJS.ProcessEnv; executeProcess: typeof executeRunProcess }) => Promise<DoctorEditor[]>;
  editorFingerprint?: () => string;
  smokeCompile?: (context: DoctorSmokeContext) => Promise<DoctorSmokeResult>;
  now?: () => number;
  platform?: NodeJS.Platform;
  uid?: number;
}
interface CacheEntry { report: DoctorReport; basis: string; createdAt: number; workspacePaths: string[] }
const digest = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
const successful = (outcome: ProcessOutcome): boolean => outcome.exitCode === 0 && outcome.rawExitCode !== null && !outcome.signal && !outcome.timedOut && !outcome.cancelled && !outcome.maxBufferExceeded && !outcome.error;

function executable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = [...new Set([
    ...(env.PATH || "").split(path.delimiter).filter(Boolean), "/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
    path.join(os.homedir(), "Library/TinyTeX/bin/universal-darwin"), path.join(os.homedir(), ".TinyTeX/bin/x86_64-linux"),
  ])];
  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return undefined;
}

function fileFact(file: string): unknown {
  try {
    const stat = fs.statSync(file);
    return [file, fs.realpathSync(file), stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode];
  } catch { return [file, "missing"]; }
}
function texDatabaseFacts(root?: string): unknown[] {
  if (!root) return [];
  return ["ls-R", "texmf.cnf", "texmf-dist/web2c/texmf.cnf", "texmf-dist/ls-R", "texmf-var/ls-R", "texmf-config/ls-R", "tlpkg/texlive.tlpdb"].map(relative => fileFact(path.join(root, relative)));
}

export function classifyTexOwnership(input: { root: string; ownerUid: number; currentUid: number; writable: boolean; platform?: NodeJS.Platform }): TexOwnership {
  const lower = input.root.toLowerCase();
  const distribution: TexOwnership["distribution"] = lower.includes("tinytex") ? "tinytex" : /basictex|texlive[^\n]*basic/.test(lower) ? "basictex" :
    (input.platform || process.platform) === "darwin" && /texlive|\/library\/tex/.test(lower) ? "mactex" : lower.includes("texlive") ? "texlive" : "unknown";
  const ownTree = input.ownerUid === input.currentUid;
  const privilege: TexOwnership["privilege"] = ownTree && input.writable ? "user" :
    distribution !== "tinytex" && input.ownerUid === 0 ? "system-admin" : "repair-required";
  const message = privilege === "user" ? "This user-owned TeX installation supports package changes without administrator privileges." :
    privilege === "system-admin" ? "Normal system-owned TeX installation. Use the distribution's administrator privilege policy for package changes; preserve its ownership." :
      "TeX ownership or write access needs a distribution-specific repair. Existing ownership must be preserved during health checks.";
  return { ...input, distribution, privilege, message };
}

function readAssets(options: DoctorOptions, expectedVersion: string): { manifest?: DoctorAssetsManifest; check: DoctorCheck; facts: unknown[] } {
  let manifestPath = typeof options.assetsManifest === "string" ? options.assetsManifest : path.join(options.extensionRoot, "out/assets-manifest.json");
  try {
    const packagedVersion = JSON.parse(fs.readFileSync(resolveContainedPath(options.extensionRoot, "package.json"), "utf8")).version;
    if (packagedVersion !== expectedVersion) throw new Error(`Packaged extension version ${packagedVersion} does not match expected version ${expectedVersion}.`);
    if (!options.assetsManifest) {
      // Transitional 0.5 bundles used the singular filename. Only its absence
      // permits fallback: a damaged canonical contract must remain an error.
      try { fs.lstatSync(manifestPath); }
      catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        manifestPath = path.join(options.extensionRoot, "out/asset-manifest.json");
      }
      manifestPath = resolveContainedPath(options.extensionRoot, path.relative(options.extensionRoot, manifestPath).split(path.sep).join("/"));
    }
    const raw = options.assetsManifest && typeof options.assetsManifest === "object" ? options.assetsManifest : JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (raw.schemaVersion !== 1 || raw.extensionVersion !== expectedVersion || !raw.files || Array.isArray(raw.files) || typeof raw.files !== "object") {
      throw new Error("The packaged asset manifest is invalid or does not match the expected extension version.");
    }
    const manifest = raw as DoctorAssetsManifest;
    for (const required of DOCTOR_REQUIRED_ASSETS) if (!Object.hasOwn(manifest.files, required)) throw new Error(`The asset manifest omits required file ${required}.`);
    const facts: unknown[] = [digest(JSON.stringify(manifest))];
    for (const [relative, expected] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) {
      if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256) || (expected.size !== undefined && (!Number.isInteger(expected.size) || expected.size < 0))) throw new Error(`Invalid asset digest for ${relative}.`);
      const file = resolveContainedPath(options.extensionRoot, relative);
      facts.push(fileFact(file));
    }
    return { manifest, facts, check: { id: "assets", status: "ok", required: true, message: "Packaged asset paths are valid." } };
  } catch (error: any) {
    return { facts: [fileFact(manifestPath), error.message], check: { id: "assets", status: "error", required: true, message: `Packaged assets could not be verified: ${error.message || String(error)}` } };
  }
}

function verifyAssetHashes(extensionRoot: string, manifest: DoctorAssetsManifest): DoctorCheck {
  const failures: string[] = [];
  for (const [relative, expected] of Object.entries(manifest.files)) {
    try {
      const file = resolveContainedPath(extensionRoot, relative);
      if (!fs.statSync(file).isFile()) throw new Error("not a regular file");
      const contents = fs.readFileSync(file);
      if (expected.size !== undefined && contents.length !== expected.size) throw new Error("size mismatch");
      if (digest(contents) !== expected.sha256) throw new Error("SHA-256 mismatch");
    } catch (error: any) { failures.push(`${relative}: ${error.message || String(error)}`); }
  }
  return { id: "assets", status: failures.length ? "error" : "ok", required: true,
    message: failures.length ? `${failures.length} packaged assets failed verification.` : `Verified ${Object.keys(manifest.files).length} packaged asset hashes.`, details: failures };
}

export function createDoctor(dependencies: DoctorDependencies = {}): { run(options: DoctorOptions): Promise<DoctorReport>; invalidate(): void } {
  const cache = new Map<string, CacheEntry>();
  const now = dependencies.now || Date.now;
  const find = dependencies.findExecutable || executable;
  const execute = dependencies.executeProcess || executeRunProcess;
  const probeEditors: NonNullable<DoctorDependencies["probeEditors"]> = dependencies.probeEditors || (async context =>
    (await detectEditors({ env: context.env, execute: context.executeProcess })).map(editor => ({ ...editor, error: editor.status === "broken" ? editor.message : undefined })));
  const invalidate = (): void => cache.clear();
  const run = async (options: DoctorOptions): Promise<DoctorReport> => {
    const started = now();
    const extensionRoot = path.resolve(options.extensionRoot);
    const env = { ...process.env, ...options.env };
    let extensionVersion = options.expectedVersion || "unknown";
    if (!options.expectedVersion) { try { extensionVersion = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8")).version; } catch {} }
    const key = JSON.stringify([extensionRoot, options.mode, options.workspaceRoot, options.selectedEngine, options.expectedEditors || [], options.requiredTools || []]);
    const cached = cache.get(key);
    const assets = readAssets({ ...options, extensionRoot }, extensionVersion);
    let requirements: TexRequirements | undefined;
    let requirementsError: string | undefined;
    try { requirements = loadTexRequirements(extensionRoot); } catch (error: any) { requirementsError = error.message || String(error); }
    const core = new Set(["pandoc", options.selectedEngine || "xelatex", "pdflatex", "pandoc-crossref", "mmdc", ...(options.requiredTools || [])]);
    const names = [...new Set([...core, "mmdc", "python3", "ghostscript", ...(options.mode === "full" ? ["kpsewhich"] : [])])];
    const paths = Object.fromEntries(names.map(name => [name, find(name === "ghostscript" ? "gs" : name, env)]));
    let workspacePaths = cached?.workspacePaths || [];
    const workspaceFacts = (): unknown => options.workspaceRoot ? [...new Set([options.workspaceRoot, path.join(options.workspaceRoot, ".inkwell"), path.join(options.workspaceRoot, ".inkwell/manifest.json"), ...workspacePaths])].map(fileFact) : null;
    const editorFacts = (): unknown => dependencies.editorFingerprint?.() ?? (dependencies.probeEditors ? undefined : [
      ...["cursor", "code"].flatMap(id => editorCandidates(id as "cursor" | "code", { env })),
      ...[".cursor/extensions", ".vscode/extensions"].flatMap(relative => [path.join(os.homedir(), relative), path.join(os.homedir(), relative, "extensions.json")]),
    ].map(fileFact));
    const basis = digest(JSON.stringify({ extensionVersion, assets: assets.facts, requirements: requirements?.hash || requirementsError,
      environment: digest(JSON.stringify(Object.entries(env).sort())), paths: Object.entries(paths).map(([name, file]) => [name, file ? fileFact(file) : null]),
      texRoot: cached?.report.tex?.root, databases: texDatabaseFacts(cached?.report.tex?.root), editor: editorFacts(), workspace: workspaceFacts() }));
    if (!options.forceRefresh && cached && cached.basis === basis && now() - cached.createdAt < (options.cacheTtlMs ?? 60_000)) {
      return { ...structuredClone(cached.report), cacheHit: true, durationMs: now() - started, processCount: 0 };
    }
    const checks: DoctorCheck[] = [];
    const tools: Record<string, DoctorTool> = {};
    let processCount = 0;
    const observed: typeof executeRunProcess = async (...args) => { processCount++; return execute(...args); };
    const report = (tex?: TexOwnership, missingPackages: string[] = []): DoctorReport => {
      const ready = checks.every(check => !check.required || check.status === "ok");
      const status = checks.some(check => check.required && check.status === "error") ? "error" : !ready || checks.some(check => check.status === "warning") ? "warning" : "ok";
      return { schemaVersion: 1, mode: options.mode, ready, status, checks, tools, tex, missingPackages,
        fingerprint: digest(JSON.stringify({ basis, tools: Object.fromEntries(Object.entries(tools).sort()), texRoot: tex?.root, databases: texDatabaseFacts(tex?.root), requirements: requirements?.hash, extensionVersion })),
        extensionVersion, cacheHit: false, durationMs: now() - started, processCount, generatedAt: new Date(now()).toISOString() };
    };
    if (options.cachedOnly) {
      checks.push({ id: "cached-health", status: "skipped", required: true, message: "No current cached doctor result is available. Run the light doctor on the next Inkwell action." });
      return report();
    }
    checks.push(assets.manifest ? verifyAssetHashes(extensionRoot, assets.manifest) : assets.check);
    if (requirementsError) checks.push({ id: "requirements-manifest", status: "error", required: true, message: requirementsError });
    else checks.push({ id: "requirements-manifest", status: "ok", required: true, message: `Loaded the installed requirements manifest (${requirements!.packages.length} packages).` });
    await Promise.all(names.map(async name => {
      const binary = paths[name];
      if (!binary) {
        tools[name] = { state: "missing" };
        return;
      }
      try {
        fs.accessSync(binary, fs.constants.X_OK);
        const result = await observed(binary, ["--version"], { cwd: extensionRoot, env, timeoutMs: 5_000, maxBuffer: 1024 * 1024 });
        const version = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/)[0];
        const ready = successful(result) && /\d/.test(version);
        tools[name] = { path: binary, state: ready ? "ready" : "broken", version: ready ? version : undefined, exitCode: result.exitCode, signal: result.signal,
          error: ready ? undefined : result.error || result.stderr.trim() || "The executable did not return a successful version probe." };
      } catch (error: any) { tools[name] = { path: binary, state: "broken", error: error.message || String(error) }; }
    }));
    for (const name of names) {
      const tool = tools[name];
      const required = core.has(name) || name === "kpsewhich";
      checks.push({ id: `tool:${name}`, required, status: tool.state === "ready" ? "ok" : required ? "error" : "warning",
        message: tool.state === "ready" ? `${name}: ${tool.version}` : `${name} is ${tool.state === "missing" ? "not installed" : "present but its executable/version probe failed"}.`, details: tool });
    }
    if (probeEditors) {
      try {
        const editors = await probeEditors({ expectedVersion: extensionVersion, expectedEditors: options.expectedEditors || [], env, executeProcess: observed });
        const ids = [...new Set([...(options.expectedEditors || []), ...editors.map(editor => editor.id)])];
        for (const id of ids) {
          const editor = editors.find(candidate => candidate.id === id);
          const required = Boolean(options.expectedEditors?.includes(id));
          const verified = Boolean(editor?.path && editor.version && !editor.error && editor.extensionVersion === extensionVersion);
          checks.push({ id: `editor:${id}`, required, status: verified ? "ok" : required ? "error" : "warning",
            message: verified ? `${id} has Inkwell ${extensionVersion} installed.` : `${id} did not verify the expected Inkwell ${extensionVersion} installation.`, details: editor });
        }
        if (!ids.length) checks.push({ id: "editors", required: false, status: "skipped", message: "No supported editor was detected in this environment." });
      } catch (error: any) {
        checks.push({ id: "editors", required: Boolean(options.expectedEditors?.length), status: options.expectedEditors?.length ? "error" : "warning", message: `Editor probing failed: ${error.message || String(error)}` });
      }
    } else checks.push({ id: "editors", required: Boolean(options.expectedEditors?.length), status: options.expectedEditors?.length ? "error" : "skipped", message: "No editor-detection adapter was provided." });
    if (options.workspaceRoot) {
      try {
        const workspaceRoot = path.resolve(options.workspaceRoot);
        if (!fs.existsSync(resolveContainedPath(workspaceRoot, ".inkwell"))) checks.push({ id: "workspace", required: false, status: "warning", message: "This folder has not opted in to Inkwell setup. No files were changed." });
        else {
          const plan = planMigration(workspaceRoot, extensionRoot);
          workspacePaths = plan.observedPaths.map(relative => resolveContainedPath(workspaceRoot, relative));
          checks.push({ id: "workspace", required: true, status: plan.blocked ? "error" : plan.operations.length || plan.conflicts.length || plan.resumed ? "warning" : "ok",
            message: plan.blocked ? "Workspace scaffold needs repair." : plan.operations.length || plan.conflicts.length || plan.resumed ? "Workspace scaffold has pending migrations or conflicts." : "Workspace scaffold is up to date.",
            details: { diagnostics: plan.diagnostics, conflicts: plan.conflicts, operationCount: plan.operations.length } });
        }
      } catch (error: any) { checks.push({ id: "workspace", required: true, status: "error", message: error.message || String(error) }); }
    } else checks.push({ id: "workspace", required: false, status: "skipped", message: "No workspace was selected; workspace files were not accessed." });

    let tex: TexOwnership | undefined;
    const missingPackages: string[] = [];
    if (options.mode === "full") {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inkwell-doctor-"));
      try {
        if (tools.pandoc?.state === "ready" && tools["pandoc-crossref"]?.state === "ready") {
          const fixture = path.join(temporaryRoot, "crossref.md");
          fs.writeFileSync(fixture, "# Doctor section {#sec:doctor}\n\nSee @sec:doctor.\n");
          const result = await observed(tools.pandoc.path!, [fixture, "--from=markdown", "--to=plain", "--number-sections", "--filter", tools["pandoc-crossref"].path!], { cwd: temporaryRoot, env, timeoutMs: 20_000 });
          const passed = successful(result) && /See\s+(?:sec(?:tion)?\.?\s*)?1\./i.test(result.stdout) && !/undefined|not found|unresolved|@sec:doctor/i.test(result.stderr + result.stdout);
          checks.push({ id: "crossref-functional", required: true, status: passed ? "ok" : "error", message: passed ? "Pandoc and pandoc-crossref resolve the same functional fixture." : "Pandoc and pandoc-crossref failed the reference conversion fixture.", details: result });
        } else checks.push({ id: "crossref-functional", required: true, status: "skipped", message: "Functional cross-reference check requires working Pandoc and pandoc-crossref." });
        if (tools.kpsewhich?.state === "ready") {
          const rootProbe = await observed(tools.kpsewhich.path!, ["-var-value", "TEXMFROOT"], { cwd: temporaryRoot, env, timeoutMs: 5_000 });
          try {
            if (!successful(rootProbe) || !rootProbe.stdout.trim()) throw new Error("TEXMFROOT probe failed.");
            const root = fs.realpathSync(rootProbe.stdout.trim());
            const stat = fs.statSync(root);
            if (!stat.isDirectory()) throw new Error("TEXMFROOT is not a directory.");
            let writable = false;
            try { fs.accessSync(root, fs.constants.W_OK); writable = true; } catch {}
            tex = classifyTexOwnership({ root, ownerUid: stat.uid, currentUid: dependencies.uid ?? process.getuid?.() ?? stat.uid, writable, platform: dependencies.platform });
            checks.push({ id: "tex-root", required: true, status: tex.privilege === "repair-required" ? "warning" : "ok", message: tex.message, details: tex });
          } catch (error: any) { checks.push({ id: "tex-root", required: true, status: "error", message: error.message || String(error) }); }
          if (requirements) {
            const files = [...new Set(requirements.packages.flatMap(pkg => [...pkg.files]))];
            const missingFiles = new Set<string>();
            for (let start = 0; start < files.length; start += 12) {
              await Promise.all(files.slice(start, start + 12).map(async file => {
                const result = await observed(tools.kpsewhich.path!, texFileProbeArguments(file), { cwd: temporaryRoot, env, timeoutMs: 5_000 });
                // A filename may contain newlines; kpsewhich returns one requested path.
                const found = result.stdout.replace(/\r?\n$/, "");
                if (!successful(result) || !found || !path.isAbsolute(found) || !fs.existsSync(found) || !fs.statSync(found).isFile()) missingFiles.add(file);
              }));
            }
            missingPackages.push(...requirements.packages.filter(pkg => pkg.files.some(file => missingFiles.has(file))).map(pkg => pkg.name));
            for (const pkg of requirements.packages) checks.push({ id: `tex-package:${pkg.name}`, required: true, status: missingPackages.includes(pkg.name) ? "error" : "ok",
              message: missingPackages.includes(pkg.name) ? `Required TeX package ${pkg.name} has missing files.` : `Verified TeX package ${pkg.name}.`, details: { files: pkg.files, missingFiles: pkg.files.filter(file => missingFiles.has(file)) } });
            checks.push({ id: "tex-requirements", required: true, status: missingPackages.length ? "error" : "ok",
              message: missingPackages.length ? `${missingPackages.length} required TeX packages have missing files.` : `Verified all ${files.length} required TeX files from ${requirements.packages.length} installed-manifest packages.`, details: { missingPackages, missingFiles: [...missingFiles] } });
          } else checks.push({ id: "tex-requirements", required: true, status: "skipped", message: "The installed requirements manifest must be repaired before package verification." });
        } else {
          checks.push({ id: "tex-root", required: true, status: "skipped", message: "A working kpsewhich is required to inspect the TeX distribution." });
          checks.push({ id: "tex-requirements", required: true, status: "skipped", message: "A working kpsewhich is required to verify the exact package file manifest." });
        }
        if (!dependencies.smokeCompile) checks.push({ id: "smoke-compile", required: true, status: "skipped", message: "No Inkwell compiler adapter is configured for the required PDF smoke build." });
        else if (checks.some(check => check.required && check.status !== "ok" && check.id !== "workspace" && !check.id.startsWith("editor"))) {
          checks.push({ id: "smoke-compile", required: true, status: "skipped", message: "Repair required compilation capabilities before the PDF smoke build." });
        } else {
          const smoke = await dependencies.smokeCompile({ temporaryRoot, extensionRoot, tools, env });
          if (smoke.success) {
            try {
              if (!smoke.pdfPath || !path.isAbsolute(smoke.pdfPath)) throw new Error("The smoke compiler did not return an absolute PDF path.");
              resolveContainedPath(temporaryRoot, path.relative(temporaryRoot, smoke.pdfPath));
              validatePdf(smoke.pdfPath);
            } catch (error: any) { smoke.success = false; smoke.message = `The smoke PDF could not be verified: ${error.message || String(error)}`; }
          }
          checks.push({ id: "smoke-compile", required: true, status: smoke.success ? "ok" : "error", message: smoke.message, details: smoke });
        }
      } catch (error: any) {
        checks.push({ id: "full-doctor", required: true, status: "error", message: `Full doctor failed: ${error.message || String(error)}` });
        if (!checks.some(check => check.id === "smoke-compile")) checks.push({ id: "smoke-compile", required: true, status: "skipped", message: "The full doctor failed before the PDF smoke build could be verified." });
      } finally {
        try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
        catch (error: any) { checks.push({ id: "scratch-cleanup", required: false, status: "warning", message: `Temporary doctor fixtures could not be removed: ${error.message || String(error)}` }); }
      }
    }
    const result = report(tex, missingPackages);
    // Include the newly learned root/database state in the pre-probe cache key.
    const storedBasis = digest(JSON.stringify({ extensionVersion, assets: assets.facts, requirements: requirements?.hash || requirementsError,
      environment: digest(JSON.stringify(Object.entries(env).sort())), paths: Object.entries(paths).map(([name, file]) => [name, file ? fileFact(file) : null]),
      texRoot: tex?.root, databases: texDatabaseFacts(tex?.root), editor: editorFacts(), workspace: workspaceFacts() }));
    cache.set(key, { report: structuredClone(result), basis: storedBasis, createdAt: now(), workspacePaths });
    return result;
  };
  return { run, invalidate };
}

const defaultDoctor = createDoctor();
export const runDoctor = defaultDoctor.run;
export const invalidateDoctorCache = defaultDoctor.invalidate;

export function formatDoctorText(report: DoctorReport): string {
  return [`Inkwell ${report.extensionVersion} ${report.mode} doctor: ${report.ready ? "ready" : "not ready"}`,
    ...report.checks.map(check => `[${check.status}] ${check.message}`),
    `Processes: ${report.processCount}; elapsed: ${report.durationMs} ms${report.cacheHit ? " (cached)" : ""}`].join("\n");
}
