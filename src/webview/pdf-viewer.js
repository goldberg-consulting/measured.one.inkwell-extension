/** PDF.js adapter with a six-page resident window and reusable document load.
 * The injected platform makes races and memory bounds testable without VS Code.
 */
export class BoundedPdfViewer {
  constructor({ document, pane, loadLibrary, onError = () => {}, onScroll = () => {},
    IntersectionObserver = globalThis.IntersectionObserver, pdfOptions = {} }) {
    Object.assign(this, { document, pane, loadLibrary, onError, onScroll, IntersectionObserver, pdfOptions });
    this.source = null;
    this.pdf = null;
    this.loading = null;
    this.container = null;
    this.observer = null;
    this.slots = [];
    this.resident = new Map();
    this.visible = new Map();
    this.epoch = 0;
    this.layoutEpoch = 0;
    this.anchor = 1;
    this.settings = { pdfFitMode: 'width', pdfZoom: 100 };
    this.counters = { pdfTransfers: 0, createdCanvases: 0, activeCanvases: 0, peakCanvases: 0, renderedPages: 0 };
  }

  async setSource(source, settings = this.settings, scroll = undefined) {
    this.settings = settings;
    if (!source) { this.clear(); return; }
    if (source === this.source) {
      if (scroll !== undefined) this.pendingScroll = scroll;
      if (this.pdf) this.layout(settings);
      return this.loading;
    }
    this.clear();
    this.source = source;
    this.pendingScroll = scroll;
    const epoch = this.epoch;
    this.loading = (async () => {
      try {
        const library = await this.loadLibrary();
        if (epoch !== this.epoch) return;
        this.counters.pdfTransfers++;
        const task = library.getDocument({ ...this.pdfOptions, url: source, isEvalSupported: false });
        this.loadTask = task;
        const pdf = await task.promise;
        if (epoch !== this.epoch) { this.destroy(pdf); return; }
        this.loadTask = null;
        this.pdf = pdf;
        this.container = this.document.createElement('div');
        this.container.className = 'pdf-canvas-container';
        this.container.setAttribute('aria-label', `PDF, ${pdf.numPages} pages`);
        // Allocate only lightweight, ordered placeholders; page requests happen
        // after observation and never create canvases for the whole document.
        for (let number = 1; number <= pdf.numPages; number++) {
          const element = this.document.createElement('div');
          element.className = 'pdf-page-placeholder';
          element.setAttribute('data-page', String(number));
          element.setAttribute('aria-label', `Page ${number}`);
          element.style.flexShrink = '0';
          this.slots.push({ element, width: 612, height: 792 });
          this.container.appendChild(element);
        }
        this.pane.appendChild(this.container);
        this.container.addEventListener('scroll', () => {
          if (epoch !== this.epoch || !this.container) return;
          this.onScroll({ top: this.container.scrollTop, left: this.container.scrollLeft });
          if (!this.observer) this.selectFromScroll();
        });
        this.layout(this.settings);
        const latestScroll = this.pendingScroll;
        if (latestScroll) {
          this.container.scrollTop = Math.max(0, Number(latestScroll.top) || 0);
          this.container.scrollLeft = Math.max(0, Number(latestScroll.left) || 0);
          this.selectFromScroll();
        }
        if (this.IntersectionObserver) {
          this.observer = new this.IntersectionObserver(entries => {
            if (epoch !== this.epoch) return;
            for (const entry of entries) {
              const number = Number(entry.target.getAttribute('data-page'));
              if (entry.isIntersecting) this.visible.set(number, entry.intersectionRatio);
              else this.visible.delete(number);
            }
            // Prefer the page with greatest visible area, keeping a bounded
            // neighbor window even when many tiny pages are simultaneously seen.
            const nearest = [...this.visible].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
            if (nearest) this.renderNear(nearest[0]);
          }, { root: this.container, rootMargin: '0px', threshold: [0, 0.25, 0.5, 0.75, 1] });
          for (const slot of this.slots) this.observer.observe(slot.element);
        }
      } catch (error) {
        if (epoch === this.epoch) {
          this.clear();
          this.onError(error);
        }
      }
    })();
    return this.loading;
  }

  viewport(width, height) {
    const widthScale = Math.max(0.1, (this.pane.clientWidth - 24) / width);
    const scale = this.settings.pdfFitMode === 'custom' ? this.settings.pdfZoom / 100
      : this.settings.pdfFitMode === 'page' ? Math.min(widthScale, Math.max(0.1, (this.pane.clientHeight - 90) / height))
        : widthScale;
    return { width: width * scale, height: height * scale, scale };
  }

