const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pandoc = process.env.INKWELL_PANDOC || 'pandoc';
const available = cp.spawnSync(pandoc, ['--version'], { encoding: 'utf8' }).status === 0;
const markdown = '| Heading | Number |\n|:--|--:|\n| **Rich** cell | 1.25 |\n| Last | 2 |\n\n: A caption {#tbl:one}\n';
const defaults = { preset: 'booktabs', stripe: false, density: 'normal', fontSizePt: 10, headerWeight: 'bold', headerBackground: null, stripeColor: '#f5f5fa', ruleColor: '#000000', ruleThicknessPt: .4, paddingHorizontalPt: 6, paddingVerticalPt: 0, alignment: 'source', numericAlignment: 'source', width: 'auto', overflow: 'wrap', captionPosition: 'above', captionStyle: 'normal' };
function convert(source, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-table-filter-'));
  try {
    const args = ['-f', options.from || 'markdown', '-t', options.format || 'latex'];
    if (options.standalone) args.push('--standalone');
    if (options.model) {
      const metadata = path.join(temp, 'options.json');
      fs.writeFileSync(metadata, JSON.stringify({ 'inkwell-table-options': 'hex:' + Buffer.from(JSON.stringify({ schemaVersion: 1, enabled: true, templateId: 'default', bodySizePt: 11, defaults, explicit: [], supported: {}, ...options.model })).toString('hex') }));
      args.push('--metadata-file', metadata);
    }
    for (const filter of options.filters || ['table-data.lua', 'semantic-tables.lua']) args.push('--lua-filter', path.join(root, 'filters', filter));
    return cp.spawnSync(pandoc, args, { input: source, encoding: 'utf8' });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

test('private data tables preserve literal characters, spaces and newlines in a native AST', { skip: !available }, () => {
  const payload = { schemaVersion: 1, headers: ['Heading', 'Value'], rows: [['  a|b, "quoted"  ', '**not bold**\nnext'], ['λ', '$not math$']], caption: 'Generated caption', label: 'tbl:data', attributes: { 'table-preset': 'grid' } };
  const result = convert('```inkwell-table-data\n' + JSON.stringify(payload) + '\n```', { format: 'json', filters: ['table-data.lua'] });
  assert.equal(result.status, 0, result.stderr);
  const table = JSON.parse(result.stdout).blocks[0];
  assert.equal(table.t, 'Table');
  assert.equal(table.c[0][0], 'tbl:data');
  assert.deepEqual(table.c[0][2], [['table-preset', 'grid']]);
  const encoded = JSON.stringify(table);
  assert.match(encoded, /a\|b, \\\"quoted\\\"/);
  assert.match(encoded, /LineBreak/);
  assert.doesNotMatch(encoded, /"Strong"|"Math"/);
});

test('malformed private data fails conversion instead of printing partial or misleading tables', { skip: !available }, () => {
  const result = convert('```inkwell-table-data\n{"schemaVersion":1,"headers":["A"],"rows":[["x","extra"]]}\n```');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /row|column|width/i);
});

test('ordinary tables stay byte-identical without explicit styling', { skip: !available }, () => {
  const baseline = convert(markdown, { filters: [] });
  const filtered = convert(markdown);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.equal(filtered.stdout, baseline.stdout);
});

test('grid has cell rules and plain has no rules, scoped to native body tables', { skip: !available }, () => {
  const source = '\\begin{tabular}{l}LayoutSentinel\\\\\\end{tabular}\n\n' + markdown.replace('{#tbl:one}', '{#tbl:one .grid table-rule-color="#336699"}') + '\n' + markdown.replace('{#tbl:one}', '{#tbl:two .plain}');
  const result = convert(source, { model: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\\begin\{tabular\}\{l\}LayoutSentinel\\\\\\end\{tabular\}/);
  assert.match(result.stdout, /\\hline/);
  assert.match(result.stdout, /336699/);
  assert.match(result.stdout, /\\textbf\{Rich\}/);
  assert.doesNotMatch(result.stdout, /AtBeginEnvironment|rowcolors|inkwellRowMarker/);
  const groups = result.stdout.split('\\begingroup');
  assert.doesNotMatch(groups.at(-1), /^\\(?:toprule|midrule|bottomrule|hline)/m);
});

test('caption placement is per table and two-column constraints are authoritative', { skip: !available }, () => {
  const below = convert(markdown.replace('{#tbl:one}', '{#tbl:one table-caption-position="below"}'), { model: {} });
  assert.equal(below.status, 0, below.stderr);
  assert.ok(below.stdout.indexOf('\\caption') > below.stdout.indexOf('\\endhead'));
  const locked = convert(markdown.replace('{#tbl:one}', '{#tbl:one table-caption-position="below"}'), { model: { templateId: 'rho', supported: { captionPosition: false } } });
  assert.notEqual(locked.status, 0);
  assert.match(locked.stderr, /caption|above|support/i);
});

test('per-table untrusted values cannot become LaTeX commands', { skip: !available }, () => {
  const result = convert(markdown.replace('{#tbl:one}', '{#tbl:one table-rule-color="evil"}'), { model: {} });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /color|invalid/i);
});

test('generated JSON schema rejects objects masquerading as arrays and null cells', { skip: !available }, () => {
  for (const payload of [
    { schemaVersion: 1, headers: { 0: 'A' }, rows: [] },
    { schemaVersion: 1, headers: ['A'], rows: { ignored: ['bad'] } },
    { schemaVersion: 1, headers: ['A'], rows: [[null]] },
  ]) {
    const result = convert('```inkwell-table-data\n' + JSON.stringify(payload) + '\n```', { filters: ['table-data.lua'] });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /column|array|string/);
  }
});

test('per-table presets recompute density and stripes while explicit document values win', { skip: !available }, () => {
  const source = markdown.replace('{#tbl:one}', '{#tbl:one .zebra}');
  const model = { defaults: { ...defaults, stripe: false, paddingHorizontalPt: 8 }, explicit: ['stripe', 'paddingHorizontalPt'], presets: { zebra: { stripe: true, density: 'normal', ruleThicknessPt: .8 } }, densityPadding: { normal: [6, 3] } };
  const result = convert(source, { model });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tabcolsep\}\{8pt/);
  assert.doesNotMatch(result.stdout, /cellcolor/);
  const overridden = convert(source.replace('.zebra', '.zebra table-stripe=true'), { model });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.match(overridden.stdout, /cellcolor\[HTML\]\{F5F5FA\}/);
});

