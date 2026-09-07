import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createDoctor } from "./doctor";
import { detectEditors, EditorSelection, installEditorArtifact, selectEditors, uninstallEditorArtifact } from "./editor-installation";
import { executeInstallerProcess } from "./installer-process";
import { createFileSetupStore, createSetupOrchestrator } from "./setup-orchestrator";
import { doctorToInstallationPlan, asSetupPlan } from "./setup-adapters";
import { ensureProjectReady } from "./project-readiness";
import { executeInstallationPlan, InstallationPlan } from "./macos-install";
import { executeRunProcess, RunCancellation } from "./run-process";
import { runSmokeBuild } from "./smoke-build";
import { buildTexInvocationPath } from "./shell-env";

export interface InstallerArguments { extensionRoot: string; vsix: string; selection: EditorSelection; profile: "full" | "lean"; yes: boolean; outputRoot?: string; expectedVersion?: string; uninstall?: boolean }
export function parseInstallerArguments(args: string[]): InstallerArguments {
  const result: InstallerArguments = { extensionRoot: path.join(__dirname, ".."), vsix: "", selection: "auto", profile: "full", yes: false };
  for (const arg of args) {
    if (arg === "--yes") { result.yes = true; continue; }
    if (arg === "--uninstall") { result.uninstall = true; continue; }
    const split = arg.indexOf("="); if (split < 0) throw new Error(`Unknown installer argument: ${arg}`);
    const key = arg.slice(0, split), value = arg.slice(split + 1);
    if (key === "--artifact-root") result.extensionRoot = path.resolve(value);
    else if (key === "--vsix") result.vsix = path.resolve(value);
    else if (key === "--output-root") result.outputRoot = path.resolve(value);
    else if (key === "--version") result.expectedVersion = value;
    else if (key === "--editor" && ["auto", "all", "cursor", "code"].includes(value)) result.selection = value as EditorSelection;
    else if (key === "--profile" && ["full", "lean"].includes(value)) result.profile = value as "full" | "lean";
    else throw new Error(`Unknown installer argument: ${arg}`);
  }
  if (!result.vsix) throw new Error("An authoritative release VSIX path is required (--vsix=...).");
  return result;
}

export async function runInstaller(args: InstallerArguments): Promise<number> {
  const controller = new AbortController();
  const active = new Set<RunCancellation>();
  const interrupt = () => { controller.abort(); for (const cancellation of active) cancellation.cancel(); };
  const observed = (execute: typeof executeRunProcess): typeof executeRunProcess => async (command, argv, options, provided) => {
    const cancellation = provided || new RunCancellation();
    if (controller.signal.aborted) cancellation.cancel();
    active.add(cancellation);
    try { return await execute(command, argv, options, cancellation); }
    finally { active.delete(cancellation); }
  };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try { return await runInstallerSteps(args, controller, observed(executeRunProcess), observed(executeInstallerProcess)); }
  finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}

