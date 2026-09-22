import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ensureProjectReady, isProjectOptedIn, ProjectReadiness, ProjectReadinessOptions } from "./project-readiness";
import { getInkwellOutputChannel } from "./inkwell-output";

/** A global template directory in the user's home is not a project opt-in. */
export function readinessRoot(sourceFile: string, workspaceRoot?: string): string {
  if (workspaceRoot && isProjectOptedIn(workspaceRoot)) return workspaceRoot;
  let directory = path.dirname(sourceFile);
  while (true) {
    if (directory === os.homedir() && !fs.existsSync(path.join(directory, ".inkwell", "manifest.json"))) break;
    if (fs.existsSync(path.join(directory, ".inkwell"))) return directory;
    if (directory === workspaceRoot || path.dirname(directory) === directory) break;
    directory = path.dirname(directory);
  }
  return workspaceRoot || path.dirname(sourceFile);
}

export async function ensureProjectReadyWithUI(
  options: ProjectReadinessOptions,
  ui: { allowPrompt?: boolean; onSuppressed?: () => PromiseLike<void>; useExistingFiles?: boolean } = {},
): Promise<ProjectReadiness> {
  let result = await ensureProjectReady(options);
  // Reviewing bundled updates is separate from using the preserved project.
  // Never await an optional notification on the preview/run/compile path.
  if (result.status === "conflicts" && ui.useExistingFiles) return result;
  if (result.ready || result.status === "suppressed" || ui.allowPrompt === false) return result;
  if (result.status === "setup-required") {
    const choice = await vscode.window.showInformationMessage(
      "Set up this workspace to use Inkwell preview, PDF compilation, and code runs.",
      "Set up this workspace", "Don't ask here",
    );
    if (choice === "Don't ask here") {
      await ui.onSuppressed?.();
      return { ...result, status: "suppressed", actions: [] };
    }
    if (choice !== "Set up this workspace") return result;
    result = await ensureProjectReady({ ...options, explicitSetup: true });
  }
  if (result.status === "conflicts") {
    const choice = await vscode.window.showWarningMessage(
      "Your edited project files have been preserved. Compare the proposed updates, or keep your files and finish setup.",
      "Keep my files", "Compare files",
    );
    if (choice === "Keep my files") {
      result = await ensureProjectReady({ ...options, explicitSetup: true, resolveConflicts: "keep-user-files" });
    } else if (choice === "Compare files") {
      const actions = result.actions.filter(action => action.id === "compare" && action.path && action.proposedPath);
      const selected = actions.length === 1 ? actions[0] : (await vscode.window.showQuickPick(
        actions.map(action => ({ label: path.basename(action.path!), detail: action.path, action })),
        { placeHolder: "Choose an edited file to compare. Run the Inkwell action again when you are ready to continue." },
      ))?.action;
      if (selected) await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(selected.path!), vscode.Uri.file(selected.proposedPath!), "Your file ↔ proposed Inkwell update");
      return result;
    } else return result;
  }
  if (!result.ready) {
    const output = getInkwellOutputChannel();
    for (const diagnostic of result.diagnostics) output.appendLine(`${diagnostic.path}: ${diagnostic.message}`);
    const message = result.diagnostics.find(d => d.severity === "error")?.message || "Project setup needs attention. Resolve the edited files before continuing.";
    const choice = await vscode.window.showErrorMessage(`Inkwell: ${message}`, "Show details");
    if (choice === "Show details") output.show(true);
  }
  return result;
}

/** Share a pending prompt/migration across commands in the same workspace. */
export class ProjectReadinessGate {
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly updatesNotified = new Set<string>();
  constructor(private readonly context: vscode.ExtensionContext) {}

  async ensure(document: vscode.TextDocument, allowPrompt = true): Promise<boolean> {
    if (document.isUntitled || document.uri.scheme !== "file") {
      if (allowPrompt) await vscode.window.showInformationMessage("Save this document in a local workspace before using Inkwell.");
      return false;
    }
    const root = readinessRoot(document.uri.fsPath, vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath);
    const existing = this.pending.get(root);
    if (existing) return existing;
    const key = `inkwell.setup.suppressed:${root}`;
    const work = (async () => {
      const result = await ensureProjectReadyWithUI({
        root, trusted: vscode.workspace.isTrusted, assetRoot: this.context.extensionPath,
        dontAskHere: this.context.workspaceState.get<boolean>(key, false),
      }, { allowPrompt, useExistingFiles: true, onSuppressed: () => this.context.workspaceState.update(key, true) });
      const canUseExistingFiles = result.status === "conflicts" && !result.diagnostics.some(d => d.severity === "error");
      if (canUseExistingFiles && allowPrompt && !this.updatesNotified.has(root)) {
        this.updatesNotified.add(root);
        getInkwellOutputChannel().appendLine("Project updates are available. Preview, runs and compilation will use your preserved files. Run Inkwell: Setup Workspace to review updates.");
        void Promise.resolve(vscode.window.showInformationMessage(
          "Your edited project files are preserved and ready to use. Optional Inkwell updates are available.", "Review updates",
        )).then(choice => {
          if (choice === "Review updates") return vscode.commands.executeCommand("inkwell.setupWorkspace");
        }).catch(error => getInkwellOutputChannel().appendLine(`Could not open project updates: ${String(error)}`));
      }
      const ready = result.ready || canUseExistingFiles;
      if (ready) await vscode.commands.executeCommand("setContext", "inkwell.hasProject", true);
      return ready;
    })();
    this.pending.set(root, work);
    try { return await work; } finally { if (this.pending.get(root) === work) this.pending.delete(root); }
  }
}
