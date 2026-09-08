// Extension entry point. Registers all commands, wires the preview panel
// to the compilation and code-execution pipelines, and manages lifecycle
// (auto-compile timers, toolchain checks on activation).

import * as vscode from "vscode";
import { InkwellPreviewProvider } from "./preview";
import { compile, exportPDF, isCompilable, reportCompileFailure, readLastSuccessfulOutput, CompileResult } from "./compiler";
import { InkwellDiagnostics } from "./diagnostics";
import { selectTemplateCommand } from "./templates";
import { findInkwellRoot, getInkwellOutputsDir, getInkwellProjectRoot, saveManifestField } from "./config";
import { checkToolchain, installLatexPackage, showToolchainStatus, setExtensionPath, setToolchainActions } from "./toolchain";
import { runAllBlocks, parseCodeBlocks, RunCancellation } from "./runner";
import { clearCache } from "./cache";
import { setupWorkspace, initProject } from "./scaffold";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { setupPythonEnvironment } from "./python-setup";
import { getInkwellOutputChannel } from "./inkwell-output";
import { ProjectReadinessGate } from "./project-readiness-ui";
import { createSetupUI, registerSetupCommands, SetupUI } from "./setup-ui";
import { invalidateDoctorCache } from "./doctor";
import { registerDocumentStyleCommand } from "./document-style-ui";
import { invalidateCitationPandoc } from "./citation-pandoc";
import { registerBibliographyAuthoring } from "./bibliography-authoring";
import { registerRunAuthoring, PreparedRunRequest } from "./run-authoring-ui";
import { registerRunWatchers } from "./run-watchers";
import { CompileCoordinator } from "./compile-coordinator";
import { CompileInputs } from "./compile-inputs";
import { disposeResolutionCaches } from "./resolution-cache";
import { createDocumentSnapshot } from "./document-snapshot";
import { templateAssetCache } from "./template-assets";

let diagnostics: InkwellDiagnostics;
let autoCompileTimer: ReturnType<typeof setInterval> | undefined;
let activeRunCancel: RunCancellation | undefined;
interface ScheduledCompile { document: vscode.TextDocument; original: vscode.TextDocument }
let compileCoordinator: CompileCoordinator<ScheduledCompile, { result?: CompileResult; cacheable: boolean }>;
let compileInputs: CompileInputs;
const compileRequests = new Map<string, number>();
let readiness: ProjectReadinessGate;
let setup: SetupUI;

