const test = require('node:test');
const assert = require('node:assert/strict');
const MarkdownIt = require('markdown-it');
const { parseDocument } = require('htmlparser2');
const { sanitizeRawHtml, sanitizeHtmlStyle, installSafeHtmlRendering, HtmlSafetyLimitError } = require('../out/html-safety');

const markdown = options => {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
  installSafeHtmlRendering(md, options);
  return md;
};
const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
const nodes = html => descendants(parseDocument(html)).filter(node => node.type === 'tag' || node.type === 'script' || node.type === 'style');

test('raw block HTML strips scripts, foreign content, embedded documents, forms, and event handlers', () => {
  const source = '<div><p onclick="run()">Visible</p><script>secret_script()</script><style>body{display:none}</style>' +
    '<svg><foreignObject><p>foreign secret</p><script>run()</script></foreignObject></svg>' +
    '<math><mtext>math secret</mtext></math><iframe srcdoc="&lt;script&gt;run()&lt;/script&gt;">frame secret</iframe>' +
    '<object data="https://example.org">object secret</object><form><input autofocus onfocus="run()"></form></div>';
  assert.equal(sanitizeRawHtml(source), '<div><p>Visible</p></div>');
  assert.equal(markdown().render(source), '<div><p>Visible</p></div>');
});

test('unsafe inline elements suppress their contents across Markdown tokens without altering surrounding prose', () => {
  const rendered = markdown().render('Before **safe** <script>bad **secret** [click](https://example.org)</script> after ' +
    '<svg><a href="javascript:run()">hidden</a><svg>nested</svg>also hidden</svg> $a_b < c$ end.');
  assert.equal(rendered, '<p>Before <strong>safe</strong>  after  $a_b &lt; c$ end.</p>\n');
});

test('inline citation and reference links remain correctly nested rather than closing every raw opening token', () => {
  const source = 'As <span class="citation" data-cites="smith2024 doe:2025">[<a href="#ref-smith2024" role="doc-biblioref">Smith</a>; Doe]</span> notes.';
  assert.equal(markdown().render(source), `<p>${source}</p>\n`);
});

test('approved CSL markup and reference typography survive sanitization', () => {
  const source = '<section class="references-section"><h2 class="inkwell-reference-heading references-heading unnumbered" id="references">References</h2>' +
    '<div id="refs" class="references csl-bib-body hanging-indent" role="doc-bibliography" style="font-size:9.962640pt;line-height:1.2;--inkwell-reference-entry-space:0.48em;">' +
    '<div id="ref-smith2024" class="csl-entry" role="doc-biblioentry"><span class="csl-left-margin">1.</span> ' +
    '<span class="csl-right-inline"><i>Research</i>. <a href="https://doi.org/10.1/test?a=1&amp;b=2">DOI</a>.</span></div></div></section>';
  assert.equal(sanitizeRawHtml(source), source);
  assert.equal(markdown().render(source), source);
});

test('body tables retain approved presentation variables, captions, provenance, and alignment', () => {
  const source = '<div class="inkwell-table-scroll" role="region" aria-label="Table" tabindex="0" ' +
    'style="--inkwell-table-font-size:10pt;--inkwell-table-rule-thickness:0.5pt;--inkwell-table-padding-horizontal:6pt;--inkwell-table-padding-vertical:3pt;' +
    '--inkwell-table-header-weight:700;--inkwell-table-header-background:transparent;--inkwell-table-stripe-color:#f5f5fa;--inkwell-table-rule-color:currentColor;' +
    '--inkwell-table-caption-style:italic;--inkwell-table-width:100%;">' +
    '<table class="inkwell-table table-preset-grid" id="tbl:summary" data-inkwell-artifact="results.csv" data-inkwell-block="summary">' +
    '<caption style="caption-side:bottom;">Summary</caption><thead><tr><th scope="col" class="inkwell-table-literal" style="text-align:right;">Value</th></tr></thead>' +
    '<tbody><tr><td class="inkwell-table-literal" colspan="2">$x$ &lt;b&gt;literal&lt;/b&gt;</td></tr></tbody></table></div>';
  assert.equal(sanitizeRawHtml(source), source);
  assert.equal(markdown().render(source), source);
});