async function runInstallerSteps(args: InstallerArguments, controller: AbortController,
  execute: typeof executeRunProcess, interactive: typeof executeRunProcess): Promise<number> {
  const pkg = JSON.parse(fs.readFileSync(path.join(args.extensionRoot, "package.json"), "utf8"));
  if (pkg.name !== "inkwell" || pkg.publisher !== "measure-one" || args.expectedVersion && args.expectedVersion !== pkg.version) throw new Error("The VSIX payload identity/version does not match the requested release.");
  const env = { ...process.env, PATH: buildTexInvocationPath() };
  const detected = await detectEditors({ env, execute });
  if (controller.signal.aborted) return 130;
  if (args.uninstall) {
    const selected = detected.length ? selectEditors(detected, args.selection) : [];
    const removed = await uninstallEditorArtifact(pkg.version, selected, { env, execute });
    process.stdout.write(removed.log + "\n");
    return removed.success ? 0 : 1;
  }
  const selected = selectEditors(detected, args.selection);
  const doctor = createDoctor({ executeProcess: execute, smokeCompile: async context => {
    const result = await runSmokeBuild(context.extensionRoot, context.temporaryRoot, context.env, controller.signal);
    return { success: result.success && result.verified, message: result.success ? "The installed Inkwell compiler produced a verified PDF." : "The installed Inkwell compiler failed its smoke build.", pdfPath: result.pdfPath, log: result.logs.join("\n") };
  } });
  const preliminary = await doctor.run({ extensionRoot: args.extensionRoot, mode: "light", expectedVersion: pkg.version, env, forceRefresh: true });
  const assetErrors = preliminary.checks.filter(check => ["assets", "requirements-manifest"].includes(check.id) && check.status !== "ok");
  if (assetErrors.length) throw new Error(assetErrors.map(check => check.message).join("\n"));
  if (controller.signal.aborted) return 130;
  process.stdout.write(`Installing Inkwell ${pkg.version} into ${selected.map(editor => editor.label).join(" and ")}.\n`);
  const installed = await installEditorArtifact(args.vsix, pkg.version, selected, { env, execute });
  process.stdout.write(installed.log + "\n");
  if (!installed.success) throw new Error("Extension installation is partial or unverified. Repeat the installer after resolving the editor errors.");
  if (controller.signal.aborted) return 130;
  doctor.invalidate();
  const base = args.outputRoot || path.join(os.homedir(), "Library", "Application Support", "Inkwell", "verification", pkg.version);
  const projectRoot = path.join(base, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const smoke = async () => runSmokeBuild(args.extensionRoot, path.join(base, "pdf"), env, controller.signal);
  const setup = createSetupOrchestrator({
    store: createFileSetupStore(path.join(base, "setup-state.json")),
    doctor: options => doctor.run({ extensionRoot: args.extensionRoot, mode: "full", workspaceRoot: options.workspaceRoot,
      expectedVersion: pkg.version, expectedEditors: selected.map(editor => editor.id), env, forceRefresh: true,
      requiredTools: args.profile === "lean" ? ["ghostscript"] : [] }),
    plan: report => asSetupPlan(doctorToInstallationPlan(report, { extensionRoot: args.extensionRoot, cwd: projectRoot, env, profile: args.profile })),
    consent: async plan => {
      process.stdout.write(plan.steps.map(step => `• ${step.label}`).join("\n") + "\n");
      if (!args.yes) process.stderr.write("System installation requires --yes, or use Inkwell: Setup / Repair in the editor to review the plan.\n");
      return args.yes;
    },
    install: async (plan, context) => {
      const result = await executeInstallationPlan({ ...plan, steps: plan.steps.map(step => ({ ...step, args: [...step.args], verificationIds: [...step.verificationIds] })), diagnostics: [], requirementsHash: "" } as InstallationPlan,
        { execute: interactive, env, onLog: context.onLog });
      doctor.invalidate(); return result;
    },
    readiness: ({ root }) => ensureProjectReady({ root, trusted: true, explicitSetup: true, assetRoot: args.extensionRoot }),
    smoke: async () => smoke(),
  });
  let previous = "";
  const state = await setup.run({ projectRoot, signal: controller.signal, onProgress: progress => {
    if (progress.stage !== previous) { previous = progress.stage; process.stdout.write(`Inkwell setup: ${progress.stage}\n`); }
  } });
  fs.writeFileSync(path.join(base, "setup.log"), state.logs.map(entry => `${entry.time} [${entry.stage}] ${entry.message}`).join("\n") + "\n");
  if (state.status !== "complete") { process.stderr.write(`Inkwell setup ${state.status}. Details: ${path.join(base, "setup.log")}\n`); return 1; }
  const finalReport = await doctor.run({ extensionRoot: args.extensionRoot, mode: "full", workspaceRoot: projectRoot, expectedVersion: pkg.version,
    expectedEditors: selected.map(editor => editor.id), env, forceRefresh: true, requiredTools: args.profile === "lean" ? ["ghostscript"] : [] });
  fs.writeFileSync(path.join(base, "doctor.json"), JSON.stringify(finalReport, null, 2) + "\n");
  if (!finalReport.ready || controller.signal.aborted) { process.stderr.write(`Inkwell setup failed final verification. Details: ${path.join(base, "doctor.json")}\n`); return 1; }
  process.stdout.write(`Inkwell ${pkg.version} installation complete. Every selected editor, the full doctor, and a real PDF build passed.\nVerification PDFs and logs: ${base}\n`);
  return 0;
}

if (require.main === module) {
  try { void runInstaller(parseInstallerArguments(process.argv.slice(2))).then(code => { process.exitCode = code; }, error => { process.stderr.write(`Inkwell installation failed: ${error.message || String(error)}\n`); process.exitCode = 1; }); }
  catch (error: any) { process.stderr.write(`Inkwell installer: ${error.message || String(error)}\n`); process.exitCode = 2; }
}