export function activate(context: vscode.ExtensionContext) {
  setExtensionPath(context.extensionPath);
  diagnostics = new InkwellDiagnostics();
  compileInputs = new CompileInputs(() => compileCoordinator?.invalidate());
  compileCoordinator = new CompileCoordinator<ScheduledCompile, { result?: CompileResult; cacheable: boolean }>(async (request, isCurrent) => {
    const { document, original } = request.value;
    const sourceCurrent = () => !original.isClosed && original.version === document.version && original.getText() === document.getText();
    if (!sourceCurrent() || !vscode.workspace.isTrusted) return { cacheable: false };
    const before = await compileInputs.fingerprint(document);
    if (!sourceCurrent() || !isCurrent() || !vscode.workspace.isTrusted) return { cacheable: false };
    const result = await compile(document);
    let unchanged = false;
    try { unchanged = await compileInputs.fingerprint(document) === before; } catch { /* Changed input must never establish a cache hit. */ }
    if (sourceCurrent() && isCurrent()) reportCompileResult(original, result);
    return { result, cacheable: result.success && unchanged && before === request.signature && sourceCurrent() };
  }, value => value.cacheable, (request, cached) => {
    const previous = readLastSuccessfulOutput(request.value.document.uri.fsPath);
    return Boolean(previous && previous.sourceHash === crypto.createHash("sha256").update(request.value.document.getText()).digest("hex")
      && previous.pdfHash === cached.result?.lastSuccessfulOutput?.pdfHash);
  });
  context.subscriptions.push(compileInputs, compileCoordinator, { dispose: disposeResolutionCaches });
  readiness = new ProjectReadinessGate(context);
  setup = createSetupUI(context);
  setToolchainActions({ setup: () => setup.run(), installPackage: name => setup.installPackage(name) });
  registerSetupCommands(context, setup);

  const previewProvider = new InkwellPreviewProvider(context);
  registerDocumentStyleCommand(context, () => previewProvider.refresh());
  registerBibliographyAuthoring(context, () => previewProvider.refresh());
  previewProvider.setDiagnostics(diagnostics);
  previewProvider.onCompile = document => runCompile(document);
  const runWatchers = registerRunWatchers(context, async (document, request) => {
    if (request.isCurrent()) await previewProvider.refresh(document, request.isCurrent);
  }, { onError: error => getInkwellOutputChannel().appendLine(`Run dependency refresh: ${String(error)}`) });
  const runAuthoring = registerRunAuthoring(context, {
    ensureReady: async document => {
      if (!await readiness.ensure(document)) return false;
      runWatchers.observe(document); return true;
    },
    execute: request => runCodeBlocksWithProgress(request, previewProvider),
    onDocumentChanged: document => { runWatchers.observe(document); void previewProvider.refresh(document); },
  });
  previewProvider.ensureReady = async (document, allowPrompt) => {
    if (!await ensureAuthoringReady(document, allowPrompt)) return false;
    runWatchers.observe(document); return true;
  };

  // n.b. The webview steals focus from the editor, so activeTextEditor
  // is undefined when the user clicks Run in the preview panel. We
  // resolve the target document from the preview provider instead.
  previewProvider.onRun = async () => {
    const doc = previewProvider.getDocument();
    if (!doc || !isCompilable(doc)) {
      vscode.window.showWarningMessage("Open a markdown or LaTeX file first.");
      return;
    }
    await runAuthoring.run(doc);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("inkwell.preview.decreaseFontScale", () => previewProvider.changeFontScale("decrease")),
    vscode.commands.registerCommand("inkwell.preview.increaseFontScale", () => previewProvider.changeFontScale("increase")),
    vscode.commands.registerCommand("inkwell.preview.resetFontScale", () => previewProvider.changeFontScale("reset")),
    vscode.commands.registerCommand("inkwell.preview", async () => {
      await previewProvider.show();
    }),

    vscode.commands.registerCommand("inkwell.compile", async () => {
      const doc =
        vscode.window.activeTextEditor?.document ?? previewProvider.getDocument();
      if (!doc || !isCompilable(doc)) {
        vscode.window.showWarningMessage("Open a markdown or LaTeX file first.");
        return;
      }
      await runCompile(doc);
    }),

    vscode.commands.registerCommand("inkwell.exportPDF", async () => {
      const doc =
        vscode.window.activeTextEditor?.document ?? previewProvider.getDocument();
      if (!doc || !isCompilable(doc)) {
        vscode.window.showWarningMessage("Open a markdown or LaTeX file first.");
        return;
      }
      if (await ensureAuthoringReady(doc)) await exportPDF(doc, diagnostics);
    }),

    vscode.commands.registerCommand("inkwell.selectTemplate", async () => {
      const doc =
        vscode.window.activeTextEditor?.document ?? previewProvider.getDocument();
      const uri = doc?.uri;
      if (doc && !await readiness.ensure(doc)) return;
      const templateId = await selectTemplateCommand(uri);
      if (!templateId) return;

      const root = uri ? findInkwellRoot(uri) : undefined;
      if (root) {
        saveManifestField(root, "template", templateId);
        vscode.window.showInformationMessage(
          `Template set to "${templateId}" in .inkwell/manifest.json`
        );
      } else {
        vscode.window.showInformationMessage(
          `Selected "${templateId}". Add template: ${templateId} to your YAML frontmatter, or create an .inkwell/ project to persist this choice.`
        );
      }
    }),

    vscode.commands.registerCommand("inkwell.installPackage", async (pkg?: string) => {
      let packageName = pkg?.trim();
      if (!packageName) {
        packageName = await vscode.window.showInputBox({
          prompt: "LaTeX package name to install via tlmgr",
          placeHolder: "e.g. booktabs",
        });
      }
      if (!packageName) return;
      await installLatexPackage(packageName);
    }),

    vscode.commands.registerCommand("inkwell.runCodeBlocks", async () => {
      const doc =
        vscode.window.activeTextEditor?.document ?? previewProvider.getDocument();
      if (!doc || !isCompilable(doc)) {
        vscode.window.showWarningMessage("Open a markdown or LaTeX file first.");
        return;
      }
      await runAuthoring.run(doc);
    }),

    vscode.commands.registerCommand("inkwell.cancelRun", () => {
      if (activeRunCancel) {
        activeRunCancel.cancel();
      }
    }),

    vscode.commands.registerCommand("inkwell.clearRunCache", async () => {
      const doc =
        vscode.window.activeTextEditor?.document ?? previewProvider.getDocument();
      if (!doc) return;
      const cacheDir = getInkwellOutputsDir(doc.uri.fsPath);
      clearCache(cacheDir, doc.uri.fsPath);
      await previewProvider.refresh(doc);
      vscode.window.showInformationMessage("Inkwell: Code block cache cleared.");
    }),

    vscode.commands.registerCommand("inkwell.setupPythonEnv", async () => {
      const doc =
        vscode.window.activeTextEditor?.document ?? previewProvider.getDocument();
      if (!doc) return;
      await setupPythonEnv(doc);
    }),

    vscode.commands.registerCommand("inkwell.initProject", async () => {
      await initProject(async (root, template) => ({ ready: (await setup.run(root, template))?.status === "complete" }));
    }),

    vscode.commands.registerCommand("inkwell.setupWorkspace", async () => {
      await setupWorkspace(async (root, template) => ({ ready: (await setup.run(root, template))?.status === "complete" }));
    }),

    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const mode = vscode.workspace
        .getConfiguration("inkwell")
        .get<string>("autoCompile");
      if (mode === "onSave" && isCompilable(document)) {
        await runCompile(document, false);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("inkwell") || e.affectsConfiguration("terminal.integrated.env")) { invalidateDoctorCache(); invalidateCitationPandoc(); compileInputs.invalidate(); }
      if (e.affectsConfiguration("inkwell.autoCompile") ||
          e.affectsConfiguration("inkwell.autoCompileIntervalSeconds")) {
        setupAutoCompileTimer();
      }
    }),

    diagnostics
  );

  refreshProjectContextKey();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshProjectContextKey();
    }),
    vscode.workspace.onDidOpenTextDocument(() => {
      refreshProjectContextKey();
    }),
    vscode.workspace.onDidCloseTextDocument(() => {
      refreshProjectContextKey();
    }),
  );

  setupAutoCompileTimer();
  activationCheck().catch((err) =>
    console.error("Inkwell activation check failed:", err)
  );
}

