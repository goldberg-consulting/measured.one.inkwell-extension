---
title: "Evidence into action"
subtitle: "A reproducible consulting report"
author: "Goldberg Consulting LLC"
client: "Illustrative engagement"
date: "September 2026"
template: measured-report
documentclass: report
top-level-division: chapter
papersize: letter
numbersections: true
toc: true
linestretch: 1.18
abstract: |
  Good decisions connect a clear question to inspectable evidence. This report
  demonstrates that connection with Python analysis, Observable Plot figures,
  and chaptered appendices in a single document. All observations are synthetic;
  the report makes no claim about a client, intervention, or causal effect.
inkwell:
  code-display: output
  python-env: ./.venv
---

# Decision brief

The decision is whether the observed pattern warrants a more detailed investigation.
The illustrative series rises above its baseline over six months. That difference
is descriptive: it does not establish that an intervention caused the improvement.

**Recommendation.** Validate the measurement process, document the comparison
assumptions, and test alternative explanations before committing resources.

## What would change the decision?

A change in eligibility, reporting completeness, or case mix could explain the
pattern. A credible next analysis would measure those changes and define a
comparison before evaluating results.

# Evidence

## Trend over time · Python

The Python script reads a shared CSV and creates the monthly trend figure.

```{python id="monthly-trend" file=".inkwell/scripts/mixed-report/trend.py" inputs=".inkwell/scripts/mixed-report/outcomes.csv" output="trend" caption="Illustrative outcome index. Dashed line: baseline; teal line: observed." label="trend"}
```

```{=latex}
\clearpage
```

## Size of the difference · Observable Plot

A separate JavaScript file uses Observable Plot to make the same evidence easier
to compare across months. Both the data and helper module are declared inputs,
so editing either makes this result stale.

```{node id="monthly-uplift" file=".inkwell/scripts/mixed-report/uplift.mjs" inputs=".inkwell/scripts/mixed-report/outcomes.csv,.inkwell/scripts/mixed-report/plot-helpers.mjs,.inkwell/scripts/mixed-report/package.json,.inkwell/scripts/mixed-report/package-lock.json" output="uplift" caption="Observed minus baseline in each month. Synthetic data." label="uplift"}
```

# Action plan

1. Agree on the outcome definition and the unit of analysis.
2. Audit missing records and changes in the population.
3. Specify a comparison and sensitivity checks before fitting a model.
4. Share the data, scripts, and assumptions alongside the final recommendation.

The appendices preserve the supporting calculations and the instructions needed
to reproduce every figure.

```{=latex}
\appendix
```

# Supporting observations

This second Python file creates a table from the same input used by both plotting
libraries. No values are copied by hand into the report.

```{python id="observation-table" file=".inkwell/scripts/mixed-report/summary.py" inputs=".inkwell/scripts/mixed-report/outcomes.csv" output="summary" caption="Synthetic observations and their differences." label="observations"}
```

# Comparison view

This second Observable Plot file displays the baseline and observed value as a
connected pair for each month.

```{node id="paired-comparison" file=".inkwell/scripts/mixed-report/comparison.mjs" inputs=".inkwell/scripts/mixed-report/outcomes.csv,.inkwell/scripts/mixed-report/plot-helpers.mjs,.inkwell/scripts/mixed-report/package.json,.inkwell/scripts/mixed-report/package-lock.json" output="comparison" caption="Baseline (gray) and observed (teal) values. Synthetic data." label="comparison"}
```

# Reproduction notes

Use **Inkwell: Setup / Repair** and choose **Create .venv** to install the Python
requirements. The project also needs Node.js and the Observable Plot dependencies:
from the project root, run `npm install --prefix .inkwell/scripts/mixed-report` once.
Then choose **Run Code Blocks**, followed by **Compile PDF**.

Save edited scripts and data before running. **Run This Block** and **Run Code
Blocks** execute again; **Run Changed Blocks** reuses verified current results.
When adding imported helper modules or data files, list them in `inputs` so
changes invalidate the correct results. PDF compilation consumes the last verified
runs; it does not execute analysis code.

The original cover artwork, *Signal field*, is decorative vector art supplied with
the template under the Inkwell Source License v1.0, which permits commercial use.
No third-party photograph or university branding is included.