test('entity-obfuscated, encoded, control-character, protocol-relative, and active URLs are removed', () => {
  const unsafe = ['javascript:run()', 'jAvAsCrIpT:run()', 'java&#x0a;script:run()', '&#106;avascript:run()',
    'javascript&colon;run()', 'data:text/html,attack', 'vbscript:run()', 'file:///etc/passwd', 'command:workbench.action.openSettings',
    '//example.org/track', '\\example.org/track', '%6aavascript%3arun()', '%2f%2fexample.org/track', '../private.txt', '%2e%2e/private.txt'];
  for (const url of unsafe) {
    assert.equal(nodes(sanitizeRawHtml(`<a href="${url}">Label</a>`))[0].attribs.href, undefined, url);
  }
});

test('safe local and web reference links remain usable; raw images cannot initiate remote requests', () => {
  for (const url of ['#ref-key', 'notes/chapter.md#section', 'https://doi.org/10.1/abc', 'mailto:author@example.org']) {
    assert.equal(nodes(sanitizeRawHtml(`<a href="${url}">Label</a>`))[0].attribs.href, url);
  }
  assert.equal(sanitizeRawHtml('<img src="figures/chart.png" alt="Chart" width="400" onerror="run()">'), '<img src="figures/chart.png" alt="Chart" width="400">');
  for (const src of ['https://example.org/track', 'data:image/svg+xml,attack', '/tmp/private.png', 'file:///tmp/private.png', '../private.png']) {
    assert.equal(nodes(sanitizeRawHtml(`<img src="${src}" alt="Image">`))[0].attribs.src, undefined, src);
  }
});

test('CSS filtering removes resource loads, escapes, expressions, overlays, and arbitrary variables', () => {
  const css = 'color:#123456;background-image:url(https://example.org);position:fixed;inset:0;z-index:99999;' +
    'width:expression(alert(1));font-family:evil;--secret:url(data:x);text-align:right;--inkwell-table-rule-color:var(--secret);' +
    'background-color:exp\\72 ession(alert(1));font-size:999999pt;--inkwell-table-width:calc(100% + 1px);';
  assert.equal(sanitizeHtmlStyle(css), 'color:#123456;text-align:right;');
  assert.equal(sanitizeHtmlStyle('font-size:10pt;line-height:1.2;text-indent:-1.5em;--inkwell-reference-entry-space:0.4em;'),
    'font-size:10pt;line-height:1.2;text-indent:-1.5em;--inkwell-reference-entry-space:0.4em;');
});

test('browser-confusing malformed and foreign markup cannot survive as active content', () => {
  const payloads = [
    '<svg><style><img src=x onerror=alert(1)></style></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=run()>">',
    '<noscript><p title="</noscript><img src=x onerror=run()>">',
    '<IMG SRC=javascript:run() onerror=run()>',
    '<script/>run()</script><p>safe</p>',
    '<!--><script>run()</script>--><p>safe</p>',
    '<div title="&quot; onmouseover=&quot;run()">safe</div>',
    '<table><tr><td><iframe><img src=x onerror=run()></iframe></td></tr></table>',
  ];
  for (const payload of payloads) {
    const safe = sanitizeRawHtml(payload);
    for (const element of nodes(safe)) {
      assert.ok(!['script', 'style', 'svg', 'math', 'iframe', 'noscript', 'form'].includes(element.name), safe);
      for (const [name, value] of Object.entries(element.attribs)) {
        assert.ok(!/^on/.test(name), safe);
        if (['src', 'href'].includes(name)) assert.doesNotMatch(value, /^(?:javascript|data|vbscript|file):/i);
      }
    }
    assert.equal(sanitizeRawHtml(safe), safe, 'sanitization should remain stable after reparsing');
  }
});

test('comments, processing instructions, metadata, and document-shell tags have no executable output', () => {
  assert.equal(sanitizeRawHtml('<?xml version="1"?><!DOCTYPE html><!-- comment --><meta http-equiv="refresh" content="0;url=https://example.org"><base href="https://example.org"><link rel="stylesheet" href="x"><p>safe</p>'), '<p>safe</p>');
});

test('ordinary Markdown, escaped raw text, code fences, and math retain their original output byte-for-byte', () => {
  const source = '# Heading\n\nPlain **bold** and *italic*, $a_b < c$ and \\(x < y\\).\n\n' +
    '`<script>literal code</script>` and &lt;img src=x onerror=run()&gt;.\n\n' +
    '```html\n<script>alert(1)</script>\n```\n\n| Col | Value |\n| --- | ---: |\n| $x$ | 12 |\n';
  const ordinary = new MarkdownIt({ html: true, linkify: true, typographer: true });
  assert.equal(markdown().render(source), ordinary.render(source));
});

