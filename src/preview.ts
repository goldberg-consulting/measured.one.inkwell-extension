// Side-panel preview. Renders the markdown as HTML (with KaTeX math
// and Mermaid diagrams), displays compiled PDFs inline via pdf.js, and
// exposes a run-progress panel that streams block-by-block status back
// from the runner. Communication with the webview is message-based;
// the host pushes content and the webview posts compile/run requests.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import MarkdownIt from "markdown-it";
import { compile, detectMode, isCompilable, readLastSuccessfulOutput } from "./compiler";
import { InkwellDiagnostics } from "./diagnostics";
import { parseCodeBlocks, BlockProgress } from "./runner";
import { prepareForPreview } from "./inject";
import { getInkwellOutputChannel } from "./inkwell-output";
import { getInkwellOutputsDir, getInkwellProjectRoot, getDocumentConfig, getResolvedReferences } from "./config";
import { renderCitations, CitationRenderResult } from "./citations";
import { DocumentConfig, resolveDocumentConfig } from "./document-config";
import { PreviewRevision, PreviewRun, PreviewState } from "./preview-state";
import { buildTypographyCss, resolveTypography } from "./style-model";
import { extractTablePresentation } from "./table-preview";
import { resolveTableStyle, buildTableCss } from "./table-model";
import { TABLE_ATTRIBUTE_SCHEMA } from "./table-values";
import { ViewerState, FontScaleAction, normalizeFontScale, changeFontScale, readViewerState, viewerStateRuntime } from "./viewer-state";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
});

