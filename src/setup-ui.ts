import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createDoctor, DoctorReport, runDoctor, invalidateDoctorCache } from "./doctor";
import { createFileSetupStore, createSetupOrchestrator, InstallPlan, SetupDependencies, SetupProcessOutcome, SetupState, SETUP_STAGES } from "./setup-orchestrator";
import { asSetupPlan, doctorToInstallationPlan, probeRequestedPackage, requestedPackagePlan, validateRequestedPackage } from "./setup-adapters";
import { ensureProjectReadyWithUI } from "./project-readiness-ui";
import { getInkwellOutputChannel } from "./inkwell-output";
import { buildTexInvocationPath } from "./shell-env";
import { executeRunProcess, RunCancellation } from "./run-process";
import { runSmokeBuild } from "./smoke-build";

const taskSuccess = (): SetupProcessOutcome => ({ exitCode: 0, rawExitCode: 0, signal: null, cancelled: false });
const taskFailure = (message: string, cancelled = false): SetupProcessOutcome => ({ exitCode: cancelled ? 130 : 1, rawExitCode: null, signal: null, cancelled, error: message });

/** Process tasks retain interactive password prompts while providing authoritative completion events. */
export async function runInstallationTasks(plan: InstallPlan, options: {
  signal?: AbortSignal; onLog?(message: string): void; timeoutMs?: number;
} = {}): Promise<SetupProcessOutcome> {
  for (const step of plan.steps) {
    if (options.signal?.aborted) return taskFailure("Installation cancelled.", true);
    const name = path.basename(step.command), args = [...step.args];
    const packageArgs = name === "tlmgr" ? args.slice(1) : step.command === "/usr/bin/sudo" ? args.slice(2) : [];
    const allowed = path.isAbsolute(step.command) && (
      name === "brew" && args[0] === "install" && args.slice(1).every(arg => /^[A-Za-z0-9@+_.-]+$/.test(arg)) ||
      name === "tlmgr" && args[0] === "install" && packageArgs.length > 0 && packageArgs.every(arg => /^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(arg)) ||
      step.command === "/usr/bin/sudo" && path.isAbsolute(args[0] || "") && path.basename(args[0] || "") === "tlmgr" && args[1] === "install" && packageArgs.length > 0 && packageArgs.every(arg => /^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(arg)));
    if (!allowed) return taskFailure("The installation task contains an unsupported command or argument.");
    options.onLog?.(`${step.label}\n${JSON.stringify([step.command, ...args])}\nDetailed installer output is retained in the Inkwell Setup task terminal.`);
    const outcome = await new Promise<SetupProcessOutcome>(resolve => {
      const id = randomUUID();
      let execution: vscode.TaskExecution | undefined, done = false, cancelled = false, timedOut = false;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const subscriptions: vscode.Disposable[] = [];
      const terminate = () => { try { execution?.terminate(); } catch (error) { options.onLog?.(`The task could not be terminated: ${String(error)}`); } };
      const finish = (result: SetupProcessOutcome) => {
        if (done) return; done = true;
        if (timer) clearTimeout(timer); if (fallback) clearTimeout(fallback);
        options.signal?.removeEventListener("abort", abort); subscriptions.forEach(subscription => subscription.dispose());
        resolve(result);
      };
      const matches = (candidate: vscode.TaskExecution) => candidate === execution || candidate.task.definition.inkwellSetupId === id;
      const abort = () => {
        cancelled = true; terminate();
        if (!fallback) fallback = setTimeout(() => finish(taskFailure("Installation cancellation did not produce a process exit status.", true)), 5000);
      };
      subscriptions.push(vscode.tasks.onDidEndTaskProcess(event => {
        if (!matches(event.execution)) return;
        const code = event.exitCode;
        finish({ exitCode: cancelled || timedOut ? 130 : code ?? 1, rawExitCode: code ?? null, signal: null,
          cancelled, timedOut, error: code === undefined ? "The task ended without a process exit status." : undefined });
      }));
      subscriptions.push(vscode.tasks.onDidEndTask(event => {
        if (!matches(event.execution) || done || fallback) return;
        fallback = setTimeout(() => finish(taskFailure("The task ended without a process exit status.", cancelled)), 50);
      }));
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const task = new vscode.Task({ type: "inkwell-setup", inkwellSetupId: id }, vscode.TaskScope.Workspace,
          `Inkwell Setup: ${step.label}`, "Inkwell", new vscode.ProcessExecution(step.command, args, { cwd: step.cwd, env: step.env ? { ...step.env } : undefined }));
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, focus: true, clear: false };
        timer = setTimeout(() => { timedOut = true; terminate();
          fallback = setTimeout(() => finish({ ...taskFailure("Installation timed out."), timedOut: true }), 5000);
        }, options.timeoutMs ?? 60 * 60 * 1000);
        Promise.resolve(vscode.tasks.executeTask(task)).then(value => {
          execution = value;
          if (done || timedOut) terminate();
          else if (cancelled || options.signal?.aborted) abort();
        }, error => finish(taskFailure(`The installation task could not start: ${String(error)}`)));
      } catch (error) { finish(taskFailure(`The installation task could not start: ${String(error)}`)); }
    });
    options.onLog?.(`${step.label}: ${outcome.cancelled ? "cancelled" : `exit ${outcome.rawExitCode ?? "unknown"}`}.`);
    if (outcome.exitCode !== 0 || outcome.rawExitCode !== 0 || outcome.cancelled || outcome.timedOut || outcome.error) return outcome;
  }
  return taskSuccess();
}

