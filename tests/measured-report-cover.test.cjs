const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pandoc = process.env.INKWELL_PANDOC || 'pandoc';
const available = cp.spawnSync(pandoc, ['--version'], { encoding: 'utf8' }).status === 0;
const template = path.join(root, 'templates', 'measured-report', 'measured-report.latex');
const render = yaml => cp.spawnSync(pandoc, ['-s', '-t', 'latex', '--template', template],
  { input: `---\ntitle: "Cover title"\nsubtitle: "Cover subtitle"\n${yaml}---\n\nBody\n`, encoding: 'utf8' });
const cover = tex => tex.slice(tex.indexOf('\\begin{titlepage}'), tex.indexOf('\\end{titlepage}'));

test('measured.one cover keeps the wordmark above the title by default', { skip: !available }, () => {
  const result = render('');
  assert.equal(result.status, 0, result.stderr);
  const page = cover(result.stdout);
  assert.match(page, /\\bfseries measured\.one\\par/);
  assert.ok(page.indexOf('RESEARCH + ADVISORY') < page.indexOf('Cover title'));
});

test('hide-wordmark leaves the title as the only wordmark with the tagline beneath it', { skip: !available }, () => {
  const result = render('hide-wordmark: true\n');
  assert.equal(result.status, 0, result.stderr);
  const page = cover(result.stdout);
  assert.doesNotMatch(page, /\\bfseries measured\.one\\par/);
  const title = page.indexOf('Cover title'), tagline = page.indexOf('RESEARCH + ADVISORY'), subtitle = page.indexOf('Cover subtitle');
  assert.ok(title >= 0 && title < tagline && tagline < subtitle);
  assert.equal((page.match(/\\begin\{minipage\}/g) || []).length, (page.match(/\\end\{minipage\}/g) || []).length);
});