test('numeric inference accepts grouped/exponent values and explicit alignment wins', { skip: !available }, () => {
  const source = '| Text | Numeric |\n|--|--|\n| a | 1,234.50 |\n| b | -.5e+2% |\n\n: Numeric {#tbl:numeric table-numeric-alignment=right}\n';
  const result = convert(source, { model: { defaults: { ...defaults, alignment: [], numericAlignment: 'inherit' } } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /raggedleft/);
  const explicit = convert(source.replace('table-numeric-alignment=right', 'table-numeric-alignment=right table-alignment="l l"'), { model: {} });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.doesNotMatch(explicit.stdout, /raggedleft/);
});

test('width-only fixed-template adapter preserves its presentation and caption order', { skip: !available }, () => {
  const result = convert(markdown.replace('{#tbl:one}', '{#tbl:one table-width="100%"}'), { model: { templateId: 'rho', supported: { preset: false, width: true, fontSizePt: false } } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bounded table width/);
  assert.match(result.stdout, /\\toprule/);
  assert.doesNotMatch(result.stdout, /\\bfseries|\\fontsize|arrayrulecolor|\\setlength/);
});

test('canonical table attributes win over legacy aliases regardless of source order', { skip: !available }, () => {
  const schema = [{ field: 'preset', aliases: ['table-preset', 'table-style', 'tables'], type: 'enum' }];
  for (const attrs of ['table-preset=plain table-style=grid', 'table-style=grid table-preset=plain']) {
    const result = convert(markdown.replace('{#tbl:one}', `{#tbl:one ${attrs}}`), { model: { attributeSchema: schema } });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^\\(?:toprule|hline)/m);
  }
});

test('isolated writer emits one document under standalone compilation', { skip: !available }, () => {
  const result = convert(markdown, { model: {}, standalone: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/\\documentclass/g) || []).length, 1);
  assert.equal((result.stdout.match(/\\begin\{document\}/g) || []).length, 1);
});

