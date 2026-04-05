// Extension entry point. Registers all commands, wires the preview panel
// to the compilation and code-execution pipelines, and manages lifecycle
// (auto-compile timers, toolchain checks on activation).

import * as vscode from "vscode";
import { InkwellPreviewProvider } from "./preview";
import { compile, exportPDF, isCompilable } from "./compiler";
import { InkwellDiagnostics } from "./diagnostics";
import { selectTemplateCommand } from "./templates";
import { findInkwellRoot, getInkwellOutputsDir, getInkwellProjectRoot, saveManifestField } from "./config";
import { checkToolchain, installLatexPackage, showToolchainStatus, setExtensionPath } from "./toolchain";
import { runAllBlocks, parseCodeBlocks, RunCancellation } from "./runner";
import { clearCache } from "./cache";
import { bootstrapWorkspaceInkwell, initProject, updateProject } from "./scaffold";
import * as path from "path";
import * as fs from "fs";

let diagnostics: InkwellDiagnostics;
let autoCompileTimer: ReturnType<typeof setInterval> | undefined;
let activeRunCancel: RunCancellation | undefined;
let compileInFlight = false;
let queuedCompile: vscode.TextDocument | undefined;

export function activate(context: vscode.ExtensionContext) {
  setExtensionPath(context.extensionPath);
  diagnostics = new InkwellDiagnostics();

  const previewProvider = new InkwellPreviewProvider(context);
  previewProvider.setDiagnostics(diagnostics);

  // n.b. The webview steals focus from the editor, so activeTextEditor
  // is undefined when the user clicks Run in the preview panel. We
  // resolve the target document from the preview provider instead.
  previewProvider.onRun = async () => {
    const doc = previewProvider.getDocument();
    if (!doc || !isCompilable(doc)) {
      vscode.window.showWarningMessage("Open a markdown or LaTeX file first.");
      return;
    }
    await runCodeBlocksWithProgress(doc, previewProvider);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("inkwell.preview", () => {
      previewProvider.show();
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
      await exportPDF(doc, diagnostics);
    }),

    vscode.commands.registerCommand("inkwell.selectTemplate", async () => {
      const doc =
        vscode.window.activeTextEditor?.document ?? previewProvider.getDocument();
      const uri = doc?.uri;
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

    vscode.commands.registerCommand("inkwell.setupToolchain", () => {
      showToolchainStatus();
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
      await runCodeBlocksWithProgress(doc, previewProvider);
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
      clearCache(cacheDir);
      vscode.window.showInformationMessage("Inkwell: Code block cache cleared.");
    }),

    vscode.commands.registerCommand("inkwell.setupPythonEnv", async () => {
      const doc =
        vscode.window.activeTextEditor?.document ?? previewProvider.getDocument();
      if (!doc) return;
      await setupPythonEnv(doc);
    }),

    vscode.commands.registerCommand("inkwell.initProject", () => {
      initProject();
    }),

    vscode.commands.registerCommand("inkwell.bootstrapWorkspaceInkwell", () => {
      bootstrapWorkspaceInkwell();
    }),

    vscode.commands.registerCommand("inkwell.updateProject", () => {
      updateProject();
    }),

    vscode.workspace.onDidSaveTextDocument((document) => {
      const mode = vscode.workspace
        .getConfiguration("inkwell")
        .get<string>("autoCompile");
      if (mode === "onSave" && isCompilable(document)) {
        runCompile(document);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
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
      runCompile(editor.document);
    }
  }, seconds * 1000);
}

async function runCompile(document: vscode.TextDocument): Promise<void> {
  if (compileInFlight) {
    queuedCompile = document;
    return;
  }

  compileInFlight = true;
  let current: vscode.TextDocument | undefined = document;

  try {
    while (current) {
      queuedCompile = undefined;
      try {
        const result = await compile(current);
        diagnostics.report(current.uri, result.errors);
        if (result.success && result.pdfPath) {
          vscode.window.setStatusBarMessage(
            `Inkwell: PDF compiled (${result.duration.toFixed(1)}s)`,
            5000
          );
        } else if (result.errors.length > 0) {
          vscode.window.setStatusBarMessage(
            `Inkwell: ${result.errors.length} error(s)`,
            5000
          );
        }
      } catch (err) {
        console.error("Inkwell compile error:", err);
      }
      current = queuedCompile;
    }
  } finally {
    compileInFlight = false;
    queuedCompile = undefined;
  }
}

async function runCodeBlocksWithProgress(
  document: vscode.TextDocument,
  previewProvider: InkwellPreviewProvider
): Promise<void> {
  if (activeRunCancel) {
    activeRunCancel.cancel();
    activeRunCancel = undefined;
  }

  const text = document.getText();
  const blocks = parseCodeBlocks(text);

  if (!blocks.length) {
    vscode.window.showInformationMessage("No executable code blocks found.");
    return;
  }

  const sourceFile = document.uri.fsPath;
  const cancel = new RunCancellation();
  activeRunCancel = cancel;

  previewProvider.sendRunStarted(blocks.length);

  let results: Awaited<ReturnType<typeof runAllBlocks>> = [];
  let threw = false;
  try {
    results = await runAllBlocks(text, sourceFile, cancel, (p) => {
      previewProvider.sendBlockProgress(p);
      if (p.warning) {
        previewProvider.sendLogEntry("error", p.warning);
      }
      if (p.interpreter && p.status === "running") {
        previewProvider.sendLogEntry("info", `Block ${p.index + 1}: using ${p.interpreter}`);
      }
    });
  } catch (err) {
    threw = true;
    previewProvider.sendLogEntry("error", "Run failed unexpectedly", String(err));
  } finally {
    activeRunCancel = undefined;
    const failed = results.filter((r) => r.exitCode !== 0 && r.exitCode !== 130);
    const cancelled = results.filter((r) => r.exitCode === 130);
    const cached = results.filter((r) => r.cached);
    const ran = results.length - cached.length - cancelled.length;

    for (const r of failed) {
      previewProvider.sendLogEntry(
        "error",
        `Block ${r.block.index + 1} (${r.block.lang}) failed`,
        r.stderr,
      );
    }

    if (threw) {
      previewProvider.sendRunComplete("failed", ran, cached.length, cancelled.length, failed.length || 1);
    } else if (cancel.cancelled) {
      previewProvider.sendRunComplete("cancelled", ran, cached.length, cancelled.length);
    } else if (failed.length) {
      previewProvider.sendRunComplete("failed", ran, cached.length, 0, failed.length);
    } else {
      previewProvider.sendRunComplete("done", ran, cached.length);
    }

    previewProvider.notifyBlocksRan();
  }
}

async function setupPythonEnv(document: vscode.TextDocument): Promise<void> {
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
  const hasReqs = Boolean(reqFile);

  const terminal = vscode.window.createTerminal("Inkwell Python Env");
  terminal.show();

  const commands: string[] = [];

  if (fs.existsSync(resolved)) {
    commands.push(`echo "Venv already exists at ${resolved}"`);
  } else {
    commands.push(`python3 -m venv "${resolved}"`);
  }

  commands.push(`source "${resolved}/bin/activate"`);

  if (hasReqs && reqFile) {
    commands.push(`pip install -r "${reqFile}"`);
  } else {
    const installPick = await vscode.window.showInputBox({
      prompt: "Packages to install (space-separated, or leave empty)",
      placeHolder: "numpy matplotlib pandas polars scikit-learn seaborn",
    });
    if (installPick?.trim()) {
      commands.push(`pip install ${installPick.trim()}`);
    }
  }

  commands.push(`python3 --version`);
  commands.push(`echo "Venv ready at ${envPath}"`);
  commands.push(`echo "Add to your frontmatter:  python-env: ${envPath}"`);

  terminal.sendText(commands.join(" && "));
}

async function activationCheck() {
  const status = await checkToolchain();
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
    showToolchainStatus();
  }
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
