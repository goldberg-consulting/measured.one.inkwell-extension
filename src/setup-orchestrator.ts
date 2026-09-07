import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const SETUP_STAGES = ["preflight", "consent", "install", "re-probe", "scaffold-migrate", "smoke-compile", "complete"] as const;
export type SetupStage = typeof SETUP_STAGES[number];
export type SetupStageStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export interface SetupAction { id: string; label: string; path?: string; proposedPath?: string; detail?: string }
export interface SetupInstallStep {
  id: string; label: string; command: string; args: readonly string[];
  cwd?: string; env?: Readonly<Record<string, string>>; verificationIds: readonly string[];
}
export interface InstallPlan { id: string; title: string; steps: readonly SetupInstallStep[] }
export interface SetupDoctorReport {
  mode: "light" | "full"; ready: boolean; status: string; fingerprint: string;
  checks: readonly { id: string; status: string; required: boolean; message: string }[];
}
export interface SetupState {
  schemaVersion: 1; id: string; projectRoot: string; updatedAt: string;
  status: "running" | "awaiting-consent" | "failed" | "cancelled" | "complete";
  stage: SetupStage;
  stages: Record<SetupStage, { status: SetupStageStatus; attempts: number; message?: string; verifiedFingerprint?: string }>;
  logs: { time: string; stage: SetupStage; message: string }[];
  actions: SetupAction[];
  warnings?: string[];
  plan?: InstallPlan; planHash?: string; consent?: { planHash: string; authorizedAt: string };
}
export interface SetupStore { load(): Promise<SetupState | undefined>; save(state: SetupState): Promise<void> }
export interface SetupProcessOutcome {
  exitCode: number | null; rawExitCode?: number | null; signal?: string | null;
  cancelled?: boolean; timedOut?: boolean; maxBufferExceeded?: boolean;
  stdout?: string; stderr?: string; error?: string;
}
export interface SetupDependencies<Report extends SetupDoctorReport = SetupDoctorReport> {
  store: SetupStore;
  doctor(options: { mode: "full"; forceRefresh: true; workspaceRoot: string; signal?: AbortSignal }): Promise<Report>;
  plan(report: Report): Promise<InstallPlan> | InstallPlan;
  consent(plan: InstallPlan, hash: string): Promise<boolean>;
  install(plan: InstallPlan, context: { signal?: AbortSignal; onLog(message: string): void }): Promise<SetupProcessOutcome>;
  readiness(options: { root: string; signal?: AbortSignal }): Promise<{
    ready: boolean; diagnostics?: readonly { message: string; severity?: string }[]; actions?: readonly SetupAction[];
  }>;
  smoke(options: { root: string; signal?: AbortSignal }): Promise<{
    success: boolean; verified: boolean; logs?: readonly string[]; actions?: readonly SetupAction[];
  }>;
  now?(): Date;
}
export interface SetupRunOptions { projectRoot: string; signal?: AbortSignal; onProgress?(state: Readonly<SetupState>): void }

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function hashInstallPlan(plan: InstallPlan): string { return createHash("sha256").update(canonical(plan)).digest("hex"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function snapshotPlan(plan: InstallPlan): InstallPlan {
  const copy = clone(plan);
  if (!copy || typeof copy.id !== "string" || typeof copy.title !== "string" || !Array.isArray(copy.steps)) throw new Error("The install plan is invalid.");
  const ids = new Set<string>();
  for (const step of copy.steps) {
    if (!step.id || ids.has(step.id) || typeof step.label !== "string" || typeof step.command !== "string" || !path.isAbsolute(step.command)
      || !Array.isArray(step.args) || step.args.some((arg: unknown) => typeof arg !== "string" || arg.includes("\0"))
      || !Array.isArray(step.verificationIds) || !step.verificationIds.length || step.verificationIds.some((id: unknown) => typeof id !== "string" || !id)
      || (step.cwd !== undefined && (typeof step.cwd !== "string" || !path.isAbsolute(step.cwd)))
      || (step.env !== undefined && (!step.env || typeof step.env !== "object" || Object.values(step.env).some(value => typeof value !== "string")))) {
      throw new Error("The install plan must contain distinct steps, absolute executables, argument arrays and verification checks.");
    }
    if (/^(?:ba|z|da|fi|k|c|tc)?sh$|^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|osascript)$/i.test(path.basename(step.command))) throw new Error("Setup does not accept shell-wrapper installation commands.");
    ids.add(step.id);
  }
  return freeze(copy);
}
function validateState(state: SetupState, projectRoot?: string): void {
  if (!state || state.schemaVersion !== 1 || typeof state.id !== "string" || typeof state.projectRoot !== "string"
    || !Array.isArray(state.logs) || !Array.isArray(state.actions) || !SETUP_STAGES.includes(state.stage)
    || !["running", "awaiting-consent", "failed", "cancelled", "complete"].includes(state.status)
    || SETUP_STAGES.some(stage => !state.stages?.[stage] || !Number.isInteger(state.stages[stage].attempts))
    || (projectRoot !== undefined && state.projectRoot !== projectRoot)) throw new Error("Saved setup state is invalid or belongs to another project.");
}
/** The caller chooses a per-project state path in extension storage, outside the scaffold. */
export function createFileSetupStore(file: string): SetupStore {
  return {
    async load() {
      if (!fs.existsSync(file)) return undefined;
      if (!fs.lstatSync(file).isFile()) throw new Error("Setup state must be a regular file.");
      const state = JSON.parse(fs.readFileSync(file, "utf8")); validateState(state); return state;
    },
    async save(state) {
      validateState(state);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error("Setup state must be a regular file.");
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    },
  };
}

class SetupCancelled extends Error {}
const activeRuns = new Map<string, Promise<SetupState>>();

/** Side effects are injected. Every invocation probes again; saved consent applies only to the exact current plan. */
export function createSetupOrchestrator<Report extends SetupDoctorReport>(deps: SetupDependencies<Report>): { run(options: SetupRunOptions): Promise<SetupState> } {
  async function execute(options: SetupRunOptions): Promise<SetupState> {
    const root = path.resolve(options.projectRoot);
    const now = () => (deps.now?.() || new Date()).toISOString();
    const saved = await deps.store.load();
    if (saved) validateState(saved, root);
    const state: SetupState = saved ? clone(saved) : { schemaVersion: 1, id: randomUUID(), projectRoot: root,
      updatedAt: now(), status: "running", stage: "preflight", logs: [], actions: [],
      stages: Object.fromEntries(SETUP_STAGES.map(stage => [stage, { status: "pending", attempts: 0 }])) as SetupState["stages"] };
    let persistence = Promise.resolve();
    const persist = () => {
      state.updatedAt = now();
      const snapshot = clone(state);
      persistence = persistence.then(() => deps.store.save(snapshot));
      options.onProgress?.(freeze(clone(snapshot)));
      return persistence;
    };
    const log = (message: string) => { state.logs.push({ time: now(), stage: state.stage, message }); };
    const checkCancelled = () => { if (options.signal?.aborted) throw new SetupCancelled("Setup was cancelled. Saved progress can be resumed."); };
    const begin = async (stage: SetupStage) => {
      checkCancelled(); state.stage = stage; state.stages[stage].status = "running"; state.stages[stage].attempts++;
      delete state.stages[stage].message; log(`Starting ${stage}.`); await persist();
    };
    const succeed = async (stage: SetupStage, message: string, fingerprint?: string) => {
      checkCancelled(); state.stages[stage].status = "succeeded"; state.stages[stage].message = message;
      state.stages[stage].verifiedFingerprint = fingerprint; log(message); await persist();
    };
    const probe = async () => {
      const report = await deps.doctor({ mode: "full", forceRefresh: true, workspaceRoot: root, signal: options.signal });
      checkCancelled();
      if (report.mode !== "full" || !Array.isArray(report.checks) || typeof report.fingerprint !== "string") throw new Error("Setup requires a fresh full Doctor report.");
      for (const check of report.checks) log(`${check.id}: ${check.status}: ${check.message}`);
      state.warnings = report.checks.filter(check => !check.required && check.status === "warning" && check.id !== "workspace").map(check => check.message);
      return report;
    };
    const failingChecks = (report: SetupDoctorReport) => report.checks.filter(check => check.required && !["workspace", "smoke-compile"].includes(check.id) && check.status !== "ok");
    const verified = (plan: InstallPlan, report: SetupDoctorReport) => plan.steps.every(step => step.verificationIds.every(id => report.checks.some(check => check.id === id && check.status === "ok")));
    try {
      for (const stage of SETUP_STAGES) {
        if (state.stages[stage].status === "running") log(`Interrupted ${stage}; verification will run again.`);
        state.stages[stage].status = "pending";
      }
      state.status = "running"; state.actions = [];
      await begin("preflight");
      let report = await probe();
      let plan = snapshotPlan(await deps.plan(report));
      await succeed("preflight", "Preflight verified the current environment and installation requirements.", report.fingerprint);
      for (let round = 0; ; round++) {
        if (round >= 3) throw new Error("Setup reached the installation retry limit. Review the diagnostic log before resuming.");
        const hash = hashInstallPlan(plan);
        if (state.planHash !== hash || state.consent?.planHash !== hash) delete state.consent;
        state.plan = clone(plan); state.planHash = hash; await persist();
        await begin("consent");
        if (plan.steps.length && state.consent?.planHash !== hash) {
          const authorized = await deps.consent(plan, hash); checkCancelled();
          if (!authorized) {
            state.status = "awaiting-consent"; state.stages.consent.status = "cancelled";
            log("System installation is waiting for approval of this exact plan.");
            state.actions = [{ id: "resume-setup", label: "Review installation plan" }]; await persist(); return clone(state);
          }
          state.consent = { planHash: hash, authorizedAt: now() }; await persist();
        }
        await succeed("consent", plan.steps.length ? "The exact installation plan is authorized." : "No system installation is required.");
        await begin("install");
        if (plan.steps.length) {
          const outcome = await deps.install(plan, { signal: options.signal, onLog: message => { log(message); void persist().catch(() => {}); } });
          await persistence;
          if (outcome.stdout) log(outcome.stdout); if (outcome.stderr) log(outcome.stderr);
          if (outcome.cancelled) throw new SetupCancelled("Installation was cancelled. Its logs and consent are saved for resuming.");
          checkCancelled();
          if (outcome.exitCode !== 0 || (outcome.rawExitCode !== undefined && outcome.rawExitCode !== 0) || outcome.signal || outcome.timedOut || outcome.maxBufferExceeded || outcome.error) {
            throw new Error(outcome.error || `Installation failed (exit ${outcome.exitCode}${outcome.signal ? `, ${outcome.signal}` : ""}${outcome.timedOut ? ", timed out" : ""}${outcome.maxBufferExceeded ? ", output limit exceeded" : ""}).`);
          }
          log("The installation process exited successfully; fresh verification is still required."); await persist();
        }
        await begin("re-probe"); report = await probe();
        if (!verified(plan, report)) throw new Error("Installation finished, but a fresh probe did not verify every installed requirement.");
        await succeed("install", "Fresh probes verified the installation plan.", report.fingerprint);
        const next = snapshotPlan(await deps.plan(report));
        if (next.steps.length && hashInstallPlan(next) !== hash) { plan = next; log("Fresh probes found a new installation plan; renewed consent is required."); continue; }
        const failed = failingChecks(report);
        if (failed.length) throw new Error(`Setup verification failed: ${failed.map(check => check.message).join("; ")}`);
        await succeed("re-probe", "Fresh probes verified the required tools and assets.", report.fingerprint);
        break;
      }
      await begin("scaffold-migrate");
      const readiness = await deps.readiness({ root, signal: options.signal }); checkCancelled();
      for (const diagnostic of readiness.diagnostics || []) log(diagnostic.message);
      state.warnings = [...(state.warnings || []), ...(readiness.diagnostics || []).filter(diagnostic => diagnostic.severity === "warning").map(diagnostic => diagnostic.message)];
      state.actions = clone([...(readiness.actions || [])]);
      if (!readiness.ready) throw new Error("Project scaffold verification failed. Resolve the reported project repair actions and resume setup.");
      await succeed("scaffold-migrate", "The shared readiness service verified the project scaffold.");
      await begin("smoke-compile");
      const smoke = await deps.smoke({ root, signal: options.signal }); checkCancelled();
      for (const message of smoke.logs || []) log(message);
      state.actions = clone([...(smoke.actions || [])]);
      if (!smoke.success || !smoke.verified) throw new Error("Smoke compilation did not produce a freshly verified document.");
      await succeed("smoke-compile", "Smoke compilation produced a freshly verified document.");
      await begin("complete");
      await succeed("complete", "Setup is complete; tools, scaffold and smoke compilation are verified.");
      state.status = "complete"; await persist();
    } catch (error) {
      const cancelled = error instanceof SetupCancelled || options.signal?.aborted;
      const message = error instanceof Error ? error.message : String(error);
      state.status = cancelled ? "cancelled" : "failed";
      for (const stage of SETUP_STAGES) if (state.stages[stage].status === "running") { state.stages[stage].status = cancelled ? "cancelled" : "failed"; state.stages[stage].message = message; }
      log(message);
      if (!state.actions.length) state.actions = [{ id: "resume-setup", label: cancelled ? "Resume setup" : "Repair and retry" }, { id: "show-setup-log", label: "Show diagnostics" }];
      await persist();
    }
    return clone(state);
  }
  return { run(options) {
    const root = path.resolve(options.projectRoot);
    if (activeRuns.has(root)) return Promise.reject(new Error("Setup / Repair is already running for this project. Wait for it to finish before starting another setup or package installation."));
    const work = execute(options).finally(() => { if (activeRuns.get(root) === work) activeRuns.delete(root); });
    activeRuns.set(root, work); return work;
  } };
}