export class InkwellPreviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private context: vscode.ExtensionContext;
  private throttle: ReturnType<typeof setTimeout> | undefined;
  private disposables: vscode.Disposable[] = [];
  private diagnostics: InkwellDiagnostics | undefined;
  private currentDocument: vscode.TextDocument | undefined;
  private outputChannel: vscode.OutputChannel = getInkwellOutputChannel();
  private initialized = false;
  private pdfCache: { path: string; mtimeMs: number; base64: string } | undefined;
  private compileInFlight = false;
  private compileQueued = false;
  private readonly previewState = new PreviewState();
  private runRequest: PreviewRun | null = null;
  private nextRunId = 0;
  private showSequence = 0;
  private viewerState: ViewerState;
  private viewerStateStored: boolean;
  onRun?: () => Promise<void>;
  ensureReady?: (document: vscode.TextDocument, allowPrompt?: boolean) => Promise<boolean>;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.viewerStateStored = context.workspaceState?.get("inkwell.viewerState") !== undefined;
    this.viewerState = readViewerState(context.workspaceState?.get("inkwell.viewerState"),
      vscode.workspace.getConfiguration("inkwell").get<number>("preview.fontScale", 100));
  }

  async refresh(): Promise<void> {
    if (this.currentDocument && this.panel && this.initialized) await this.sendContentUpdate(this.currentDocument);
  }

  async changeFontScale(action: FontScaleAction): Promise<void> {
    this.viewerState = { ...this.viewerState, fontScale: changeFontScale(this.viewerState.fontScale, action) };
    this.viewerStateStored = true;
    await this.context.workspaceState?.update("inkwell.viewerState", this.viewerState);
    await this.sendViewerState();
  }

  private async sendViewerState(): Promise<void> {
    if (this.panel && this.initialized) await this.panel.webview.postMessage({ type: "viewerState", state: this.viewerState });
  }

  setDiagnostics(diagnostics: InkwellDiagnostics): void {
    this.diagnostics = diagnostics;
  }

  getDocument(): vscode.TextDocument | undefined {
    return this.currentDocument;
  }

  async notifyBlocksRan(document = this.currentDocument, request = this.runRequest): Promise<void> {
    if (!document || !this.panel || !this.initialized) return;
    if (!request || !this.isCurrent(request)) return;
    if (document.uri.toString() !== this.currentDocument?.uri.toString()) return;
    await this.sendContentUpdate(document);
  }

  sendRunStarted(blockCount: number, document = this.currentDocument): PreviewRun | null {
    if (!this.panel || !this.initialized || !document) return null;
    const current = this.previewState.current;
    if (!current || current.documentUri !== document.uri.toString() || current.sourceVersion !== document.version) return null;
    this.runRequest = Object.freeze({ ...current, runId: ++this.nextRunId });
    this.postMessage({ type: "runStarted", blockCount }, this.runRequest);
    return this.runRequest;
  }

  sendBlockProgress(progress: BlockProgress, request = this.runRequest): void {
    if (!request) return;
    this.postMessage({ type: "blockProgress", ...progress }, request);
  }

  sendRunComplete(
    outcome: "done" | "failed" | "cancelled",
    ran: number, cached: number, cancelled?: number, failed?: number,
    request = this.runRequest,
  ): void {
    if (!request) return;
    this.postMessage({
      type: "runComplete", outcome, ran, cached,
      cancelled: cancelled || 0, failed: failed || 0,
    }, request);
  }

  private isCurrent(request: PreviewRevision): boolean {
    return !!this.panel && this.initialized && this.previewState.isCurrent(request) &&
      (!("runId" in request) || request.runId === this.runRequest?.runId) &&
      this.currentDocument?.uri.toString() === request.documentUri &&
      this.currentDocument.version === request.sourceVersion;
  }

  private postMessage(message: Record<string, unknown>, request: PreviewRevision | null | undefined = this.previewState.current): void {
    if (!request || !this.isCurrent(request)) return;
    // VS Code returns a Thenable. Observe rejection even when called from a
    // synchronous progress callback; an already disposed view is harmless.
    const report = (error: unknown) => {
      this.outputChannel.appendLine(`Preview message failed: ${String(error)}`);
    };
    try {
      Promise.resolve(this.panel!.webview.postMessage({ ...message, ...request })).catch(report);
    } catch (error) {
      report(error);
    }
  }

  private beginRender(document: vscode.TextDocument): PreviewRevision {
    const previous = this.previewState.current;
    const request = this.previewState.begin(document.uri.toString(), document.version);
    const documentChanged = previous?.documentUri !== request.documentUri;
    if (documentChanged) {
      this.pdfCache = undefined;
      this.lastCitationSignature = undefined;
      this.runRequest = null;
    }
    this.postMessage({ type: "renderStarted", documentChanged }, request);
    return request;
  }

  /**
   * Surface citation-engine results in the preview Log tab. Only emits
   * when there's a plausibly interesting signal (unresolved keys, or a
   * total-miss when bibliography was referenced but the engine was
   * unavailable) so we don't spam the log on every keystroke.
   */
  private lastCitationSignature: string | undefined;
  private lastConfigurationSignature: string | undefined;
  private lastTableDiagnosticSignature: string | undefined;
  private reportCitationStatus(r: CitationRenderResult, request: PreviewRevision): void {
    const total = r.resolvedKeys.size + r.missingKeys.size;
    if (total === 0) return;

    const sig = `${r.engine}|${[...r.missingKeys].sort().join(",")}`;
    if (sig === this.lastCitationSignature) return;
    this.lastCitationSignature = sig;

    if (r.missingKeys.size > 0) {
      const sample = [...r.missingKeys].slice(0, 8).join(", ");
      const extra = r.missingKeys.size > 8 ? ` (+${r.missingKeys.size - 8} more)` : "";
      this.sendLogEntry(
        "warn",
        `Citations: ${r.resolvedKeys.size} resolved, ${r.missingKeys.size} unresolved via ${r.engine}. Missing keys: ${sample}${extra}`,
        undefined, request,
      );
    } else if (r.engine === "none") {
      this.sendLogEntry(
        "warn",
        `Citations present in document but no bibliography or pandoc available to resolve them.`,
        undefined, request,
      );
    }
  }

  sendLogEntry(tag: string, message: string, details?: string, request: PreviewRevision | null | undefined = this.previewState.current): void {
    this.postMessage({ type: "logEntry", tag, message, details: details || "" }, request);
  }

  async show(): Promise<void> {
    const sequence = ++this.showSequence;
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isCompilable(editor.document)) {
      await vscode.window.showWarningMessage("Open a markdown or LaTeX file first.");
      return;
    }
    if (this.ensureReady && !await this.ensureReady(editor.document, true)) return;
    if (sequence !== this.showSequence) return;
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (activeDocument && activeDocument.uri.toString() !== editor.document.uri.toString()) return;

    this.currentDocument = editor.document;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.updateResourceRoots(editor.document);
      await this.sendContentUpdate(editor.document);
      return;
    }

    const docDir = path.dirname(editor.document.uri.fsPath);
    const sourceFile = editor.document.uri.fsPath;
    const projectRoot = getInkwellProjectRoot(sourceFile);
    const inkwellOutputDir = getInkwellOutputsDir(sourceFile);

    this.panel = vscode.window.createWebviewPanel(
      "inkwellPreview",
      "Inkwell Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, "media")),
          vscode.Uri.file(docDir),
          vscode.Uri.file(projectRoot),
          vscode.Uri.file(inkwellOutputDir),
        ],
        retainContextWhenHidden: true,
      }
    );

    this.initialized = false;
    if (vscode.workspace.onDidChangeConfiguration) this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration("inkwell.preview.fontScale")) return;
      this.viewerState = { ...this.viewerState, fontScale: normalizeFontScale(vscode.workspace.getConfiguration("inkwell").get("preview.fontScale", 100)) };
      this.viewerStateStored = true;
      Promise.resolve(this.context.workspaceState?.update("inkwell.viewerState", this.viewerState))
        .then(() => this.sendViewerState()).catch(error => this.outputChannel.appendLine(`Preview preference failed: ${String(error)}`));
    }));

    this.panel.onDidDispose(() => {
      this.showSequence++;
      if (this.throttle) {
        clearTimeout(this.throttle);
        this.throttle = undefined;
      }
      this.previewState.clear();
      this.runRequest = null;
      this.panel = undefined;
      this.currentDocument = undefined;
      this.initialized = false;
      for (const d of this.disposables) d.dispose();
      this.disposables = [];
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "viewerStateChanged") {
          this.viewerStateStored = true;
          this.viewerState = readViewerState(msg.state, this.viewerState.fontScale, this.viewerState.selectedTab);
          await this.context.workspaceState?.update("inkwell.viewerState", this.viewerState);
        } else if (msg.type === "compile") {
          await this.handleCompile();
        } else if (msg.type === "run") {
          if (this.onRun) {
            await this.onRun();
          }
        } else if (msg.type === "cancelRun") {
          await vscode.commands.executeCommand("inkwell.cancelRun");
        } else if (msg.type === "ready") {
          this.initialized = true;
          await this.sendViewerState();
          if (this.currentDocument) {
            await this.sendContentUpdate(this.currentDocument);
          }
        }
      } catch (error) {
        this.sendLogEntry("error", "Preview action failed", String(error));
      }
    });

    const changeDoc = vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        this.panel &&
        isCompilable(e.document) &&
        e.document === vscode.window.activeTextEditor?.document
      ) {
        this.currentDocument = e.document;
        this.scheduleUpdate(e.document);
      }
    });

    const changeEditor = vscode.window.onDidChangeActiveTextEditor(async (e) => {
      try {
        if (this.panel && e && isCompilable(e.document)) {
          this.showSequence++;
          this.currentDocument = e.document;
          this.updateResourceRoots(e.document);
          await this.sendContentUpdate(e.document);
        }
      } catch (error) {
        this.sendLogEntry("error", "Preview could not switch documents", String(error));
      }
    });

    this.disposables.push(changeDoc, changeEditor);

    const isTeX = detectMode(editor.document) === "xelatex";
    this.panel.webview.html = this.buildShell(this.panel.webview, isTeX);
  }

  private updateResourceRoots(document: vscode.TextDocument): void {
    if (!this.panel) return;
    const docDir = path.dirname(document.uri.fsPath);
    const sourceFile = document.uri.fsPath;
    const projectRoot = getInkwellProjectRoot(sourceFile);
    const outputsDir = getInkwellOutputsDir(sourceFile);
    (this.panel as any).webview.options = {
      ...this.panel.webview.options,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
        vscode.Uri.file(docDir),
        vscode.Uri.file(projectRoot),
        vscode.Uri.file(outputsDir),
      ],
    };
  }

  private async sendContentUpdate(document: vscode.TextDocument, requested?: PreviewRevision): Promise<void> {
    if (!this.panel || !this.initialized) return;
    const request = requested || this.beginRender(document);
    if (!this.isCurrent(request)) return;
    try {
      if (this.ensureReady && !await this.ensureReady(document, false)) {
        this.postMessage({ type: "updateContent", html: "<p>Use Inkwell: Open Preview to set up this workspace.</p>", pdfData: null,
          pdfOutput: null, title: path.basename(document.uri.fsPath), hasCodeBlocks: false, blockCount: 0, layoutCss: "", bodyClasses: [] }, request);
        return;
      }
      if (!this.isCurrent(request)) return;
      await this.renderContentUpdate(document, request);
    } catch (error) {
      if (this.isCurrent(request)) {
        this.sendLogEntry("error", "Preview could not be updated", String(error), request);
      }
    }
  }

  private async renderContentUpdate(document: vscode.TextDocument, request: PreviewRevision): Promise<void> {
    const text = document.getText();
    const sourceFile = document.uri.fsPath;
    const mode = detectMode(document);
    const isTeX = mode === "xelatex";

    let htmlBody: string;
    let title: string | undefined;
    let layout: LayoutPayload = { cssText: "", bodyClasses: [] };

    if (isTeX) {
      htmlBody = `<pre><code>${escapeHtml(text)}</code></pre>`;
      const titleMatch = text.match(/\\title\{([^}]+)\}/);
      title = titleMatch ? titleMatch[1] : undefined;
    } else {
      const mermaidMeta = extractMermaidMeta(text);
      const injected = prepareForPreview(text, sourceFile);
      const config = getDocumentConfig(injected, sourceFile);
      const fm = stripFrontmatter(injected, config);
      const references = getResolvedReferences(config, sourceFile);
      const diagnostics = [...config.diagnostics, ...references.diagnostics];
      const diagnosticSignature = JSON.stringify([sourceFile, diagnostics]);
      if (this.lastConfigurationSignature !== diagnosticSignature) {
        this.lastConfigurationSignature = diagnosticSignature;
        for (const diagnostic of diagnostics) {
          this.sendLogEntry(diagnostic.severity === "error" ? "error" : "warn", diagnostic.message,
            `${diagnostic.sourcePath}:${diagnostic.line}:${diagnostic.column}`, request);
        }
      }

      const prefixes = {
        fig: fm.figPrefix || "Figure",
        tbl: fm.tblPrefix || "Table",
        eqn: fm.eqnPrefix || "Equation",
        sec: fm.secPrefix || "Section",
      };
      const tables = extractTablePresentation(fm.body, { tablePrefix: prefixes.tbl });
      let body = resolveReferences(
        tables.markdown,
        mermaidMeta,
        prefixes,
        fm.sectionNumbering || "decimal",
        tables.labels,
      );

      const projectRoot = getInkwellProjectRoot(sourceFile);
      const citeResult = await renderCitations(body, {
        sourceFile,
        projectRoot,
        bibliography: [...references.bibliography],
        csl: references.csl,
        linkCitations: references.linkCitations,
        referencesHeading: references.referencesHeading || "References",
        resolvedReferences: references,
      });
      if (!this.isCurrent(request)) return;
      body = citeResult.body;
      if (citeResult.approximate) body = '<aside class="citation-preview-notice">Approximate citation preview: Pandoc is unavailable or could not render this bibliography. The active CSL style is not applied.</aside>\n\n' + body;
      this.reportCitationStatus(citeResult, request);

      // If the author marked a references slot with Pandoc's fenced-div
      // `::: {#refs} ... :::` syntax (or similar variants such as
      // `::: refs`), swap it out for a sentinel that we can replace with
      // the CSL references block after markdown-it renders. markdown-it
      // does not understand `:::` fenced divs, so without this step the
      // `:::` lines surface as literal text in the preview.
      const refsPlaceholder = INKWELL_REFS_SLOT;
      let refsSlotInjected = false;
      body = body.replace(
        /^:::[ \t]*(?:\{#refs[^}]*\}|refs)[ \t]*$[\s\S]*?^:::[ \t]*$/gm,
        () => {
          refsSlotInjected = true;
          return `\n\n${refsPlaceholder}\n\n`;
        },
      );

      // Strip any remaining Pandoc header attributes not caught above.
      // Use [ \t]*$ rather than \s*$ — JavaScript's `\s` matches `\n`,
      // and with the /m flag the greedy `\s*$` will eat the blank line
      // *after* the attribute, merging the attribute's line into the
      // next block. That broke lists and headings downstream of any
      // `{#foo}` attribute.
      body = body.replace(/[ \t]*\{[#.][\w:. -]+\}[ \t]*$/gm, "");
      // Clean up unresolved inline expression errors for preview
      body = body.replace(
        /\?\?\(([^)]+)\)/g,
        '<span class="eval-error" title="$1">??</span>',
      );
      // Style unresolved {{variable}} placeholders (outside math)
      body = body.replace(
        /(?<!\$)\{\{(\w+)\}\}(?!\$)/g,
        '<span class="var-placeholder">$1</span>',
      );

      // LaTeX typesetting directives (\newpage, \vspace, \hfill, etc.)
      // are meaningful for the PDF compile but render as literal text
      // in the preview. Strip cosmetic spacing commands entirely; keep
      // structural breaks (\newpage / \clearpage / \pagebreak) as a
      // subtle marker so the reader can still see where the author
      // intended a page boundary without the raw macro showing.
      body = maskLatexTypesettingDirectives(body);

      // Shield math blocks from markdown-it's escape / emphasis rules
      // before rendering. markdown-it does not know about `$$...$$` or
      // `$...$` delimiters, so underscores, backslashes, and asterisks
      // inside math would otherwise be consumed as emphasis or escape
      // sequences and reach KaTeX in a corrupted form. We swap each
      // math span for an opaque placeholder, render markdown, then
      // restore the raw LaTeX so KaTeX auto-render sees it intact.
      const { shielded, restore } = shieldMathForMarkdown(body);

      let rendered = tables.render(md, shielded, attributes => {
        const result = resolveTableStyle(config, attributes);
        return { preset: result.style.preset, captionPosition: result.style.captionPosition,
          alignment: result.style.alignment, alignmentIsLocal: TABLE_ATTRIBUTE_SCHEMA.find(rule => rule.field === "alignment")!.aliases.some(key => attributes[key] !== undefined),
          numericAlignment: result.style.numericAlignment,
          cssText: buildTableCss(result.style), diagnostics: result.diagnostics.filter(diagnostic => !config.diagnostics.includes(diagnostic)) };
      });
      const tableDiagnosticSignature = JSON.stringify([sourceFile, tables.diagnostics]);
      if (this.lastTableDiagnosticSignature !== tableDiagnosticSignature) {
        this.lastTableDiagnosticSignature = tableDiagnosticSignature;
        for (const diagnostic of tables.diagnostics) this.sendLogEntry(diagnostic.severity === "error" ? "error" : "warn", diagnostic.message, undefined, request);
      }
      rendered = restore(rendered);
      rendered = this.convertLocalImages(rendered, document);
      rendered = softenMissingCitations(rendered);
      htmlBody = addDataLineAttrs(rendered);
      title = fm.title;

      layout = buildLayoutStyle(fm, config);

      const parts: string[] = [];
      if (fm.title) {
        parts.push(`<h1>${escapeHtml(fm.title)}</h1>`);
      }
      if (fm.subtitle) {
        parts.push(`<p class="subtitle">${escapeHtml(fm.subtitle)}</p>`);
      }
      if (fm.author) {
        parts.push(`<p class="author">${escapeHtml(fm.author)}</p>`);
      }
      if (fm.date) {
        parts.push(`<p class="date">${escapeHtml(fm.date)}</p>`);
      }
      if (parts.length) {
        htmlBody = `<header class="title-block">${parts.join("\n")}</header>` + htmlBody;
      }
      if (fm.abstract) {
        const abstractHtml = md.render(fm.abstract);
        const abstractBlock = `<div class="abstract-block"><p class="abstract-title">Abstract</p>${abstractHtml}</div>`;
        if (parts.length) {
          htmlBody = htmlBody.replace(
            /(<\/header>)/,
            `$1${abstractBlock}`
          );
        } else {
          htmlBody = abstractBlock + htmlBody;
        }
      }

      // Build the final references section. Prefer pandoc's rendered
      // CSL block; when every key is missing (pandoc emits no refs div
      // in that case), synthesize a stub that lists the unresolved
      // keys so the reader still sees a visible References section and
      // knows which entries the bibliography is missing.
      const referencesHtml = citeResult.referencesEmbedded ? "" : buildReferencesSection(citeResult);
      if (referencesHtml) {
        if (refsSlotInjected && htmlBody.includes(refsPlaceholder)) {
          htmlBody = htmlBody.replace(refsPlaceholder, referencesHtml);
        } else {
          htmlBody = htmlBody + referencesHtml;
        }
      } else if (refsSlotInjected) {
        // Author asked for refs but there were no citations at all;
        // drop the placeholder so it doesn't appear as raw text.
        htmlBody = htmlBody.replace(refsPlaceholder, "");
      }
    }

    const baseName = path.basename(sourceFile, path.extname(sourceFile));
    const pdfPath = path.join(path.dirname(sourceFile), `${baseName}.pdf`);
    let existingPdfData: string | undefined;
    try {
      const stat = fs.statSync(pdfPath);
      if (this.pdfCache && this.pdfCache.path === pdfPath && this.pdfCache.mtimeMs === stat.mtimeMs) {
        existingPdfData = this.pdfCache.base64;
      } else {
        existingPdfData = fs.readFileSync(pdfPath).toString("base64");
        this.pdfCache = { path: pdfPath, mtimeMs: stat.mtimeMs, base64: existingPdfData };
      }
    } catch {}

    const blocks = isTeX ? [] : parseCodeBlocks(text);
    const hasCodeBlocks = blocks.length > 0;

    if (!this.isCurrent(request)) return;
    this.panel!.title = title || path.basename(sourceFile);
    this.postMessage({
      type: "updateContent",
      html: htmlBody,
      pdfData: existingPdfData || null,
      pdfOutput: existingPdfData ? readLastSuccessfulOutput(sourceFile, pdfPath) || null : null,
      isTeX,
      hasCodeBlocks,
      blockCount: blocks.length,
      title: title || "",
      layoutCss: layout.cssText,
      typographyNotice: layout.typographyNotice || "",
      bodyClasses: layout.bodyClasses,
    }, request);
  }

  private convertLocalImages(html: string, document: vscode.TextDocument): string {
    if (!this.panel) return html;
    const webview = this.panel.webview;
    return html.replace(
      /(<img\s+[^>]*src=")([^"]+)(")/g,
      (_match, prefix, src, suffix) => {
        if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) {
          return prefix + src + suffix;
        }
        const absPath = path.isAbsolute(src)
          ? src
          : path.resolve(path.dirname(document.uri.fsPath), src);
        if (fs.existsSync(absPath)) {
          const uri = webview.asWebviewUri(vscode.Uri.file(absPath));
          return prefix + uri.toString() + suffix;
        }
        return prefix + src + suffix;
      }
    );
  }

  // 150ms debounce: fast enough to feel live, slow enough to avoid
  // re-rendering on every keystroke during rapid editing.
  private scheduleUpdate(document: vscode.TextDocument): void {
    if (this.throttle) clearTimeout(this.throttle);
    const request = this.beginRender(document);
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      void this.sendContentUpdate(document, request);
    }, 150);
  }

  private async handleCompile(): Promise<void> {
    if (!this.panel || !this.currentDocument) return;
    if (this.compileInFlight) {
      this.compileQueued = true;
      return;
    }

    this.compileInFlight = true;
    try {
      do {
        this.compileQueued = false;
        const doc = this.currentDocument;
        if (!this.panel || !doc) break;

        const request = this.previewState.current;
        if (this.ensureReady && !await this.ensureReady(doc, true)) break;
        if (!request || !this.isCurrent(request)) break;
        this.postMessage({ type: "compileStarted" }, request);

        try {
          const result = await compile(doc);

          this.outputChannel.clear();
          this.outputChannel.appendLine(`Inkwell compile: ${doc.uri.fsPath}`);
          this.outputChannel.appendLine(
            `Result: ${result.success ? "success" : "failed"} (${result.duration.toFixed(1)}s)`
          );
          if (result.errors.length) {
            this.outputChannel.appendLine(`\n--- Errors (${result.errors.length}) ---`);
            for (const err of result.errors) {
              const loc = err.line ? `line ${err.line}` : "unknown location";
              this.outputChannel.appendLine(`  [${err.severity}] ${loc}: ${err.message}`);
            }
          }
          if (result.log.trim()) {
            this.outputChannel.appendLine("\n--- Full Log ---");
            this.outputChannel.appendLine(result.log);
          }

          if (this.diagnostics) {
            this.diagnostics.report(doc.uri, result.errors);
          }

          if (!this.isCurrent(request)) continue;

          if (result.success && result.pdfPath) {
            const pdfData = fs.readFileSync(result.pdfPath).toString("base64");
            this.postMessage({
              type: "compileDone",
              success: true,
              pdfData,
              pdfOutput: result.lastSuccessfulOutput || null,
              duration: result.duration,
              errors: [],
              log: "",
            }, request);
            const warnings = result.errors.filter(e => e.severity === "warning");
            for (const w of warnings) {
              const loc = w.line ? `line ${w.line}: ` : "";
              this.sendLogEntry("warn", `${loc}${w.message}`, undefined, request);
            }
          } else {
            const retained = result.lastSuccessfulOutput;
            const existingPath = retained?.pdfPath || path.join(path.dirname(doc.uri.fsPath), `${path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath))}.pdf`);
            // An older installation (or lost metadata cache) can leave a valid
            // existing PDF with unknown provenance. Keep it for this document.
            const pdfData = fs.existsSync(existingPath) ? fs.readFileSync(existingPath).toString("base64") : null;
            this.postMessage({
              type: "compileDone",
              success: false,
              pdfData,
              pdfOutput: retained || null,
              duration: result.duration,
              errors: result.errors.map((e) => {
                const loc = e.line ? `Line ${e.line}: ` : "";
                return `${loc}${e.message}`;
              }),
              log: result.log,
            }, request);
          }
        } catch (err) {
          if (this.isCurrent(request)) {
            this.postMessage({
              type: "compileDone",
              success: false,
              retainPdf: true,
              duration: 0,
              errors: [String(err)],
              log: "",
            }, request);
          }
        }
      } while (this.compileQueued);
    } finally {
      this.compileInFlight = false;
      this.compileQueued = false;
    }
  }

  private buildShell(webview: vscode.Webview, defaultToPdf: boolean): string {
    const mediaUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.file(
          path.join(this.context.extensionPath, "media", file)
        )
      );

    const cssUri = mediaUri("preview.css");
    const nonce = getNonce();

    const previewLabel = defaultToPdf ? "Source" : "Draft";
    const previewActive = defaultToPdf ? "" : " active";
    const pdfActive = defaultToPdf ? " active" : "";
    const initialTab = defaultToPdf ? "pdf" : "preview";
    if (!this.viewerStateStored) this.viewerState = { ...this.viewerState, selectedTab: initialTab };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;
      font-src https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;
      script-src 'nonce-${nonce}' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;
      worker-src blob:;
      img-src ${webview.cspSource} data: https:;
      object-src ${webview.cspSource};
      frame-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
  <link rel="stylesheet" id="hljs-light" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css" media="(prefers-color-scheme: light)">
  <link rel="stylesheet" id="hljs-dark" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
  <link rel="stylesheet" href="${cssUri}">
  <style>
    :root {
      --body-font: var(--vscode-font-family, sans-serif);
      --heading-font: var(--body-font);
      --mono-font: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      --base-size: 16px;
      --line-height: 1.5;
      --content-width: 100%;
      --paragraph-spacing: 0.8em;
      --hr-display: block;
    }
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    /* Mermaid diagram sizing. Inline mermaid SVGs expand to their
       natural size, which often exceeds the preview pane; these rules
       constrain each diagram to its container while preserving aspect
       ratio. Frontmatter and per-block attrs can override the maxes. */
    .mermaid {
      text-align: center; margin: 1.5em auto;
      max-width: var(--mermaid-max-width, 100%);
      /* Default cap prevents a single uncontrolled diagram from
         stretching the preview to multiple screens tall. Users can
         relax the cap with the frontmatter setting
         inkwell.mermaid-max-height (any CSS length like 90vh or
         800px) or tighten it per-diagram with a max-height attribute
         on the mermaid fence. */
      max-height: var(--mermaid-max-height, 70vh);
      overflow: hidden;
    }
    .mermaid svg {
      max-width: 100%;
      max-height: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
    .mermaid-frame {
      display: block; margin: 1.5em auto; text-align: center; overflow: hidden;
    }
    .mermaid-frame .mermaid {
      max-width: 100%; max-height: 100%; margin: 0 auto;
    }

    .inkwell-toolbar {
      display: flex; align-items: center; height: 36px;
      padding: 0 8px; background: var(--code-bg);
      border-bottom: 1px solid var(--border); gap: 2px;
      flex-shrink: 0; user-select: none; flex-wrap: wrap; min-height: 36px; height: auto;
    }
    .inkwell-tab {
      padding: 4px 12px; font-size: 12px; font-weight: 500;
      border: none; background: transparent; color: var(--blockquote);
      cursor: pointer; border-radius: 4px; font-family: var(--vscode-font-family, sans-serif);
    }
    .inkwell-tab:hover { background: var(--border); }
    .inkwell-tab.active { background: var(--accent); color: #fff; }
    .inkwell-spacer { flex: 1; }
    .inkwell-compile-btn {
      padding: 3px 10px; font-size: 11px; font-weight: 500;
      border: 1px solid var(--border); background: transparent;
      color: var(--text); cursor: pointer; border-radius: 4px;
      font-family: var(--vscode-font-family, sans-serif); display: flex; align-items: center; gap: 4px;
    }
    .inkwell-compile-btn:hover { background: var(--border); }
    .inkwell-compile-btn:disabled { opacity: 0.5; cursor: default; }
    .inkwell-status { font-size: 11px; color: var(--blockquote); margin-right: 8px; }

    .viewer-controls { display: flex; align-items: center; gap: 3px; font: 11px var(--vscode-font-family, sans-serif); }
    .viewer-controls button, .viewer-controls select, .viewer-controls input {
      font: inherit; color: var(--text); background: var(--code-bg); border: 1px solid var(--border); border-radius: 3px; padding: 3px 5px;
    }
    .viewer-controls button:focus-visible { outline: 2px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 1px; }
    #font-scale { min-width: 34px; text-align: center; }
    #pdf-controls { width: 100%; padding: 6px 12px; flex-shrink: 0; }
    #pdf-zoom { width: 64px; }
    .document-notice { font: 12px var(--vscode-font-family, sans-serif); color: var(--blockquote); padding: 8px 0; }
    .inkwell-document { font-family: var(--body-font, serif); font-size: var(--base-size, 11pt); line-height: var(--line-height, 1.2); }
    .inkwell-content { flex: 1; overflow: hidden; position: relative; }
    .inkwell-pane {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      overflow-y: auto; display: none;
    }
    .inkwell-pane.active { display: block; }
    .inkwell-pane.preview-pane { padding: 32px 24px; }
    .inkwell-pane.pdf-pane { display: none; overflow: hidden; }
    .inkwell-pane.pdf-pane.active {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
    }
    .inkwell-pane.pdf-pane embed { width: 100%; height: 100%; border: none; }
    .pdf-canvas-container {
      width: 100%; overflow-y: auto; padding: 8px 0;
      display: flex; flex-direction: column; align-items: safe center; gap: 8px;
    }
    .pdf-canvas-container canvas {
      box-shadow: 0 2px 8px rgba(0,0,0,0.15); flex-shrink: 0;
    }
    .pdf-output-status { font: 11px var(--vscode-font-family, sans-serif); padding: 6px 12px; color: var(--blockquote); }
    .pdf-placeholder { text-align: center; color: var(--blockquote); font-size: 14px; padding: 40px; }
    .pdf-placeholder p { margin: 8px 0; }

    .compile-errors {
      width: 100%; max-height: 100%; overflow-y: auto; padding: 16px 24px;
      font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6;
    }
    .compile-errors-header {
      font-family: var(--vscode-font-family, sans-serif); font-weight: 600; font-size: 13px;
      color: #e05252; margin-bottom: 12px;
    }
    .compile-error-item {
      padding: 6px 10px; margin-bottom: 4px;
      background: rgba(224, 82, 82, 0.08); border-left: 3px solid #e05252;
      border-radius: 2px; color: var(--text); word-wrap: break-word;
    }
    .compile-log-toggle {
      margin-top: 16px; font-family: var(--vscode-font-family, sans-serif); font-size: 12px;
      color: var(--accent); cursor: pointer; border: none; background: none;
      padding: 4px 0; text-decoration: underline;
    }
    .compile-log {
      margin-top: 8px; padding: 12px; background: var(--code-bg);
      border-radius: 4px; white-space: pre-wrap; font-size: 11px;
      color: var(--blockquote); max-height: 300px; overflow-y: auto; display: none;
    }
    .compile-log.visible { display: block; }

    .inkwell-wrapper { display: flex; flex-direction: column; height: 100vh; }

    .run-panel {
      display: none; flex-direction: column;
      border-bottom: 1px solid var(--border); background: var(--code-bg);
      font-family: var(--vscode-font-family, sans-serif); font-size: 12px;
      max-height: 200px; overflow-y: auto; flex-shrink: 0;
    }
    .run-panel.visible { display: flex; }
    .run-panel-header {
      display: flex; align-items: center; padding: 6px 12px; gap: 8px;
      border-bottom: 1px solid var(--border); position: sticky; top: 0;
      background: var(--code-bg); z-index: 1;
    }
    .run-panel-title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--blockquote); }
    .run-panel-summary { font-size: 11px; color: var(--blockquote); flex: 1; }
    .run-panel-close {
      border: none; background: none; color: var(--blockquote); cursor: pointer;
      font-size: 14px; padding: 0 4px; line-height: 1;
    }
    .run-panel-close:hover { color: var(--text); }
    .run-cancel-btn {
      padding: 2px 8px; font-size: 10px; font-weight: 500;
      border: 1px solid #e05252; background: transparent; color: #e05252;
      cursor: pointer; border-radius: 3px; font-family: var(--vscode-font-family, sans-serif);
    }
    .run-cancel-btn:hover { background: rgba(224,82,82,0.1); }
    .run-block-list { padding: 4px 12px 8px; }
    .run-block-item {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 0; font-size: 11px; color: var(--text);
    }
    .run-block-icon { width: 16px; text-align: center; flex-shrink: 0; }
    .run-block-label { flex: 1; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 10px; }
    .run-block-meta { color: var(--blockquote); font-size: 10px; }
    .run-block-item.status-pending .run-block-icon { color: var(--blockquote); }
    .run-block-item.status-running .run-block-icon { color: var(--accent); }
    .run-block-item.status-cached .run-block-icon { color: #8b8; }
    .run-block-item.status-done .run-block-icon { color: #4a4; }
    .run-block-item.status-failed .run-block-icon { color: #e05252; }
    .run-block-item.status-cancelled .run-block-icon { color: var(--blockquote); }
    .run-block-error { font-size: 10px; color: #e05252; padding-left: 24px; margin-bottom: 2px; }

    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner { display: inline-block; animation: spin 1s linear infinite; }

    .log-pane { display: none; overflow: hidden; flex-direction: column; }
    .log-pane.active { display: flex !important; }
    .log-toolbar {
      display: flex; align-items: center; padding: 8px 16px; gap: 8px;
      border-bottom: 1px solid var(--border); background: var(--code-bg);
      flex-shrink: 0;
    }
    .log-toolbar-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--blockquote); flex: 1; }
    .log-clear-btn {
      padding: 2px 8px; font-size: 10px; border: 1px solid var(--border);
      background: transparent; color: var(--blockquote); cursor: pointer;
      border-radius: 3px; font-family: var(--vscode-font-family, sans-serif);
    }
    .log-clear-btn:hover { background: var(--border); }
    .log-entries {
      flex: 1; overflow-y: auto; padding: 8px 0;
      font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5;
    }
    .log-empty { padding: 40px 16px; text-align: center; color: var(--blockquote); font-family: var(--vscode-font-family, sans-serif); font-size: 13px; }
    .log-entry { padding: 4px 16px; border-bottom: 1px solid rgba(128,128,128,0.08); }
    .log-entry:last-child { border-bottom: none; }
    .log-entry-header {
      display: flex; align-items: center; gap: 6px; margin-bottom: 2px;
      font-family: var(--vscode-font-family, sans-serif); font-size: 10px; color: var(--blockquote);
    }
    .log-tag {
      padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.3px;
    }
    .log-tag-compile { background: rgba(74,144,217,0.15); color: #4A90D9; }
    .log-tag-run { background: rgba(74,180,100,0.15); color: #4ab464; }
    .log-tag-error { background: rgba(224,82,82,0.15); color: #e05252; }
    .log-tag-warn { background: rgba(204,163,0,0.15); color: #CCA300; }
    .log-tag-info { background: rgba(128,128,128,0.1); color: var(--blockquote); }
    .log-entry-body { white-space: pre-wrap; word-wrap: break-word; color: var(--text); }
    .log-entry-body.is-error { color: #e05252; }
    .log-entry-toggle {
      font-family: var(--vscode-font-family, sans-serif); font-size: 10px; color: var(--accent);
      cursor: pointer; border: none; background: none; padding: 2px 0;
      text-decoration: underline;
    }
    .log-entry-details {
      display: none; margin-top: 4px; padding: 8px;
      background: var(--code-bg); border-radius: 4px;
      max-height: 300px; overflow-y: auto; font-size: 10px; color: var(--blockquote);
    }
    .log-entry-details.visible { display: block; }
    .log-badge {
      display: none; min-width: 14px; height: 14px; border-radius: 7px;
      background: #e05252; color: #fff; font-size: 9px; font-weight: 700;
      text-align: center; line-height: 14px; margin-left: 4px; padding: 0 3px;
    }
    .log-badge.visible { display: inline-block; }

    /* ── Print View: paginated simulation ─────────────────────── */
    .inkwell-pane.print-pane {
      display: none; background: #5a5a5a; padding: 24px 0;
    }
    @media (prefers-color-scheme: dark) {
      .inkwell-pane.print-pane { background: #2a2a2a; }
    }
    .inkwell-pane.print-pane.active { display: block; }
    .print-page-stage {
      display: flex; flex-direction: column; align-items: center; gap: 18px;
      min-height: 100%;
    }
    .page-sheet {
      width: var(--page-width, 8.5in);
      min-height: var(--page-height, 11in);
      background: #fff;
      color: #111;
      box-shadow: 0 4px 18px rgba(0,0,0,0.35);
      padding: var(--page-margin-top, 1in) var(--page-margin-right, 1in)
               var(--page-margin-bottom, 1in) var(--page-margin-left, 1in);
      position: relative;
      display: flex; flex-direction: column;
      font-family: var(--body-font);
      font-size: var(--base-size, 11pt);
      line-height: var(--line-height, 1.4);
      box-sizing: border-box;
      overflow: hidden;
    }
    .page-sheet .page-header,
    .page-sheet .page-footer {
      position: absolute; left: var(--page-margin-left, 1in);
      right: var(--page-margin-right, 1in);
      font-size: 9pt; color: #555;
      display: flex; justify-content: space-between;
      font-family: var(--body-font);
    }
    .page-sheet .page-header {
      top: calc(var(--page-margin-top, 1in) / 2); padding-bottom: 4px;
      border-bottom: 0.4pt solid #ccc;
    }
    .page-sheet .page-footer {
      bottom: calc(var(--page-margin-bottom, 1in) / 2); padding-top: 4px;
    }
    .page-sheet .page-body { flex: 1; }
    .page-sheet .page-body > :first-child { margin-top: 0; }
    .page-sheet .page-body > :last-child { margin-bottom: 0; }
    .page-sheet :is(figure, table, pre, .theorem-env, blockquote) {
      break-inside: avoid; page-break-inside: avoid;
    }
    .page-sheet h1, .page-sheet h2, .page-sheet h3 {
      page-break-after: avoid; break-after: avoid;
    }

    /* Visual marker that replaces the newpage / clearpage /
       pagebreak LaTeX directives in the preview so the intent is
       visible at a glance but not intrusive. The raw macro still
       travels to the LaTeX compile pipeline untouched; this is a
       preview-only affordance. Hidden inside print-view page-sheets
       since those already paginate physically. */
    hr.page-break-marker {
      border: none;
      border-top: 1px dashed var(--blockquote, #888);
      margin: 2em 0;
      position: relative;
      overflow: visible;
      opacity: 0.55;
    }
    hr.page-break-marker::after {
      content: "page break";
      position: absolute;
      top: -0.7em;
      left: 50%;
      transform: translateX(-50%);
      padding: 0 0.6em;
      background: var(--bg, #fff);
      font-family: var(--body-font, serif);
      font-size: 10px;
      font-variant: small-caps;
      letter-spacing: 0.12em;
      color: var(--blockquote, #888);
    }
    .page-sheet hr.page-break-marker { display: none; }

    /* HLJS: match Pandoc Shaded background */
    .hljs { background: var(--code-bg); padding: 0; font-size: 0.85em; }
    pre code.hljs { padding: 0; }

    /* Visible, inline mermaid error boxes instead of silent failure */
    .mermaid.mermaid-error { text-align: left; margin: 1.2em 0; }
    .mermaid-error-box {
      border-left: 3px solid #e05252;
      background: rgba(224, 82, 82, 0.08);
      padding: 10px 14px;
      border-radius: 2px;
      font-family: var(--body-font);
    }
    .mermaid-error-title {
      font-weight: 600; color: #e05252; margin-bottom: 6px; font-size: 0.95em;
    }
    .mermaid-error-msg {
      font-family: var(--mono-font); font-size: 0.82em; color: var(--text);
      white-space: pre-wrap; word-wrap: break-word;
    }
    .mermaid-error-box details { margin-top: 8px; font-size: 0.82em; }
    .mermaid-error-box summary { cursor: pointer; color: var(--accent); }
    .mermaid-error-src {
      margin-top: 6px; padding: 8px; background: var(--code-bg);
      font-family: var(--mono-font); font-size: 0.78em;
      white-space: pre-wrap; word-wrap: break-word; border-radius: 2px;
    }

    /* Print button icon alignment */
    #print-btn span { font-size: 13px; }

    /* ── @page for window.print() ─────────────────────────────── */
    @page {
      size: var(--page-size, letter);
      margin: var(--page-margin-top, 1in) var(--page-margin-right, 1in)
              var(--page-margin-bottom, 1in) var(--page-margin-left, 1in);
    }

    /* When printing, hide all chrome and paginate from the active source. */
    @media print {
      html, body { overflow: visible !important; height: auto !important; background: #fff !important; }
      .inkwell-toolbar, .run-panel, #pane-pdf, #pane-log, #pane-print, .inkwell-spacer { display: none !important; }
      .inkwell-content, .inkwell-pane.preview-pane { position: static !important; display: block !important; overflow: visible !important; padding: 0 !important; }
      .inkwell-document { zoom: 1 !important; }
      #article-content { max-width: none !important; color: #000 !important; }
    }
    /* When the webview body carries .printing, only the preview pane prints. */
    body.printing .inkwell-toolbar,
    body.printing .run-panel,
    body.printing #pane-pdf,
    body.printing #pane-log,
    body.printing #pane-print {
      display: none !important;
    }
  </style>
</head>
<body>
  <div class="inkwell-wrapper">
    <div class="inkwell-toolbar">
      <button class="inkwell-tab${previewActive}" data-tab="preview">${previewLabel}</button>
      <button class="inkwell-tab" data-tab="print">Print View</button>
      <button class="inkwell-tab${pdfActive}" data-tab="pdf">PDF</button>
      <button class="inkwell-tab" data-tab="log">Log<span class="log-badge" id="log-badge"></span></button>
      <div class="viewer-controls" role="group" aria-label="Draft readability">
        <button id="font-decrease" title="Decrease preview text size" aria-label="Decrease preview text size">A−</button>
        <output id="font-scale" aria-live="polite">100%</output>
        <button id="font-increase" title="Increase preview text size" aria-label="Increase preview text size">A+</button>
        <button id="font-reset" title="Reset preview text size to 100%">Reset</button>
      </div>
      <div class="inkwell-spacer"></div>
      <span class="inkwell-status" id="compile-status"></span>
      <button class="inkwell-compile-btn" id="print-btn" title="Print / Save as PDF">
        <span>&#128424;</span> Print
      </button>
      <button class="inkwell-compile-btn" id="run-btn" title="Run Code Blocks (Cmd+Shift+B)" style="display:none;">
        <span id="run-icon">&#9881;</span> Run
      </button>
      <button class="inkwell-compile-btn" id="compile-btn" title="Compile PDF (Cmd+Shift+R)">
        <span id="compile-icon">&#9654;</span> Compile
      </button>
    </div>
    <div class="run-panel" id="run-panel">
      <div class="run-panel-header">
        <span class="run-panel-title">Run</span>
        <span class="run-panel-summary" id="run-summary"></span>
        <button class="run-cancel-btn" id="run-cancel-btn" style="display:none;">Cancel</button>
        <button class="run-panel-close" id="run-panel-close" title="Close">&times;</button>
      </div>
      <div class="run-block-list" id="run-block-list"></div>
    </div>
    <div class="inkwell-content">
      <div class="inkwell-pane preview-pane${previewActive}" id="pane-preview">
        <div class="document-notice" id="typography-notice" role="status" style="display:none;"></div>
        <article class="inkwell-document" id="article-content"></article>
      </div>
      <div class="inkwell-pane print-pane" id="pane-print">
        <div class="print-page-stage inkwell-document" id="print-page-stage"></div>
      </div>
      <div class="inkwell-pane pdf-pane${pdfActive}" id="pane-pdf">
        <div class="viewer-controls" id="pdf-controls" role="group" aria-label="PDF zoom">
          <label for="pdf-fit-mode">PDF view</label>
          <select id="pdf-fit-mode"><option value="width">Fit width</option><option value="page">Fit page</option><option value="custom">Custom zoom</option></select>
          <label for="pdf-zoom">Zoom</label><input id="pdf-zoom" type="number" min="25" max="400" step="10" value="100" aria-label="PDF zoom percentage"><span>%</span>
        </div>
        <div class="pdf-output-status" id="pdf-output-status" role="status" style="display:none;"></div>
        <div class="pdf-placeholder" id="pdf-placeholder">
          <p>No PDF yet.</p>
          <p>Click <strong>Compile</strong> to build.</p>
        </div>
        <div class="compile-errors" id="compile-errors" style="display:none;"></div>
      </div>
      <div class="inkwell-pane log-pane" id="pane-log">
        <div class="log-toolbar">
          <span class="log-toolbar-title">Output Log</span>
          <button class="log-clear-btn" id="log-clear-btn">Clear</button>
        </div>
        <div class="log-entries" id="log-entries">
          <div class="log-empty">No output yet. Run code blocks or compile to see output here.</div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/python.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/bash.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/sql.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/r.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/typescript.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/julia.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/yaml.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/json.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/latex.min.js"></script>
  <script nonce="${nonce}">
  (function() {
    var vscodeApi = acquireVsCodeApi();
    var viewerApi = (${viewerStateRuntime.toString()})();
    var changeFontScale = viewerApi.changeFontScale;
    var readViewerState = viewerApi.readViewerState;
    var viewerState = readViewerState(vscodeApi.getState ? vscodeApi.getState() : undefined, ${this.viewerState.fontScale}, "${initialTab}");
    var currentTab = viewerState.selectedTab;
    var currentPdfData = null;
    var currentPdfDoc = null;
    var pdfRenderVersion = 0;
    var contentRevision = 0;
    var documentUri = null;
    var sourceVersion = null;
    var currentPdfOutput = null;
    var runId = 0;

    if (typeof pdfjsLib !== "undefined") {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }

    var tabs = document.querySelectorAll(".inkwell-tab");
    var previewPane = document.getElementById("pane-preview");
    var pdfPane = document.getElementById("pane-pdf");
    var printPane = document.getElementById("pane-print");
    var printStage = document.getElementById("print-page-stage");
    var articleEl = document.getElementById("article-content");
    var compileBtn = document.getElementById("compile-btn");
    var compileIcon = document.getElementById("compile-icon");
    var compileStatus = document.getElementById("compile-status");
    var pdfPlaceholder = document.getElementById("pdf-placeholder");
    var pdfOutputStatus = document.getElementById("pdf-output-status");
    var compileErrors = document.getElementById("compile-errors");
    var runBtn = document.getElementById("run-btn");
    var runIcon = document.getElementById("run-icon");
    var runPanel = document.getElementById("run-panel");
    var runSummary = document.getElementById("run-summary");
    var runBlockList = document.getElementById("run-block-list");
    var runCancelBtn = document.getElementById("run-cancel-btn");
    var runPanelClose = document.getElementById("run-panel-close");
    var printBtn = document.getElementById("print-btn");
    var logPane = document.getElementById("pane-log");
    var logEntries = document.getElementById("log-entries");
    var logClearBtn = document.getElementById("log-clear-btn");
    var logBadge = document.getElementById("log-badge");
    var isRunning = false;
    var logErrorCount = 0;
    var docTitle = "";
    var printPaginated = false;

    var STATUS_ICONS = {
      pending: "\\u25CB",
      running: "\\u25F7",
      cached: "\\u21BB",
      done: "\\u2713",
      failed: "\\u2717",
      cancelled: "\\u2014"
    };

    function persistViewerState(notify) {
      if (vscodeApi.setState) vscodeApi.setState(viewerState);
      if (notify !== false) vscodeApi.postMessage({ type: "viewerStateChanged", state: viewerState });
    }

    function applyViewerState(next, notify) {
      var previous = viewerState;
      viewerState = readViewerState(next);
      articleEl.style.zoom = String(viewerState.fontScale / 100);
      printStage.style.zoom = String(viewerState.fontScale / 100);
      document.getElementById("font-scale").textContent = viewerState.fontScale + "%";
      document.getElementById("font-decrease").disabled = viewerState.fontScale <= 50;
      document.getElementById("font-increase").disabled = viewerState.fontScale >= 200;
      document.getElementById("pdf-fit-mode").value = viewerState.pdfFitMode;
      document.getElementById("pdf-zoom").value = String(viewerState.pdfZoom);
      if (viewerState.selectedTab !== currentTab) switchTab(viewerState.selectedTab, false);
      else if (currentTab === "pdf" && currentPdfData && (previous.pdfFitMode !== viewerState.pdfFitMode || previous.pdfZoom !== viewerState.pdfZoom)) renderPdf(currentPdfData);
      persistViewerState(notify);
    }

    ["decrease", "increase", "reset"].forEach(function(action) {
      document.getElementById("font-" + action).addEventListener("click", function() {
        applyViewerState(Object.assign({}, viewerState, { fontScale: changeFontScale(viewerState.fontScale, action) }));
      });
    });
    document.getElementById("pdf-fit-mode").addEventListener("change", function(event) {
      applyViewerState(Object.assign({}, viewerState, { pdfFitMode: event.target.value }));
    });
    document.getElementById("pdf-zoom").addEventListener("change", function(event) {
      applyViewerState(Object.assign({}, viewerState, { pdfFitMode: "custom", pdfZoom: Number(event.target.value) }));
    });

    function switchTab(tab, notify) {
      currentTab = tab;
      viewerState = Object.assign({}, viewerState, { selectedTab: tab });
      persistViewerState(notify);
      tabs.forEach(function(t) {
        t.classList.toggle("active", t.getAttribute("data-tab") === tab);
      });
      previewPane.classList.toggle("active", tab === "preview");
      if (printPane) printPane.classList.toggle("active", tab === "print");
      pdfPane.classList.toggle("active", tab === "pdf");
      logPane.classList.toggle("active", tab === "log");
      if (tab === "pdf" && currentPdfData) {
        renderPdf(currentPdfData);
      }
      if (tab === "print") {
        paginateForPrint();
      }
      if (tab === "log") {
        logErrorCount = 0;
        logBadge.classList.remove("visible");
        logBadge.textContent = "";
      }
    }

    /* Populate #print-page-stage by cloning the article-content and
       splitting children across fixed-height page sheets. Purely visual
       — the original article is never modified. Uses overflow detection
       with getBoundingClientRect after each append. Re-runs on content
       updates and on explicit window resize. */
    function paginateForPrint() {
      if (!printStage || !articleEl) return;
      if (printPaginated) return;

      var source = articleEl.cloneNode(true);
      var children = Array.prototype.slice.call(source.childNodes).filter(function(n) {
        if (n.nodeType === 1) return true;
        if (n.nodeType === 3 && n.textContent.trim()) return true;
        return false;
      });

      printStage.innerHTML = "";
      var pageIndex = 0;
      var page = createPageSheet(++pageIndex);
      printStage.appendChild(page);
      var body = page.querySelector(".page-body");

      function overflowing(el) {
        return el.scrollHeight > el.clientHeight + 2;
      }

      for (var i = 0; i < children.length; i++) {
        var node = children[i].cloneNode(true);
        body.appendChild(node);

        if (overflowing(body)) {
          if (body.childNodes.length === 1) {
            // single oversized element — leave it on its page.
            page = createPageSheet(++pageIndex);
            printStage.appendChild(page);
            body = page.querySelector(".page-body");
          } else {
            body.removeChild(node);
            page = createPageSheet(++pageIndex);
            printStage.appendChild(page);
            body = page.querySelector(".page-body");
            body.appendChild(node);
            if (overflowing(body) && body.childNodes.length === 1) {
              // accept the overflow for single oversized nodes.
            }
          }
        }
      }

      var totalPages = pageIndex;
      printStage.querySelectorAll(".page-sheet").forEach(function(sheet, idx) {
        var ft = sheet.querySelector(".page-footer");
        if (ft) {
          var right = ft.querySelector(".pf-right");
          if (right) right.textContent = (idx + 1) + " / " + totalPages;
        }
      });

      printPaginated = true;
    }

    function createPageSheet(idx) {
      var sheet = document.createElement("div");
      sheet.className = "page-sheet";

      var header = document.createElement("div");
      header.className = "page-header";
      header.innerHTML = '<span class="ph-left">' + esc(docTitle || "") + '</span>' +
        '<span class="ph-right"></span>';
      sheet.appendChild(header);

      var body = document.createElement("div");
      body.className = "page-body";
      sheet.appendChild(body);

      var footer = document.createElement("div");
      footer.className = "page-footer";
      footer.innerHTML = '<span class="pf-left"></span>' +
        '<span class="pf-right">' + idx + '</span>';
      sheet.appendChild(footer);

      return sheet;
    }

    var paginateResizeTimer = null;
    window.addEventListener("resize", function() {
      if (currentTab !== "print" && currentTab !== "pdf") return;
      if (paginateResizeTimer) clearTimeout(paginateResizeTimer);
      paginateResizeTimer = setTimeout(function() {
        if (currentTab === "pdf") { if (currentPdfData) renderPdf(currentPdfData); return; }
        printPaginated = false;
        paginateForPrint();
      }, 300);
    });

    function addLogEntry(tag, tagClass, message, details) {
      var empty = logEntries.querySelector(".log-empty");
      if (empty) empty.remove();

      var now = new Date();
      var ts = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      var entry = document.createElement("div");
      entry.className = "log-entry";

      var header = document.createElement("div");
      header.className = "log-entry-header";
      header.innerHTML = '<span class="log-tag ' + tagClass + '">' + tag + '</span>' +
        '<span>' + ts + '</span>';
      entry.appendChild(header);

      var body = document.createElement("div");
      body.className = "log-entry-body" + (tagClass === "log-tag-error" ? " is-error" : "");
      body.textContent = message;
      entry.appendChild(body);

      if (details && details.trim()) {
        var toggle = document.createElement("button");
        toggle.className = "log-entry-toggle";
        toggle.textContent = "Show details";
        entry.appendChild(toggle);

        var detailsEl = document.createElement("div");
        detailsEl.className = "log-entry-details";
        detailsEl.textContent = details;
        entry.appendChild(detailsEl);

        toggle.addEventListener("click", function() {
          detailsEl.classList.toggle("visible");
          toggle.textContent = detailsEl.classList.contains("visible") ? "Hide details" : "Show details";
        });
      }

      logEntries.appendChild(entry);
      logEntries.scrollTop = logEntries.scrollHeight;

      if (tagClass === "log-tag-error" && currentTab !== "log") {
        logErrorCount++;
        logBadge.textContent = String(logErrorCount);
        logBadge.classList.add("visible");
      }
    }

    function destroyPdf(pdf) {
      if (!pdf) return;
      try { Promise.resolve(pdf.destroy()).catch(function() {}); } catch (e) {}
    }

    function clearPdf() {
      currentPdfData = null;
      currentPdfOutput = null;
      pdfRenderVersion++;
      destroyPdf(currentPdfDoc);
      currentPdfDoc = null;
      var existing = pdfPane.querySelector(".pdf-canvas-container");
      if (existing) existing.remove();
      var embed = pdfPane.querySelector("embed");
      if (embed) embed.remove();
      compileErrors.style.display = "none";
      compileErrors.innerHTML = "";
      pdfOutputStatus.textContent = "";
      pdfOutputStatus.style.display = "none";
      pdfPlaceholder.innerHTML = "<p>No PDF yet.</p><p>Click <strong>Compile</strong> to build.</p>";
      pdfPlaceholder.style.display = "block";
    }

    function labelPdf() {
      if (!currentPdfData) return;
      var label = "Last successful output";
      if (currentPdfOutput) {
        label += " — source version " + currentPdfOutput.sourceVersion +
          " — " + new Date(currentPdfOutput.publishedAt).toLocaleString();
      } else {
        label = "Existing PDF — source version and build time unavailable";
      }
      pdfOutputStatus.textContent = label;
      pdfOutputStatus.style.display = "block";
    }

    function updatePdf(data, output) {
      if (data === null) { clearPdf(); return; }
      if (typeof data !== "string") return;
      currentPdfData = data;
      currentPdfOutput = output || null;
      labelPdf();
      if (currentTab === "pdf") renderPdf(data);
    }

    function resetDocument() {
      articleEl.innerHTML = "";
      document.getElementById("typography-notice").style.display = "none";
      if (printStage) printStage.innerHTML = "";
      printPaginated = false;
      docTitle = "";
      clearPdf();
      runPanel.classList.remove("visible");
      runBlockList.innerHTML = "";
      runSummary.textContent = "";
      runBtn.style.display = "none";
      logEntries.innerHTML = '<div class="log-empty">No output yet.</div>';
      logErrorCount = 0;
      logBadge.classList.remove("visible");
      logBadge.textContent = "";
    }

    function renderPdf(base64Data) {
      currentPdfData = base64Data;
      pdfRenderVersion++;
      var version = pdfRenderVersion;

      pdfPlaceholder.style.display = "none";
      compileErrors.style.display = "none";

      var existing = pdfPane.querySelector(".pdf-canvas-container");
      if (existing) existing.remove();

      if (currentPdfDoc) {
        destroyPdf(currentPdfDoc);
        currentPdfDoc = null;
      }

      if (typeof pdfjsLib === "undefined") {
        pdfPlaceholder.innerHTML = "<p>PDF compiled but viewer failed to load.</p>";
        pdfPlaceholder.style.display = "block";
        return;
      }

      var binary = atob(base64Data);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      var container = document.createElement("div");
      container.className = "pdf-canvas-container";
      pdfPane.appendChild(container);

      pdfjsLib.getDocument({ data: bytes }).promise.then(function(pdf) {
        if (version !== pdfRenderVersion) {
          destroyPdf(pdf);
          return;
        }
        currentPdfDoc = pdf;
        for (var pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          (function(num) {
            pdf.getPage(num).then(function(page) {
              if (version !== pdfRenderVersion) return;
              var natural = page.getViewport({ scale: 1 });
              var widthScale = Math.max(0.1, (pdfPane.clientWidth - 24) / natural.width);
              var scale = viewerState.pdfFitMode === "custom" ? viewerState.pdfZoom / 100 : viewerState.pdfFitMode === "page" ? Math.min(widthScale, Math.max(0.1, (pdfPane.clientHeight - 90) / natural.height)) : widthScale;
              var viewport = page.getViewport({ scale: scale });
              var canvas = document.createElement("canvas");
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              container.appendChild(canvas);
              return page.render({
                canvasContext: canvas.getContext("2d"),
                viewport: viewport
              }).promise;
            }).catch(function(err) {
              if (version !== pdfRenderVersion) return;
              pdfPlaceholder.textContent = "Failed to render PDF page: " + String(err);
              pdfPlaceholder.style.display = "block";
            });
          })(pageNum);
        }
      }).catch(function(err) {
        if (version !== pdfRenderVersion) return;
        pdfPlaceholder.innerHTML = "<p>Failed to render PDF: " + esc(String(err)) + "</p>";
        pdfPlaceholder.style.display = "block";
      });
    }

    function showErrors(errors, log) {
      pdfPlaceholder.style.display = "none";
      var existing = pdfPane.querySelector("embed");
      if (existing) existing.remove();
      var existingCanvas = pdfPane.querySelector(".pdf-canvas-container");
      if (existingCanvas) existingCanvas.remove();

      var html = '<div class="compile-errors-header">' +
        errors.length + ' compilation error' + (errors.length === 1 ? '' : 's') + '</div>';
      errors.forEach(function(e) {
        html += '<div class="compile-error-item">' + esc(e) + '</div>';
      });
      if (log && log.trim()) {
        html += '<div class="compile-log-toggle" id="log-toggle">Show full log</div>';
        html += '<div class="compile-log" id="log-content">' + esc(log) + '</div>';
      }
      compileErrors.innerHTML = html;
      compileErrors.style.display = "block";

      var toggle = document.getElementById("log-toggle");
      var logEl = document.getElementById("log-content");
      if (toggle && logEl) {
        toggle.addEventListener("click", function() {
          logEl.classList.toggle("visible");
          toggle.textContent = logEl.classList.contains("visible") ? "Hide full log" : "Show full log";
        });
      }
    }

    function esc(text) {
      var d = document.createElement("div");
      d.textContent = text;
      return d.innerHTML;
    }

    function highlightCode() {
      if (!articleEl || typeof hljs === "undefined") return;
      articleEl.querySelectorAll("pre code").forEach(function(block) {
        if (block.classList.contains("hljs")) return;
        // Skip mermaid, it's converted separately.
        if (block.className && block.className.indexOf("language-mermaid") !== -1) return;
        try {
          hljs.highlightElement(block);
        } catch (e) {}
      });
    }

    function renderMath() {
      if (typeof renderMathInElement !== "undefined" && articleEl) {
        renderMathInElement(articleEl, {
          ignoredClasses: ["inkwell-table-literal"],
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\\\[", right: "\\\\]", display: true },
            { left: "\\\\(", right: "\\\\)", display: false }
          ],
          throwOnError: false
        });
      }
    }

    var mermaidInited = false;
    var mermaidSvgCache = {};

    /* Normalize common mermaid-v10 syntax quirks in the raw source.
       - <br/> (XHTML self-closing) -> <br> which v10 accepts more reliably.
       - Collapse trailing whitespace that can confuse the parser. */
    function normalizeMermaidSrc(src) {
      return src
        .replace(/<br[^>]*>/g, "<br>")
        .replace(/[ \\t]+$/gm, "")
        .trim();
    }

    var mermaidRenderCounter = 0;

    function renderMermaid() {
      var revision = contentRevision;
      var uri = documentUri;
      if (!articleEl || typeof mermaid === "undefined") return;

      var isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (!mermaidInited) {
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? "dark" : "default",
          securityLevel: "loose",
          flowchart: { htmlLabels: true }
        });
        mermaidInited = true;
      }

      var blocks = Array.prototype.slice.call(
        articleEl.querySelectorAll("code.language-mermaid")
      );

      blocks.forEach(function(block) {
        var pre = block.parentElement;
        if (!pre || !pre.parentNode) return;
        var src = normalizeMermaidSrc(block.textContent || "");

        var wrapper = document.createElement("div");
        wrapper.className = "mermaid";
        wrapper.setAttribute("data-original-src", src);
        pre.parentNode.replaceChild(wrapper, pre);

        var cached = mermaidSvgCache[src];
        if (cached) {
          wrapper.innerHTML = cached;
          wrapper.setAttribute("data-processed", "true");
          return;
        }

        var id = "inkwell-mermaid-" + (++mermaidRenderCounter);
        try {
          var result = mermaid.render(id, src);
          var handleResult = function(r) {
            if (revision !== contentRevision || uri !== documentUri) return;
            var svg = typeof r === "string" ? r : r.svg;
            wrapper.innerHTML = svg;
            wrapper.setAttribute("data-processed", "true");
            if (typeof r !== "string" && r.bindFunctions) {
              try { r.bindFunctions(wrapper); } catch (e) {}
            }
            mermaidSvgCache[src] = svg;
          };
          if (result && typeof result.then === "function") {
            result.then(handleResult).catch(function(err) {
              if (revision !== contentRevision || uri !== documentUri) return;
              renderMermaidError(wrapper, src, err);
            });
          } else {
            handleResult(result);
          }
        } catch (err) {
          renderMermaidError(wrapper, src, err);
        }
      });
    }

    function renderMermaidError(wrapper, src, err) {
      var msg = (err && (err.message || err.str)) || String(err);
      var line = err && err.hash && err.hash.line ? " (line " + err.hash.line + ")" : "";
      wrapper.className = "mermaid mermaid-error";
      wrapper.innerHTML =
        '<div class="mermaid-error-box">' +
          '<div class="mermaid-error-title">Mermaid error' + esc(line) + '</div>' +
          '<div class="mermaid-error-msg">' + esc(msg) + '</div>' +
          '<details><summary>Show source</summary><pre class="mermaid-error-src">' + esc(src) + '</pre></details>' +
        '</div>';
    }

    tabs.forEach(function(t) {
      t.addEventListener("click", function() {
        switchTab(t.getAttribute("data-tab"));
      });
    });

    runBtn.addEventListener("click", function() {
      vscodeApi.postMessage({ type: "run" });
    });

    runCancelBtn.addEventListener("click", function() {
      vscodeApi.postMessage({ type: "cancelRun" });
    });

    runPanelClose.addEventListener("click", function() {
      runPanel.classList.remove("visible");
    });

    logClearBtn.addEventListener("click", function() {
      logEntries.innerHTML = '<div class="log-empty">Log cleared.</div>';
      logErrorCount = 0;
      logBadge.classList.remove("visible");
      logBadge.textContent = "";
    });

    compileBtn.addEventListener("click", function() {
      vscodeApi.postMessage({ type: "compile" });
    });

    function wireCitationScroll() {
      if (!articleEl) return;
      articleEl.querySelectorAll(".citation a[href^='#'], .cross-ref[href^='#']").forEach(function(a) {
        a.addEventListener("click", function(ev) {
          var href = a.getAttribute("href") || "";
          if (!href.startsWith("#")) return;
          var target = articleEl.querySelector(href) || document.querySelector(href);
          if (target) {
            ev.preventDefault();
            target.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        });
      });
    }

    printBtn.addEventListener("click", function() {
      // window.print() is unreliable inside a VS Code webview (the
      // sandbox often swallows the dialog silently), so rebind Print
      // to the same pipeline as the Compile button: pandoc + xelatex
      // produces a real PDF and the extension then switches to the
      // PDF tab to display it. This matches what "print" means for a
      // typeset document anyway.
      vscodeApi.postMessage({ type: "compile" });
    });

    window.addEventListener("message", function(event) {
      var msg = event.data;
      if (msg && msg.type === "viewerState") { applyViewerState(msg.state, false); return; }
      if (!msg || typeof msg.revision !== "number" || typeof msg.documentUri !== "string") return;
      var startsRender = msg.type === "renderStarted" || msg.type === "updateContent";
      if (msg.revision < contentRevision) return;
      if (msg.revision === contentRevision && documentUri !== null && msg.documentUri !== documentUri) return;
      if (!startsRender && (msg.revision !== contentRevision || msg.documentUri !== documentUri)) return;
      if (typeof msg.runId === "number") {
        if (msg.runId < runId) return;
        runId = msg.runId;
      }
      if (startsRender) {
        var changed = documentUri !== msg.documentUri;
        var newer = contentRevision !== msg.revision;
        if (changed) resetDocument();
        if (changed || newer) {
          // Pending old PDF loads and status timers lose authority at once.
          pdfRenderVersion++;
          compileBtn.disabled = false;
          compileIcon.textContent = "\\u25B6";
          compileStatus.textContent = "";
          if (changed || sourceVersion !== msg.sourceVersion) {
            isRunning = false;
            runBtn.disabled = false;
            runIcon.textContent = "\\u2699";
            runCancelBtn.style.display = "none";
            runPanel.classList.remove("visible");
            runBlockList.innerHTML = "";
          }
        }
        documentUri = msg.documentUri;
        sourceVersion = msg.sourceVersion;
        contentRevision = msg.revision;
      }
      if (msg.type === "renderStarted") return;

      if (msg.type === "updateContent") {
        articleEl.innerHTML = msg.html;
        docTitle = msg.title || "";

        var layoutStyleEl = document.getElementById("inkwell-layout-style");
        if (!layoutStyleEl) {
          layoutStyleEl = document.createElement("style");
          layoutStyleEl.id = "inkwell-layout-style";
          document.head.appendChild(layoutStyleEl);
        }
        layoutStyleEl.textContent = msg.layoutCss || "";
        var typographyNotice = document.getElementById("typography-notice");
        typographyNotice.textContent = msg.typographyNotice || "";
        typographyNotice.style.display = msg.typographyNotice ? "block" : "none";

        document.body.className = document.body.className
          .split(" ")
          .filter(function(c) {
            return c && c !== "printing" &&
              c.indexOf("table-style-") !== 0 &&
              c.indexOf("pagestyle-") !== 0 &&
              c !== "table-stripe" &&
              c !== "caption-above" && c !== "caption-below";
          }).join(" ");
        if (msg.bodyClasses && msg.bodyClasses.length) {
          for (var bc = 0; bc < msg.bodyClasses.length; bc++) {
            document.body.classList.add(msg.bodyClasses[bc]);
          }
        }
        highlightCode();
        renderMath();
        renderMermaid();
        wireCitationScroll();
        printPaginated = false;
        if (currentTab === "print") paginateForPrint();
        updatePdf(msg.pdfData, msg.pdfOutput);
        if (msg.hasCodeBlocks) {
          runBtn.style.display = "";
        } else {
          runBtn.style.display = "none";
        }
      } else if (msg.type === "runStarted") {
        isRunning = true;
        runBtn.disabled = true;
        runIcon.textContent = "\\u23F3";
        runCancelBtn.style.display = "";
        runPanel.classList.add("visible");
        runBlockList.innerHTML = "";
        runSummary.textContent = "Starting...";
        addLogEntry("run", "log-tag-run", "Running " + msg.blockCount + " code block" + (msg.blockCount === 1 ? "" : "s") + "...", "");
        for (var bi = 0; bi < msg.blockCount; bi++) {
          var item = document.createElement("div");
          item.className = "run-block-item status-pending";
          item.id = "run-block-" + bi;
          item.innerHTML = '<span class="run-block-icon">' + STATUS_ICONS.pending + '</span>' +
            '<span class="run-block-label">Block ' + (bi + 1) + '</span>' +
            '<span class="run-block-meta"></span>';
          runBlockList.appendChild(item);
        }
      } else if (msg.type === "blockProgress") {
        var el = document.getElementById("run-block-" + msg.index);
        if (el) {
          el.className = "run-block-item status-" + msg.status;
          var iconEl = el.querySelector(".run-block-icon");
          var labelEl = el.querySelector(".run-block-label");
          var metaEl = el.querySelector(".run-block-meta");
          if (iconEl) {
            if (msg.status === "running") {
              iconEl.innerHTML = '<span class="spinner">' + STATUS_ICONS.running + '</span>';
            } else {
              iconEl.textContent = STATUS_ICONS[msg.status] || STATUS_ICONS.pending;
            }
          }
          if (labelEl) labelEl.textContent = msg.label;
          if (metaEl) {
            var nocache = msg.noCache ? " (no-cache)" : "";
            if (msg.status === "cached") metaEl.textContent = "cached";
            else if (msg.elapsed) metaEl.textContent = (msg.elapsed / 1000).toFixed(1) + "s" + nocache;
            else if (msg.status === "running") metaEl.textContent = msg.noCache ? "running (no-cache)" : "running";
          }
          if (msg.error) {
            var errDiv = document.createElement("div");
            errDiv.className = "run-block-error";
            errDiv.textContent = msg.error;
            el.after(errDiv);
            addLogEntry("error", "log-tag-error", "Block " + (msg.index + 1) + " (" + msg.lang + ") failed: " + msg.error, "");
          }
        }
        var doneCount = runBlockList.querySelectorAll(".status-done, .status-cached, .status-failed, .status-cancelled").length;
        runSummary.textContent = doneCount + "/" + msg.total + " blocks";
      } else if (msg.type === "runComplete") {
        isRunning = false;
        runBtn.disabled = false;
        runIcon.textContent = "\\u2699";
        runCancelBtn.style.display = "none";
        var parts = [];
        if (msg.ran) parts.push(msg.ran + " ran");
        if (msg.cached) parts.push(msg.cached + " cached");
        if (msg.failed) parts.push(msg.failed + " failed");
        if (msg.cancelled) parts.push(msg.cancelled + " cancelled");
        var outcomeLabel = msg.outcome === "done" ? "Complete" : msg.outcome === "failed" ? "Errors" : "Cancelled";
        runSummary.textContent = outcomeLabel + ": " + parts.join(", ");
        var logTag = msg.outcome === "done" ? "log-tag-run" : msg.outcome === "failed" ? "log-tag-error" : "log-tag-info";
        addLogEntry("run", logTag, "Run " + outcomeLabel.toLowerCase() + ": " + parts.join(", "), "");
        if (msg.outcome === "done") {
          compileStatus.textContent = "Run done. Compile to update PDF.";
          setTimeout(function() {
            if (msg.revision === contentRevision && msg.documentUri === documentUri) compileStatus.textContent = "";
          }, 6000);
        }
      } else if (msg.type === "compileStarted") {
        compileBtn.disabled = true;
        compileIcon.textContent = "\\u23F3";
        compileStatus.textContent = "Compiling...";
        addLogEntry("compile", "log-tag-compile", "LaTeX compilation started...", "");
      } else if (msg.type === "compileDone") {
        compileBtn.disabled = false;
        compileIcon.textContent = "\\u25B6";
        if (!msg.retainPdf) updatePdf(msg.pdfData, msg.pdfOutput);
        else labelPdf();
        if (msg.success && msg.pdfData) {
          compileStatus.textContent = "Done (" + msg.duration.toFixed(1) + "s)";
          addLogEntry("compile", "log-tag-compile", "PDF compiled successfully (" + msg.duration.toFixed(1) + "s)", "");
          if (currentTab !== "pdf") {
            switchTab("pdf");
          }
        } else if (msg.errors && msg.errors.length) {
          compileStatus.textContent = msg.errors.length + " error(s)";
          for (var ei = 0; ei < msg.errors.length; ei++) {
            addLogEntry("error", "log-tag-error", msg.errors[ei], "");
          }
          addLogEntry("compile", "log-tag-error", "Compilation failed with " + msg.errors.length + " error(s)", msg.log || "");
          if (!currentPdfData) showErrors(msg.errors, msg.log || "");
          switchTab("log");
        } else {
          compileStatus.textContent = "Failed";
          addLogEntry("error", "log-tag-error", "Compilation failed", msg.log || "");
          if (!currentPdfData) showErrors(["Compilation failed. Check the Log tab for details."], msg.log || "");
          switchTab("log");
        }
        setTimeout(function() {
          if (msg.revision === contentRevision && msg.documentUri === documentUri) compileStatus.textContent = "";
        }, 8000);
      } else if (msg.type === "logEntry") {
        var lTag = msg.tag === "error" ? "log-tag-error" : msg.tag === "warn" ? "log-tag-warn" : msg.tag === "run" ? "log-tag-run" : msg.tag === "compile" ? "log-tag-compile" : "log-tag-info";
        addLogEntry(msg.tag, lTag, msg.message, msg.details);
      }
    });

    applyViewerState(viewerState, false);
    switchTab(viewerState.selectedTab, false);
    vscodeApi.postMessage({ type: "ready" });
  })();
  </script>
</body>
</html>`;
  }
}

interface FrontmatterResult {
  body: string;
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  abstract?: string;
  mainfont?: string;
  monofont?: string;
  figPrefix?: string;
  tblPrefix?: string;
  eqnPrefix?: string;
  secPrefix?: string;
  // Layout parity with LaTeX
  geometry?: string;
  papersize?: string;
  fontsize?: string;
  linestretch?: string;
  documentclass?: string;
  pagestyle?: string;
  // Inkwell table options mirrored from src/preamble.ts
  tableStyle?: "booktabs" | "grid" | "plain";
  tableStripe?: boolean;
  tableFontSize?: string;
  captionStyle?: "above" | "below";
  // Inkwell mermaid sizing defaults (apply to all diagrams that don't
  // specify their own {mermaid max-width="..."} attributes)
  mermaidMaxWidth?: string;
  mermaidMaxHeight?: string;
  // Heading and code typography
  headingFont?: string;
  headingColor?: string;
  headingWeight?: string;
  headingScale?: number;
  codeFontSize?: string;
  captionFontSize?: string;
  sectionNumbering?: SectionNumberingStyle;
  // Citations
  bibliography?: string[];
  csl?: string;
  linkCitations?: boolean;
}

/**
 * Section-numbering style for auto-generated heading numbers.
 *
 * - `decimal`: 1 / 1.1 / 1.1.1 (default; matches Pandoc / LaTeX default)
 * - `legal`:   1 / 1.a / 1.a.i / 1.a.i.(1) (outline / legal style)
 * - `none`:    no numbers
 */
type SectionNumberingStyle = "decimal" | "legal" | "none";

export function stripFrontmatter(text: string, config?: DocumentConfig): FrontmatterResult {
  const resolved = config || resolveDocumentConfig({ text });
  const metadata = resolved.compatibility;
  const inkwell = metadata.inkwell && typeof metadata.inkwell === "object" && !Array.isArray(metadata.inkwell)
    ? metadata.inkwell as Record<string, unknown> : {};
  const scalar = (value: unknown): string | undefined => typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  const author = (value: unknown): string | undefined => {
    if (Array.isArray(value)) return value.map(author).filter(Boolean).join(", ");
    if (value && typeof value === "object") return scalar((value as Record<string, unknown>).name);
    return scalar(value);
  };
  const result: FrontmatterResult = { body: resolved.body, author: author(metadata.author) };
  for (const key of ["title", "subtitle", "date", "abstract", "mainfont", "monofont", "figPrefix", "tblPrefix", "eqnPrefix", "secPrefix", "geometry", "papersize", "fontsize", "linestretch", "documentclass", "pagestyle"] as const) {
    result[key] = scalar(metadata[key]);
  }
  const keys = {
    tableFontSize: "table-font-size", mermaidMaxWidth: "mermaid-max-width", mermaidMaxHeight: "mermaid-max-height",
    headingFont: "heading-font", headingColor: "heading-color", headingWeight: "heading-weight",
    codeFontSize: "code-font-size", captionFontSize: "caption-font-size",
  } as const;
  for (const key of Object.keys(keys) as (keyof typeof keys)[]) result[key] = scalar(inkwell[keys[key]]);
  const table = inkwell.tables && typeof inkwell.tables === "object" ? (inkwell.tables as Record<string, unknown>).preset : inkwell.tables;
  if (["booktabs", "grid", "plain"].includes(String(table))) result.tableStyle = table as FrontmatterResult["tableStyle"];
  result.tableStripe = inkwell["table-stripe"] === true;
  if (inkwell["caption-style"] === "above" || inkwell["caption-style"] === "below") result.captionStyle = inkwell["caption-style"];
  if (typeof inkwell["heading-scale"] === "number") result.headingScale = inkwell["heading-scale"];
  const numbering = inkwell["section-numbering"];
  result.sectionNumbering = numbering === "legal" || numbering === "outline" ? "legal" : numbering === "none" || numbering === "off" ? "none" : "decimal";
  result.bibliography = typeof metadata.bibliography === "string" ? [metadata.bibliography] : Array.isArray(metadata.bibliography) ? metadata.bibliography.filter((value): value is string => typeof value === "string") : undefined;
  result.csl = scalar(metadata.csl);
  if (typeof metadata["link-citations"] === "boolean") result.linkCitations = metadata["link-citations"];
  return result;
}

function addDataLineAttrs(html: string): string {
  let lineCounter = 0;
  // Alternation order matters: JavaScript's regex engine takes the
  // FIRST matching alternative, not the longest. If `p` appears before
  // `pre`, the engine matches `<pre>` as `<p` and the replacement
  // corrupts the opening tag to `<p data-line="N"re>`, which the HTML
  // parser then collapses to a `<p>` \u2014 silently converting every code
  // block into a paragraph, losing `white-space: pre`, and making all
  // newlines disappear. Put longer tokens before their prefixes.
  return html.replace(
    /<(pre|h[1-6]|blockquote|table|ul|ol|li|hr|p)(?=[\s>])/g,
    (_match, tag) => {
      lineCounter++;
      return `<${tag} data-line="${lineCounter}"`;
    },
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ── Cross-references and citations ────────────────────────────────────

interface MermaidMeta {
  label?: string;
  caption?: string;
  /** Sanitized CSS dimension values keyed by CSS property (max-width, etc.) */
  sizeStyle?: string;
}

/**
 * Walk ```{mermaid ...} fences in source order. We record size attributes
 * here rather than in inject.ts because normalizeMermaidForPreview strips
 * the attribute block before markdown-it ever sees it; the preview pipeline
 * needs an ordered list to reattach styles to the normalized fences.
 */
function extractMermaidMeta(text: string): MermaidMeta[] {
  const out: MermaidMeta[] = [];
  const re = /^```\{mermaid([^}]*)\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1];
    const labelMatch = attrs.match(/label="([^"]+)"/);
    const captionMatch = attrs.match(/caption="([^"]+)"/);
    const entry: MermaidMeta = {};
    if (labelMatch) {
      entry.label = labelMatch[1];
      entry.caption = captionMatch?.[1] || "Diagram";
    }
    const sizeStyle = parseMermaidSizeAttrs(attrs);
    if (sizeStyle) entry.sizeStyle = sizeStyle;
    out.push(entry);
  }
  return out;
}

/**
 * Accept a handful of size-like attributes on mermaid fences and emit a
 * minimal inline style string. We reject anything that doesn't look like a
 * CSS length/percent to keep the attribute surface small and safe.
 */
function parseMermaidSizeAttrs(attrs: string): string | undefined {
  const keys = ["max-width", "max-height", "width", "height"] as const;
  const styles: string[] = [];
  for (const k of keys) {
    const re = new RegExp(`${k}="([^"]+)"`);
    const m = attrs.match(re);
    if (!m) continue;
    const v = sanitizeCssLength(m[1]);
    if (v) styles.push(`${k}: ${v}`);
  }
  return styles.length ? styles.join("; ") : undefined;
}

function sanitizeCssLength(raw: string): string | undefined {
  const s = raw.trim();
  // Accept numeric lengths with common units, percentages, or bare numbers
  // (treated as px). Reject anything with spaces/semicolons/quotes.
  if (/^[+-]?\d+(\.\d+)?%$/.test(s)) return s;
  if (/^[+-]?\d+(\.\d+)?(px|pt|em|rem|vh|vw|ch|ex|cm|mm|in)$/.test(s)) return s;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return `${s}px`;
  return undefined;
}

/**
 * Format a section counter array into a label string per the chosen
 * numbering style.
 *
 *   decimal (default): [1, 2, 3]     -> "1.2.3"
 *   legal / outline:   [1, 2, 3]     -> "1.b.iii"
 *                      [1, 2, 3, 4]  -> "1.b.iii.(4)"
 *                      [1, 2, 3, 4, 5] -> "1.b.iii.(4).(e)"
 *   none:              [1, 2, 3]     -> ""
 *
 * The legal style uses: uppercase decimal for level 1, lowercase latin
 * for level 2, lowercase roman for level 3, parenthesised decimal for
 * level 4, parenthesised latin for level 5+ (uncommon but preserves
 * distinctness).
 */
function formatSectionNumber(counters: number[], style: SectionNumberingStyle): string {
  const active = counters.filter((n) => n > 0);
  if (!active.length) return "";
  if (style === "none") return "";
  if (style === "decimal") return active.join(".");
  // legal / outline
  const parts: string[] = [];
  for (let i = 0; i < active.length; i++) {
    const n = active[i];
    if (i === 0) parts.push(String(n));
    else if (i === 1) parts.push(latinLower(n));
    else if (i === 2) parts.push(romanLower(n));
    else if (i === 3) parts.push(`(${n})`);
    else parts.push(`(${latinLower(n)})`);
  }
  return parts.join(".");
}

function latinLower(n: number): string {
  // 1 -> a, 2 -> b, ..., 26 -> z, 27 -> aa, 28 -> ab, ...
  if (n <= 0) return "";
  let s = "";
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    s = String.fromCharCode(97 + rem) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

function romanLower(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
    [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let v = n;
  let out = "";
  for (const [val, sym] of table) {
    while (v >= val) { out += sym; v -= val; }
  }
  return out;
}

function resolveReferences(
  body: string,
  mermaidMeta: MermaidMeta[],
  prefixes: { fig: string; tbl: string; eqn: string; sec: string },
  sectionNumbering: SectionNumberingStyle = "decimal",
  tableLabels: ReadonlyMap<string, string> = new Map(),
): string {
  const labels = new Map<string, string>(tableLabels);
  const secNums = [0, 0, 0, 0, 0, 0];
  let figNum = 0;
  let eqNum = 0;

  // Headers: # Title {#sec:label} -> numbered anchor + clean heading.
  // NB: use [ \t]* for the surrounding whitespace rather than \s* —
  // \s matches \n and, with /m, a greedy \s*$ eats the blank line
  // after the heading and glues the heading into whatever block
  // follows (list, paragraph, table). That causes markdown-it to
  // render both as a single run of text.
  let result = body.replace(
    /^(#{1,6})\s+(.*?)[ \t]*\{#([\w:.-]+)\}[ \t]*$/gm,
    (_, hashes: string, title: string, label: string) => {
      if (label.startsWith("sec:")) {
        const level = hashes.length - 1;
        secNums[level]++;
        for (let i = level + 1; i < secNums.length; i++) secNums[i] = 0;
        const num = formatSectionNumber(secNums.slice(0, level + 1), sectionNumbering);
        if (num) labels.set(label, `${prefixes.sec}\u00a0${num}`);
        else labels.set(label, prefixes.sec);
      }
      return `${hashes} <a id="${label}"></a>${title}`;
    },
  );

  // Image figure labels: ![cap](src){#fig:label}. The attribute block may
  // carry more than the identifier (e.g. {#fig:label width=80%} or
  // {width=80% #fig:label}) — pandoc numbers those figures in the PDF, so
  // the preview must register them too, not just the bare-label form.
  result = result.replace(
    /!\[([^\]]*)\]\(([^)]+)\)\{([^}]*)\}/g,
    (full: string, caption: string, src: string, attrs: string) => {
      const labelMatch = attrs.match(/#(fig:[\w:.-]+)/);
      if (!labelMatch) return full;
      const label = labelMatch[1];
      figNum++;
      labels.set(label, `${prefixes.fig}\u00a0${figNum}`);
      return `<a id="${label}"></a>\n\n![${prefixes.fig} ${figNum}: ${caption}](${src})`;
    },
  );

  // Mermaid diagram labels + optional size wrappers. The order of
  // ```mermaid fences in the normalized body matches the order of
  // ```{mermaid ...} fences in the source, so we walk the two in lockstep.
  let mermaidIdx = 0;
  result = result.replace(/^(```mermaid\s*\n[\s\S]*?^```)/gm, (block) => {
    const meta: MermaidMeta | undefined = mermaidMeta[mermaidIdx++];
    if (!meta) return block;

    const pieces: string[] = [];
    if (meta.label) {
      const label = `fig:${meta.label}`;
      if (!labels.has(label)) {
        figNum++;
        labels.set(label, `${prefixes.fig}\u00a0${figNum}`);
      }
      pieces.push(`<a id="${label}"></a>`);
      pieces.push("");
    }
    if (meta.sizeStyle) {
      // Wrap in a sized frame. The blank lines around the fence are
      // required so markdown-it still parses the inner code block.
      pieces.push(`<div class="mermaid-frame" style="${meta.sizeStyle}">`);
      pieces.push("");
      pieces.push(block);
      pieces.push("");
      pieces.push("</div>");
      return pieces.join("\n");
    }
    pieces.push(block);
    return pieces.join("\n");
  });

  // Equation labels: $$ ... $$ {#eq:label}
  result = result.replace(
    /(\$\$[\s\S]*?\$\$)\s*\{#(eq:[\w:.-]+)\}/g,
    (_, equation: string, label: string) => {
      eqNum++;
      labels.set(label, `${prefixes.eqn}\u00a0(${eqNum})`);
      return `<a id="${label}"></a>\n\n${equation}`;
    },
  );

  // Replace @type:label references with clickable links (case-insensitive)
  result = result.replace(
    /@(fig|sec|tbl|eq):([\w:.-]+)/gi,
    (_, type: string, id: string) => {
      const label = `${type.toLowerCase()}:${id}`;
      const display = labels.get(label) || `${type.toLowerCase()}:${id}`;
      return `<a href="#${label}" class="cross-ref">${display}</a>`;
    },
  );

  return result;
}

interface LayoutPayload {
  typographyNotice?: string;
  cssText: string;
  bodyClasses: string[];
}

function buildLayoutStyle(fm: FrontmatterResult, config: DocumentConfig): LayoutPayload {
  const vars: string[] = [];

  const paper = parsePaperSize(fm.papersize);
  if (paper) {
    vars.push(`--page-width: ${paper.width}`);
    vars.push(`--page-height: ${paper.height}`);
    vars.push(`--page-size: ${paper.cssSize}`);
  }

  const margins = parseGeometry(fm.geometry);
  vars.push(`--page-margin-top: ${margins.top}`);
  vars.push(`--page-margin-right: ${margins.right}`);
  vars.push(`--page-margin-bottom: ${margins.bottom}`);
  vars.push(`--page-margin-left: ${margins.left}`);

  const mmw = fm.mermaidMaxWidth ? sanitizeCssLength(fm.mermaidMaxWidth) : undefined;
  if (mmw) vars.push(`--mermaid-max-width: ${mmw}`);
  const mmh = fm.mermaidMaxHeight ? sanitizeCssLength(fm.mermaidMaxHeight) : undefined;
  if (mmh) vars.push(`--mermaid-max-height: ${mmh}`);

  const tableStyle = fm.tableStyle || "booktabs";
  vars.push(`--table-style: "${tableStyle}"`);
  if (fm.tableStripe) {
    vars.push(`--table-stripe-bg: var(--code-bg)`);
  } else {
    vars.push(`--table-stripe-bg: transparent`);
  }

  const bodyClasses: string[] = [];
  bodyClasses.push(`table-style-${tableStyle}`);
  if (fm.tableStripe) bodyClasses.push("table-stripe");
  if (fm.captionStyle === "above") bodyClasses.push("caption-above");
  else bodyClasses.push("caption-below");
  if (fm.pagestyle) bodyClasses.push(`pagestyle-${fm.pagestyle.replace(/[^\w-]/g, "")}`);
  bodyClasses.push(`section-numbering-${fm.sectionNumbering || "decimal"}`);

  vars.push(buildTypographyCss(config));
  vars.push("--body-font: var(--inkwell-body-font)", "--mono-font: var(--inkwell-mono-font)", "--heading-font: var(--inkwell-heading-font)",
    "--base-size: var(--inkwell-body-size)", "--line-height: var(--inkwell-line-spacing)", "--code-font-size: var(--inkwell-code-size)",
    "--table-font-size: var(--inkwell-table-size)", "--caption-font-size: var(--inkwell-caption-size)",
    "--heading-color: var(--inkwell-heading-color)", "--heading-weight: var(--inkwell-heading-weight)");
  const cssText = `.inkwell-document { ${vars.join("; ")}; }`;
  return { cssText, bodyClasses, typographyNotice: config.capabilities.typographyNotice || resolveTypography(config).approximation };
}

interface PaperSize {
  width: string;
  height: string;
  cssSize: string;
}

function parsePaperSize(raw: string | undefined): PaperSize | undefined {
  if (!raw) return { width: "8.5in", height: "11in", cssSize: "letter" };
  const s = raw.trim().toLowerCase();
  const known: Record<string, PaperSize> = {
    letter: { width: "8.5in", height: "11in", cssSize: "letter" },
    letterpaper: { width: "8.5in", height: "11in", cssSize: "letter" },
    legal: { width: "8.5in", height: "14in", cssSize: "legal" },
    legalpaper: { width: "8.5in", height: "14in", cssSize: "legal" },
    a4: { width: "210mm", height: "297mm", cssSize: "A4" },
    a4paper: { width: "210mm", height: "297mm", cssSize: "A4" },
    a5: { width: "148mm", height: "210mm", cssSize: "A5" },
    a5paper: { width: "148mm", height: "210mm", cssSize: "A5" },
    b5: { width: "176mm", height: "250mm", cssSize: "B5" },
    executive: { width: "7.25in", height: "10.5in", cssSize: "7.25in 10.5in" },
  };
  return known[s] || { width: "8.5in", height: "11in", cssSize: "letter" };
}

interface Margins { top: string; right: string; bottom: string; left: string; }

function parseGeometry(raw: string | undefined): Margins {
  const defaults: Margins = { top: "1in", right: "1in", bottom: "1in", left: "1in" };
  if (!raw) return defaults;

  const margins: Margins = { ...defaults };
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    const val = p.slice(eq + 1).trim();
    if (!val) continue;
    switch (key) {
      case "margin":
        margins.top = margins.right = margins.bottom = margins.left = val;
        break;
      case "top": case "tmargin":
        margins.top = val; break;
      case "bottom": case "bmargin":
        margins.bottom = val; break;
      case "left": case "lmargin": case "inner":
        margins.left = val; break;
      case "right": case "rmargin": case "outer":
        margins.right = val; break;
      case "hmargin":
        margins.left = margins.right = val; break;
      case "vmargin":
        margins.top = margins.bottom = val; break;
    }
  }
  return margins;
}

const INKWELL_REFS_SLOT = "<!--INKWELL-REFS-SLOT-->";

/**
 * Assemble the final References section HTML.
 *
 * Pandoc normally emits a `<div id="refs">` block that we pick up via
 * `citeResult.referencesHtml`. But when EVERY cited key is missing from
 * the configured bibliography, pandoc emits no references block at
 * all, which leaves the author staring at a document whose cites look
 * broken and with no explanation why. Synthesize a fallback section
 * that lists each unresolved key under the "References" heading with
 * an italic "(not in bibliography)" marker, so the user sees where a
 * real entry is expected and what key is missing.
 *
 * When there are no citations in the document at all, return `""`:
 * the author did not ask for a References section and we should not
 * conjure one.
 */
function buildReferencesSection(
  r: Pick<CitationRenderResult, "referencesHtml" | "resolvedKeys" | "missingKeys">,
): string {
  if (r.referencesHtml && r.referencesHtml.trim()) {
    return r.referencesHtml;
  }
  if (r.missingKeys.size === 0 && r.resolvedKeys.size === 0) {
    return "";
  }
  const items = [...r.missingKeys].sort().map((key) => {
    const safeKey = escapeHtml(key);
    return `<div class="csl-entry citation-missing" id="ref-${safeKey}"><strong>${safeKey}</strong> <em>(not in bibliography)</em></div>`;
  }).join("\n");
  return [
    '<section class="references-section references-stub">',
    '<h2 class="references-heading">References</h2>',
    '<p class="references-stub-note"><em>Bibliography resolved 0 of ',
    String(r.missingKeys.size + r.resolvedKeys.size),
    ' citations. Add the following entries to your <code>.bib</code> file:</em></p>',
    '<div class="csl-bib-body">',
    items,
    '</div>',
    '</section>',
  ].join("");
}

/**
 * Pandoc-citeproc renders missing citations as `(<strong>key?</strong>)`
 * inside a `<span class="citation-missing">` (or, for bracketed groups,
 * without that class). That bold-with-question-mark styling reads as an
 * error; a softer `[key]` in italic gray with the `.citation-missing`
 * class applied uniformly is easier to scan and makes it obvious the
 * reference is pending rather than broken.
 */
function softenMissingCitations(html: string): string {
  // Replace `<strong>key?</strong>` inside any .citation span with a
  // cleaner `[key]` marker. The outer span keeps its data-cites attr
  // so click-to-scroll and cache keying still work.
  return html.replace(
    /(<span[^>]*class="[^"]*citation[^"]*"[^>]*>)([\s\S]*?)(<\/span>)/g,
    (_m, open: string, inner: string, close: string) => {
      const replaced = inner.replace(
        /<strong>([^<]+?)\?<\/strong>/g,
        (_, key: string) => `<em class="citation-missing-inline">[${escapeHtml(key)}]</em>`,
      );
      const wasMissing = replaced !== inner;
      const openAdj = wasMissing && !/citation-missing/.test(open)
        ? open.replace(/class="([^"]*)"/, 'class="$1 citation-missing"')
        : open;
      return openAdj + replaced + close;
    },
  );
}

/**
 * Hide LaTeX typesetting-only directives from the preview while leaving
 * the source markdown unchanged (the compile pipeline still sees them).
 *
 * - Structural page breaks (`\newpage`, `\clearpage`, `\pagebreak`) are
 *   replaced with a raw HTML `<hr class="page-break-marker">` surrounded
 *   by blank lines so markdown-it treats it as an HTML block. A CSS
 *   rule styles the marker as a faint dashed rule with a "page break"
 *   label, which is removed in the print view so the actual page-sheet
 *   pagination does not collide with a decorative marker.
 * - Cosmetic spacing commands (`\vspace{..}`, `\hspace{..}`, `\vfill`,
 *   `\hfill`, `\bigskip`, `\medskip`, `\smallskip`, `\noindent`, `\par`)
 *   are stripped entirely. They have no preview representation and
 *   would otherwise surface as literal text.
 */
function maskLatexTypesettingDirectives(body: string): string {
  let out = body;

  // Page-break family -> visual marker.
  out = out.replace(
    /^[ \t]*\\(?:newpage|clearpage|cleardoublepage|pagebreak(?:\[\d+\])?)[ \t]*$/gm,
    "\n\n<hr class=\"page-break-marker\">\n\n",
  );

  // Cosmetic spacing / layout directives -> drop.
  const droppable: RegExp[] = [
    /^[ \t]*\\nopagebreak(?:\[\d+\])?[ \t]*$/gm,
    /^[ \t]*\\vfill[ \t]*$/gm,
    /^[ \t]*\\hfill[ \t]*$/gm,
    /^[ \t]*\\(?:big|med|small)skip[ \t]*$/gm,
    /^[ \t]*\\vspace\*?\{[^}]*\}[ \t]*$/gm,
    /^[ \t]*\\hspace\*?\{[^}]*\}[ \t]*$/gm,
    /^[ \t]*\\noindent[ \t]*$/gm,
    /^[ \t]*\\par[ \t]*$/gm,
    /^[ \t]*\\null[ \t]*$/gm,
  ];
  for (const re of droppable) out = out.replace(re, "");

  return out;
}

/**
 * Replace math spans (`$$...$$`, `\[...\]`, inline `$...$`, `\(...\)`)
 * with placeholder tokens that survive markdown-it intact, and return a
 * `restore` function that swaps the placeholders back with the original
 * source in the rendered HTML.
 *
 * Without shielding, markdown-it interprets `\_`, `\*`, unmatched `_`,
 * etc. inside math as emphasis or escape sequences, so KaTeX receives
 * corrupted input and renders the expression as a red error string.
 *
 * The placeholder uses letters only so markdown-it cannot split it with
 * its escape / emphasis rules. Inline math is wrapped in a span so
 * markdown-it's paragraph detection sees a non-empty line where the
 * math would otherwise be; block math ($$...$$ on its own) is left as a
 * bare token so it ends up in its own paragraph, matching KaTeX's
 * display-mode requirement.
 */
function shieldMathForMarkdown(body: string): {
  shielded: string;
  restore: (html: string) => string;
} {
  const slots: string[] = [];
  const tokenFor = (raw: string, inline: boolean): string => {
    const idx = slots.length;
    slots.push(raw);
    const marker = `INKWELLMATHPLACEHOLDER${idx}ENDMATH`;
    if (inline) {
      return `<span data-inkwell-math="${idx}">${marker}</span>`;
    }
    // Block math: wrap in a raw-HTML `<div>` with surrounding blank
    // lines so markdown-it treats it as an HTML block and does not
    // wrap it in `<p>`. KaTeX's display-mode renderer emits a
    // block-level `<span class="katex-display">`; nesting that inside
    // a `<p>` makes the browser auto-close the paragraph and breaks
    // the centering / vertical spacing.
    return `\n\n<div class="math-display" data-inkwell-math="${idx}">${marker}</div>\n\n`;
  };

  // Order matters: block forms first so inline `$` does not swallow
  // half of a `$$...$$` span.
  let shielded = body.replace(/\$\$[\s\S]+?\$\$/g, (m) => tokenFor(m, false));
  shielded = shielded.replace(/\\\[[\s\S]+?\\\]/g, (m) => tokenFor(m, false));
  shielded = shielded.replace(/\\\([\s\S]+?\\\)/g, (m) => tokenFor(m, true));
  // Inline `$...$`: require non-whitespace adjacent to the delimiters
  // so dollar signs in prose ("costs $5 and $10") do not trigger.
  shielded = shielded.replace(
    /(^|[^\\$])\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\d)/g,
    (_m, pre: string, inner: string) => pre + tokenFor(`$${inner}$`, true),
  );

  const restore = (html: string): string => {
    // Restore only wrappers created here. Literal generated cells and source
    // notices may contain the same marker text and must remain unchanged.
    return html.replace(/(<(?:span|div)(?: class="math-display")? data-inkwell-math="(\d+)">)INKWELLMATHPLACEHOLDER\2ENDMATH(<\/(?:span|div)>)/g,
      (match, opening: string, n: string, closing: string) => {
        const raw = slots[Number(n)];
        return raw === undefined ? match : opening + escapeHtml(raw) + closing;
      });
  };

  return { shielded, restore };
}
