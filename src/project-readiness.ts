import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { BUNDLED_ASSET_PATHS, resolveContainedPath, AssetDiagnostic } from "./bundled-assets";
import { applyMigration, planMigration, MigrationPlan, MigrationResult } from "./scaffold-migrations";

export interface ReadinessAction { id: "setup-workspace" | "compare" | "repair-manifest"; label: string; path?: string; proposedPath?: string }
export interface ProjectReadiness {
  ready: boolean;
  status: "ready" | "setup-required" | "suppressed" | "blocked" | "conflicts";
  root?: string;
  actions: ReadinessAction[];
  diagnostics: AssetDiagnostic[];
  migration?: MigrationResult;
  plan?: MigrationPlan;
  cached?: boolean;
}
export interface ProjectReadinessOptions {
  root?: string;
  trusted: boolean;
  explicitSetup?: boolean;
  dontAskHere?: boolean;
  readOnly?: boolean;
  assetRoot?: string;
  template?: string;
  resolveConflicts?: "keep-user-files";
}
const healthCache = new Map<string, { fingerprint: string; result: ProjectReadiness }>();

export function isProjectOptedIn(root: string): boolean {
  const resolved = path.resolve(root);
  if (resolved === path.resolve(os.homedir()) && !fs.existsSync(path.join(resolved, ".inkwell", "manifest.json"))) return false;
  return fs.existsSync(path.join(resolved, ".inkwell"));
}

function fingerprint(plan: MigrationPlan): string {
  const paths = new Set([".inkwell", ...plan.observedPaths]);
  for (const relative of [...paths]) {
    const pieces = relative.split("/");
    while (pieces.length > 1) { pieces.pop(); paths.add(pieces.join("/")); }
  }
  const facts: unknown[] = [];
  for (const [root, relatives] of [[plan.root, [...paths].sort()], [plan.assetRoot, BUNDLED_ASSET_PATHS]] as const) {
    for (const relative of relatives) {
      try {
        const full = resolveContainedPath(root, relative);
        const stat = fs.lstatSync(full);
        facts.push([root, relative, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode]);
      } catch { facts.push([root, relative, "missing-or-unsafe"]); }
    }
  }
  return crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

export function invalidateProjectReadiness(root?: string): void {
  if (!root) healthCache.clear();
  else for (const key of healthCache.keys()) if (key.startsWith(path.resolve(root) + "::")) healthCache.delete(key);
}

/** Consent/prompt persistence belongs to the caller; this service never imports VS Code. */
export async function ensureProjectReady(options: ProjectReadinessOptions): Promise<ProjectReadiness> {
  const root = options.root ? path.resolve(options.root) : undefined;
  const blocked = (message: string): ProjectReadiness => ({ ready: false, status: "blocked", root, actions: [], diagnostics: [{ path: root || "", severity: "error", message }] });
  if (!root) return blocked("Choose a saved document and workspace folder before creating or migrating an Inkwell project.");
  if (!options.trusted) return blocked("Workspace trust is required before Inkwell can create or migrate project files.");
  try {
    if (!fs.statSync(root).isDirectory()) return blocked("The selected project root is not a directory.");
    const inkwell = resolveContainedPath(root, ".inkwell");
    const optedIn = isProjectOptedIn(root);
    if (!optedIn && !options.explicitSetup) {
      return { ready: false, root, status: options.dontAskHere ? "suppressed" : "setup-required", diagnostics: [],
        actions: options.dontAskHere ? [] : [{ id: "setup-workspace", label: "Set up this workspace" }] };
    }
    if (options.readOnly || !(fs.statSync(root).mode & 0o222)) return blocked("The workspace is read-only; creating or migrating the scaffold is blocked.");
    fs.accessSync(root, fs.constants.W_OK);
    if (optedIn && !(fs.statSync(inkwell).mode & 0o222)) return blocked("The .inkwell directory is read-only; scaffold migration is blocked.");
    const assetRoot = options.assetRoot || path.join(__dirname, "..");
    const key = `${root}::${path.resolve(assetRoot)}`;
    const cached = healthCache.get(key);
    if (cached?.result.plan && cached.fingerprint === fingerprint(cached.result.plan)) return { ...cached.result, cached: true };
    const plan = planMigration(root, assetRoot, { template: options.template });
    // Existing opted-in projects may safely receive comparison proposals. The
    // scaffold version remains unchanged until the user resolves every conflict.
    const migration = applyMigration(plan, { resolveConflicts: options.resolveConflicts });
    if (migration.success && plan.resumed) {
      // Finish the interrupted transaction, then assess the currently installed
      // extension assets in case an upgrade happened while that work was pending.
      return ensureProjectReady(options);
    }
    const result: ProjectReadiness = {
      ready: migration.success, status: migration.success ? "ready" : migration.status === "conflict" ? "conflicts" : "blocked",
      root, plan, migration, diagnostics: migration.diagnostics,
      actions: migration.conflicts.map((conflict) => ({ id: "compare", label: conflict.message, path: path.join(root, conflict.path), proposedPath: conflict.proposalPath ? path.join(root, conflict.proposalPath) : undefined })),
    };
    if (migration.success) healthCache.set(key, { result, fingerprint: fingerprint(plan) });
    return result;
  } catch (error: any) {
    return blocked(`Scaffold readiness is blocked: ${error.message || String(error)}`);
  }
}
