import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedPdfViewer } from '../src/webview/pdf-viewer.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(options = {}) {
  let observer;
  const pagesRequested = [], cleanups = [], errors = [], cancelled = [], destroyed = [];
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.attrs = {}; this.scrollTop = 0; this.scrollLeft = 0; }
    appendChild(element) { element.parent = this; this.children.push(element); return element; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    setAttribute(name, value) { this.attrs[name] = value; }
    getAttribute(name) { return this.attrs[name]; }
    addEventListener(event, listener) { this.listeners ||= {}; this.listeners[event] = listener; }
    getContext() { return {}; }
    get offsetTop() { return this.parent ? this.parent.children.slice(0, this.parent.children.indexOf(this)).reduce((sum, slot) => sum + slot.clientHeight + 8, 0) : 0; }
    get clientHeight() { return this.style.height ? parseFloat(this.style.height) : 1000; }
    get clientWidth() { return this.style.width ? parseFloat(this.style.width) : 900; }
  }
  const pane = new Element('section');
  const getPage = number => {
    pagesRequested.push(number);
    const page = { getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
      render: () => ({ promise: options.renderWait?.promise || Promise.resolve(), cancel: () => cancelled.push(number) }),
      cleanup: () => cleanups.push(number) };
    return options.pageWait ? options.pageWait(number, page) : Promise.resolve(page);
  };
  const pdf = { numPages: 100, getPage, destroy: () => destroyed.push('document') };
  const viewer = new BoundedPdfViewer({
    document: { createElement: tag => new Element(tag) }, pane,
    loadLibrary: async () => ({ getDocument: args => {
      assert.ok(args.url);
      assert.equal(args.isEvalSupported, false);
      return { promise: options.loadWait?.promise || Promise.resolve(pdf), destroy: () => destroyed.push('load') };
    } }), onError: error => errors.push(error),
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.observed = []; observer = this; }
      observe(element) { this.observed.push(element); }
      disconnect() { this.disconnected = true; }
    },
  });
  return { viewer, pane, pdf, pagesRequested, cleanups, errors, cancelled, destroyed,
    observe: number => observer.callback([{ target: viewer.slots[number - 1].element, isIntersecting: true, intersectionRatio: 1 }]),
    get observer() { return observer; } };
}

test('100 pages allocate ordered placeholders and at most six near-viewport canvases', async () => {
  const h = harness();
  await h.viewer.setSource('local-resource:/test.pdf?version=1');
  await settle();
  assert.equal(h.viewer.slots.length, 100);
  assert.equal(h.observer.observed.length, 100);
  assert.deepEqual(h.pagesRequested, [1, 2, 3, 4, 5, 6]);
  assert.equal(h.viewer.counters.activeCanvases, 6);
  h.observe(50);
  await settle();
  assert.deepEqual([...h.viewer.resident.keys()].sort((a,b) => a-b), [48,49,50,51,52,53]);
  assert.equal(h.viewer.counters.activeCanvases, 6);
  assert.equal(h.viewer.counters.peakCanvases, 6);
  assert.equal(h.viewer.counters.renderedPages, 12);
  assert.deepEqual(h.viewer.slots.map(slot => slot.element.getAttribute('data-page')), Array.from({length:100}, (_,i) => String(i+1)));
  assert.equal(h.viewer.slots[0].element.children.length, 0);
  assert.equal(h.viewer.slots[49].element.children[0].tag, 'canvas');
});

test('zoom and source repetition reuse the loaded PDF and preserve resident bounds', async () => {
  const h = harness();
  await h.viewer.setSource('local-resource:/test.pdf?version=1');
  await settle();
  h.observe(98);
  await settle();
  const firstCanvas = h.viewer.slots[97].element.children[0];
  h.viewer.layout({ pdfFitMode:'custom',pdfZoom:200 });
  await settle();
  assert.equal(firstCanvas.width, 0, 'eviction must release backing-store memory');
  assert.equal(h.viewer.slots[97].element.style.width, '1224px');
  const created = h.viewer.counters.createdCanvases;
  await h.viewer.setSource('local-resource:/test.pdf?version=1');
  await settle();
  assert.equal(h.viewer.counters.pdfTransfers, 1);
  assert.equal(h.viewer.counters.createdCanvases, created, 'unchanged content must not recreate page canvases');
  assert.equal(h.viewer.counters.peakCanvases, 6);
  assert.deepEqual(h.destroyed, []);
  assert.deepEqual(h.errors, []);
});

