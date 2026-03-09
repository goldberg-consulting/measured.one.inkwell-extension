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

if (failures > 0) {
  process.exit(1);
}

console.log("Template regression checks passed.");
