// Side-panel preview. Renders the markdown as HTML (with KaTeX math
// and Mermaid diagrams), displays compiled PDFs inline via pdf.js, and
// exposes a run-progress panel that streams block-by-block status back
// from the runner. Communication with the webview is message-based;
// the host pushes content and the webview posts compile/run requests.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import MarkdownIt from "markdown-it";
import { compile, CompileResult, detectMode, isCompilable } from "./compiler";
import { InkwellDiagnostics } from "./diagnostics";
import { parseCodeBlocks, BlockProgress } from "./runner";
import { prepareForPreview } from "./inject";

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
  private outputChannel: vscode.OutputChannel;
  private initialized = false;
  onRun?: () => Promise<void>;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel("Inkwell LaTeX");
  }

  setDiagnostics(diagnostics: InkwellDiagnostics): void {
    this.diagnostics = diagnostics;
  }

  getDocument(): vscode.TextDocument | undefined {
    return this.currentDocument;
  }

  notifyBlocksRan(): void {
    if (!this.panel || !this.initialized) return;
    if (this.currentDocument) {
      this.sendContentUpdate(this.currentDocument);
    }
  }

  sendRunStarted(blockCount: number): void {
    if (!this.panel || !this.initialized) return;
    this.panel.webview.postMessage({ type: "runStarted", blockCount });
  }

  sendBlockProgress(progress: BlockProgress): void {
    if (!this.panel || !this.initialized) return;
    this.panel.webview.postMessage({ type: "blockProgress", ...progress });
  }

  sendRunComplete(
    outcome: "done" | "failed" | "cancelled",
    ran: number, cached: number, cancelled?: number, failed?: number
  ): void {
    if (!this.panel || !this.initialized) return;
    this.panel.webview.postMessage({
      type: "runComplete", outcome, ran, cached,
      cancelled: cancelled || 0, failed: failed || 0,
    });
  }

  sendLogEntry(tag: string, message: string, details?: string): void {
    if (!this.panel || !this.initialized) return;
    this.panel.webview.postMessage({
      type: "logEntry", tag, message, details: details || "",
    });
  }

  show(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isCompilable(editor.document)) {
      vscode.window.showWarningMessage("Open a markdown or LaTeX file first.");
      return;
    }

    this.currentDocument = editor.document;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.sendContentUpdate(editor.document);
      return;
    }

    const docDir = path.dirname(editor.document.uri.fsPath);

    const inkwellOutputDir = path.join(docDir, ".inkwell", "outputs");

    this.panel = vscode.window.createWebviewPanel(
      "inkwellPreview",
      "Inkwell Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, "media")),
          vscode.Uri.file(docDir),
          vscode.Uri.file(inkwellOutputDir),
        ],
        retainContextWhenHidden: true,
      }
    );

    this.initialized = false;

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.currentDocument = undefined;
      this.initialized = false;
      for (const d of this.disposables) d.dispose();
      this.disposables = [];
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "compile") {
        await this.handleCompile();
      } else if (msg.type === "run") {
        if (this.onRun) {
          await this.onRun();
        }
      } else if (msg.type === "cancelRun") {
        await vscode.commands.executeCommand("inkwell.cancelRun");
      } else if (msg.type === "ready") {
        this.initialized = true;
        this.sendContentUpdate(editor.document);
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

    const changeEditor = vscode.window.onDidChangeActiveTextEditor((e) => {
      if (this.panel && e && isCompilable(e.document)) {
        this.currentDocument = e.document;
        this.updateResourceRoots(e.document);
        this.sendContentUpdate(e.document);
      }
    });

    this.disposables.push(changeDoc, changeEditor);

    const isTeX = detectMode(editor.document) === "xelatex";
    this.panel.webview.html = this.buildShell(this.panel.webview, isTeX);
  }

  private updateResourceRoots(document: vscode.TextDocument): void {
    if (!this.panel) return;
    const docDir = path.dirname(document.uri.fsPath);
    (this.panel as any).webview.options = {
      ...this.panel.webview.options,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
        vscode.Uri.file(docDir),
        vscode.Uri.file(path.join(docDir, ".inkwell", "outputs")),
      ],
    };
  }

  private sendContentUpdate(document: vscode.TextDocument): void {
    if (!this.panel || !this.initialized) return;

    const text = document.getText();
    const sourceFile = document.uri.fsPath;
    const mode = detectMode(document);
    const isTeX = mode === "xelatex";

    let htmlBody: string;
    let title: string | undefined;

    if (isTeX) {
      htmlBody = `<pre><code>${escapeHtml(text)}</code></pre>`;
      const titleMatch = text.match(/\\title\{([^}]+)\}/);
      title = titleMatch ? titleMatch[1] : undefined;
    } else {
      const mermaidLabels = extractMermaidLabels(text);
      const injected = prepareForPreview(text, sourceFile);
      const fm = stripFrontmatter(injected);

      const prefixes = {
        fig: fm.figPrefix || "Figure",
        tbl: fm.tblPrefix || "Table",
        eqn: fm.eqnPrefix || "Equation",
        sec: fm.secPrefix || "Section",
      };
      let body = resolveReferences(fm.body, mermaidLabels, prefixes);
      body = resolveCitations(body);
      // Strip any remaining Pandoc header attributes not caught above
      body = body.replace(/\s*\{[#.][\w:. -]+\}\s*$/gm, "");
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
      // Convert raw LaTeX table environments to HTML for preview
      body = convertLatexTables(body);

      let rendered = md.render(body);
      rendered = this.convertLocalImages(rendered, document);
      htmlBody = addDataLineAttrs(rendered);
      title = fm.title;

      const fontStyle = buildFontOverrides(fm);
      if (fontStyle) {
        htmlBody = fontStyle + htmlBody;
      }

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
    }

    const baseName = path.basename(sourceFile, path.extname(sourceFile));
    const pdfPath = path.join(path.dirname(sourceFile), `${baseName}.pdf`);
    let existingPdfData: string | undefined;
    if (fs.existsSync(pdfPath)) {
      existingPdfData = fs.readFileSync(pdfPath).toString("base64");
    }

    const blocks = isTeX ? [] : parseCodeBlocks(text);
    const hasCodeBlocks = blocks.length > 0;

    this.panel.title = title || path.basename(sourceFile);
    this.panel.webview.postMessage({
      type: "updateContent",
      html: htmlBody,
      pdfData: existingPdfData || null,
      isTeX,
      hasCodeBlocks,
      blockCount: blocks.length,
    });
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
    this.throttle = setTimeout(() => this.sendContentUpdate(document), 150);
  }

  private async handleCompile(): Promise<void> {
    if (!this.panel || !this.currentDocument) return;

    this.panel.webview.postMessage({ type: "compileStarted" });

    const result = await compile(this.currentDocument);

    this.outputChannel.clear();
    this.outputChannel.appendLine(
      `Inkwell compile: ${this.currentDocument.uri.fsPath}`
    );
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
      this.diagnostics.report(this.currentDocument.uri, result.errors);
    }

    if (result.success && result.pdfPath && this.panel) {
      const pdfData = fs.readFileSync(result.pdfPath).toString("base64");
      this.panel.webview.postMessage({
        type: "compileDone",
        pdfData,
        duration: result.duration,
        errors: [],
        log: "",
      });
      const warnings = result.errors.filter(e => e.severity === "warning");
      for (const w of warnings) {
        const loc = w.line ? `line ${w.line}: ` : "";
        this.sendLogEntry("warn", `${loc}${w.message}`);
      }
    } else if (this.panel) {
      this.panel.webview.postMessage({
        type: "compileDone",
        pdfUri: null,
        duration: result.duration,
        errors: result.errors.map((e) => {
          const loc = e.line ? `Line ${e.line}: ` : "";
          return `${loc}${e.message}`;
        }),
        log: result.log,
      });
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
    const jsUri = mediaUri("preview.js");
    const nonce = getNonce();

    const previewLabel = defaultToPdf ? "Source" : "Preview";
    const previewActive = defaultToPdf ? "" : " active";
    const pdfActive = defaultToPdf ? " active" : "";
    const initialTab = defaultToPdf ? "pdf" : "preview";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net;
      font-src https://cdn.jsdelivr.net;
      script-src 'nonce-${nonce}' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;
      worker-src blob:;
      img-src ${webview.cspSource} data: https:;
      object-src ${webview.cspSource};
      frame-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
  <link rel="stylesheet" href="${cssUri}">
  <style>
    :root {
      --body-font: Georgia, 'Palatino Linotype', 'Book Antiqua', Palatino, serif;
      --heading-font: var(--body-font);
      --mono-font: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      --base-size: 16px;
      --line-height: 1.5;
      --content-width: 100%;
      --paragraph-spacing: 0.8em;
      --hr-display: block;
    }
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    .mermaid { text-align: center; margin: 1.5em 0; }

    .inkwell-toolbar {
      display: flex; align-items: center; height: 36px;
      padding: 0 8px; background: var(--code-bg);
      border-bottom: 1px solid var(--border); gap: 2px;
      flex-shrink: 0; user-select: none;
    }
    .inkwell-tab {
      padding: 4px 12px; font-size: 12px; font-weight: 500;
      border: none; background: transparent; color: var(--blockquote);
      cursor: pointer; border-radius: 4px; font-family: var(--body-font);
    }
    .inkwell-tab:hover { background: var(--border); }
    .inkwell-tab.active { background: var(--accent); color: #fff; }
    .inkwell-spacer { flex: 1; }
    .inkwell-compile-btn {
      padding: 3px 10px; font-size: 11px; font-weight: 500;
      border: 1px solid var(--border); background: transparent;
      color: var(--text); cursor: pointer; border-radius: 4px;
      font-family: var(--body-font); display: flex; align-items: center; gap: 4px;
    }
    .inkwell-compile-btn:hover { background: var(--border); }
    .inkwell-compile-btn:disabled { opacity: 0.5; cursor: default; }
    .inkwell-status { font-size: 11px; color: var(--blockquote); margin-right: 8px; }

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
      display: flex; flex-direction: column; align-items: center; gap: 8px;
    }
    .pdf-canvas-container canvas {
      box-shadow: 0 2px 8px rgba(0,0,0,0.15); max-width: 100%;
    }
    .pdf-placeholder { text-align: center; color: var(--blockquote); font-size: 14px; padding: 40px; }
    .pdf-placeholder p { margin: 8px 0; }

    .compile-errors {
      width: 100%; max-height: 100%; overflow-y: auto; padding: 16px 24px;
      font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6;
    }
    .compile-errors-header {
      font-family: var(--body-font); font-weight: 600; font-size: 13px;
      color: #e05252; margin-bottom: 12px;
    }
    .compile-error-item {
      padding: 6px 10px; margin-bottom: 4px;
      background: rgba(224, 82, 82, 0.08); border-left: 3px solid #e05252;
      border-radius: 2px; color: var(--text); word-wrap: break-word;
    }
    .compile-log-toggle {
      margin-top: 16px; font-family: var(--body-font); font-size: 12px;
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
      font-family: var(--body-font); font-size: 12px;
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
      cursor: pointer; border-radius: 3px; font-family: var(--body-font);
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
      border-radius: 3px; font-family: var(--body-font);
    }
    .log-clear-btn:hover { background: var(--border); }
    .log-entries {
      flex: 1; overflow-y: auto; padding: 8px 0;
      font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5;
    }
    .log-empty { padding: 40px 16px; text-align: center; color: var(--blockquote); font-family: var(--body-font); font-size: 13px; }
    .log-entry { padding: 4px 16px; border-bottom: 1px solid rgba(128,128,128,0.08); }
    .log-entry:last-child { border-bottom: none; }
    .log-entry-header {
      display: flex; align-items: center; gap: 6px; margin-bottom: 2px;
      font-family: var(--body-font); font-size: 10px; color: var(--blockquote);
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
      font-family: var(--body-font); font-size: 10px; color: var(--accent);
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
  </style>
</head>
<body>
  <div class="inkwell-wrapper">
    <div class="inkwell-toolbar">
      <button class="inkwell-tab${previewActive}" data-tab="preview">${previewLabel}</button>
      <button class="inkwell-tab${pdfActive}" data-tab="pdf">PDF</button>
      <button class="inkwell-tab" data-tab="log">Log<span class="log-badge" id="log-badge"></span></button>
      <div class="inkwell-spacer"></div>
      <span class="inkwell-status" id="compile-status"></span>
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
        <article id="article-content"></article>
      </div>
      <div class="inkwell-pane pdf-pane${pdfActive}" id="pane-pdf">
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
  <script nonce="${nonce}">
  (function() {
    var vscodeApi = acquireVsCodeApi();
    var currentTab = "${initialTab}";
    var currentPdfData = null;
    var currentPdfDoc = null;
    var pdfRenderVersion = 0;

    if (typeof pdfjsLib !== "undefined") {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }

    var tabs = document.querySelectorAll(".inkwell-tab");
    var previewPane = document.getElementById("pane-preview");
    var pdfPane = document.getElementById("pane-pdf");
    var articleEl = document.getElementById("article-content");
    var compileBtn = document.getElementById("compile-btn");
    var compileIcon = document.getElementById("compile-icon");
    var compileStatus = document.getElementById("compile-status");
    var pdfPlaceholder = document.getElementById("pdf-placeholder");
    var compileErrors = document.getElementById("compile-errors");
    var runBtn = document.getElementById("run-btn");
    var runIcon = document.getElementById("run-icon");
    var runPanel = document.getElementById("run-panel");
    var runSummary = document.getElementById("run-summary");
    var runBlockList = document.getElementById("run-block-list");
    var runCancelBtn = document.getElementById("run-cancel-btn");
    var runPanelClose = document.getElementById("run-panel-close");
    var logPane = document.getElementById("pane-log");
    var logEntries = document.getElementById("log-entries");
    var logClearBtn = document.getElementById("log-clear-btn");
    var logBadge = document.getElementById("log-badge");
    var isRunning = false;
    var logErrorCount = 0;

    var STATUS_ICONS = {
      pending: "\\u25CB",
      running: "\\u25F7",
      cached: "\\u21BB",
      done: "\\u2713",
      failed: "\\u2717",
      cancelled: "\\u2014"
    };

    function switchTab(tab) {
      currentTab = tab;
      tabs.forEach(function(t) {
        t.classList.toggle("active", t.getAttribute("data-tab") === tab);
      });
      previewPane.classList.toggle("active", tab === "preview");
      pdfPane.classList.toggle("active", tab === "pdf");
      logPane.classList.toggle("active", tab === "log");
      if (tab === "pdf" && currentPdfData) {
        renderPdf(currentPdfData);
      }
      if (tab === "log") {
        logErrorCount = 0;
        logBadge.classList.remove("visible");
        logBadge.textContent = "";
      }
    }

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

    function renderPdf(base64Data) {
      currentPdfData = base64Data;
      pdfRenderVersion++;
      var version = pdfRenderVersion;

      pdfPlaceholder.style.display = "none";
      compileErrors.style.display = "none";

      var existing = pdfPane.querySelector(".pdf-canvas-container");
      if (existing) existing.remove();

      if (currentPdfDoc) {
        currentPdfDoc.destroy();
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
          pdf.destroy();
          return;
        }
        currentPdfDoc = pdf;
        var scale = 1.5;
        for (var pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          (function(num) {
            pdf.getPage(num).then(function(page) {
              if (version !== pdfRenderVersion) return;
              var viewport = page.getViewport({ scale: scale });
              var canvas = document.createElement("canvas");
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              container.appendChild(canvas);
              page.render({
                canvasContext: canvas.getContext("2d"),
                viewport: viewport
              });
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

    function renderMath() {
      if (typeof renderMathInElement !== "undefined" && articleEl) {
        renderMathInElement(articleEl, {
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

    function renderMermaid() {
      if (!articleEl) return;
      articleEl.querySelectorAll("code.language-mermaid").forEach(function(block) {
        var pre = block.parentElement;
        if (!pre) return;
        var div = document.createElement("div");
        div.className = "mermaid";
        div.textContent = block.textContent;
        pre.parentNode.replaceChild(div, pre);
      });
      if (typeof mermaid !== "undefined") {
        var isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({ startOnLoad: false, theme: isDark ? "dark" : "default" });
        mermaid.run();
      }
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

    window.addEventListener("message", function(event) {
      var msg = event.data;

      if (msg.type === "updateContent") {
        articleEl.innerHTML = msg.html;
        renderMath();
        renderMermaid();
        if (msg.pdfData) {
          currentPdfData = msg.pdfData;
        }
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
          setTimeout(function() { compileStatus.textContent = ""; }, 6000);
        }
      } else if (msg.type === "compileStarted") {
        compileBtn.disabled = true;
        compileIcon.textContent = "\\u23F3";
        compileStatus.textContent = "Compiling...";
        addLogEntry("compile", "log-tag-compile", "LaTeX compilation started...", "");
      } else if (msg.type === "compileDone") {
        compileBtn.disabled = false;
        compileIcon.textContent = "\\u25B6";
        if (msg.pdfData) {
          compileStatus.textContent = "Done (" + msg.duration.toFixed(1) + "s)";
          addLogEntry("compile", "log-tag-compile", "PDF compiled successfully (" + msg.duration.toFixed(1) + "s)", "");
          if (currentTab !== "pdf") {
            currentPdfData = msg.pdfData;
            switchTab("pdf");
          } else {
            renderPdf(msg.pdfData);
          }
        } else if (msg.errors && msg.errors.length) {
          compileStatus.textContent = msg.errors.length + " error(s)";
          for (var ei = 0; ei < msg.errors.length; ei++) {
            addLogEntry("error", "log-tag-error", msg.errors[ei], "");
          }
          addLogEntry("compile", "log-tag-error", "Compilation failed with " + msg.errors.length + " error(s)", msg.log || "");
          showErrors(msg.errors, msg.log || "");
          switchTab("log");
        } else {
          compileStatus.textContent = "Failed";
          addLogEntry("error", "log-tag-error", "Compilation failed", msg.log || "");
          showErrors(["Compilation failed. Check the Log tab for details."], msg.log || "");
          switchTab("log");
        }
        setTimeout(function() { compileStatus.textContent = ""; }, 8000);
      } else if (msg.type === "logEntry") {
        var lTag = msg.tag === "error" ? "log-tag-error" : msg.tag === "warn" ? "log-tag-warn" : msg.tag === "run" ? "log-tag-run" : msg.tag === "compile" ? "log-tag-compile" : "log-tag-info";
        addLogEntry(msg.tag, lTag, msg.message, msg.details);
      }
    });

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
}

function stripFrontmatter(text: string): FrontmatterResult {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { body: text };

  const fm = match[1];
  const body = match[2];

  const scalar = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*['"]?(.+?)['"]?\\s*$`, "m"));
    return m ? m[1] : undefined;
  };

  const block = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*\\|\\s*\\n((?:[ \\t]+.+\\n?)+)`, "m"));
    return m ? m[1].replace(/^[ \t]+/gm, "").trim() : undefined;
  };

  return {
    body,
    title: scalar("title"),
    subtitle: scalar("subtitle"),
    author: scalar("author"),
    date: scalar("date"),
    abstract: block("abstract") || scalar("abstract"),
    mainfont: scalar("mainfont"),
    monofont: scalar("monofont"),
    figPrefix: scalar("figPrefix"),
    tblPrefix: scalar("tblPrefix"),
    eqnPrefix: scalar("eqnPrefix"),
    secPrefix: scalar("secPrefix"),
  };
}

function addDataLineAttrs(html: string): string {
  let lineCounter = 0;
  return html.replace(/<(h[1-6]|p|pre|blockquote|table|ul|ol|li|hr)/g, (match, tag) => {
    lineCounter++;
    return `<${tag} data-line="${lineCounter}"`;
  });
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

function extractMermaidLabels(text: string): Map<string, string> {
  const labels = new Map<string, string>();
  const re = /^```\{mermaid([^}]*)\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1];
    const labelMatch = attrs.match(/label="([^"]+)"/);
    const captionMatch = attrs.match(/caption="([^"]+)"/);
    if (labelMatch) {
      labels.set(labelMatch[1], captionMatch?.[1] || "Diagram");
    }
  }
  return labels;
}

function resolveReferences(
  body: string,
  mermaidLabels: Map<string, string>,
  prefixes: { fig: string; tbl: string; eqn: string; sec: string },
): string {
  const labels = new Map<string, string>();
  const secNums = [0, 0, 0, 0, 0, 0];
  let figNum = 0;
  let tblNum = 0;
  let eqNum = 0;

  // Headers: # Title {#sec:label} -> numbered anchor + clean heading
  let result = body.replace(
    /^(#{1,6})\s+(.*?)\s*\{#([\w:.-]+)\}\s*$/gm,
    (_, hashes: string, title: string, label: string) => {
      if (label.startsWith("sec:")) {
        const level = hashes.length - 1;
        secNums[level]++;
        for (let i = level + 1; i < secNums.length; i++) secNums[i] = 0;
        const num = secNums
          .slice(0, level + 1)
          .filter((n) => n > 0)
          .join(".");
        labels.set(label, `${prefixes.sec}\u00a0${num}`);
      }
      return `${hashes} <a id="${label}"></a>${title}`;
    },
  );

  // Image figure labels: ![cap](src){#fig:label}
  result = result.replace(
    /!\[([^\]]*)\]\(([^)]+)\)\{#(fig:[\w:.-]+)\}/g,
    (_, caption: string, src: string, label: string) => {
      figNum++;
      labels.set(label, `${prefixes.fig}\u00a0${figNum}`);
      return `<a id="${label}"></a>\n\n![${prefixes.fig} ${figNum}: ${caption}](${src})`;
    },
  );

  // Mermaid diagram labels (extracted from original text before normalization)
  const mermaidList = [...mermaidLabels.entries()];
  let mermaidIdx = 0;
  result = result.replace(/^```mermaid\s*$/gm, (match) => {
    if (mermaidIdx < mermaidList.length) {
      const [id] = mermaidList[mermaidIdx++];
      const label = `fig:${id}`;
      if (!labels.has(label)) {
        figNum++;
        labels.set(label, `${prefixes.fig}\u00a0${figNum}`);
      }
      return `<a id="${label}"></a>\n\n${match}`;
    }
    return match;
  });

  // Table caption labels: : caption {#tbl:label} -> HTML figcaption
  result = result.replace(
    /^:\s+(.*?)\s*\{#(tbl:[\w:.-]+)\}\s*$/gm,
    (_, caption: string, label: string) => {
      tblNum++;
      labels.set(label, `${prefixes.tbl}\u00a0${tblNum}`);
      return `<figcaption class="table-caption"><a id="${label}"></a><strong>${prefixes.tbl}\u00a0${tblNum}:</strong> ${caption}</figcaption>`;
    },
  );

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

function resolveCitations(body: string): string {
  // Pandoc citation syntax: [@key], [@k1; @k2], [-@key], [@key, p. 23]
  // Lookahead ensures at least one @ inside the brackets.
  return body.replace(
    /\[(?=[^\[\]]*@)((?:[^\[\]])*)\]/g,
    (_, inner: string) => {
      const parts = inner.split(";").map((s) => {
        const m = s.trim().match(/-?@([\w:./-]+)/);
        return m ? m[1] : s.trim();
      });
      return `<span class="citation">[${parts.join("; ")}]</span>`;
    },
  );
}

function convertLatexTables(body: string): string {
  return body.replace(
    /\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}/g,
    (env) => {
      const captionMatch = env.match(/\\caption\{([^}]+)\}/);
      const labelMatch = env.match(/\\label\{([^}]+)\}/);

      const tabularMatch = env.match(
        /\\begin\{tabular\}(?:\{[^}]*\})?\s*([\s\S]*?)\\end\{tabular\}/,
      );
      if (!tabularMatch) {
        return '<div class="latex-env-placeholder"><em>LaTeX table (renders in PDF)</em></div>';
      }

      let content = tabularMatch[1];
      content = content.replace(/\\(?:toprule|midrule|bottomrule|hline)\s*/g, "");
      content = content.replace(/\\(?:centering|small|normalsize|footnotesize|scriptsize|tiny|large|Large)\s*/g, "");

      const rows = content
        .split(/\\\\\s*/)
        .map((r) => r.trim())
        .filter((r) => r);

      const htmlRows = rows.map((row, i) => {
        const cells = row.split("&").map((cell) => cleanLatexCell(cell.trim()));
        const tag = i === 0 ? "th" : "td";
        return "<tr>" + cells.map((c) => `<${tag}>${c}</${tag}>`).join("") + "</tr>";
      });

      let html = "<table>\n";
      if (htmlRows.length > 0) {
        html += `<thead>${htmlRows[0]}</thead>\n`;
        html += `<tbody>${htmlRows.slice(1).join("\n")}</tbody>\n`;
      }
      html += "</table>";

      if (captionMatch) {
        const anchor = labelMatch ? `<a id="${labelMatch[1]}"></a>` : "";
        html += `\n<figcaption class="table-caption">${anchor}<strong>${captionMatch[1]}</strong></figcaption>`;
      }

      return html;
    },
  );
}

function cleanLatexCell(cell: string): string {
  let c = cell;
  c = c.replace(/\\textbf\{([^}]+)\}/g, "<strong>$1</strong>");
  c = c.replace(/\\textit\{([^}]+)\}/g, "<em>$1</em>");
  c = c.replace(/\\emph\{([^}]+)\}/g, "<em>$1</em>");
  c = c.replace(/\{\\o\}/g, "\u00f8");
  c = c.replace(/\\o(?=\b)/g, "\u00f8");
  c = c.replace(/\$([^$]+)\$/g, "$$$1$$");
  c = c.replace(/\\&/g, "&amp;");
  c = c.replace(/\\%/g, "%");
  c = c.replace(/\\\$/g, "$");
  c = c.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1");
  c = c.replace(/[{}]/g, "");
  return c;
}

function buildFontOverrides(fm: FrontmatterResult): string {
  const rules: string[] = [];
  if (fm.mainfont) {
    const safe = fm.mainfont.replace(/'/g, "\\'");
    rules.push(`--body-font: '${safe}', Georgia, 'Palatino Linotype', serif`);
    rules.push(`--heading-font: '${safe}', Georgia, 'Palatino Linotype', serif`);
  }
  if (fm.monofont) {
    const safe = fm.monofont.replace(/'/g, "\\'");
    rules.push(`--mono-font: '${safe}', 'SF Mono', Menlo, Consolas, monospace`);
  }
  if (!rules.length) return "";
  return `<style>:root { ${rules.join("; ")}; }</style>`;
}
