const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const MarkdownIt = require('markdown-it');
const { resolveDocumentConfig } = require('../out/document-config');
const { resolveTableStyle, buildTableCss } = require('../out/table-model');
const { buildTypographyCss, TEX_POINT_TO_CSS_POINT } = require('../out/style-model');
const { extractTablePresentation } = require('../out/table-preview');
const { TABLE_ATTRIBUTE_SCHEMA } = require('../out/table-values');

test('actual browser measures all table presets, caption positions, literal cells and bounded wrapping', {
  skip: !process.env.INKWELL_CHROME_BIN, timeout: 30000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-tables-browser-'));
  t.diagnostic(`Table browser evidence: ${root}`);
  const presets = ['booktabs', 'grid', 'plain', 'zebra', 'compact'];
  const expected = [];
  const articles = presets.map(preset => {
    const below = ['plain', 'zebra'].includes(preset);
    const config = resolveDocumentConfig({ text: `---\ntable-font-size: 9pt\ntables:\n  preset: ${preset}\n  headerBackground: '#ddeeff'\n  ruleColor: '#336699'\n  captionPosition: ${below ? 'below' : 'above'}\n  alignment: [center, center]\n---\n` });
    const payload = { schemaVersion: 1, headers: ['Heading', 'Number'], rows: [
      ['TableMarker\nSecondLineMarker | "quotes", commas', '1,234.50'], ['W'.repeat(300), '-.5e+2%'],
    ], caption: 'CaptionMarker', attributes: { 'table-column-alignment': 'left right' } };
    const tables = extractTablePresentation('```inkwell-table-data\n' + JSON.stringify(payload) + '\n```');
    const html = tables.render(new MarkdownIt({ html: true }), tables.markdown, attributes => {
      const { style, diagnostics } = resolveTableStyle(config, attributes);
      expected.push({ preset, style, below });
      return { ...style, cssText: buildTableCss(style), diagnostics,
        alignmentIsLocal: TABLE_ATTRIBUTE_SCHEMA.find(rule => rule.field === 'alignment').aliases.some(key => attributes[key] !== undefined) };
    });
    return `<article class="inkwell-document" data-preset="${preset}" style="${buildTypographyCss(config)}"><h2>${preset}</h2>${html}</article>`;
  }).join('\n');
  const script = `const measured=[...document.querySelectorAll('article')].map(article=>{
    const table=article.querySelector('table'),wrapper=table.parentElement,rows=table.tBodies[0].rows;
    const caption=table.caption,cell=rows[0].cells[0],header=table.tHead.rows[0].cells[0];
    const cs=getComputedStyle(cell),ts=getComputedStyle(table),hs=getComputedStyle(header);
    return {preset:article.dataset.preset,fontSize:parseFloat(cs.fontSize),lineHeight:parseFloat(cs.lineHeight),
      padding:parseFloat(cs.paddingTop),border:parseFloat(cs.borderLeftWidth),outerBorder:parseFloat(ts.borderTopWidth),
      headerColor:hs.backgroundColor,headerWeight:hs.fontWeight,stripe:getComputedStyle(rows[1]).backgroundColor,
      captionBelow:caption.getBoundingClientRect().top>cell.getBoundingClientRect().top,
      align:[...rows[0].cells].map(c=>getComputedStyle(c).textAlign),literal:cell.innerText,
      whiteSpace:cs.whiteSpace,wrapperWidth:wrapper.clientWidth,tableWidth:table.getBoundingClientRect().width,
      overflow:getComputedStyle(wrapper).overflowX,tabindex:wrapper.getAttribute('tabindex'),scrollWidth:wrapper.scrollWidth};
  });const result=document.createElement('pre');result.id='browser-result';result.textContent=JSON.stringify(measured);document.body.appendChild(result);`;
  const css = fs.readFileSync(path.resolve(__dirname, '../media/preview.css'), 'utf8');
  const fixture = path.join(root, 'tables.html');
  fs.writeFileSync(fixture, `<meta charset="utf-8"><style>${css}\nbody{background:white;color:black;padding:20px}article{width:520px;margin-bottom:30px}</style>${articles}<script>${script}</script>`);
  const { stdout } = await promisify(execFile)(process.env.INKWELL_CHROME_BIN, [
    '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-extensions', '--no-first-run',
    `--user-data-dir=${path.join(root, 'profile')}`, '--virtual-time-budget=500', '--dump-dom', pathToFileURL(fixture).href,
  ], { timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
  const match = stdout.match(/<pre id="browser-result">([^<]+)<\/pre>/);
  assert.ok(match, 'Chrome produced actual layout measurements');
  const measured = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  for (const actual of measured) {
    const { style, below } = expected.find(item => item.preset === actual.preset);
    assert.ok(Math.abs(actual.fontSize - style.fontSizePt * TEX_POINT_TO_CSS_POINT * 4 / 3) < .02);
    assert.ok(Math.abs(actual.lineHeight - actual.fontSize * 1.2) < .02);
    assert.ok(Math.abs(actual.padding - style.paddingVerticalPt * TEX_POINT_TO_CSS_POINT * 4 / 3) < .02);
    assert.equal(actual.border > 0, actual.preset === 'grid');
    assert.equal(actual.outerBorder > 0, actual.preset !== 'plain');
    assert.equal(actual.headerColor, 'rgb(221, 238, 255)'); assert.equal(actual.headerWeight, '700');
    assert.equal(actual.stripe, actual.preset === 'zebra' ? 'rgb(245, 245, 250)' : 'rgba(0, 0, 0, 0)');
    assert.equal(actual.captionBelow, below); assert.deepEqual(actual.align, ['left', 'right']);
    assert.equal(actual.literal, 'TableMarker\nSecondLineMarker | "quotes", commas');
    assert.equal(actual.whiteSpace, 'pre-wrap'); assert.equal(actual.overflow, 'auto'); assert.equal(actual.tabindex, '0');
    assert.ok(actual.tableWidth <= actual.wrapperWidth + 1); assert.ok(actual.scrollWidth <= actual.wrapperWidth + 1);
  }
  fs.writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(measured, null, 2));
});
