import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getDocumentConfig } from "./config";
import { resolveContainedPath } from "./bundled-assets";
import { invalidateProjectReadiness } from "./project-readiness";
import { ensureProjectReadyWithUI, readinessRoot } from "./project-readiness-ui";
import { DocumentConfig } from "./document-config";
import { DocumentStyleChange, documentStyleControls, MalformedStyleManifestError, ManifestStyleEdit, parseStyleManifest,
  planDocumentStyleEdit, planManifestStyleEdit, validateDocumentStyleValue } from "./document-style";

export interface StyleManifestSnapshot { root: string; realRoot: string; realParent: string; file: string; text: string; bytes: Buffer; mode: number }
export type DocumentStyleRefresh = (document: vscode.TextDocument) => void | PromiseLike<void>;
export interface DocumentStyleDependencies {
  getConfig?: (text: string, sourceFile: string) => DocumentConfig;
  ensureReady?: (root: string, document: vscode.TextDocument) => Promise<boolean>;
}

function manifestPath(root: string): string {
  const file = resolveContainedPath(root, ".inkwell/manifest.json");
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())) throw new Error("The project manifest must be a local regular file, not a symbolic link.");
  return file;
}

/** Malformed files are preserved and backed up before any style edit is planned. */
export function readProjectStyleManifest(root: string): StyleManifestSnapshot {
  root = path.resolve(root);
  const file = manifestPath(root), bytes = fs.readFileSync(file), text = bytes.toString("utf8");
  try {
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new MalformedStyleManifestError("The project manifest is not valid UTF-8.");
    parseStyleManifest(text);
  } catch (error) {
    if (!(error instanceof MalformedStyleManifestError)) throw error;
    const filename = `manifest.json.malformed-${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.bak`;
    const backup = resolveContainedPath(root, `.inkwell/${filename}`);
    if (fs.existsSync(backup)) {
      if (fs.lstatSync(backup).isSymbolicLink() || !fs.readFileSync(backup).equals(bytes)) throw new Error("The existing manifest backup is unsafe or differs from the malformed original. Both files were preserved.", { cause: error });
    } else fs.writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 });
    throw new Error(`${error.message} Original preserved; backup: ${backup}. Repair it before changing project defaults.`, { cause: error });
  }
  return { root, realRoot: fs.realpathSync(root), realParent: fs.realpathSync(path.dirname(file)), file, text, bytes, mode: fs.statSync(file).mode & 0o777 };
}

