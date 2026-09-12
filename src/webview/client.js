/* global acquireVsCodeApi, document, window, setTimeout, clearTimeout */
import { viewerStateRuntime } from "../viewer-state.ts";
import { BoundedPdfViewer } from "./pdf-viewer.js";
import { createAssetLoader } from "./assets.js";

export function startPreview(initial) {
    var vscodeApi = acquireVsCodeApi();
    var viewerApi = viewerStateRuntime();
    var changeFontScale = viewerApi.changeFontScale;
    var readViewerState = viewerApi.readViewerState;
    var viewerState = readViewerState(vscodeApi.getState ? vscodeApi.getState() : undefined, initial.fontScale, initial.selectedTab);
    var currentTab = viewerState.selectedTab;
    var currentPdfData = null;
    var contentRevision = 0;
    var documentUri = null;
    var currentPdfOutput = null;
    var runId = 0;
    var runRows = new Map();

    var assets = initial.assets || createAssetLoader(document, initial);
    var articleGeneration = 0;
    var scrollReady = false;
    var pendingScrollRestore = null;
    var saved = vscodeApi.getState ? vscodeApi.getState() : {};
    var scrollByDocument = saved && saved.scrollByDocument || {};
    var mermaid, hljs, renderMathInElement;

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

    var logErrorCount = 0;
    var docTitle = "";
    var printPaginated = false;

    var pdfViewer = new BoundedPdfViewer({ document: document, pane: pdfPane,
      loadLibrary: () => assets.pdf(), pdfOptions: assets.pdfOptions,
      onError: error => { pdfPlaceholder.textContent = "Failed to render PDF: " + String(error); pdfPlaceholder.style.display = "block"; },
      onScroll: scroll => { saveScroll("pdf", scroll); },
    });
    window.inkwellPreviewMetrics = pdfViewer.counters;
    function saveScroll(pane, scroll) {
      if (!documentUri || !scrollReady || pendingScrollRestore || pane !== currentTab) return;
      scrollByDocument[documentUri] = Object.assign({}, scrollByDocument[documentUri], { [pane]: scroll });
      var keys = Object.keys(scrollByDocument);
      if (keys.length > 20) delete scrollByDocument[keys[0]];
      persistViewerState(false);
    }
    function savedScroll(pane) { return scrollByDocument[documentUri] && scrollByDocument[documentUri][pane]; }
    function applyPendingScroll() {
      if (!pendingScrollRestore) return;
      for (var name of ["preview", "print"]) {
        var position = pendingScrollRestore[name] || { top: 0, left: 0 };
        var pane = name === "preview" ? previewPane : printPane;
        pane.scrollTop = Math.max(0, Number(position.top) || 0);
        pane.scrollLeft = Math.max(0, Number(position.left) || 0);
      }
    }
    // A deliberate user scroll takes priority over an in-progress restoration.
    for (var scrollSurface of [previewPane, printPane, pdfPane]) {
      for (var eventName of ["wheel", "touchstart", "keydown"]) {
        scrollSurface.addEventListener(eventName, () => { pendingScrollRestore = null; });
      }
    }
    previewPane.addEventListener("scroll", () => saveScroll("preview", { top: previewPane.scrollTop, left: previewPane.scrollLeft }));
    printPane.addEventListener("scroll", () => saveScroll("print", { top: printPane.scrollTop, left: printPane.scrollLeft }));

    var STATUS_ICONS = {
      pending: "\u25CB",
      running: "\u25F7",
      cached: "\u21BB",
      done: "\u2713",
      failed: "\u2717",
      cancelled: "\u2014"
    };

    function ensureRunRow(index) {
      if (!Number.isInteger(index) || index < 0) return null;
      if (runRows.has(index)) return runRows.get(index);
      var item = document.createElement("div");
      item.className = "run-block-item status-pending";
      item.id = "run-block-" + index;
      item.innerHTML = '<span class="run-block-icon">' + STATUS_ICONS.pending + '</span>' +
        '<span class="run-block-label">Block ' + (index + 1) + '</span>' +
        '<span class="run-block-meta"></span>';
      var next = [...runRows].sort((a, b) => a[0] - b[0]).find(entry => entry[0] > index);
      if (next) runBlockList.insertBefore(item, next[1]);
      else runBlockList.appendChild(item);
      runRows.set(index, item);
      return item;
    }

    function persistViewerState(notify) {
      if (vscodeApi.setState) vscodeApi.setState(Object.assign({}, viewerState, { scrollByDocument }));
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
      if (tab === "preview") {
        var previewScroll = savedScroll("preview");
        if (previewScroll) { previewPane.scrollTop = Math.max(0, Number(previewScroll.top) || 0); previewPane.scrollLeft = Math.max(0, Number(previewScroll.left) || 0); }
      }
      if (tab === "pdf" && currentPdfData) {
        renderPdf(currentPdfData);
      }
      if (tab === "print") {
        paginateForPrint();
        var printScroll = savedScroll("print");
        if (printScroll) { printPane.scrollTop = Math.max(0, Number(printScroll.top) || 0); printPane.scrollLeft = Math.max(0, Number(printScroll.left) || 0); }
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

    function clearPdf() {
      currentPdfData = null;
      currentPdfOutput = null;
      pdfViewer.clear();
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
      scrollReady = false;
      pendingScrollRestore = null;
      previewPane.scrollTop = previewPane.scrollLeft = 0;
      printPane.scrollTop = printPane.scrollLeft = 0;
      articleGeneration++;
      articleEl.innerHTML = "";
      document.getElementById("typography-notice").style.display = "none";
      if (printStage) printStage.innerHTML = "";
      printPaginated = false;
      docTitle = "";
      clearPdf();
      runPanel.classList.remove("visible");
      runBlockList.innerHTML = "";
      runRows.clear();
      runSummary.textContent = "";
      runBtn.style.display = "none";
      logEntries.innerHTML = '<div class="log-empty">No output yet.</div>';
      logErrorCount = 0;
      logBadge.classList.remove("visible");
      logBadge.textContent = "";
    }

    function renderPdf(resource) {
      pdfPlaceholder.style.display = "none";
      compileErrors.style.display = "none";
      void pdfViewer.setSource(resource, viewerState, savedScroll("pdf"));
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

    function featureError(feature, error, generation) {
      if (generation === articleGeneration) addLogEntry("warn", "log-tag-warn", feature + " could not render using bundled assets", String(error));
    }

    async function highlightCode() {
      if (!articleEl || !articleEl.querySelector("pre code:not(.language-mermaid)")) return;
      var generation = articleGeneration;
      try { hljs = await assets.highlight(); } catch (error) { featureError("Syntax highlighting", error, generation); return; }
      if (generation !== articleGeneration) return;
      articleEl.querySelectorAll("pre code").forEach(function(block) {
        if (block.classList.contains("hljs")) return;
        // Skip mermaid, it's converted separately.
        if (block.className && block.className.indexOf("language-mermaid") !== -1) return;
        try {
          hljs.highlightElement(block);
        } catch { /* A failed optional decoration leaves readable document content. */ }
      });
    }

    async function renderMath() {
      if (!articleEl || !articleEl.querySelector("[data-inkwell-math]")) return;
      var generation = articleGeneration;
      try { renderMathInElement = await assets.math(); } catch (error) { featureError("Math", error, generation); return; }
      if (generation !== articleGeneration) return;
      if (renderMathInElement) {
        var options = {
          ignoredClasses: ["inkwell-table-literal"],
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\[", right: "\\]", display: true },
            { left: "\\(", right: "\\)", display: false }
          ],
          throwOnError: false
        };
        // The Markdown pass has already identified math using Pandoc's
        // delimiter rules. Scanning the whole article again would turn
        // ordinary currency into math as soon as any real formula is present.
        articleEl.querySelectorAll("[data-inkwell-math]").forEach(function (element) {
          // Auto-render's ignored tags/classes normally apply while walking
          // descendants. Preserve those exclusions when starting at a wrapper.
          if (element.closest("script, noscript, style, textarea, pre, code, option, .inkwell-table-literal")) return;
          renderMathInElement(element, options);
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
        .replace(/[ \t]+$/gm, "")
        .trim();
    }

    var mermaidRenderCounter = 0;

    async function renderMermaid() {
      var revision = contentRevision;
      var uri = documentUri;
      if (!articleEl || !articleEl.querySelector("code.language-mermaid")) return;
      var generation = articleGeneration;
      try { mermaid = await assets.mermaid(); } catch (error) { featureError("Mermaid", error, generation); return; }
      if (generation !== articleGeneration) return;

      var isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (!mermaidInited) {
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? "dark" : "default",
          securityLevel: "strict",
          flowchart: { htmlLabels: true }
        });
        mermaidInited = true;
      }

      var blocks = Array.prototype.slice.call(
        articleEl.querySelectorAll("code.language-mermaid")
      );

      var pending = [];
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
            if (revision !== contentRevision || uri !== documentUri || generation !== articleGeneration) return;
            var svg = typeof r === "string" ? r : r.svg;
            wrapper.innerHTML = svg;
            wrapper.setAttribute("data-processed", "true");
            if (typeof r !== "string" && r.bindFunctions) {
              try { r.bindFunctions(wrapper); } catch { /* A failed optional decoration leaves readable document content. */ }
            }
            mermaidSvgCache[src] = svg;
          };
          if (result && typeof result.then === "function") {
            pending.push(result.then(handleResult).catch(function(err) {
              if (revision !== contentRevision || uri !== documentUri || generation !== articleGeneration) return;
              renderMermaidError(wrapper, src, err);
            }));
          } else {
            handleResult(result);
          }
        } catch (err) {
          renderMermaidError(wrapper, src, err);
        }
      });
      await Promise.all(pending);
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
        if (changed) {
          saveScroll("preview", { top: previewPane.scrollTop, left: previewPane.scrollLeft });
          saveScroll("print", { top: printPane.scrollTop, left: printPane.scrollLeft });
          resetDocument();
          var priorScroll = scrollByDocument[msg.documentUri] || {};
          pendingScrollRestore = { preview: priorScroll.preview || { top: 0, left: 0 }, print: priorScroll.print || { top: 0, left: 0 } };
        }
        if (changed || newer) {
          // Pending old PDF loads and status timers lose authority at once.
          // The PDF represents the last successful build of this document.
          // Document changes already clear it; same-document edits reuse it.
          compileBtn.disabled = false;
          compileIcon.textContent = "\u25B6";
          compileStatus.textContent = "";
          // A newer render invalidates run authority even when only a dependency changed.
          runBtn.disabled = false;
          runIcon.textContent = "\u2699";
          runCancelBtn.style.display = "none";
          runPanel.classList.remove("visible");
          runBlockList.innerHTML = "";
          runRows.clear();
        }
        documentUri = msg.documentUri;
        contentRevision = msg.revision;
      }
      if (msg.type === "renderStarted") { articleGeneration++; return; }

      if (msg.type === "draftContent") {
        articleGeneration++;
        articleEl.innerHTML = msg.html;
        compileStatus.textContent = "";
        docTitle = msg.title || "";
        compileStatus.textContent = msg.featureStatus || "";
        applyPendingScroll();
        scrollReady = true;
        printPaginated = false;
        return;
      }

      if (msg.type === "updateContent") {
        articleGeneration++;
        articleEl.innerHTML = msg.html;
        compileStatus.textContent = "";
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
        var enhancementGeneration = articleGeneration;
        var enhancements = [highlightCode, renderMath, renderMermaid].map(enhance => enhance().then(() => {
          if (enhancementGeneration !== articleGeneration) return;
          printPaginated = false;
          if (currentTab === "print") paginateForPrint();
        }).catch(error => featureError("Optional preview content", error, enhancementGeneration)));
        void Promise.all(enhancements).then(() => {
          if (enhancementGeneration !== articleGeneration) return;
          applyPendingScroll();
          pendingScrollRestore = null;
        });
        wireCitationScroll();
        printPaginated = false;
        if (currentTab === "print") paginateForPrint();
        applyPendingScroll();
        scrollReady = true;
        updatePdf(msg.pdfUri !== undefined ? msg.pdfUri : msg.pdfData, msg.pdfOutput);
        if (msg.hasCodeBlocks) {
          runBtn.style.display = "";
        } else {
          runBtn.style.display = "none";
        }
      } else if (msg.type === "runStarted") {

        runBtn.disabled = true;
        runIcon.textContent = "\u23F3";
        runCancelBtn.style.display = "";
        runPanel.classList.add("visible");
        runBlockList.innerHTML = "";
      runRows.clear();
        runSummary.textContent = "Starting...";
        var selected = Array.isArray(msg.blockIndices) ? msg.blockIndices : Array.from({ length: msg.blockCount }, (_, index) => index);
        for (var index of selected) ensureRunRow(index);
        addLogEntry("run", "log-tag-run", "Running " + runRows.size + (Array.isArray(msg.blockIndices) ? " selected blocks and required dependencies..." : " code blocks..."), "");
      } else if (msg.type === "blockProgress") {
        var el = ensureRunRow(msg.index);
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
          if (labelEl && msg.label) labelEl.textContent = msg.label;
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
        var doneCount = [...runRows.values()].filter(row => ["done", "cached", "failed", "cancelled"].some(status => row.classList.contains("status-" + status))).length;
        runSummary.textContent = doneCount + "/" + runRows.size + " blocks";
      } else if (msg.type === "runComplete") {
        for (var row of runRows.values()) {
          if (!row.classList.contains("status-pending") && !row.classList.contains("status-running")) continue;
          row.className = "run-block-item status-cancelled";
          var pendingIcon = row.querySelector(".run-block-icon"), pendingMeta = row.querySelector(".run-block-meta");
          if (pendingIcon) pendingIcon.textContent = STATUS_ICONS.cancelled;
          if (pendingMeta) pendingMeta.textContent = "Not run";
        }

        runBtn.disabled = false;
        runIcon.textContent = "\u2699";
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
        compileIcon.textContent = "\u23F3";
        compileStatus.textContent = "Compiling...";
        addLogEntry("compile", "log-tag-compile", "LaTeX compilation started...", "");
      } else if (msg.type === "compileDone") {
        compileBtn.disabled = false;
        compileIcon.textContent = "\u25B6";
        if (!msg.retainPdf) updatePdf(msg.pdfUri !== undefined ? msg.pdfUri : msg.pdfData, msg.pdfOutput);
        else labelPdf();
        if (msg.success && (msg.pdfUri || msg.pdfData)) {
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
  }
