const test = require('node:test');
const assert = require('node:assert/strict');
const MarkdownIt = require('markdown-it');
const { extractTablePresentation } = require('../out/table-preview');

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
const pipe = '| Name | Value |\n|:--|--:|\n| Alpha | 12 |';
function render(source, transform = value => value) {
  const presentation = extractTablePresentation(source);
  const observed = [];
  const html = presentation.render(md, transform(presentation.markdown), attributes => {
    observed.push(attributes);
    return { preset: attributes['table-preset'] || attributes['table-style'] || 'booktabs',
      captionPosition: attributes['caption-position'] || 'above', cssText: '--table-color:#123456;', diagnostics: [] };
  });
  return { ...presentation, html, observed };
}

test('a Pandoc caption becomes a real table caption with formatting, label, alignment, and one overflow wrapper', () => {
  const result = render(`${pipe}\n\n: Results **bold** {#tbl:results .grid caption-position=below}\n`);
  assert.equal((result.html.match(/class="inkwell-table-scroll"/g) || []).length, 1);
  assert.match(result.html, /<table class="inkwell-table table-preset-grid" id="tbl:results">\s*<caption style="caption-side:bottom">/);
  assert.match(result.html, /<strong>Table 1:<\/strong> Results <strong>bold<\/strong><\/caption>/);
  assert.match(result.html, /<th style="text-align:left">Name<\/th>/);
  assert.match(result.html, /<td style="text-align:right">12<\/td>/);
  assert.doesNotMatch(result.html, /figcaption|INKWELLTABLE|caption-position=below/);
  assert.equal(result.labels.get('tbl:results'), 'Table 1');
  assert.deepEqual(result.observed, [{ 'caption-position': 'below', 'table-preset': 'grid' }]);
});

test('caption placement is explicit and a caption above the source table still uses the normalized placement', () => {
  const result = render(`Table: Before *emphasis* {#tbl:before .plain caption-position=below}\n\n${pipe}\n`);
  assert.match(result.html, /<caption style="caption-side:bottom"><strong>Table 1:<\/strong> Before <em>emphasis<\/em><\/caption>/);
  assert.match(result.html, /table-preset-plain/);
  assert.equal(result.labels.get('tbl:before'), 'Table 1');
});