export interface SetupUI {
  run(root?: string, template?: string): Promise<SetupState | undefined>;
  installPackage(name: string, root?: string): Promise<void>;
  checkLight(cachedOnly?: boolean, root?: string): Promise<DoctorReport>;
}
export function registerSetupCommands(context: Pick<vscode.ExtensionContext, "subscriptions">, ui: Pick<SetupUI, "run">): void {
  for (const command of ["inkwell.setupRepair", "inkwell.setupToolchain"]) context.subscriptions.push(
    vscode.commands.registerCommand(command, async () => await ui.run()));
}

async function chooseRoot(root?: string): Promise<string | undefined> {
  if (root) return path.resolve(root);
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length === 1) return folders[0].uri.fsPath;
  if (folders?.length) return (await vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the project to set up or repair" }))?.uri.fsPath;
  return (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Set up this folder" }))?.[0]?.fsPath;
}

export function createSetupUI(context: vscode.ExtensionContext, overrides: Partial<SetupDependencies<DoctorReport>> = {}): SetupUI {
  const output = getInkwellOutputChannel();
  const environment = () => ({ ...process.env, PATH: buildTexInvocationPath() });
  const checkLight = (cachedOnly = false, root?: string) => runDoctor({ extensionRoot: context.extensionPath, mode: "light", cachedOnly, workspaceRoot: root, env: environment() });
  const run = async (providedRoot?: string, template?: string, requestedPackage?: string): Promise<SetupState | undefined> => {
    if (vscode.workspace.isTrusted === false) { await vscode.window.showErrorMessage("Trust this workspace before running Setup / Repair."); return undefined; }
    const root = await chooseRoot(providedRoot); if (!root) return undefined;
    const controller = new AbortController();
    const env = environment();
    const doctor = createDoctor({ executeProcess: async (command, args, options) => {
      const cancellation = new RunCancellation(), abort = () => cancellation.cancel();
      if (controller.signal.aborted) abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      try { return await executeRunProcess(command, args, options, cancellation); }
      finally { controller.signal.removeEventListener("abort", abort); }
    } });
    const stateKey = createHash("sha256").update(`${root}\n${requestedPackage || "setup"}`).digest("hex");
    const deps: SetupDependencies<DoctorReport> = {
      store: createFileSetupStore(path.join(context.globalStorageUri.fsPath, "setup", `${stateKey}.json`)),
      doctor: async options => {
        let report = await doctor.run({ ...options, extensionRoot: context.extensionPath, env });
        if (requestedPackage) report = await probeRequestedPackage(report, requestedPackage, { cwd: root, env, signal: controller.signal });
        return report;
      },
      plan: report => requestedPackage ? requestedPackagePlan(report, requestedPackage, root, env)
        : asSetupPlan(doctorToInstallationPlan(report, { cwd: root, extensionRoot: context.extensionPath, env })),
      consent: async plan => await vscode.window.showWarningMessage(plan.title, { modal: true,
        detail: `${plan.steps.map(step => `${step.label}\n${JSON.stringify([step.command, ...step.args])}`).join("\n\n")}\n\nAdministrator approval may be requested in the task terminal.` }, "Install") === "Install",
      install: (plan, options) => runInstallationTasks(plan, options),
      readiness: () => ensureProjectReadyWithUI({ root, template, trusted: true, explicitSetup: true, assetRoot: context.extensionPath }),
      smoke: async options => {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "inkwell-setup-smoke-"));
        try { return await runSmokeBuild(context.extensionPath, temporary, env, options.signal); }
        finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      },
      ...overrides,
    };
    let logged = 0;
    try {
      const state = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Inkwell: Setup / Repair", cancellable: true }, async (progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          return await createSetupOrchestrator(deps).run({ projectRoot: root, signal: controller.signal, onProgress: current => {
            progress.report({ message: `${SETUP_STAGES.indexOf(current.stage) + 1}/${SETUP_STAGES.length}: ${current.stage.replace(/-/g, " ")}` });
            for (const entry of current.logs.slice(logged)) output.appendLine(`[${entry.time}] ${entry.stage}: ${entry.message}`);
            logged = current.logs.length;
          } });
        } finally { subscription.dispose(); }
      });
      invalidateDoctorCache();
      await vscode.commands.executeCommand("setContext", "inkwell.setupVerified", state.status === "complete");
      if (state.status === "complete" && state.warnings?.length) {
        const choice = await vscode.window.showWarningMessage("Inkwell is ready. Some optional checks need attention; tools, project files and PDF compilation are verified.", "Show diagnostics");
        if (choice === "Show diagnostics") output.show(true);
      } else if (state.status === "complete") await vscode.window.showInformationMessage("Inkwell is ready: tools, project files and PDF compilation are verified.");
      else {
        output.show(true);
        const labels = [...new Set(state.actions.map(action => action.label)), "Show diagnostics"];
        const message = state.status === "awaiting-consent" ? "Setup is waiting for installation approval." : state.status === "cancelled" ? "Setup was cancelled. Your progress is saved." : "Setup needs repair. Your progress and diagnostics are saved.";
        const choice = await (state.status === "failed" ? vscode.window.showErrorMessage(message, ...labels) : vscode.window.showWarningMessage(message, ...labels));
        const action = state.actions.find(candidate => candidate.label === choice);
        if (choice === "Show diagnostics" || action?.id === "show-setup-log") output.show(true);
        else if (action?.id === "compare" && action.path && action.proposedPath) await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(action.path), vscode.Uri.file(action.proposedPath), "Inkwell proposed update");
        else if (action?.id === "resume-setup") return await run(root, template, requestedPackage);
      }
      return state;
    } catch (error) {
      output.appendLine(`Setup failed: ${String(error)}`); output.show(true);
      await vscode.window.showErrorMessage(`Setup could not save or complete its work: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  return { run, checkLight, installPackage: async (name, root) => { try { await run(root, undefined, validateRequestedPackage(name)); }
    catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); } } };
}