test('generated captions retain source Markdown while cells remain literal', { skip: !available }, () => {
  const payload = { schemaVersion: 1, headers: ['A'], rows: [['**literal**']], caption: '*StyledCaption* cites [@source].', label: 'tbl:caption', attributes: {} };
  const result = convert('```inkwell-table-data\n' + JSON.stringify(payload) + '\n```', { format: 'json', filters: ['table-data.lua'] });
  assert.equal(result.status, 0, result.stderr);
  const ast = JSON.parse(result.stdout);
  assert.match(JSON.stringify(ast.blocks[0].c[1]), /"Emph"/);
  assert.match(JSON.stringify(ast.blocks[0].c[1]), /"Cite"/);
  assert.doesNotMatch(JSON.stringify(ast.blocks[0].c[4]), /"Strong"/);
});

test('images and highlighted code confined to a styled table retain writer dependencies', { skip: !available }, () => {
  const source = markdown.replace('**Rich** cell', '![Image](image.png) and $x^2$');
  const image = convert(source, { model: {}, standalone: true });
  assert.equal(image.status, 0, image.stderr);
  assert.match(image.stdout, /\\usepackage\{graphicx\}/);
  assert.match(image.stdout, /\\(?:newcommand\*?|providecommand)\\pandocbounded/);
  const ast = JSON.parse(convert(markdown, { format: 'json', filters: [] }).stdout);
  const cell = ast.blocks[0].c[4][0][3][0][1][0];
  cell[4] = [{ t: 'CodeBlock', c: [['', ['python'], []], 'print(123)'] }];
  const code = convert(JSON.stringify(ast), { from: 'json', model: {}, standalone: true });
  assert.equal(code.status, 0, code.stderr);
  assert.match(code.stdout, /\\usepackage\{fancyvrb\}/);
  assert.match(code.stdout, /\\newcommand\{\\BuiltInTok\}/);
  assert.match(code.stdout, /\\BuiltInTok\{print\}/);
});

test('legacy reader caption suffix becomes attributes without losing rich caption nodes', { skip: !available }, () => {
  const parsed = convert(markdown, { format: 'json', filters: [] });
  const ast = JSON.parse(parsed.stdout), table = ast.blocks[0];
  table.c[0] = ['', [], []];
  table.c[1][1][0].c = [{ t: 'Emph', c: [{ t: 'Str', c: 'Styled' }] }, { t: 'Space' }, { t: 'Str', c: '{#tbl:legacy' }, { t: 'Space' }, { t: 'Str', c: '.grid' }, { t: 'Space' }, { t: 'Str', c: 'table-density="compact"}' }];
  const result = convert(JSON.stringify(ast), { from: 'json', format: 'json', filters: ['table-data.lua'] });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout).blocks[0];
  assert.deepEqual(migrated.c[0], ['tbl:legacy', ['grid'], [['table-density', 'compact']]]);
  assert.equal(migrated.c[1][1][0].c[0].t, 'Emph');
  assert.doesNotMatch(JSON.stringify(migrated.c[1]), /table-density/);
});

test('alignment order is local attributes, source markers, document defaults, numeric inference', { skip: !available }, () => {
  const model = { defaults: { ...defaults, alignment: ['center', 'center'], numericAlignment: 'right' } };
  const native = convert(markdown, { model });
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /raggedright/); assert.match(native.stdout, /raggedleft/);
  const local = convert(markdown.replace('{#tbl:one}', '{#tbl:one table-alignment="center center"}'), { model });
  assert.equal(local.status, 0, local.stderr);
  assert.doesNotMatch(local.stdout, /raggedright|raggedleft/);
});
