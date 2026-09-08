import * as vscode from "vscode";
import * as path from "path";
import MarkdownIt from "markdown-it";
import { getDocumentConfig, getInkwellProjectRoot, getResolvedReferences } from "./config";
import { BibliographyDiagnostic, BibliographyEntry, BibliographySnapshot, bibliographyService, preferredBibliographyEntry } from "./bibliography-service";
import { citationPandocEngine } from "./citation-pandoc";
import { configureBibliography } from "./bibliography-ui";

export interface CitationLocation { key: string; start: number; end: number; line: number; column: number }
/** Authoring locations only; Pandoc decides which keys are actual citations. */
export function citationLocations(text: string): CitationLocation[] {
  const starts = [0];
  for (const match of text.matchAll(/\r?\n/g)) starts.push(match.index! + match[0].length);
  const tokens = new MarkdownIt().parse(text, {}), masked = text.split("");
  const excluded = new Set<number>();
  for (const token of tokens) if (["fence", "code_block"].includes(token.type) && token.map) for (let line = token.map[0]; line < token.map[1]; line++) excluded.add(line);
  const escaped = (offset: number) => { let slashes = 0; while (offset > 0 && text[--offset] === "\\") slashes++; return slashes % 2 === 1; };
  // Inline code can span lines and contain shorter backtick runs. Match exact
  // delimiter lengths within a Markdown paragraph without changing offsets.
  for (const token of tokens) if (token.type === "inline" && token.map) {
    const start = starts[token.map[0]], end = starts[token.map[1]] ?? text.length;
    const runs = [...text.slice(start, end).matchAll(/`+/g)].map(match => ({ start: start + match.index!, length: match[0].length }));
    const next = new Map<number, number>(), closing = new Map<number, number>();
    for (let i = runs.length - 1; i >= 0; i--) { const found = next.get(runs[i].length); if (found !== undefined) closing.set(i, found); next.set(runs[i].length, i); }
    for (let i = 0; i < runs.length; i++) {
      const close = closing.get(i); if (escaped(runs[i].start) || close === undefined) continue;
      for (let offset = runs[i].start; offset < runs[close].start + runs[close].length; offset++) if (!/[\r\n]/.test(masked[offset])) masked[offset] = " ";
      i = close;
    }
  }
  const lines = masked.join("").split(/\r?\n/);
  const locations: CitationLocation[] = [];
  for (let line = 0; line < lines.length; line++) {
    if (excluded.has(line)) continue;
    const value = lines[line];
    // Pandoc permits single internal punctuation, or arbitrary braced keys.
    // https://pandoc.org/MANUAL.html#extension-citations
    for (const match of value.matchAll(/(?<![\p{L}\p{N}_@.])@(?:\{([^}\r\n]+)\}|([\p{L}\p{N}_]+(?:[:.#$%&+?<>~/-][\p{L}\p{N}_]+)*))/gu)) {
      if (escaped(starts[line] + match.index!)) continue;
      const key = match[1] ?? match[2], prefix = match[1] === undefined ? 1 : 2;
      if (!key || /^(?:fig|tbl|eq|sec|lst):/i.test(key)) continue;
      locations.push({ key, start: starts[line] + match.index! + prefix, end: starts[line] + match.index! + prefix + key.length, line: line + 1, column: match.index! + prefix + 1 });
    }
  }
  return locations;
}
interface AuthoringDocument {
  document: vscode.TextDocument; version: number; root: string; snapshot: BibliographySnapshot;
  definitions: Map<string, BibliographyEntry[]>; completions: vscode.CompletionItem[]; diagnostics: BibliographyDiagnostic[];
}
const eligible = (document: vscode.TextDocument) => document.languageId === "markdown" && !document.isUntitled && document.uri.scheme === "file";
export class BibliographyAuthoring implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly collection = vscode.languages.createDiagnosticCollection("inkwell-bibliography");
  private readonly documents = new Map<string, AuthoringDocument>();
  private readonly pending = new Map<string, Promise<AuthoringDocument | undefined>>();
  private readonly pendingGenerations = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  constructor() {
    this.disposables.push(this.collection,
      vscode.languages.registerCompletionItemProvider("markdown", { provideCompletionItems: async document => (await this.get(document))?.completions || [] }, "@"),
      vscode.languages.registerHoverProvider("markdown", { provideHover: async (document, position) => {
        const key = this.keyAt(document, position), state = await this.get(document);
        const definitions = key && state?.definitions.get(key.key), entry = definitions && preferredBibliographyEntry(definitions);
        if (!entry || !key) return undefined;
        const content = new vscode.MarkdownString(); content.appendText(`${entry.title}\n\n${entry.author}${entry.year ? ` (${entry.year})` : ""}\n\n${entry.sourcePath}:${entry.line}`);
        if (definitions!.length > 1) content.appendText(`\n\n${definitions!.length} definitions; the first file in the resolved order takes precedence.`);
        return new vscode.Hover(content, new vscode.Range(document.positionAt(key.start), document.positionAt(key.end)));
      } }),
      vscode.languages.registerDefinitionProvider("markdown", { provideDefinition: async (document, position) => {
        const key = this.keyAt(document, position), state = await this.get(document);
        return key ? (state?.definitions.get(key.key) || []).map(entry => new vscode.Location(vscode.Uri.file(entry.sourcePath), new vscode.Position(entry.line - 1, entry.column - 1))) : [];
      } }),
      vscode.workspace.onDidOpenTextDocument(document => this.schedule(document)),
      vscode.workspace.onDidChangeTextDocument(event => this.schedule(event.document)),
      vscode.workspace.onDidCloseTextDocument(document => {
        const key = document.uri.toString(); this.generations.set(key, (this.generations.get(key) || 0) + 1);
        clearTimeout(this.timers.get(key)); this.timers.delete(key); this.documents.delete(key); this.publish();
      }),
    );
    for (const glob of ["**/*.{bib,csl}", "**/{defaults.yaml,.inkwell/manifest.json}"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      const changed = (uri: vscode.Uri) => this.invalidateFile(uri.fsPath);
      this.disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
    }
    // Activation only registers providers. The first edit, language request,
    // or explicit bibliography action starts indexing and optional Pandoc work.
  }
  private keyAt(document: vscode.TextDocument, position: vscode.Position): CitationLocation | undefined {
    const offset = document.offsetAt(position);
    return citationLocations(document.getText()).find(location => offset >= location.start - 1 && offset <= location.end);
  }
  private schedule(document: vscode.TextDocument, delay = 180): void {
    if (this.disposed || !eligible(document)) return;
    const key = document.uri.toString(); this.generations.set(key, (this.generations.get(key) || 0) + 1);
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.update(document).catch(() => {}); }, delay));
  }
  private invalidateFile(file: string): void {
    if (this.disposed) return;
    bibliographyService.invalidate(file);
    for (const document of vscode.workspace.textDocuments) {
      if (!eligible(document)) continue;
      const state = this.documents.get(document.uri.toString()), root = state?.root || getInkwellProjectRoot(document.uri.fsPath);
      const parent = path.dirname(file), discovery = [root, path.join(root, "references"), path.join(root, ".inkwell/references")];
      if (state?.snapshot.bibliography.includes(file) || state?.snapshot.csl === file || discovery.includes(parent) || file === path.join(root, "defaults.yaml") || file === path.join(root, ".inkwell/manifest.json")) this.schedule(document, 60);
    }
  }
  private async get(document: vscode.TextDocument): Promise<AuthoringDocument | undefined> {
    if (!eligible(document) || this.disposed) return undefined;
    const key = document.uri.toString(), cached = this.documents.get(key);
    if (cached?.version === document.version && !this.timers.has(key) && !this.pending.has(key)) return cached;
    return this.pendingGenerations.get(key) === this.generations.get(key) ? this.pending.get(key) || this.update(document) : this.update(document);
  }
  private async update(document: vscode.TextDocument): Promise<AuthoringDocument | undefined> {
    if (this.disposed || !eligible(document) || document.isClosed) return undefined;
    const key = document.uri.toString(), generation = (this.generations.get(key) || 0) + 1;
    this.generations.set(key, generation); clearTimeout(this.timers.get(key)); this.timers.delete(key);
    const version = document.version, text = document.getText(), root = getInkwellProjectRoot(document.uri.fsPath);
    const current = () => !this.disposed && !document.isClosed && document.version === version && this.generations.get(key) === generation;
    const task = (async () => {
      const config = getDocumentConfig(text, document.uri.fsPath), references = getResolvedReferences(config, document.uri.fsPath);
      const snapshot = await bibliographyService.snapshot(references);
      if (!current()) return undefined;
      const definitions = new Map<string, BibliographyEntry[]>(), completions: vscode.CompletionItem[] = [];
      for (const entry of snapshot.entries) { const group = definitions.get(entry.key) || []; group.push(entry); definitions.set(entry.key, group); }
      let count = 0;
      for (const [id, entries] of definitions) {
        const entry = preferredBibliographyEntry(entries)!, item = new vscode.CompletionItem(id, vscode.CompletionItemKind.Reference);
        item.insertText = id; item.detail = [entry.title, entry.author, entry.year].filter(Boolean).join(" · ");
        item.sortText = id; completions.push(item);
        if (++count % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (!current()) return undefined;
      const diagnostics: BibliographyDiagnostic[] = [...config.diagnostics.filter(issue => issue.key?.startsWith("references.") || issue.key === "typography.referenceSize" || issue.code.startsWith("yaml-") || issue.code.includes("manifest")), ...snapshot.diagnostics];
      const reportFailure = (reason: string) => {
        if (!snapshot.diagnostics.some(issue => issue.severity === "error")) diagnostics.push({
          code: "bibliography-preview-approximate", severity: "warning", sourcePath: document.uri.fsPath, line: 1, column: 1,
          message: `Citation rendering could not be verified: ${reason.slice(0, 3000)}`,
        });
      };
      try {
        let failure: string | undefined;
        const citations = vscode.workspace.isTrusted ? await citationPandocEngine.render(config.parsed.body, references, root, reason => { failure = reason; }) : undefined;
        if (failure) reportFailure(failure);
        if (citations?.missingKeys.size) for (const location of citationLocations(text)) if (citations.missingKeys.has(location.key)) diagnostics.push({
          code: "citation-missing", severity: "warning", key: location.key, sourcePath: document.uri.fsPath, line: location.line, column: location.column,
          message: `Citation @${location.key} is missing from the resolved bibliography. Add its entry or correct this key.`,
        });
      } catch (error) { reportFailure(error instanceof Error ? error.message : String(error)); }
      if (!current()) return undefined;
      const state = { document, version, root, snapshot, definitions, completions, diagnostics };
      this.documents.set(key, state); this.publish(); return state;
    })();
    this.pending.set(key, task);
    this.pendingGenerations.set(key, generation);
    try { return await task; } finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }
  private publish(): void {
    const byFile = new Map<string, Map<string, BibliographyDiagnostic>>();
    for (const state of this.documents.values()) for (const issue of state.diagnostics) {
      const group = byFile.get(issue.sourcePath) || new Map(); group.set(JSON.stringify([issue.code, issue.line, issue.column, issue.message]), issue); byFile.set(issue.sourcePath, group);
    }
    this.collection.clear();
    for (const [file, issues] of byFile) this.collection.set(vscode.Uri.file(file), [...issues.values()].map(issue => {
      const line = Math.max(0, issue.line - 1), column = Math.max(0, issue.column - 1);
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, column, line, column + Math.max(1, issue.key?.length || 1)), issue.message,
        issue.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      diagnostic.source = "Inkwell bibliography"; diagnostic.code = issue.code;
      if (issue.related) diagnostic.relatedInformation = issue.related.map(related => new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.file(related.sourcePath), new vscode.Position(related.line - 1, related.column - 1)), "Another definition of this citation key"));
      return diagnostic;
    }));
  }
  async doctor(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !eligible(document)) { await vscode.window.showInformationMessage("Open a saved Markdown document to check its bibliography."); return; }
    const state = await this.update(document); if (!state) return;
    if (!state.diagnostics.length) {
      await vscode.window.showInformationMessage(`Bibliography checked: ${state.definitions.size} keys in ${state.snapshot.bibliography.length} files. Style: ${path.basename(state.snapshot.csl || "Pandoc default")}.`); return;
    }
    const selected = await vscode.window.showQuickPick(state.diagnostics.map(issue => ({ label: `${issue.severity === "error" ? "$(error)" : "$(warning)"} ${issue.message}`,
      description: `${issue.sourcePath}:${issue.line}`, issue })), { title: "Bibliography Doctor", placeHolder: "Choose a problem to open its source" });
    if (selected && !this.disposed) {
      const source = await vscode.workspace.openTextDocument(vscode.Uri.file(selected.issue.sourcePath));
      const position = new vscode.Position(selected.issue.line - 1, selected.issue.column - 1);
      await vscode.window.showTextDocument(source, { selection: new vscode.Range(position, position), preview: false });
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.documents.clear(); this.timers.clear(); this.pending.clear(); this.pendingGenerations.clear(); this.generations.clear();
  }
}
export function registerBibliographyAuthoring(context: vscode.ExtensionContext, refresh?: () => Promise<void>): void {
  const authoring = new BibliographyAuthoring();
  context.subscriptions.push(authoring,
    vscode.commands.registerCommand("inkwell.configureBibliography", () => configureBibliography(refresh)),
    vscode.commands.registerCommand("inkwell.bibliographyDoctor", () => authoring.doctor()));
}