  layout(settings = this.settings) {
    this.settings = settings;
    if (!this.pdf) return;
    const key = `${settings.pdfFitMode}:${settings.pdfZoom}:${this.pane.clientWidth}:${this.pane.clientHeight}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    // Preserve the position within the visible page when changing zoom.
    const first = this.slots[this.anchor - 1]?.element;
    const offset = first ? (this.container.scrollTop - first.offsetTop) / Math.max(1, first.clientHeight) : 0;
    ++this.layoutEpoch;
    for (const number of [...this.resident.keys()]) this.release(number);
    for (const slot of this.slots) this.sizeSlot(slot);
    if (first) this.container.scrollTop = Math.max(0, first.offsetTop + offset * first.clientHeight);
    this.renderNear(this.anchor);
  }

  sizeSlot(slot) {
    const size = this.viewport(slot.width, slot.height);
    slot.element.style.width = `${size.width}px`;
    slot.element.style.height = `${size.height}px`;
  }

  selectFromScroll() {
    if (!this.container) return;
    const top = this.container.scrollTop;
    const index = this.slots.findIndex(slot => slot.element.offsetTop + slot.element.clientHeight > top);
    if (index >= 0) this.renderNear(index + 1);
  }

  renderNear(number) {
    if (!this.pdf) return;
    this.anchor = Math.max(1, Math.min(this.pdf.numPages, number));
    const start = Math.max(1, Math.min(this.pdf.numPages - 5, this.anchor - 2));
    const end = Math.min(this.pdf.numPages, start + 5);
    for (const resident of [...this.resident.keys()]) {
      if (resident < start || resident > end) this.release(resident);
    }
    // Visible page first, then nearest neighbors, with stable DOM order supplied
    // by placeholders regardless of the order in which getPage resolves.
    const window = Array.from({ length: end - start + 1 }, (_, index) => start + index)
      .sort((a, b) => Math.abs(a - this.anchor) - Math.abs(b - this.anchor) || a - b);
    for (const page of window) if (!this.resident.has(page)) this.renderPage(page);
  }

  async renderPage(number) {
    const epoch = this.epoch;
    const layoutEpoch = this.layoutEpoch;
    const resident = {};
    this.resident.set(number, resident);
    const current = () => epoch === this.epoch && layoutEpoch === this.layoutEpoch && this.resident.get(number) === resident;
    try {
      const page = await this.pdf.getPage(number);
      if (!current()) { page.cleanup(); return; }
      resident.page = page;
      const natural = page.getViewport({ scale: 1 });
      const slot = this.slots[number - 1];
      slot.width = natural.width;
      slot.height = natural.height;
      this.sizeSlot(slot);
      const size = this.viewport(natural.width, natural.height);
      // Bound backing-store pixels at high custom zoom without changing the
      // document's displayed scale or introducing another PDF transfer.
      const quality = Math.min(1, Math.sqrt(8_000_000 / (size.width * size.height)));
      const viewport = page.getViewport({ scale: size.scale * quality });
      const canvas = this.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width - 1e-8);
      canvas.height = Math.ceil(viewport.height - 1e-8);
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
      slot.element.appendChild(canvas);
      resident.canvas = canvas;
      this.counters.createdCanvases++;
      this.counters.activeCanvases++;
      this.counters.peakCanvases = Math.max(this.counters.peakCanvases, this.counters.activeCanvases);
      resident.task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      await resident.task.promise;
      if (current()) this.counters.renderedPages++;
    } catch (error) {
      if (current() && error?.name !== 'RenderingCancelledException') this.onError(error);
    }
  }

  release(number) {
    const resident = this.resident.get(number);
    if (!resident) return;
    this.resident.delete(number);
    try { resident.task?.cancel(); } catch { /* Disposal remains safe after cancellation or a previous destroy. */ }
    if (resident.canvas) {
      resident.canvas.remove();
      resident.canvas.width = 0;
      resident.canvas.height = 0;
      this.counters.activeCanvases--;
    }
    try { resident.page?.cleanup(); } catch { /* Disposal remains safe after cancellation or a previous destroy. */ }
    if (resident.task?.promise) Promise.resolve(resident.task.promise).catch(() => {}).then(() => {
      try { resident.page?.cleanup(); } catch { /* Disposal remains safe after cancellation or a previous destroy. */ }
    });
  }

  destroy(value) {
    if (value?.destroy) try { Promise.resolve(value.destroy()).catch(() => {}); } catch { /* Disposal remains safe after cancellation or a previous destroy. */ }
  }

  clear() {
    ++this.epoch;
    ++this.layoutEpoch;
    this.observer?.disconnect();
    this.observer = null;
    this.visible.clear();
    for (const number of [...this.resident.keys()]) this.release(number);
    this.destroy(this.loadTask);
    this.destroy(this.pdf);
    this.pdf = null;
    this.loadTask = null;
    this.source = null;
    this.pendingScroll = undefined;
    this.loading = null;
    this.container?.remove();
    this.container = null;
    this.slots = [];
    this.anchor = 1;
    this.layoutKey = null;
  }
}