/** Same-directory publication checks expected bytes again after the temporary write. */
export function commitProjectStyleEdit(snapshot: StyleManifestSnapshot, plan: ManifestStyleEdit, trusted: boolean, stillCurrent: () => void = () => {}): void {
  if (!trusted) throw new Error("Trust this workspace before changing project defaults.");
  if (plan.before !== snapshot.text) throw new Error("The style plan does not match the observed manifest.");
  parseStyleManifest(plan.after);
  const check = () => {
    stillCurrent();
    if (fs.realpathSync(snapshot.root) !== snapshot.realRoot || manifestPath(snapshot.root) !== snapshot.file || fs.realpathSync(path.dirname(snapshot.file)) !== snapshot.realParent) {
      throw new Error("The project location changed. Run Configure Document Style again.");
    }
    if (!fs.readFileSync(snapshot.file).equals(snapshot.bytes)) throw new Error("Project defaults changed while the style picker was open. Run Configure Document Style again.");
  };
  check();
  const temporary = `${snapshot.file}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", snapshot.mode);
    fs.writeFileSync(descriptor, plan.after, "utf8");
    fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    check();
    fs.renameSync(temporary, snapshot.file);
    invalidateProjectReadiness(snapshot.root);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

class StaleStyleSessionError extends Error {}
let generation = 0;
function ensureSourceContained(root: string, file: string): void {
  const relative = path.relative(root, file);
  resolveContainedPath(root, relative.split(path.sep).join("/"));
}
function ensureManifestEditorClean(file: string): void {
  if (vscode.workspace.textDocuments.some(document => document.uri.scheme === "file" && path.resolve(document.uri.fsPath) === file && document.isDirty)) {
    throw new Error("The project manifest has unsaved editor changes. Save or revert those changes before updating project defaults.");
  }
}

export async function configureDocumentStyle(context: vscode.ExtensionContext, refresh?: DocumentStyleRefresh, dependencies: DocumentStyleDependencies = {}): Promise<boolean> {
  const session = ++generation;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown" || editor.document.isUntitled || editor.document.uri.scheme !== "file") {
    await vscode.window.showInformationMessage("Open a saved local Markdown document to configure its style."); return false;
  }
  if (!vscode.workspace.isTrusted) { await vscode.window.showErrorMessage("Trust this workspace before configuring document style."); return false; }
  const document = editor.document, uri = document.uri.toString(), version = document.version, text = document.getText();
  const getConfig = dependencies.getConfig || getDocumentConfig;
  let applied = false;
  const current = () => {
    if (session !== generation || vscode.window.activeTextEditor !== editor || document.isClosed || document.uri.toString() !== uri || document.version !== version || document.getText() !== text) {
      throw new StaleStyleSessionError("The document changed while the style picker was open. Run Configure Document Style again.");
    }
    if (!vscode.workspace.isTrusted) throw new Error("Workspace trust changed. The style edit was cancelled.");
  };
  try {
    const scope = await vscode.window.showQuickPick([
      { label: "This document", detail: "Update frontmatter with one undoable edit. The document stays unsaved.", target: "document" as const },
      { label: "Project defaults", detail: "Apply to documents without their own frontmatter override.", target: "project" as const },
    ], { title: "Configure Document Style", placeHolder: "Where should these style settings be stored?", ignoreFocusOut: true });
    if (!scope) return false;
    current();
    const sourceFile = document.uri.fsPath;
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    const root = readinessRoot(sourceFile, workspaceRoot);
    ensureSourceContained(root, sourceFile);
    let snapshot: StyleManifestSnapshot | undefined;
    if (scope.target === "project") {
      const file = manifestPath(root);
      ensureManifestEditorClean(file);
      if (fs.existsSync(file)) readProjectStyleManifest(root);
      const ready = dependencies.ensureReady ? await dependencies.ensureReady(root, document) : (await ensureProjectReadyWithUI({
        root, trusted: vscode.workspace.isTrusted, assetRoot: context.extensionPath,
      })).ready;
      if (!ready) return false;
      current(); ensureSourceContained(root, sourceFile);
      snapshot = readProjectStyleManifest(root);
    }
    const config = getConfig(text, sourceFile);
    const invalid = config.diagnostics.find(item => item.severity === "error" && (item.code.startsWith("yaml-") || item.code.includes("manifest") || item.code === "config-section-type" || item.code === "unsafe-key"));
    if (invalid) throw new Error(invalid.message);
    const field = await vscode.window.showQuickPick(documentStyleControls(config).map(control => ({
      label: `${control.locked ? "$(lock) " : ""}${control.label}`,
      description: control.value,
      detail: control.locked ? `Locked by ${config.capabilities.name}. ${control.reason}` : control.prompt,
      control,
    })), { title: `Document Style · ${config.capabilities.name}`, placeHolder: "Choose a style setting. Locked options show the template's effective value.", ignoreFocusOut: true });
    if (!field) return false;
    current();
    const control = field.control;
    if (control.locked) {
      await vscode.window.showInformationMessage(`${control.label}: ${control.value}. Locked by ${config.capabilities.name}. ${control.reason}`); return false;
    }
    let value: string | number | undefined;
    if (control.allowed?.length) {
      const choice = await vscode.window.showQuickPick(control.allowed.map(item => ({ label: String(item), value: item })), {
        title: control.label, placeHolder: `Current: ${control.value}`, ignoreFocusOut: true,
      });
      if (!choice) return false;
      if (typeof choice.value !== "boolean") value = choice.value;
    } else {
      value = await vscode.window.showInputBox({ title: control.label, prompt: control.prompt,
        value: control.value === "Template-defined" ? "" : control.value, ignoreFocusOut: true,
        validateInput: input => { try { validateDocumentStyleValue(config, control.key, input); return undefined; } catch (error) { return (error as Error).message; } },
      });
    }
    if (value === undefined) return false;
    current();
    ensureSourceContained(root, sourceFile);
    if (getConfig(text, sourceFile).fingerprint !== config.fingerprint) throw new StaleStyleSessionError("The document's style configuration changed. Run Configure Document Style again.");
    const change: DocumentStyleChange = validateDocumentStyleValue(config, control.key, value);
    if (snapshot) {
      ensureManifestEditorClean(snapshot.file);
      const plan = planManifestStyleEdit(snapshot.text, [change], config);
      commitProjectStyleEdit(snapshot, plan, vscode.workspace.isTrusted, current);
    } else {
      const plan = planDocumentStyleEdit(text, [change], config);
      current();
      applied = await editor.edit(edit => {
        current();
        edit.replace(new vscode.Range(document.positionAt(plan.start), document.positionAt(plan.end)), plan.replacement);
      }, { undoStopBefore: true, undoStopAfter: true });
      if (!applied) throw new Error("The editor could not apply the style change. The document was not saved.");
    }
    applied = true;
    await refresh?.(document);
    if (snapshot) await vscode.window.showInformationMessage(config.provenance[change.key]?.source === "document"
      ? "Project default updated. This document keeps its frontmatter override."
      : "Project style default updated.");
    return true;
  } catch (error) {
    const message = (error as Error).message || String(error);
    if (error instanceof StaleStyleSessionError) await vscode.window.showInformationMessage(message);
    else await vscode.window.showErrorMessage(applied ? `Style updated, but the preview refresh failed: ${message}` : `Inkwell: ${message}`);
    return applied;
  }
}

export function registerDocumentStyleCommand(context: vscode.ExtensionContext, refresh?: DocumentStyleRefresh): void {
  context.subscriptions.push(vscode.commands.registerCommand("inkwell.configureDocumentStyle", async () => await configureDocumentStyle(context, refresh)));
}
