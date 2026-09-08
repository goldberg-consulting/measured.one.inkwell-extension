import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getInkwellProjectRoot } from "./config";
import { applyBlockOverrides } from "./document-config";
import { applyRunTextEdits, extractScriptTransaction, planBlockIdentities, planScriptExtraction, RunTextEdit } from "./run-authoring";
import { blockIdentityErrors } from "./run-attributes";
import { containedRunPath } from "./run-paths";
import { CodeBlock, parseCodeBlocks, parseRunConfig, readCurrentRunResults } from "./runner";
import { resolveRunSource, RunStore } from "./run-store";

export const RUN_AUTHORING_COMMANDS = Object.freeze({
  extract: "inkwell.extractCodeBlockToScript",
  open: "inkwell.openRunScript",
  runBlock: "inkwell.runThisBlock",
  runChanged: "inkwell.runChangedBlocks",
  details: "inkwell.showCurrentRunDetails",
});

export interface RunBlockTarget { uri: string; version: number; index: number }
export interface RunAuthoringOptions { mode?: "all" | "changed" | "block"; index?: number; expectedVersion?: number }
export interface PreparedRunRequest {
  document: vscode.TextDocument;
  text: string;
  sourceVersion: number;
  mode: "all" | "changed" | "block";
  selectedIndices?: number[];
}
export interface RunAuthoringAdapters {
  /** Existing first-action/scaffold readiness coordinator. Runs only after trust and write checks. */
  ensureReady(document: vscode.TextDocument): Promise<boolean>;
  /** Executes the prepared snapshot through the existing progress/cancellation UI. */
  execute(request: PreparedRunRequest): Promise<void>;
  /** Refresh preview after a successful extraction or persisted identity edit. */
  onDocumentChanged?(document: vscode.TextDocument): void;
}
export interface RunAuthoringRegistration {
  /** Use this for every existing Run Code Blocks entry point, including preview buttons. */
  run(document: vscode.TextDocument, options?: RunAuthoringOptions): Promise<boolean>;
}

function requireTrusted(): void {
  if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before extracting scripts or running document code.");
}
function requireDocument(document: vscode.TextDocument): void {
  if (document.languageId !== "markdown") throw new Error("Open a Markdown document before running or extracting code.");
  if (document.isClosed || document.isUntitled || document.uri.scheme !== "file") throw new Error("Save this Markdown document to the project before running or extracting code.");
}
async function requireWritable(document: vscode.TextDocument): Promise<void> {
  requireDocument(document);
  const projectRoot = getInkwellProjectRoot(document.uri.fsPath);
  containedRunPath(projectRoot, document.uri.fsPath);
  const stat = await vscode.workspace.fs.stat(document.uri);
  if (stat.permissions !== undefined && (stat.permissions & vscode.FilePermission.Readonly)) throw new Error("This document is read-only. Save an editable copy before running or extracting code.");
  if ((fs.statSync(document.uri.fsPath).mode & 0o222) === 0) throw new Error("This document is read-only. Save an editable copy before running or extracting code.");
  fs.accessSync(document.uri.fsPath, fs.constants.W_OK);
}
function expectedVersion(document: vscode.TextDocument, version?: number): void {
  if (version !== undefined && document.version !== version) throw new Error("The document changed. Select the code block again before continuing.");
}

/** TextEditor.edit carries the captured document version across the editor RPC. */
async function commitEdits(document: vscode.TextDocument, text: string, version: number, edits: RunTextEdit[]): Promise<boolean> {
  requireTrusted(); requireDocument(document);
  if (!edits.length) return document.version === version && document.getText() === text;
  const editor = vscode.window.visibleTextEditors.find(candidate => candidate.document === document)
    || await vscode.window.showTextDocument(document, { preserveFocus: true, preview: false });
  requireTrusted(); requireDocument(document);
  if (document.version !== version || document.getText() !== text || editor.document !== document) return false;
  return editor.edit(builder => {
    for (const edit of edits) builder.replace(new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.replacement);
  }, { undoStopBefore: true, undoStopAfter: true });
}

function validateBlocks(document: vscode.TextDocument): CodeBlock[] {
  const blocks = parseCodeBlocks(document.getText());
  const errors = [...blockIdentityErrors(blocks)].flatMap(([line, messages]) => messages.map(message => `Line ${line}: ${message}`));
  for (const block of blocks) if (block.parsingError) errors.push(`Line ${block.startLine}: ${block.parsingError}`);
  if (errors.length) throw new Error(errors.join("\n"));
  return blocks;
}