test('actual preview math shielding wrappers retain the exact attributes required by restoration', () => {
  const inline = '<span data-inkwell-math="0">INKWELLMATHPLACEHOLDER0ENDMATH</span>';
  const display = '<div class="math-display" data-inkwell-math="1">INKWELLMATHPLACEHOLDER1ENDMATH</div>';
  assert.equal(markdown().renderInline(inline), inline);
  assert.equal(markdown().render(display), display);
  assert.equal(sanitizeRawHtml('<span data-inkwell-math="javascript:run()" onclick="run()">x</span>'), '<span>x</span>');
});

test('the generated approximate-citation notice stays visible and cannot introduce active content', () => {
  const notice = '<aside class="citation-preview-notice">Approximate citation preview: Pandoc is unavailable or could not render this bibliography. The active CSL style is not applied.</aside>';
  assert.equal(markdown().render(notice), notice);
  assert.equal(markdown().render('<aside class="citation-preview-notice" onclick="run()">Approximate<script>run()</script></aside>'),
    '<aside class="citation-preview-notice">Approximate</aside>');
});

test('generated reference typography retains decimal point spacing and indent variables', () => {
  const source = '<div class="csl-bib-body hanging-indent" style="font-size:10.5pt;line-height:1.15;--inkwell-reference-entry-space:17.6pt;--inkwell-reference-indent:26.4pt;"><div class="csl-entry">Reference</div></div>';
  assert.equal(markdown().render(source), source);
  assert.equal(sanitizeRawHtml('<div style="--inkwell-reference-indent:url(https://example.org);--inkwell-reference-entry-space:-1pt;">Reference</div>'), '<div>Reference</div>');
});

test('inline HTML nesting is bounded across tokens and the depth budget resets between renders', () => {
  const md = markdown({ maxDepth: 2 });
  assert.throws(() => md.renderInline('text <span><b><i>deep</i></b></span>'), HtmlSafetyLimitError);
  assert.equal(md.renderInline('<span><b>valid</b></span>'), '<span><b>valid</b></span>');
  assert.equal(md.renderInline('<span><b>next</b></span>'), '<span><b>next</b></span>');
  assert.throws(() => md.renderInline('<span/><b/><i/>'), HtmlSafetyLimitError, 'HTML self-closing syntax does not close nonvoid elements');
});

test('quoted greater-than characters cannot bypass inline suppression of active content', () => {
  assert.equal(markdown().renderInline('before <script title=">">hidden **content**</script> after'), 'before  after');
  assert.equal(markdown().renderInline('before <svg aria-label=">"><a href="https://example.org">hidden</a></svg> after'), 'before  after');
});

test('raw inline opener/closer sanitization preserves emphasis and does not leak suppression across renders', () => {
  const md = markdown();
  assert.equal(md.renderInline('A <span onclick="run()" class="citation">**B**</span> C'), 'A <span class="citation"><strong>B</strong></span> C');
  assert.equal(md.renderInline('A <script>hidden'), 'A ');
  assert.equal(md.renderInline('Next $a_b$'), 'Next $a_b$');
  installSafeHtmlRendering(md);
  assert.equal(md.renderInline('<i>Valid</i>'), '<i>Valid</i>');
});

test('DOM-clobbering identifiers, chrome classes, arbitrary attributes, and active controls are removed', () => {
  assert.equal(sanitizeRawHtml('<div id="compile-btn" class="inkwell-toolbar csl-entry" contenteditable="true" draggable="true" data-command="compile" tabindex="0"><a name="constructor" target="_blank" ping="https://example.org" href="#ref-safe">Read</a></div>'),
    '<div class="csl-entry"><a href="#ref-safe">Read</a></div>');
});

test('input, output, node, and nesting limits fail explicitly instead of publishing partial HTML', () => {
  for (const [source, options] of [
    ['<p>abc</p>', { maxInputBytes: 8 }],
    ['<p>&</p>', { maxOutputBytes: 10 }],
    ['<p>A</p><p>B</p>', { maxNodes: 1 }],
    ['<div><span><b>X</b></span></div>', { maxDepth: 2 }],
  ]) assert.throws(() => sanitizeRawHtml(source, options), HtmlSafetyLimitError);
  assert.throws(() => sanitizeRawHtml('x', { maxInputBytes: Infinity }), TypeError);
  assert.throws(() => markdown({ maxNodes: 3 }).render('x <b>1</b> <i>2</i>'), HtmlSafetyLimitError,
    'the budget must accumulate across raw inline tokens in one render');
  const md = markdown({ maxNodes: 3 });
  assert.doesNotThrow(() => md.render('x <b>1</b>'));
  assert.doesNotThrow(() => md.render('x <b>2</b>'), 'budgets reset between renders');
});
