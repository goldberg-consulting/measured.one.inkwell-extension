/** Every optional feature is loaded from the extension's packaged vendor tree. */
export function createAssetLoader(document, { vendorRoot }) {
  const pending = new Map(), styles = new Set();
  function module(relative) {
    if (!pending.has(relative)) {
      const promise = import(vendorRoot + relative);
      pending.set(relative, promise);
      promise.catch(() => { pending.delete(relative); });
    }
    return pending.get(relative);
  }
  function style(relative, media) {
    if (styles.has(relative)) return;
    styles.add(relative);
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = vendorRoot + relative;
    if (media) link.media = media;
    document.head.appendChild(link);
  }
  return {
    async math() {
      style('katex/katex.min.css');
      return (await module('math.js')).default;
    },
    async mermaid() { return (await module('mermaid.js')).default; },
    async highlight() {
      style('highlight/github.min.css', '(prefers-color-scheme: light)');
      style('highlight/github-dark.min.css', '(prefers-color-scheme: dark)');
      return (await module('highlight.js')).default;
    },
    async pdf() {
      const library = await module('pdfjs/pdf.mjs');
      library.GlobalWorkerOptions.workerSrc = vendorRoot + 'pdfjs/pdf.worker.mjs';
      return library;
    },
    pdfOptions: { cMapUrl: vendorRoot + 'pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: vendorRoot + 'pdfjs/standard_fonts/', wasmUrl: vendorRoot + 'pdfjs/wasm/' },
  };
}
