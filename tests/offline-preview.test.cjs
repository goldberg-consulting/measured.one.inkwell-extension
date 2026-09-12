const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { shell } = require('./preview-shell-helper.cjs');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const styleParity = require('./helpers/browser-style-parity.cjs');
const root = path.resolve(__dirname, '..');
const assetRoot = path.resolve(process.env.INKWELL_PREVIEW_ASSET_ROOT || root);
const chrome = process.env.INKWELL_CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(file => fs.existsSync(file));

if (!chrome && process.env.INKWELL_REQUIRE_BROWSER === '1') throw new Error('A local Chrome/Chromium executable is required for the offline preview release gate.');

function pdfFixture(pages = 100) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const children = [];
  for (let number = 1; number <= pages; number++) {
    const page = objects.length, content = page + 1;
    children.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`);
    const stream = `BT /F1 22 Tf 72 700 Td (Page ${number} - Offline Preview) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Count ${pages} /Kids [${children.join(' ')}] >>`;
  let data = '%PDF-1.4\n'; const offsets = [0];
  for (let number = 1; number < objects.length; number++) {
    offsets[number] = Buffer.byteLength(data);
    data += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(data + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}


async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map(), handlers = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(String(event.data));
    if (data.id) { const item = pending.get(data.id); pending.delete(data.id); data.error ? item?.reject(new Error(data.error.message)) : item?.resolve(data.result); }
    else for (const handler of handlers.get(data.method) || []) handler(data.params);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  return { call, evaluate, on: (event, handler) => handlers.set(event, [...(handlers.get(event) || []), handler]), close: () => socket.close() };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await delay(40); } while (Date.now() < end);
  throw new Error('Timed out waiting for the offline preview fixture');
}

function zoomedPageInk() {
  const canvas = document.querySelector('[data-page="50"] canvas');
  if (!canvas || canvas.style.width !== '1224px' || canvas.width !== 1224 || canvas.height !== 1584) return false;
  // This fixture contains one text operation near the top of each page. Check
  // its actual painted pixels, including alpha: a newly attached transparent
  // canvas has zero RGB values and must not count as rendered black text.
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, 300).data;
  let inkPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] >= 128 && pixels[index] < 128 && pixels[index + 1] < 128 && pixels[index + 2] < 128) inkPixels++;
  }
  return inkPixels >= 20 && { page: 50, cssWidth: canvas.style.width, width: canvas.width, height: canvas.height, inkPixels };
}

test('real bundled preview renders math, Mermaid, code and bounded PDF pages with external network blocked', { skip: !chrome, timeout: 120000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-offline-browser-'));
  const requests = [], denied = [];
  const bytes = pdfFixture();
  let origin, resourceOrigin;
  const handleRequest = (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    requests.push(request.url);
    const requested = new URL(request.url, origin).pathname;
    if (requested === '/' || requested === '/index.html') {
      let html = shell(resourceOrigin);
      const nonce = html.match(/script-src 'nonce-([^']+)'/)[1];
      const bootstrap = `<script nonce="${nonce}">window.previewErrors=[];window.previewPolicies=[];window.previewSaved={};window.previewReady=false;
        window.addEventListener('error',e=>previewErrors.push(e.message));window.addEventListener('unhandledrejection',e=>previewErrors.push(String(e.reason)));
        window.addEventListener('securitypolicyviolation',e=>previewPolicies.push(e.violatedDirective+':'+e.blockedURI));
        window.acquireVsCodeApi=()=>({getState:()=>previewSaved,setState:s=>previewSaved=s,postMessage:m=>{if(m.type==='ready')previewReady=true;}});</script>`;
      html = html.replace(/(?=  <script nonce="[^"]+" src=)/, bootstrap);
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); return;
    }
    if (requested.endsWith('.pdf')) {
      const send = () => { response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length }); response.end(bytes); };
      if (requested === '/slow.pdf') setTimeout(send, 350); else send();
      return;
    }
    const file = path.resolve(assetRoot, '.' + requested);
    if (!requested.startsWith('/media/') || !file.startsWith(assetRoot + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    const type = /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type }); fs.createReadStream(file).pipe(response);
  };
  const server = http.createServer(handleRequest), resources = http.createServer(handleRequest);
  await Promise.all([server, resources].map(item => new Promise(resolve => item.listen(0, '127.0.0.1', resolve))));
  origin = `http://127.0.0.1:${server.address().port}`;
  resourceOrigin = `http://127.0.0.1:${resources.address().port}`;
  t.after(() => { for (const item of [server, resources]) { item.closeAllConnections(); item.close(); } });
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${temporary}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', data => { stderr += data; });
  let connection;
  const waitFor = async predicate => {
    try { return await until(predicate); }
    catch (error) {
      let state;
      try {
        state = connection && await Promise.race([connection.evaluate(`({ready:window.previewReady,metrics:window.inkwellPreviewMetrics,
          errors:window.previewErrors,policies:window.previewPolicies,saved:window.previewSaved,
          canvases:[...document.querySelectorAll('.pdf-page-placeholder canvas')].map(canvas=>({page:canvas.parentElement.dataset.page,width:canvas.width,height:canvas.height,cssWidth:canvas.style.width})),
          pdfStatus:document.getElementById('pdf-placeholder')?.textContent,log:document.getElementById('log-entries')?.textContent.slice(-2000)})`), delay(1000).then(() => ({ diagnosticTimeout: true }))]);
      } catch (cause) { state = { diagnosticError: String(cause) }; }
      const failure = { predicate: predicate.toString(), error: String(error), assetRoot, browserExit: browser.exitCode,
        browserSignal: browser.signalCode, state, requests: requests.slice(-100), denied, browserStderr: stderr.slice(-4000) };
      const file = path.join(os.tmpdir(), `inkwell-offline-failure-${Date.now()}-${process.pid}.json`);
      fs.writeFileSync(file, JSON.stringify(failure, null, 2) + '\n');
      t.diagnostic(`Offline browser failure evidence: ${file}`);
      throw new Error(`Offline preview wait failed: ${predicate.toString()}\n${JSON.stringify(state)}\nEvidence: ${file}`, { cause: error });
    }
  };
  t.after(async () => {
    browser.kill('SIGTERM');
    await Promise.race([new Promise(resolve => browser.once('close', resolve)), delay(2000)]);
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const debug = await waitFor(async () => {
    const portFile = path.join(temporary, 'DevToolsActivePort');
    return fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0];
  });
  const targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
  connection = await cdp(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  t.after(() => connection.close());
  await connection.call('Runtime.enable');
  await connection.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  connection.on('Fetch.requestPaused', event => {
    const allowed = event.request.url.startsWith(origin + '/') || event.request.url.startsWith(resourceOrigin + '/') || event.request.url.startsWith('data:') || event.request.url.startsWith('blob:');
    if (!allowed) denied.push(event.request.url);
    connection.call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
  });
  await connection.call('Page.navigate', { url: origin });
  await waitFor(() => connection.evaluate('window.previewReady === true'));
  assert.equal(requests.some(url => url.startsWith('/media/vendor/')), false, 'plain empty preview must not load optional vendors');
  const send = data => connection.evaluate(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(data)}}))`);
  const base = { documentUri: 'file:///offline.md', sourceVersion: 1, revision: 1 };
  const html = '<h1>Offline rendering</h1><p><span data-inkwell-math="0">$x^2 + y^2 = z^2$</span></p>' +
    '<div class="math-display" data-inkwell-math="1">$$a^2 + b^2 = c^2$$</div>' +
    '<p><span data-inkwell-math="2">\\(x + y\\)</span></p><div class="math-display" data-inkwell-math="3">\\[z = 2\\]</div>' +
    '<p class="currency-prose">Prices start at $20 and rise to $30.</p>' +
    '<table><tbody><tr><td class="currency-cell"><strong>$20 at closing + up to $30 in milestones</strong></td></tr>' +
    '<tr><td class="currency-cell">$5 upfront + $1–$2 annual minimum</td></tr>' +
    '<tr><td class="inkwell-table-literal">$x$ and $20</td></tr></tbody></table>' +
    '<p class="escaped-dollars">Escaped source dollars: $x$.</p><p><code class="literal-code">$x$ and $20</code></p>' +
    '<pre><code class="language-python">def answer():\n    return 42</code></pre><pre><code class="language-mermaid">graph TD; A[Local] --> B[Offline]</code></pre>';
  await connection.evaluate("document.querySelector('[data-tab=print]').click()");
  await send({ ...base, type: 'updateContent', html, pdfUri: resourceOrigin + '/fixture.pdf', title: 'Offline rendering' });
  await waitFor(() => connection.evaluate("!!document.querySelector('.katex') && !!document.querySelector('.mermaid svg') && !!document.querySelector('code.hljs .hljs-keyword')"));
  await waitFor(() => connection.evaluate("!!document.querySelector('#print-page-stage .katex') && !!document.querySelector('#print-page-stage .mermaid svg') && !!document.querySelector('#print-page-stage code.hljs .hljs-keyword')"));
  for (const pane of ['#article-content', '#print-page-stage']) {
    const math = await connection.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(pane)});return {
      marked:root.querySelectorAll('[data-inkwell-math] .katex').length,
      display:root.querySelectorAll('[data-inkwell-math] .katex-display').length,
      unexpected:root.querySelectorAll('.currency-prose .katex,.currency-cell .katex,.escaped-dollars .katex,.literal-code .katex,.inkwell-table-literal .katex').length,
      currency:root.querySelector('.currency-prose').textContent,
      cells:[...root.querySelectorAll('.currency-cell')].map(cell=>cell.textContent),
      bold:root.querySelector('.currency-cell strong')?.textContent,
      escaped:root.querySelector('.escaped-dollars').textContent,
      code:root.querySelector('.literal-code').textContent,
      literal:root.querySelector('.inkwell-table-literal').textContent
    };})()`);
    assert.equal(math.marked, 4, pane + ': all supported marked math delimiters render');
    assert.equal(math.display, 2, pane + ': both display math forms remain display math');
    assert.equal(math.unexpected, 0, pane + ': dollars outside validated math remain literal');
    assert.equal(math.currency, 'Prices start at $20 and rise to $30.');
    assert.deepEqual(math.cells, ['$20 at closing + up to $30 in milestones', '$5 upfront + $1–$2 annual minimum']);
    assert.equal(math.bold, '$20 at closing + up to $30 in milestones');
    assert.equal(math.escaped, 'Escaped source dollars: $x$.');
    assert.equal(math.code, '$x$ and $20');
    assert.equal(math.literal, '$x$ and $20');
  }
  assert.equal(requests.some(url => url.includes('pdfjs/')), false, 'PDF engine stays unloaded until the PDF tab opens');
  await connection.evaluate("document.querySelector('[data-tab=pdf]').click()");
  await waitFor(() => connection.evaluate('window.inkwellPreviewMetrics.renderedPages >= 6'));
  let measured = await connection.evaluate(`({pages:document.querySelectorAll('.pdf-page-placeholder').length,canvas:document.querySelectorAll('.pdf-page-placeholder canvas').length,
    metrics:window.inkwellPreviewMetrics,policies:window.previewPolicies,errors:window.previewErrors,
    ink:[...document.querySelector('canvas').getContext('2d').getImageData(0,0,document.querySelector('canvas').width,document.querySelector('canvas').height).data].some((v,i)=>i%4!==3&&v<128)})`);
  assert.equal(measured.pages, 100); assert.ok(measured.canvas <= 6); assert.equal(measured.metrics.pdfTransfers, 1); assert.equal(measured.ink, true, 'actual PDF.js canvas must contain rendered page text');
  assert.deepEqual(measured.errors, []); assert.deepEqual(measured.policies, []);
  await connection.evaluate("document.querySelector('[data-page=\"50\"]').scrollIntoView({block:'start'})");
  await waitFor(() => connection.evaluate("!!document.querySelector('[data-page=\"50\"] canvas') && !document.querySelector('[data-page=\"1\"] canvas')"));
  await connection.evaluate("const zoom=document.getElementById('pdf-zoom');zoom.value='200';zoom.dispatchEvent(new Event('change'))");
  // Zoom correctly cancels old in-flight page tasks, so their historical
  // completion count is nondeterministic. Assert the current visible output.
  const page50InkAt200Percent = await waitFor(() => connection.evaluate(`(${zoomedPageInk.toString()})()`));
  measured = await connection.evaluate('({metrics:window.inkwellPreviewMetrics, state:window.previewSaved})');
  assert.equal(measured.metrics.pdfTransfers, 1); assert.ok(measured.metrics.peakCanvases <= 6);
  assert.ok(await connection.evaluate("document.querySelectorAll('.pdf-page-placeholder canvas').length <= 6"));
  assert.equal(measured.state.pdfFitMode, 'custom'); assert.equal(measured.state.pdfZoom, 200);
  assert.ok(measured.state.scrollByDocument['file:///offline.md'].pdf.top > 0);
  assert.equal(requests.filter(url => url === '/fixture.pdf').length, 1, 'scroll and zoom must not resend or refetch the PDF');
  // Delay an actual Mermaid render, then replace its document before the
  // promise completes. Its old SVG must never reappear in the current article.
  await connection.evaluate(`(async()=>{const module=await import('${resourceOrigin}/media/vendor/mermaid.js');
    const render=module.default.render;module.default.render=(...args)=>new Promise(resolve=>{window.releaseOldMermaid=()=>{
      module.default.render=render;resolve(render(...args));};});})()`);
  await send({ ...base, revision: 2, sourceVersion: 2, type: 'updateContent', html: '<pre><code class="language-mermaid">graph LR; OLD[Stale diagram] --> X[Must not appear]</code></pre>', pdfUri: resourceOrigin + '/fixture.pdf' });
  await waitFor(() => connection.evaluate('typeof window.releaseOldMermaid === "function"'));
  await send({ ...base, revision: 3, sourceVersion: 3, type: 'updateContent', html: '<p>Newest content</p>', pdfUri: null });
  await send({ ...base, revision: 2, sourceVersion: 2, type: 'updateContent', html: '<p>STALE content</p>', pdfUri: resourceOrigin + '/fixture.pdf' });
  await connection.evaluate('window.releaseOldMermaid()');
  await delay(200);
  assert.equal(await connection.evaluate("document.getElementById('article-content').textContent"), 'Newest content');
  assert.equal(await connection.evaluate("document.querySelectorAll('.pdf-page-placeholder canvas').length"), 0);
  await send({ ...base, revision: 4, type: 'updateContent', html: '<p>Old document loading PDF</p>', pdfUri: resourceOrigin + '/slow.pdf' });
  await waitFor(() => connection.evaluate('window.inkwellPreviewMetrics.pdfTransfers === 2'));
  await send({ revision: 5, documentUri: 'file:///new-document.md', sourceVersion: 1, type: 'updateContent', html: '<p>New document</p>', pdfUri: null });
  await delay(600);
  assert.equal(await connection.evaluate("document.querySelectorAll('.pdf-page-placeholder').length"), 0);
  assert.equal(await connection.evaluate("document.getElementById('article-content').textContent"), 'New document');
  assert.deepEqual(await connection.evaluate('window.previewErrors'), []);
  assert.deepEqual(await connection.evaluate('window.previewPolicies'), []);
  const longArticle = '<h1>Scroll fixture</h1>' + '<p>Paragraph with enough text to verify document scroll isolation.</p>'.repeat(200);
  await connection.evaluate("document.querySelector('[data-tab=preview]').click()");
  await send({ revision: 6, documentUri: 'file:///scroll-a.md', sourceVersion: 1, type: 'updateContent', html: longArticle, pdfUri: null });
  await connection.evaluate("document.getElementById('pane-preview').scrollTop=3000");
  await waitFor(() => connection.evaluate("window.previewSaved.scrollByDocument['file:///scroll-a.md']?.preview?.top === 3000"));
  await connection.evaluate("document.querySelector('[data-tab=print]').click()");
  await connection.evaluate("document.getElementById('pane-print').scrollTop=1500");
  await waitFor(() => connection.evaluate("window.previewSaved.scrollByDocument['file:///scroll-a.md']?.print?.top === 1500"));
  await connection.evaluate("document.querySelector('[data-tab=preview]').click()");
  await send({ revision: 7, documentUri: 'file:///scroll-b.md', sourceVersion: 1, type: 'renderStarted', documentChanged: true });
  await delay(80);
  await send({ revision: 7, documentUri: 'file:///scroll-b.md', sourceVersion: 1, type: 'updateContent', html: longArticle, pdfUri: null });
  assert.equal(await connection.evaluate("document.getElementById('pane-preview').scrollTop"), 0, 'a new document starts at its own top');
  assert.equal(await connection.evaluate("document.getElementById('pane-print').scrollTop"), 0);
  await connection.evaluate("document.getElementById('pane-preview').scrollTop=900");
  await waitFor(() => connection.evaluate("window.previewSaved.scrollByDocument['file:///scroll-b.md']?.preview?.top === 900"));
  await send({ revision: 8, documentUri: 'file:///scroll-a.md', sourceVersion: 1, type: 'renderStarted', documentChanged: true });
  await delay(80);
  await send({ revision: 8, documentUri: 'file:///scroll-a.md', sourceVersion: 1, type: 'draftContent', html: longArticle });
  await delay(80);
  await send({ revision: 8, documentUri: 'file:///scroll-a.md', sourceVersion: 1, type: 'updateContent', html: longArticle, pdfUri: null });
  await waitFor(() => connection.evaluate("document.getElementById('pane-preview').scrollTop === 3000"));
  await connection.evaluate("document.querySelector('[data-tab=print]').click()");
  await waitFor(() => connection.evaluate("document.getElementById('pane-print').scrollTop === 1500"));
  const selectedRun = { revision: 8, documentUri: 'file:///scroll-a.md', sourceVersion: 1, runId: 1 };
  await send({ ...selectedRun, type: 'runStarted', blockCount: 1, blockIndices: [2] });
  assert.deepEqual(await connection.evaluate("[...document.querySelectorAll('#run-block-list .run-block-item')].map(row=>row.id)"), ['run-block-2']);
  await send({ ...selectedRun, type: 'blockProgress', index: 0, status: 'done', label: 'Dependency', total: 3 });
  assert.equal(await connection.evaluate("document.getElementById('run-summary').textContent"), '1/2 blocks');
  await send({ ...selectedRun, type: 'blockProgress', index: 2, status: 'done', label: 'Selected', total: 3 });
  assert.equal(await connection.evaluate("document.getElementById('run-summary').textContent"), '2/2 blocks');
  await send({ ...selectedRun, type: 'runComplete', outcome: 'done', ran: 2, cached: 0 });
  assert.deepEqual(await connection.evaluate("[...document.querySelectorAll('#run-block-list .run-block-item')].map(row=>[row.id,row.classList.contains('status-done')])"), [['run-block-0',true],['run-block-2',true]]);
  assert.equal(await connection.evaluate("document.querySelectorAll('#run-block-list .status-pending').length"), 0);
  // The existing asynchronous revision/scroll fixtures end at revision 8.
  // Use new identities afterward so style coverage cannot mask their races.
  const styleDirectory = path.join(temporary, 'style-fixtures'); fs.mkdirSync(styleDirectory);
  const renderStyle = styleParity.createStyleProvider(styleDirectory, root);
  const computedStyles = [];
  let styleRevision = 8;
  await send({ type: 'viewerState', state: { schemaVersion: 1, fontScale: 100, selectedTab: 'preview', pdfFitMode: 'width', pdfZoom: 100 } });
  await connection.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  for (const fixture of styleParity.cases()) {
    const publication = await renderStyle(fixture);
    await send({ ...publication, revision: ++styleRevision });
    const measurements = {};
    for (const [pane, tab, selector] of [['draft', 'preview', '#article-content'], ['print', 'print', '#print-page-stage']]) {
      await connection.evaluate(`document.querySelector('[data-tab=${tab}]').click()`);
      await waitFor(() => connection.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent.includes(${JSON.stringify('Body parity ' + fixture.id)}) && document.querySelectorAll(${JSON.stringify(selector + ' .csl-entry')}).length === 2 && !!document.querySelector(${JSON.stringify(selector + ' pre code.hljs')})`));
      measurements[pane] = await connection.evaluate(`(${styleParity.measure.toString()})(${JSON.stringify(selector)})`);
      styleParity.assertStyles(measurements[pane], fixture.expected, pane);
    }
    computedStyles.push({ id: fixture.id, template: fixture.template, ...measurements });
  }
  assert.equal(computedStyles.length, 48);
  assert.equal(new Set(computedStyles.map(item => item.template)).size, 10);
  assert.deepEqual(await connection.evaluate('window.previewErrors'), []);
  assert.deepEqual(await connection.evaluate('window.previewPolicies'), []);
  assert.deepEqual(denied, [], 'the preview must make no external runtime requests with the network blocked');
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    browser: await connection.call('Browser.getVersion'), assetRoot, vendorVersions: JSON.parse(fs.readFileSync(path.join(assetRoot, 'media/vendor/versions.json'), 'utf8')).packages,
    ...measured.metrics, fixturePages: 100, page50InkAt200Percent, actualPdfRequests: requests.filter(url => url.endsWith('.pdf')).length,
    externalRequests: denied.length, externalNetworkBlocked: true, crossOriginResources: true, printEnhancementsVerified: true, documentScrollIsolationVerified: true, selectedRunProgressVerified: true, cspViolations: [], browserErrors: [],
    styleParity: { verified: true, caseCount: computedStyles.length, templateCount: 10, panes: ['draft', 'print'], physicalPointUnit: '1/72.27 inch', fontCheck: 'computed declared family; PDF golden checks pin actual rendered fonts',
      providerModuleRoot: root, providerAttribution: 'Checkout compiled provider and Pandoc filters; release CI builds these from the release commit. The VSIX ships bundled entrypoints, not standalone provider modules.', clientAssetRoot: assetRoot,
      providerSha256: Object.fromEntries(['out/preview.js', 'out/document-config.js', 'out/style-model.js', 'out/table-model.js', 'out/table-preview.js', 'out/bibliography-service.js', 'out/citation-pandoc.js', 'filters/reference-common.lua', 'filters/reference-prepare.lua', 'filters/reference-render.lua', 'tests/fixtures/style/capabilities.json'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
      clientSha256: Object.fromEntries(['media/preview.css', 'media/preview-client.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(assetRoot, file))).digest('hex')])), computedStyles } };
  if (process.env.INKWELL_PREVIEW_REPORT) {
    fs.mkdirSync(path.dirname(process.env.INKWELL_PREVIEW_REPORT), { recursive: true });
    fs.writeFileSync(process.env.INKWELL_PREVIEW_REPORT, JSON.stringify(report, null, 2) + '\n');
  }
  t.diagnostic(JSON.stringify({ ...report, styleParity: { ...report.styleParity, computedStyles: undefined } }));
});
