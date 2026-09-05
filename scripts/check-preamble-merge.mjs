// Regression tests for the generated-preamble merge (the P08 failure
// class): Inkwell used to pass its generated preamble to pandoc via -H,
// which fills the `header-includes` template variable and silently
// REPLACES the document's own header-includes metadata. Documents kept
// compiling while losing their font, spacing, table, and citation
// commands. The fix injects the generated preamble into the template
// copy instead, leaving the document as the only writer of that
// variable.
//
// Asserts, against the tsc-compiled out/preamble.js (run `npm run
// compile` first; npm run verify does):
//   1. the generated Highlighting redefinition preserves breaklines /
//      breakanywhere (dropping them re-enables overfull code lines);
//   2. injection succeeds for EVERY shipped template, places the
//      generated block before the template's $for(header-includes)$
//      loop, and leaves that loop intact exactly once;
//   3. compiler.ts is actually wired to the injection path and only
//      uses -H as the no-marker fallback.

import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { generatePreamble, generatePreambleText, injectPreambleIntoTemplate } =
  require(path.join(root, "out", "preamble.js"));

let failed = 0;
const fail = (msg) => {
  failed++;
  console.error(`FAIL: ${msg}`);
};
const ok = (msg) => console.log(`  ok: ${msg}`);

// ── 1. Generated code style keeps line breaking ───────────────────────
{
  const generated = generatePreamble({ "code-font-size": "small" });
  const line = generated
    .split("\n")
    .find((l) => l.includes("\\DefineVerbatimEnvironment{Highlighting}"));
  if (line && line.includes("breaklines,breakanywhere") && line.includes("fontsize=\\small")) {
    ok("code-font-size redefinition preserves breaklines/breakanywhere");
  } else {
    fail("generated Highlighting redefinition lost breaklines/breakanywhere:\n" + generated);
  }
}

// ── 2. Frontmatter parsing end to end ─────────────────────────────────
{
  const doc = [
    "---",
    "title: Preamble merge fixture",
    "header-includes: |",
    "  \\newcommand{\\docmarker}{}",
    "inkwell:",
    "  code-font-size: small",
    "  tables: booktabs",
    "---",
    "Body",
  ].join("\n");
  const text = generatePreambleText(doc);
  if (text.includes("Highlighting")) {
    ok("generatePreambleText emits the style preamble for inkwell: keys");
  } else {
    fail("generatePreambleText produced no style preamble for a styled document");
  }
}

// ── 3. Injection point exists in every shipped template ───────────────
{
  const templatesDir = path.join(root, "templates");
  const wrappers = [path.join(templatesDir, "inkwell.latex")];
  for (const entry of fs.readdirSync(templatesDir)) {
    const dir = path.join(templatesDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const wrapper = path.join(dir, `${entry}.latex`);
    if (fs.existsSync(wrapper)) wrappers.push(wrapper);
  }
  if (wrappers.length < 2) {
    fail(`expected to find shipped template wrappers under ${templatesDir}`);
  }

  const SENTINEL = "%%INKWELL-GENERATED-SENTINEL%%";
  for (const wrapper of wrappers) {
    const rel = path.relative(root, wrapper);
    const source = fs.readFileSync(wrapper, "utf8");
    const { text, injected } = injectPreambleIntoTemplate(source, SENTINEL);

    if (!injected) {
      fail(`${rel}: no injection point found (template would fall back to -H and lose document header-includes)`);
      continue;
    }
    const sentinelAt = text.indexOf(SENTINEL);
    const loopAt = text.indexOf("$for(header-includes)$");
    const loopCount = text.split("$for(header-includes)$").length - 1;
    const sourceLoopCount = source.split("$for(header-includes)$").length - 1;

    if (sentinelAt === -1) {
      fail(`${rel}: injected text missing from result`);
    } else if (loopAt === -1 || loopCount !== sourceLoopCount) {
      fail(`${rel}: header-includes loop was altered by injection (${sourceLoopCount} -> ${loopCount})`);
    } else if (sentinelAt > loopAt) {
      fail(`${rel}: generated preamble must precede $for(header-includes)$ so document commands override Inkwell styles`);
    } else {
      ok(`${rel}: generated preamble merges before header-includes`);
    }
  }
}

// ── 4. Compiler wiring ────────────────────────────────────────────────
{
  const compilerSrc = fs.readFileSync(path.join(root, "src", "compiler.ts"), "utf8");
  if (!compilerSrc.includes("injectPreambleIntoTemplate(")) {
    fail("compiler.ts no longer calls injectPreambleIntoTemplate — generated preamble would clobber document header-includes again");
  } else {
    ok("compiler.ts is wired to the template-injection path");
  }

  const hFlagUses = compilerSrc.match(/push\("-H"/g) || [];
  if (hFlagUses.length > 1) {
    fail(`compiler.ts pushes -H in ${hFlagUses.length} places; only the no-marker fallback should use it`);
  } else {
    ok("-H is used only as the no-marker fallback");
  }
}

if (failed) {
  console.error(`\n${failed} preamble-merge check(s) failed.`);
  process.exit(1);
}
console.log("Preamble merge checks passed.");
