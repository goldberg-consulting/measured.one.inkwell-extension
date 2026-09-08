import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const checks = [
  {
    file: "templates/inkwell.latex",
    pattern: /\\usepackage\{array\}\s*\n\\usepackage\{booktabs\}/,
    message: "inkwell template must load array before booktabs",
  },
  {
    file: "templates/ludus/ludus.latex",
    pattern: /\\usepackage\{array\}\s*\n\\usepackage\{booktabs\}/,
    message: "ludus template must load array before booktabs",
  },
  {
    file: "templates/rho/rho.latex",
    pattern: /\\usepackage\{array\}\s*\n\\usepackage\{longtable\}/,
    message: "rho template must load array before longtable",
  },
  {
    file: "templates/hipster-cv/hipster-cv.latex",
    pattern: /\\usepackage\{array\}\s*\n\\usepackage\{booktabs\}/,
    message: "hipster-cv template must load array before booktabs",
  },
  // eth-report XeLaTeX/fontspec port. Each of these regressed silently in
  // the pdflatex era: wrong engine broke system fonts, a late fontspec
  // load defeated the class's @ifpackageloaded guards, an unguarded
  // Inter fallback failed on machines without the font (CI), and the
  // natbib citation route rendered labels like "[(1code )]".
  {
    file: "templates/eth-report/template.json",
    pattern: /"engine":\s*"xelatex"/,
    message: "eth-report manifest must declare xelatex (fontspec wrapper breaks under pdflatex)",
  },
  {
    file: "templates/eth-report/eth-report.latex",
    pattern: /\\RequirePackage\{fontspec\}[\s\S]*?\\documentclass/,
    message: "eth-report wrapper must load fontspec before the IVT class so the class guards see it",
  },
  {
    file: "templates/eth-report/eth-report.latex",
    pattern: /\\IfFontExistsTF\{Inter\}/,
    message: "eth-report Inter fallback must be guarded with \\IfFontExistsTF (CI runners lack Inter)",
  },
  {
    file: "templates/eth-report/eth-report.latex",
    pattern: /\\NewDocumentCommand\\citeproc\{mm\}\{\\hyperlink\{cite\.#1\}\{#2\}\}/,
    message: "eth-report citeproc must hyperlink rendered citation text (natbib route renders garbage labels)",
  },
  {
    file: "templates/eth-report/ivt-style/standard.cls",
    pattern: /\\@ifpackageloaded\{fontspec\}\{\}\{%\s*\n\s*\\RequirePackage\[utf8\]\{inputenc\}/,
    message: "IVT class must guard inputenc/fontenc behind @ifpackageloaded{fontspec}",
  },
  {
    file: "templates/eth-report/ivt-style/standard.cls",
    pattern: /\\@ifpackageloaded\{fontspec\}\{\}\{\\usepackage\[scaled=0\.92\]\{helvet\}\}/,
    message: "IVT class must guard helvet behind @ifpackageloaded{fontspec}",
  },
  // Citation pipeline assets. The bundled numeric CSL must never use
  // second-field-align: aligned styles make pandoc emit
  // \CSLLeftMargin/\CSLRightInline parboxes that crash the tufte-latex
  // wrappers with "Float(s) lost".
  {
    file: "csl/inkwell-numeric.csl",
    pattern: /citation-number/,
    message: "bundled default CSL must be a numeric style",
  },
  {
    file: "csl/inkwell-numeric.csl",
    antiPattern: /second-field-align/,
    message: "bundled default CSL must not use second-field-align (tufte wrappers crash on the parbox output)",
  },
  {
    file: "filters/section-bibliographies.lua",
    pattern: /pandoc\.utils\.citeproc/,
    message: "section-bibliographies filter must run citeproc per segment",
  },
  {
    file: "templates/tufte-book-vdqi/tufte-book-vdqi.latex",
    pattern: /\\def\\@biblabel#1\{\}/,
    message: "tufte-book wrapper must suppress the empty bibitem label (renders stray [] before numbered entries)",
  },
  // The extension and the CI harness must drive the same citation
  // pipeline: bundled CSL default and the section-scope Lua filter.
  {
    file: "src/bibliography-service.ts",
    pattern: /inkwell-numeric\.csl/,
    message: "shared reference resolver must provide the bundled numeric CSL default",
  },
  {
    file: "src/compiler.ts",
    pattern: /getResolvedReferences\(documentConfig, sourceFile\)/,
    message: "compiler must consume the shared reference resolver",
  },
  {
    file: "src/compiler.ts",
    pattern: /section-bibliographies\.lua/,
    message: "compiler must wire the section-bibliographies filter",
  },
  {
    file: "scripts/compile-demo.sh",
    pattern: /inkwell-numeric\.csl/,
    message: "compile-demo.sh must mirror the bundled numeric CSL default",
  },
  {
    file: "scripts/compile-demo.sh",
    pattern: /section-bibliographies\.lua/,
    message: "compile-demo.sh must mirror the section-scope Lua filter",
  },
];

let failures = 0;

for (const check of checks) {
  const fullPath = path.join(repoRoot, check.file);
  const content = fs.readFileSync(fullPath, "utf8");
  if (check.pattern && !check.pattern.test(content)) {
    failures += 1;
    console.error(`FAIL: ${check.message} (${check.file})`);
  }
  if (check.antiPattern && check.antiPattern.test(content)) {
    failures += 1;
    console.error(`FAIL: ${check.message} (${check.file})`);
  }
}

// The Pandoc extension list is necessarily duplicated across the TS/bash
// boundary: src/compiler.ts (the real pipeline) and scripts/compile-demo.sh
// (the CI compile harness). They must stay identical or CI compiles a
// different document than the extension does. Guard against drift.
{
  const compilerSrc = fs.readFileSync(
    path.join(repoRoot, "src", "compiler.ts"),
    "utf8",
  );
  const arrayMatch = compilerSrc.match(
    /const PANDOC_EXTENSIONS = \[([\s\S]*?)\]\.join\("\+"\)/,
  );
  const demoSrc = fs.readFileSync(
    path.join(repoRoot, "scripts", "compile-demo.sh"),
    "utf8",
  );
  const demoMatch = demoSrc.match(/PANDOC_EXTS="([^"]+)"/);

  if (!arrayMatch || !demoMatch) {
    failures += 1;
    console.error(
      "FAIL: could not locate PANDOC_EXTENSIONS (compiler.ts) or PANDOC_EXTS (compile-demo.sh)",
    );
  } else {
    const tsExts = Array.from(arrayMatch[1].matchAll(/"([a-z_]+)"/g), (m) => m[1]);
    const shExts = demoMatch[1].split("+").filter(Boolean);
    if (tsExts.join("+") !== shExts.join("+")) {
      failures += 1;
      console.error(
        "FAIL: PANDOC_EXTENSIONS drift between compiler.ts and compile-demo.sh",
      );
      console.error(`  compiler.ts:     ${tsExts.join("+")}`);
      console.error(`  compile-demo.sh: ${shExts.join("+")}`);
    }
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log("Template regression checks passed.");