test('unlabelled and empty captions attach attributes without inventing a visible label', () => {
  const noId = render(`${pipe}\n\n: Caption without ID\n`);
  assert.match(noId.html, /<caption style="caption-side:top">Caption without ID<\/caption>/);
  assert.equal(noId.labels.size, 0);
  const empty = render(`${pipe}\n\n: {#tbl:empty .zebra}\n`);
  assert.match(empty.html, /table-preset-zebra" id="tbl:empty"/);
  assert.doesNotMatch(empty.html, /<caption|\{#tbl:empty/);
  assert.equal(empty.labels.size, 0);
});

test('explicit table preset or legacy table-style wins over a class shorthand', () => {
  for (const key of ['table-preset', 'table-style']) {
    const result = render(`${pipe}\n\n: Caption {.grid ${key}="plain"}\n`);
    assert.match(result.html, /table-preset-plain/);
    assert.equal(result.observed[0][key], 'plain');
  }
});

test('caption inline citations and math remain visible to transforms while metadata stays protected', () => {
  const result = render(`${pipe}\n\n: See @source and $x_1$ {#tbl:cited table-preset=compact}\n`, value => {
    assert.match(value, /See @source and \$x_1\$/);
    assert.doesNotMatch(value, /table-preset=compact|#tbl:cited/);
    return value.replace('@source', '<a class="citation" href="#ref-source">[1]</a>').replace('$x_1$', 'MATHPLACEHOLDER');
  });
  assert.match(result.html, /<caption[^>]*>[\s\S]*<a class="citation" href="#ref-source">\[1\]<\/a> and MATHPLACEHOLDER<\/caption>/);
});

test('captions cannot jump across prose or attach twice between neighboring tables', () => {
  const source = `${pipe}\n\n: First {#tbl:first}\n\nMiddle paragraph.\n\n${pipe}\n\n: Second {#tbl:second}\n`;
  const result = render(source);
  assert.equal((result.html.match(/<caption/g) || []).length, 2);
  assert.equal(result.labels.get('tbl:first'), 'Table 1'); assert.equal(result.labels.get('tbl:second'), 'Table 2');
  assert.match(result.html, /<\/div>\s*<p>Middle paragraph\.<\/p>\s*<div class="inkwell-table-scroll"/);
  const orphan = render(`: An unrelated caption\n\nA paragraph.\n\n${pipe}\n`);
  assert.doesNotMatch(orphan.html, /<caption/); assert.match(orphan.html, /<p>: An unrelated caption<\/p>/);
});

test('bare attribute paragraphs are preserved rather than claimed as table attributes', () => {
  const result = render(`${pipe}\n\n{#tbl:bare .grid}\n`);
  assert.match(result.html, /<p>\{#tbl:bare \.grid\}<\/p>/);
  assert.equal(result.labels.size, 0); assert.match(result.html, /table-preset-booktabs/);
});

test('unchanged tables produce stable citation input and source marker lookalikes stay ordinary content', () => {
  const source = `${pipe}\n\n: Caption {#tbl:stable}\n\n<!--INKWELLTABLEpretendtable0-->\n`;
  const first = render(source), second = render(source);
  assert.equal(first.markdown, second.markdown);
  assert.equal(first.html, second.html);
  assert.match(first.html, /<!--INKWELLTABLEpretendtable0-->/);
});

test('safe IDs and normalized attributes cannot create arbitrary HTML attributes', () => {
  const result = render(`${pipe}\n\n: Caption {#tbl:safe .grid onclick="evil()" data-inkwell-artifact="a & b \\" quoted"}\n`);
  assert.doesNotMatch(result.html, /onclick=/);
  assert.match(result.html, /data-inkwell-artifact="a &amp; b &quot; quoted"/);
  assert.equal(result.observed[0].onclick, 'evil()');
  const duplicate = render(`${pipe}\n\n: One {#tbl:same}\n\n${pipe}\n\n: Two {#tbl:same}\n`);
  assert.equal((duplicate.html.match(/id="tbl:same"/g) || []).length, 1);
  assert.ok(duplicate.diagnostics.some(value => value.code === 'table-id-invalid'));
});

test('arbitrary raw LaTeX tables are escaped whole without guessing cells, macros, or mathematics', () => {
  const source = String.raw`Before.

\begin{table}[ht]
\caption{Nested \textbf{caption}}
\begin{tabular}{cc}
Research \& Development & $a_{i} + \frac{1}{2}$ \\
\multicolumn{2}{c}{A <script>alert(1)</script>} \\
\end{tabular}
\end{table}

After.`;
  const result = render(source);
  assert.equal((result.html.match(/inkwell-raw-table-notice/g) || []).length, 1);
  assert.match(result.html, /Research \\&amp; Development &amp; \$a_\{i\}/);
  assert.match(result.html, /\\multicolumn\{2\}\{c\}\{A &lt;script&gt;alert\(1\)&lt;\/script&gt;\}/);
  assert.doesNotMatch(result.html, /<table|<script>|<th>/);
  assert.match(result.html, /<p>Before\.<\/p>/); assert.match(result.html, /<p>After\.<\/p>/);
  assert.equal(source.includes('\\multicolumn{2}'), true);
});

test('raw table matching ignores commented endings and escaped percent signs', () => {
  const source = String.raw`\begin{longtable}{ll}
% \end{longtable}
100\% & Value \\
\end{longtable}

Following paragraph.`;
  const result = render(source);
  assert.match(result.html, /100\\% &amp; Value/);
  assert.match(result.html, /<p>Following paragraph\.<\/p>/);
});

test('raw table variants and unfinished environments retain their original source in the limitation view', () => {
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  for (const name of ['table', 'table*', 'tabular', 'tabular*', 'tabularx', 'longtable', 'longtblr', 'tblr']) {
    const source = `\\begin{${name}}{ll}\nA & B \\\\\n\\end{${name}}`;
    const result = render(source);
    assert.ok(result.html.includes(`<pre><code>${escape(source)}</code></pre>`), name);
    assert.doesNotMatch(result.html, /<table/);
  }
  const unfinished = '\\begin{table}\nUnknown \\macro{nested {text}} & <literal>';
  assert.ok(render(unfinished).html.includes(`<pre><code>${escape(unfinished)}</code></pre>`));
});

test('fenced, indented, and multiline inline-code LaTeX examples are never rewritten', () => {
  const raw = '\\begin{table}\n\\begin{tabular}{l}\nA \\\\\n\\end{tabular}\n\\end{table}';
  for (const source of ['```latex\n' + raw + '\n```\n', raw.split('\n').map(line => '    ' + line).join('\n'), 'Example ``\n' + raw + '\n`` end.']) {
    const result = render(source);
    assert.equal(result.markdown, source);
    assert.equal(result.html, md.render(source));
    assert.doesNotMatch(result.html, /inkwell-raw-table-notice/);
  }
});

test('ordinary document blocks retain MarkdownIt rendering when there are no tables', () => {
  const source = '# Heading\n\nA **paragraph** and [link](https://example.test).\n\n- Tight list\n- Second item\n\n> Quote\n';
  const result = render(source);
  assert.equal(result.markdown, source); assert.equal(result.html, md.render(source));
});

test('tables and captions inside a quote or list keep their original container', () => {
  for (const source of [
    '> | Name | Value |\n> |---|---|\n> | Alpha | 12 |\n>\n> : Nested caption {#tbl:nested .plain}\n',
    '- | Name | Value |\n  |---|---|\n  | Alpha | 12 |\n\n  : Nested caption {#tbl:nested .plain}\n',
  ]) {
    const result = render(source);
    assert.equal((result.html.match(/<table /g) || []).length, 1);
    assert.match(result.html, /<caption[^>]*><strong>Table 1:<\/strong> Nested caption<\/caption>/);
    assert.doesNotMatch(result.html, /INKWELLTABLE|\{#tbl:nested/);
    if (source.startsWith('>')) assert.match(result.html, /^<blockquote>\s*<div[\s\S]*<\/div>\s*<\/blockquote>/);
    else assert.match(result.html, /^<ul>\s*<li>\s*<div[\s\S]*<\/div>\s*<\/li>\s*<\/ul>/);
  }
});

test('local column alignment overrides source alignment and numeric inference skips rich or multiline values', () => {
  const source = '| Explicit | Numeric | Rich |\n|--:|---|:--|\n| 1 | 1,234.5 | **2** |\n| 2 | -3e2% | 3 |\n';
  const presentation = extractTablePresentation(source);
  const html = presentation.render(md, presentation.markdown, () => ({ preset: 'plain', captionPosition: 'above', cssText: '', alignment: ['center'], alignmentIsLocal: true, numericAlignment: 'right' }));
  assert.match(html, /<th style="text-align:center">Explicit<\/th>/);
  assert.match(html, /<th style="text-align:right">Numeric<\/th>/);
  assert.match(html, /<td style="text-align:right">1,234\.5<\/td>/);
  assert.match(html, /<th style="text-align:left">Rich<\/th>/);
  const payload = { schemaVersion: 1, headers: ['Numeric', 'Multiline', 'Empty'], rows: [['.5', '1\n2', ''], ['1.', '3', '']], attributes: {} };
  const data = extractTablePresentation('```inkwell-table-data\n' + JSON.stringify(payload) + '\n```\n');
  const literal = data.render(md, data.markdown, () => ({ preset: 'plain', captionPosition: 'above', cssText: '', numericAlignment: 'right' }));
  assert.match(literal, /<th class="inkwell-table-literal" style="text-align:right">Numeric<\/th>/);
  assert.match(literal, /<th class="inkwell-table-literal">Multiline<\/th>/);
  assert.match(literal, /<th class="inkwell-table-literal">Empty<\/th>/);
});

test('source colon alignment precedes document defaults and default columns remain eligible for numeric inference', () => {
  const source = '| Left | Right | Default | Numeric |\n|:---|---:|---|---|\n| 1 | 2 | 3 | 4 |\n';
  const presentation = extractTablePresentation(source);
  const style = { preset: 'plain', captionPosition: 'above', cssText: '', alignment: ['right', 'left', 'center'], numericAlignment: 'right' };
  const defaults = presentation.render(md, presentation.markdown, () => style);
  for (const [text, alignment] of [['Left', 'left'], ['Right', 'right'], ['Default', 'center'], ['Numeric', 'right']]) {
    assert.ok(defaults.includes(`<th style="text-align:${alignment}">${text}</th>`), text);
  }
  for (const [text, alignment] of [['1', 'left'], ['2', 'right'], ['3', 'center'], ['4', 'right']]) {
    assert.ok(defaults.includes(`<td style="text-align:${alignment}">${text}</td>`), text);
  }
  const local = presentation.render(md, presentation.markdown, () => ({ ...style, alignmentIsLocal: true }));
  assert.match(local, /<th style="text-align:right">Left<\/th>/);
  assert.match(local, /<th style="text-align:left">Right<\/th>/);
  assert.match(local, /<th style="text-align:center">Default<\/th>/);
});

test('generated table cells remain literal and private payloads do not reach citation or math transforms', () => {
  const payload = { schemaVersion: 1, headers: ['Name', '$price$'], rows: [['A | B', '**bold**\n@source <tag>']],
    caption: 'Generated *caption* @source', label: 'tbl:data', attributes: { 'table-preset': 'grid', 'data-inkwell-block': 'stable' } };
  const source = '```inkwell-table-data\n' + JSON.stringify(payload) + '\n```\n';
  const result = render(source, text => {
    assert.doesNotMatch(text, /schemaVersion|\*\*bold\*\*|\$price\$/);
    assert.match(text, /Generated \*caption\* @source/);
    return text.replace('@source', '<a class="citation">[1]</a>');
  });
  assert.match(result.html, /<th class="inkwell-table-literal">\$price\$<\/th>/);
  assert.match(result.html, /<td class="inkwell-table-literal">\*\*bold\*\*<br>@source &lt;tag&gt;<\/td>/);
  assert.match(result.html, /Generated <em>caption<\/em> <a class="citation">\[1\]<\/a>/);
  assert.match(result.html, /data-inkwell-block="stable"/); assert.equal(result.labels.get('tbl:data'), 'Table 1');
});

test('malformed private data is visibly reported and never emitted as executable HTML', () => {
  const result = render('```inkwell-table-data\n{"schemaVersion":1,"headers":"<script>"}\n```\n');
  assert.match(result.html, /inkwell-table-error/); assert.doesNotMatch(result.html, /<script>/);
  assert.ok(result.diagnostics.some(value => value.code === 'table-data-invalid'));
});