/** Snapshot saving is verified independently of the save command's boolean result. */
async function persistIdentities(document: vscode.TextDocument): Promise<{ text: string; version: number }> {
  const original = document.getText(); const version = document.version;
  const edits = planBlockIdentities(original);
  const text = applyRunTextEdits(original, edits);
  if (!await commitEdits(document, original, version, edits)) throw new Error("The document changed while assigning block IDs. Run the command again.");
  requireTrusted(); requireDocument(document);
  if (document.getText() !== text) throw new Error("The document changed while assigning block IDs. Run the command again.");
  const savedVersion = document.version;
  if (!await document.save()) throw new Error("The document could not be saved. No code was executed; save it and run again.");
  requireTrusted(); requireDocument(document);
  expectedVersion(document, savedVersion);
  if (document.isDirty || document.getText() !== text || fs.readFileSync(document.uri.fsPath, "utf8").replace(/^\uFEFF/, "") !== text) {
    throw new Error("The saved document does not match the current editor text. No code was executed; save it and run again.");
  }
  return { text, version: savedVersion };
}

function commandTarget(value: unknown): RunBlockTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const target = value as Partial<RunBlockTarget>;
  return typeof target.uri === "string" && target.uri.length > 0 && Number.isInteger(target.version) && target.version! >= 1 && Number.isInteger(target.index) && target.index! >= 0 ? target as RunBlockTarget : undefined;
}
async function getDocument(value?: unknown): Promise<{ document: vscode.TextDocument; target?: RunBlockTarget }> {
  const target = commandTarget(value);
  if (value !== undefined && !target) throw new Error("The code block target is invalid. Select the code block again.");
  const targetUri = target ? vscode.Uri.parse(target.uri) : undefined;
  if (targetUri && targetUri.scheme !== "file") throw new Error("Select a code block in a saved Markdown document.");
  const document = targetUri ? await vscode.workspace.openTextDocument(targetUri) : vscode.window.activeTextEditor?.document;
  if (!document || document.languageId !== "markdown") throw new Error("Open a Markdown document and select a code block first.");
  expectedVersion(document, target?.version);
  return { document, target };
}
function selectedBlock(document: vscode.TextDocument, target?: RunBlockTarget): CodeBlock {
  const blocks = validateBlocks(document);
  const editor = vscode.window.activeTextEditor;
  const line = editor?.document === document ? editor.selection.active.line + 1 : undefined;
  const block = target ? blocks.find(candidate => candidate.index === target.index)
    : blocks.find(candidate => line !== undefined && candidate.startLine <= line && candidate.endLine >= line);
  if (!block) throw new Error("Place the cursor inside the executable code block you want to use.");
  return block;
}

/** Dirty script buffers cannot be fingerprinted or executed as their older disk contents. */
function requireSavedScripts(document: vscode.TextDocument, text: string, selectedIndices?: number[]): void {
  const projectRoot = getInkwellProjectRoot(document.uri.fsPath);
  const config = parseRunConfig(text, document.uri.fsPath).documentConfig!;
  const blocks = parseCodeBlocks(text).map(block => {
    const attributes: Record<string, unknown> = { ...block.attributes };
    if (block.inputs !== undefined) attributes.inputs = block.inputs;
    if (block.dependsOn !== undefined) attributes["depends-on"] = block.dependsOn;
    return { index: block.index, runs: applyBlockOverrides(config, attributes).runs };
  });
  const named = new Map(blocks.map(block => [block.runs.id || block.runs.label, block]));
  const visited = new Set<number>();
  const physicalPath = (file: string): string => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
  const dirtyPaths = new Set(vscode.workspace.textDocuments.filter(candidate => candidate.isDirty && candidate.uri.scheme === "file")
    .map(candidate => physicalPath(candidate.uri.fsPath)));
  const visit = (block: typeof blocks[number]): void => {
    if (visited.has(block.index)) return;
    visited.add(block.index);
    if (block.runs.file) {
      const file = resolveRunSource(block.runs.file, path.dirname(document.uri.fsPath), projectRoot);
      if (dirtyPaths.has(physicalPath(file))) throw new Error(`Save the edited run script "${block.runs.file}" before running code.`);
    }
    for (const name of block.runs.dependsOn) { const dependency = named.get(name); if (dependency) visit(dependency); }
  };
  for (const block of blocks) if (!selectedIndices || selectedIndices.includes(block.index)) visit(block);
}