test('out-of-order getPage completion cannot publish an evicted page', async () => {
  const slow = deferred();
  const h = harness({ pageWait: (number, page) => number === 1 ? slow.promise.then(() => page) : Promise.resolve(page) });
  await h.viewer.setSource('local-resource:/test.pdf');
  h.observe(70);
  slow.resolve();
  await settle();
  assert.equal(h.viewer.slots[0].element.children.length, 0);
  assert.equal(h.viewer.counters.activeCanvases, 6);
  assert.equal(h.viewer.counters.peakCanvases, 6);
  assert.ok(h.cleanups.includes(1));
});

test('null source clears and invalidates an in-flight PDF load', async () => {
  const loadWait = deferred();
  const h = harness({ loadWait });
  const loading = h.viewer.setSource('local-resource:/old.pdf');
  await settle();
  await h.viewer.setSource(null);
  loadWait.resolve(h.pdf);
  await loading;
  assert.equal(h.viewer.source, null);
  assert.equal(h.viewer.counters.activeCanvases, 0);
  assert.equal(h.pane.children.length, 0);
  assert.deepEqual(h.pagesRequested, []);
  assert.deepEqual(h.destroyed, ['load','document']);
});

test('clearing a rendered document cancels work and releases every canvas', async () => {
  const renderWait = deferred();
  const h = harness({ renderWait });
  await h.viewer.setSource('local-resource:/old.pdf');
  await settle();
  h.viewer.clear();
  renderWait.resolve();
  await settle();
  assert.equal(h.viewer.counters.activeCanvases, 0);
  assert.equal(h.viewer.counters.renderedPages, 0);
  assert.equal(h.pane.children.length, 0);
  assert.equal(h.cancelled.length, 6);
  assert.equal(h.observer.disconnected, true);
  assert.deepEqual(h.errors, []);
});


test('a queued scroll event from a disposed PDF cannot access or update a newer document', async () => {
  const h = harness();
  await h.viewer.setSource('local-resource:/old.pdf');
  const old = h.viewer.container;
  h.viewer.clear();
  assert.doesNotThrow(() => old.listeners.scroll());
  assert.equal(h.viewer.container, null);
});


test('zoom and scroll changed during an initial PDF load remain authoritative at completion', async () => {
  const loadWait = deferred();
  const h = harness({ loadWait });
  const first = h.viewer.setSource('local-resource:/test.pdf', { pdfFitMode: 'width', pdfZoom: 100 }, { top: 100, left: 0 });
  await settle();
  const newest = h.viewer.setSource('local-resource:/test.pdf', { pdfFitMode: 'custom', pdfZoom: 200 }, { top: 2400, left: 20 });
  loadWait.resolve(h.pdf);
  await Promise.all([first, newest]);
  await settle();
  assert.deepEqual(h.viewer.settings, { pdfFitMode: 'custom', pdfZoom: 200 });
  assert.equal(h.viewer.slots[0].element.style.width, '1224px');
  assert.equal(h.viewer.container.scrollTop, 2400);
  assert.equal(h.viewer.container.scrollLeft, 20);
  assert.equal(h.viewer.counters.pdfTransfers, 1);
  assert.equal(h.viewer.counters.peakCanvases, 6);
});


test('a failed PDF load can be retried for the same resource without reopening the document', async () => {
  const h = harness();
  const load = h.viewer.loadLibrary;
  let attempts = 0;
  h.viewer.loadLibrary = async () => { if (++attempts === 1) throw new Error('transient resource failure'); return load(); };
  await h.viewer.setSource('local-resource:/retry.pdf');
  assert.equal(h.viewer.source, null);
  assert.equal(h.errors.length, 1);
  await h.viewer.setSource('local-resource:/retry.pdf');
  await settle();
  assert.equal(attempts, 2);
  assert.equal(h.viewer.pdf, h.pdf);
  assert.equal(h.viewer.counters.activeCanvases, 6);
});
