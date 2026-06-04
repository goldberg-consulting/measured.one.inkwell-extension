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
];

let failures = 0;

for (const check of checks) {
  const fullPath = path.join(repoRoot, check.file);
  const content = fs.readFileSync(fullPath, "utf8");
  if (!check.pattern.test(content)) {
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