/** Commands, diagnostics, and CodeLens share the same version-checked preparation path. */
export function registerRunAuthoring(context: vscode.ExtensionContext, adapters: RunAuthoringAdapters): RunAuthoringRegistration {
  const diagnostics = vscode.languages.createDiagnosticCollection("inkwell-runs");
  const lensChanged = new vscode.EventEmitter<void>();
  const preparing = new Set<string>();
  const updateDiagnostics = (document: vscode.TextDocument): void => {
    if (document.languageId !== "markdown" || document.isClosed) return;
    const blocks = parseCodeBlocks(document.getText());
    const errors = blockIdentityErrors(blocks);
    for (const block of blocks) if (block.parsingError) errors.set(block.startLine, [...errors.get(block.startLine) || [], block.parsingError]);
    diagnostics.set(document.uri, [...errors].flatMap(([line, messages]) => messages.map(message => {
      const diagnostic = new vscode.Diagnostic(document.lineAt(line - 1).range, message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = "Inkwell"; diagnostic.code = "run-block-identity";
      return diagnostic;
    })));
    lensChanged.fire();
  };
  const showError = (error: unknown): false => { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); return false; };
  const run = async (document: vscode.TextDocument, options: RunAuthoringOptions = {}): Promise<boolean> => {
    const key = document.uri.toString(); let acquired = false;
    const initialVersion = options.expectedVersion ?? document.version;
    try {
      requireTrusted(); await requireWritable(document);
      requireTrusted(); requireDocument(document); expectedVersion(document, initialVersion);
      if (preparing.has(key)) throw new Error("A run is already being prepared for this document.");
      preparing.add(key); acquired = true;
      if (!await adapters.ensureReady(document)) return false;
      requireTrusted(); requireDocument(document); expectedVersion(document, initialVersion);
      await requireWritable(document);
      requireTrusted(); requireDocument(document); expectedVersion(document, initialVersion);
      const blocks = validateBlocks(document);
      if (!blocks.length) { void vscode.window.showInformationMessage("No executable code blocks found."); return false; }
      const mode = options.mode || "all";
      if (mode === "block" && !blocks.some(block => block.index === options.index)) throw new Error("Select an executable code block first.");
      const requestedIndices = mode === "block" ? [options.index!] : undefined;
      requireSavedScripts(document, document.getText(), requestedIndices);
      const prepared = await persistIdentities(document);
      requireTrusted();
      updateDiagnostics(document); adapters.onDocumentChanged?.(document);
      requireTrusted(); requireDocument(document); expectedVersion(document, prepared.version);
      requireSavedScripts(document, prepared.text, requestedIndices);
      const selectedIndices = mode === "block" ? requestedIndices
        : mode === "changed" ? readCurrentRunResults(prepared.text, document.uri.fsPath).filter(result => result.cacheStatus !== "hit").map(result => result.block.index) : undefined;
      if (selectedIndices?.length === 0) { void vscode.window.showInformationMessage("All code blocks are current."); return true; }
      const request: PreparedRunRequest = { document, text: prepared.text, sourceVersion: prepared.version, mode,
        selectedIndices };
      expectedVersion(document, prepared.version);
      preparing.delete(key); acquired = false;
      await adapters.execute(request);
      return true;
    } catch (error) { updateDiagnostics(document); return showError(error); }
    finally { if (acquired) preparing.delete(key); }
  };
  const register = (name: string, action: (argument?: unknown) => Promise<unknown>) => vscode.commands.registerCommand(name, async argument => {
    try { return await action(argument); } catch (error) { return showError(error); }
  });
  context.subscriptions.push(diagnostics, lensChanged,
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
    vscode.workspace.onDidChangeTextDocument(event => updateDiagnostics(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)),
    vscode.languages.registerCodeLensProvider({ language: "markdown" }, {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses(document) {
        const blocks = parseCodeBlocks(document.getText());
        return blocks.flatMap((block, index) => {
          const target: RunBlockTarget = { uri: document.uri.toString(), version: document.version, index: block.index };
          const actions = [
            { title: "Run This Block", command: RUN_AUTHORING_COMMANDS.runBlock },
            block.file ? { title: "Open Run Script", command: RUN_AUTHORING_COMMANDS.open } : { title: "Extract to Script", command: RUN_AUTHORING_COMMANDS.extract },
            { title: "Current Run Details", command: RUN_AUTHORING_COMMANDS.details },
            ...index === 0 ? [{ title: "Run Changed Blocks", command: RUN_AUTHORING_COMMANDS.runChanged }] : [],
          ];
          return actions.map(action => new vscode.CodeLens(document.lineAt(block.startLine - 1).range, { ...action, arguments: [target] }));
        });
      },
    }),
    register(RUN_AUTHORING_COMMANDS.runBlock, async argument => {
      const { document, target } = await getDocument(argument);
      const block = selectedBlock(document, target);
      return run(document, { mode: "block", index: block.index, expectedVersion: document.version });
    }),
    register(RUN_AUTHORING_COMMANDS.runChanged, async argument => {
      const { document, target } = await getDocument(argument);
      return run(document, { mode: "changed", expectedVersion: target?.version });
    }),
    register(RUN_AUTHORING_COMMANDS.extract, async argument => {
      requireTrusted();
      const { document, target } = await getDocument(argument);
      const version = document.version;
      requireTrusted(); await requireWritable(document);
      requireTrusted(); requireDocument(document); expectedVersion(document, target?.version ?? version);
      if (!await adapters.ensureReady(document)) return false;
      requireTrusted(); requireDocument(document); expectedVersion(document, version);
      await requireWritable(document);
      requireTrusted(); requireDocument(document); expectedVersion(document, version);
      const block = selectedBlock(document, target);
      const text = document.getText();
      const projectRoot = getInkwellProjectRoot(document.uri.fsPath);
      const plan = planScriptExtraction(text, block.index, projectRoot);
      await extractScriptTransaction(plan, projectRoot, edit => commitEdits(document, text, version, [edit]));
      updateDiagnostics(document); adapters.onDocumentChanged?.(document);
      // The editor owns saving/undo for extraction. Before a run, this module verifies the saved reference.
      try { await vscode.window.showTextDocument(vscode.Uri.file(plan.sourcePath), { preview: false }); }
      catch (error) { void vscode.window.showWarningMessage(`The script was extracted, but its editor could not be opened: ${error instanceof Error ? error.message : String(error)}`); }
      return true;
    }),
    register(RUN_AUTHORING_COMMANDS.open, async argument => {
      const { document, target } = await getDocument(argument);
      requireDocument(document);
      const block = selectedBlock(document, target);
      if (!block.file) throw new Error("This block is inline. Extract it to a script first.");
      const file = resolveRunSource(block.file, path.dirname(document.uri.fsPath), getInkwellProjectRoot(document.uri.fsPath));
      if (!fs.existsSync(file)) throw new Error(`The run script is missing: ${block.file}`);
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
      return true;
    }),
    register(RUN_AUTHORING_COMMANDS.details, async argument => {
      requireTrusted();
      const { document, target } = await getDocument(argument);
      requireTrusted(); requireDocument(document);
      const block = selectedBlock(document, target);
      const id = block.id || block.label;
      const store = new RunStore(getInkwellProjectRoot(document.uri.fsPath), document.uri.fsPath);
      const details = id ? store.currentDetails(id) : undefined;
      if (!details || details.manifest.status !== "success") { void vscode.window.showInformationMessage("This block has no verified successful run yet."); return false; }
      const result = readCurrentRunResults(document.getText(), document.uri.fsPath).find(candidate => candidate.block.index === block.index);
      let unsaved: string | undefined;
      try { requireSavedScripts(document, document.getText(), [block.index]); } catch (error) { unsaved = error instanceof Error ? error.message : String(error); }
      const current = result?.cacheStatus === "hit" && !unsaved;
      const content = JSON.stringify({ ...details.manifest, state: current ? "Current successful output" : "Last successful output (stale)",
        reason: current ? undefined : unsaved || result?.stderr || "Source, inputs, or environment changed.",
        manifestPath: details.path }, null, 2);
      const view = await vscode.workspace.openTextDocument({ language: "json", content });
      await vscode.window.showTextDocument(view, { preview: true });
      return true;
    }),
  );
  for (const document of vscode.workspace.textDocuments) updateDiagnostics(document);
  return { run };
}
