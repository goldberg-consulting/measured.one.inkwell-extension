---
title: "Reproducible Results, Inserted"
subtitle: "A Python run-and-insert walkthrough"
author: "Inkwell"
date: "September 2026"
abstract: |
  This example demonstrates the full Inkwell run-and-insert loop: Python
  code blocks execute inside the document, their figures and tables land in
  the compiled PDF, and the numbers they compute flow into the prose
  through inline bindings — so the text can never drift from the results.

# --- Bibliography ---
bibliography: .inkwell/references/refs.bib
link-citations: true

# --- Cross-reference prefixes ---
figPrefix: "Figure"
tblPrefix: "Table"

# --- Inkwell styling and execution ---
inkwell:
  code-display: output
  code-font-size: small
  code-border: true
  tables: booktabs
  python-env: ./venv
---

# The Run-and-Insert Loop {#sec:loop}

Literate programming keeps analysis and narrative in one artifact
[@knuth1984; @macfarlane2023; @harris2020]. Inkwell's version of the loop has
two keystrokes: **Run Code Blocks** (`Cmd+Alt+R`) executes every fenced
`{python}` block and caches its output, then **Compile** (`Cmd+Shift+R`)
injects those cached results into the document before Pandoc and LaTeX run.
Nothing below this paragraph was typed by hand: the figure, the table, and
every number in the prose are computed by the blocks in this file.

# Generating a Figure and Exporting Values {#sec:figure}

The block below simulates two years of monthly transit ridership, fits a
linear trend, and does two things at once: it saves a figure into
`INKWELL_OUTPUT_DIR`, and it exports named values with `::inkwell key=value`
lines that later prose can reference.

```{python display="both" output="trend" caption="Simulated monthly ridership with fitted linear trend." label="trend"}
import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

rng = np.random.default_rng(42)
months = np.arange(24)
ridership = 120 + 1.8 * months + 14 * np.sin(2 * np.pi * months / 12) \
    + rng.normal(0, 4, months.size)

slope, intercept = np.polyfit(months, ridership, 1)
corr = np.corrcoef(months, ridership)[0, 1]

fig, ax = plt.subplots(figsize=(6.2, 3.4))
ax.plot(months, ridership, "o-", ms=4, lw=1, label="Monthly riders (thousands)")
ax.plot(months, intercept + slope * months, "--", lw=1.5, label="Linear trend")
ax.set_xlabel("Month")
ax.set_ylabel("Riders (thousands)")
ax.legend(frameon=False)
fig.tight_layout()

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
fig.savefig(os.path.join(out, "trend.png"), dpi=200)

print(f"::inkwell n_obs={months.size}")
print(f"::inkwell corr_r={corr:.3f}")
print(f"::inkwell slope={slope:.2f}")
```

@Fig:trend shows the simulated series. The fit uses {{n_obs}} monthly
observations and yields a correlation of $r = {{corr_r}}$
($r^2 = `{python} f"{float(corr_r)**2:.2f}"`$), with ridership growing by
about `{python} f"{float(slope):.1f}"` thousand riders per month. Those
values are **bindings**, not typed numbers: the double-brace form inserts
an exported value verbatim, while `{python}`-prefixed inline code spans
evaluate a Python expression with every exported variable pre-loaded — use
those to round, rescale, or derive.

# Generating a Table {#sec:table}

A block that writes a CSV into `INKWELL_OUTPUT_DIR` becomes a formatted
table, with the caption and cross-reference label supplied by the block
attributes rather than hand-written markup.

```{python display="output" output="summary" caption="Quarterly ridership summary (thousands of riders)." label="summary"}
import os
import numpy as np

rng = np.random.default_rng(42)
months = np.arange(24)
ridership = 120 + 1.8 * months + 14 * np.sin(2 * np.pi * months / 12) \
    + rng.normal(0, 4, months.size)

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
with open(os.path.join(out, "summary.csv"), "w") as f:
    f.write("Quarter,Mean,Min,Max\n")
    for q in range(8):
        vals = ridership[q * 3:(q + 1) * 3]
        f.write(f"Q{q % 4 + 1} Y{q // 4 + 1},{vals.mean():.1f},{vals.min():.1f},{vals.max():.1f}\n")
```

@Tbl:summary is regenerated on every run, so a change to the simulation
above can never leave a stale table behind.

# Bulk Bindings via vars.json {#sec:vars}

`::inkwell` lines suit a handful of values. For many bindings at once, a
block can write a `vars.json` artifact instead — every key becomes a
`{{ key }}` binding. Values must be flat scalars (strings, numbers,
booleans): Inkwell refuses objects and arrays rather than letting
`[object Object]` slip into a PDF, and any misspelled placeholder that
survives substitution surfaces as a compile warning with its line number.

```{python display="none" output="vars"}
import json
import os
import numpy as np

rng = np.random.default_rng(42)
months = np.arange(24)
ridership = 120 + 1.8 * months + 14 * np.sin(2 * np.pi * months / 12) \
    + rng.normal(0, 4, months.size)

quarter_means = ridership[:12].reshape(4, 3).mean(axis=1)
best = int(np.argmax(quarter_means))

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
with open(os.path.join(out, "vars.json"), "w") as f:
    json.dump({
        "peak_quarter": f"Q{best + 1}",
        "peak_mean": f"{quarter_means[best]:.1f}",
        "year_growth": f"{(ridership[12:].mean() / ridership[:12].mean() - 1) * 100:.1f}",
    }, f)
```

In the first year, ridership peaked in {{peak_quarter}} at a mean of
{{peak_mean}} thousand riders per month; the second year averaged
{{year_growth}}% higher than the first. The block that computed these is
invisible (`display="none"`) — only its bindings remain.

# How to Reproduce This PDF {#sec:reproduce}

1. Run the code blocks: `Cmd+Alt+R` (**Inkwell: Run Code Blocks**). Outputs
   cache under `.inkwell/outputs/` by content hash — a block only re-runs
   when its source changes. Blocks that read external files should set
   `cache="false"`.
2. Compile: `Cmd+Shift+R` (**Inkwell: Compile PDF**). The cached figure,
   table, and bindings are injected before Pandoc runs.
3. Citations use Inkwell's default numeric style — the bracketed group in
   the opening paragraph renders as [1,2,3] — and the sources appear under
   the heading below. Declare `csl:` in frontmatter to use another style.

## References