export function deactivate() {
  templateAssetCache.clear();
  compileCoordinator?.dispose();
  compileInputs?.dispose();
  compileRequests.clear();
  if (autoCompileTimer) {
    clearInterval(autoCompileTimer);
    autoCompileTimer = undefined;
  }
}

function setupAutoCompileTimer(): void {
  if (autoCompileTimer) {
    clearInterval(autoCompileTimer);
    autoCompileTimer = undefined;
  }

  const config = vscode.workspace.getConfiguration("inkwell");
  const mode = config.get<string>("autoCompile");
  if (mode !== "interval") return;

  const seconds = config.get<number>("autoCompileIntervalSeconds") || 60;
  autoCompileTimer = setInterval(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isCompilable(editor.document)) {
      void runCompile(editor.document, false, true).catch(err => console.error("Inkwell auto-compile failed:", err));
    }
  }, seconds * 1000);
}

// Last failure shown per document, so auto-compile (onSave / interval)
// does not re-raise an identical notification on every save while the
// user is already looking at the error. A success or a different error
// resets it.
const lastFailureNotified = new Map<string, string>();

async function runCompile(document: vscode.TextDocument, allowPrompt = true, interval = false): Promise<CompileResult | undefined> {
  const key = document.uri.toString();
  const request = (compileRequests.get(key) || 0) + 1;
  compileRequests.set(key, request);
  if (!await ensureAuthoringReady(document, allowPrompt)) return;
  const text = document.getText(), version = document.version;
  const snapshot = createDocumentSnapshot(document, text, version);
  try {
    const signature = await compileInputs.fingerprint(snapshot);
    if (compileRequests.get(key) !== request || document.isClosed || document.version !== version || document.getText() !== text) return;
    const completed = await compileCoordinator.request({ key, version, signature, interval, value: { document: snapshot, original: document } });
    return completed?.result;
  } catch (err) {
    getInkwellOutputChannel().appendLine(`Compilation could not proceed: ${String(err)}`);
    if (allowPrompt) void vscode.window.showErrorMessage(`Inkwell: ${String(err)}`);
  }
}

