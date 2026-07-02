// Regression tests for compiler.parseErrors: feeds realistic pandoc /
// LaTeX log fragments through the parser and asserts that each common
// failure class produces an actionable, correctly-classified error.
//
// Loads the tsc-compiled out/compiler.js with a stubbed `vscode`
// module, so run `npm run compile` first (npm run verify does).

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const Module = require("module");

const vscodeStub = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {} }),
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  commands: { executeCommand: () => {} },
  languages: {
    createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
    registerCodeActionsProvider: () => ({ dispose() {} }),
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  Range: class {},
  Diagnostic: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  CodeAction: class {},
  CodeActionKind: { QuickFix: "quickfix" },
  Uri: { file: (p) => ({ fsPath: p }) },
  ProgressLocation: { Notification: 15 },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vscodeStub;
  return origLoad.call(this, request, ...rest);
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { parseErrors } = require(path.join(root, "out", "compiler.js"));

const GEN = { generatedTex: true };
const DIRECT = { generatedTex: false };

const cases = [
  {
    name: "missing .sty maps to tlmgr package with quick fix",
    log: "! LaTeX Error: File `tufte-handout.sty' not found.",
    opts: GEN,
    expect: (errs) => {
      const e = errs.find((x) => x.missingPackage);
      return e && e.severity === "error" && e.message.includes("tufte-handout.sty");
    },
  },
  {
    name: "missing .cls maps to providing bundle (tufte-latex, not tufte-handout)",
    log: "! LaTeX Error: File `tufte-handout.cls' not found.",
    opts: GEN,
    expect: (errs) => errs.some((e) => e.missingPackage === "tufte-latex"),
  },
  {
    name: "missing image gives path guidance, no bogus package fix",
    log: "! LaTeX Error: File `figures/plot.png' not found.",
    opts: GEN,
    expect: (errs) =>
      errs.some((e) => e.message.includes("Image not found") && !e.missingPackage),
  },
  {
    name: "missing .bib points at frontmatter / references dirs",
    log: "pandoc: refs.bib: openBinaryFile: does not exist (No such file or directory)",
    opts: GEN,
    expect: (errs) => errs.some((e) => e.message.includes("bibliography")),
  },
  {
    name: "citation not found surfaces as warning with key",
    log: "[WARNING] Citation 'knuth1984' not found",
    opts: GEN,
    expect: (errs) =>
      errs.some((e) => e.severity === "warning" && e.message.includes("@knuth1984")),
  },
  {
    name: "pandoc 3.x citeproc citation warning format is parsed",
    log: "[WARNING] Citeproc: citation missingkey not found",
    opts: GEN,
    expect: (errs) =>
      errs.some((e) => e.severity === "warning" && e.message.includes("@missingkey")),
  },
  {
    name: "could-not-fetch-resource strips trailing colon from filename",
    log: "[WARNING] Could not fetch resource missing.png: replacing image with description",
    opts: GEN,
    expect: (errs) =>
      errs.some((e) => e.message.includes('"missing.png"') && !e.message.includes('"missing.png:"')),
  },
  {
    name: "fontspec missing font names the font",
    log: [
      "! Package fontspec Error: The font \"Lato\" cannot be",
      "(fontspec)                found.",
    ].join("\n"),
    opts: GEN,
    expect: (errs) =>
      errs.some((e) => e.message.includes('"Lato"') && e.message.includes("not installed")),
  },
  {
    name: "undefined control sequence extracts macro from l. context",
    log: ["! Undefined control sequence.", "l.42 \\brokenmacro", "          some text"].join("\n"),
    opts: GEN,
    expect: (errs) => errs.some((e) => e.message.includes("\\brokenmacro")),
  },
  {
    name: "inputenc unicode error suggests xelatex template",
    log: "! Package inputenc Error: Unicode character \u00e9 (U+00E9) not set up for use with LaTeX.",
    opts: GEN,
    expect: (errs) => errs.some((e) => e.message.includes("XeLaTeX")),
  },
  {
    name: "pandoc-pipeline engine errors do not claim markdown line numbers",
    log: ["! Misplaced alignment tab character &.", "l.123 foo & bar"].join("\n"),
    opts: GEN,
    expect: (errs) => {
      const e = errs.find((x) => x.message.includes("Misplaced alignment"));
      return e && e.line === undefined && e.message.includes("generated LaTeX");
    },
  },
  {
    name: "direct .tex compile keeps real line numbers",
    log: ["! Misplaced alignment tab character &.", "l.123 foo & bar"].join("\n"),
    opts: DIRECT,
    expect: (errs) =>
      errs.some((e) => e.line === 123 && e.message.includes("Misplaced alignment")),
  },
  {
    name: "pandoc markdown errors keep markdown line numbers",
    log: "demo.md:17:3: unexpected end of input",
    opts: GEN,
    expect: (errs) => errs.some((e) => e.line === 17),
  },
  {
    name: "identical errors from multi-pass compiles are deduped",
    log: [
      "! LaTeX Error: File `booktabs.sty' not found.",
      "some other output",
      "! LaTeX Error: File `booktabs.sty' not found.",
    ].join("\n"),
    opts: GEN,
    expect: (errs) => errs.filter((e) => e.missingPackage === "booktabs").length === 1,
  },
  {
    name: "YAML parse exception flags the frontmatter",
    log: "Error in $: YAML parse exception at line 4, column 2: mapping values are not allowed in this context",
    opts: GEN,
    expect: (errs) => errs.some((e) => e.message.includes("frontmatter")),
  },
];

let failed = 0;
for (const c of cases) {
  const errs = parseErrors(c.log, "", c.opts);
  if (c.expect(errs)) {
    console.log(`  ok: ${c.name}`);
  } else {
    failed++;
    console.error(`FAIL: ${c.name}`);
    console.error(`  parsed: ${JSON.stringify(errs, null, 2)}`);
  }
}

if (failed) {
  console.error(`\n${failed} error-parsing check(s) failed.`);
  process.exit(1);
}
console.log("Error parsing checks passed.");