function reportCompileResult(document: vscode.TextDocument, result: CompileResult): void {
  diagnostics.report(document.uri, result.errors);
  const key = document.uri.toString();
  if (result.success && result.pdfPath) {
    lastFailureNotified.delete(key);
    vscode.window.setStatusBarMessage(`Inkwell: PDF compiled (${result.duration.toFixed(1)}s)`, 5000);
  } else {
    vscode.window.setStatusBarMessage(`Inkwell: compilation failed (${result.errors.filter(e => e.severity === "error").length || 1} error(s))`, 5000);
    const failureKey = result.errors.find(e => e.severity === "error")?.message || "unknown";
    if (lastFailureNotified.get(key) !== failureKey) {
      lastFailureNotified.set(key, failureKey);
      void reportCompileFailure(document, result);
    }
  }
}

async function runCodeBlocksWithProgress(
  prepared: PreparedRunRequest,
  previewProvider: InkwellPreviewProvider
): Promise<void> {
  const { document, text, sourceVersion, selectedIndices } = prepared;
  if (!vscode.workspace.isTrusted || document.isClosed || document.version !== sourceVersion || document.getText() !== text) {
    throw new Error("The document changed before execution. Run the command again.");
  }
  if (activeRunCancel) {
    activeRunCancel.cancel();
    activeRunCancel = undefined;
  }

  const blocks = parseCodeBlocks(text);

  if (!blocks.length) {
    vscode.window.showInformationMessage("No executable code blocks found.");
    return;
  }

  const sourceFile = document.uri.fsPath;
  const cancel = new RunCancellation();
  activeRunCancel = cancel;

  const snapshot = createDocumentSnapshot(document, text, sourceVersion);
  const previewRequest = previewProvider.sendRunStarted(selectedIndices?.length ?? blocks.length, snapshot, selectedIndices);

  let results: Awaited<ReturnType<typeof runAllBlocks>> = [];
  let threw = false;
  try {
    results = await runAllBlocks(text, sourceFile, cancel, (p) => {
      previewProvider.sendBlockProgress(p, previewRequest);
      if (p.warning) {
        previewProvider.sendLogEntry("error", p.warning, undefined, previewRequest);
      }
      if (p.interpreter && p.status === "running") {
        previewProvider.sendLogEntry("info", `Block ${p.index + 1}: using ${p.interpreter}`, undefined, previewRequest);
      }
    }, selectedIndices);
  } catch (err) {
    threw = true;
    previewProvider.sendLogEntry("error", "Run failed unexpectedly", String(err), previewRequest);
  } finally {
    if (activeRunCancel === cancel) activeRunCancel = undefined;
    const failed = results.filter((r) => r.exitCode !== 0 && r.exitCode !== 130);
    const cancelled = results.filter((r) => r.exitCode === 130);
    const cached = results.filter((r) => r.cached);
    const ran = results.length - cached.length - cancelled.length;

    for (const r of failed) {
      previewProvider.sendLogEntry(
        "error",
        `Block ${r.block.index + 1} (${r.block.lang}) failed`,
        r.stderr,
        previewRequest,
      );
    }

    if (threw) {
      previewProvider.sendRunComplete("failed", ran, cached.length, cancelled.length, failed.length || 1, previewRequest);
    } else if (cancel.cancelled) {
      previewProvider.sendRunComplete("cancelled", ran, cached.length, cancelled.length, 0, previewRequest);
    } else if (failed.length) {
      previewProvider.sendRunComplete("failed", ran, cached.length, 0, failed.length, previewRequest);
    } else {
      previewProvider.sendRunComplete("done", ran, cached.length, 0, 0, previewRequest);
    }

    await previewProvider.notifyBlocksRan(snapshot, previewRequest);
  }
}

async function setupPythonEnv(document: vscode.TextDocument): Promise<void> {
  if (!await readiness.ensure(document)) return;
  const docDir = path.dirname(document.uri.fsPath);
  const projectRoot = getInkwellProjectRoot(document.uri.fsPath);

  const envOptions = [
    { label: "./venv", detail: "Create venv in document directory" },
    { label: "./.inkwell/venv", detail: "Create venv under project .inkwell/ (workspace root)" },
    { label: "Custom path...", detail: "Specify a custom venv location" },
  ];

  const pick = await vscode.window.showQuickPick(envOptions, {
    placeHolder: "Where should the Python virtual environment be created?",
  });
  if (!pick) return;

  let envPath: string;
  if (pick.label === "Custom path...") {
    const input = await vscode.window.showInputBox({
      prompt: "Path for the virtual environment (relative to document or absolute)",
      value: "./venv",
    });
    if (!input) return;
    envPath = input;
  } else {
    envPath = pick.label;
  }

  let resolved: string;
  if (path.isAbsolute(envPath)) {
    resolved = envPath;
  } else {
    const rel = envPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (rel.startsWith(".inkwell/")) {
      resolved = path.normalize(path.join(projectRoot, rel));
    } else {
      resolved = path.resolve(docDir, envPath);
    }
  }

  const reqFile = [path.join(docDir, "requirements.txt"), path.join(projectRoot, "requirements.txt")].find((p) =>
    fs.existsSync(p)
  );
  let packages: string[] = [];
  if (!reqFile) {
    const input = await vscode.window.showInputBox({
      prompt: "Packages to install (space-separated, or leave empty)",
      placeHolder: "numpy matplotlib pandas polars scikit-learn seaborn",
    });
    packages = input?.trim().split(/\s+/).filter(Boolean) || [];
  }
  const cancellation = new RunCancellation();
  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Inkwell: Setting up Python environment",
    cancellable: true,
  }, async (_progress, token) => {
    const subscription = token.onCancellationRequested(() => cancellation.cancel());
    try {
      return await setupPythonEnvironment({
        projectDir: projectRoot, environmentDir: resolved,
        requirementsFile: reqFile, packages, cancel: cancellation,
      });
    } finally { subscription.dispose(); }
  });
  const output = getInkwellOutputChannel();
  output.appendLine(result.log);
  if (result.success) {
    await vscode.window.showInformationMessage(`Inkwell: Python ${result.pythonVersion} environment verified at ${resolved}.`);
  } else {
    output.show(true);
    await vscode.window.showErrorMessage(`Inkwell: ${result.message} See the Inkwell output log for details.`);
  }
}

async function activationCheck() {
  const status = await checkToolchain({ cachedOnly: true });
  // Cold activation performs no tool processes or prompts. A user action can request fresh health.
  if (status.report.checks.some(check => check.id === "cached-health")) return;
  if (status.pandoc.installed && status.xelatex.installed) return;

  const missing: string[] = [];
  if (!status.pandoc.installed) missing.push("pandoc");
  if (!status.xelatex.installed) missing.push("xelatex");

  const choice = await vscode.window.showWarningMessage(
    `Inkwell: ${missing.join(" and ")} not found. PDF compilation requires these tools.`,
    "Setup now",
    "Dismiss"
  );

  if (choice === "Setup now") {
    await showToolchainStatus();
  }
}

const healthPrompts = new Map<string, Promise<boolean>>();
async function ensureAuthoringReady(document: vscode.TextDocument, allowPrompt = true): Promise<boolean> {
  if (!await readiness.ensure(document, allowPrompt)) return false;
  const root = getInkwellProjectRoot(document.uri.fsPath);
  const pending = healthPrompts.get(root); if (pending) return pending;
  const work = (async () => {
    const report = await setup.checkLight(!allowPrompt, root);
    if (report.checks.some(check => check.id === "cached-health")) return true;
    const failed = report.checks.filter(check => check.required && check.status !== "ok" && check.id !== "workspace");
    if (!failed.length) return true;
    if (!allowPrompt) return false;
    const output = getInkwellOutputChannel();
    for (const check of failed) output.appendLine(`${check.id}: ${check.message}`);
    const choice = await vscode.window.showWarningMessage("Inkwell needs a tool or packaged-file repair before continuing.", "Setup / Repair", "Show diagnostics");
    if (choice === "Show diagnostics") output.show(true);
    return choice === "Setup / Repair" && (await setup.run(root))?.status === "complete";
  })();
  healthPrompts.set(root, work);
  try { return await work; } finally { if (healthPrompts.get(root) === work) healthPrompts.delete(root); }
}

function refreshProjectContextKey(): void {
  const editor = vscode.window.activeTextEditor;
  let hasInkwellProject = false;

  if (editor) {
    hasInkwellProject = Boolean(findInkwellRoot(editor.document.uri));
  } else if (vscode.workspace.workspaceFolders?.length) {
    const base = vscode.workspace.workspaceFolders[0].uri.fsPath;
    hasInkwellProject = fs.existsSync(path.join(base, ".inkwell"));
  }

  void vscode.commands.executeCommand("setContext", "inkwell.hasProject", hasInkwellProject);
}
