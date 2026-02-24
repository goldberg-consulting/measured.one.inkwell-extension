---
title: "Inkwell Default Template Demo"
subtitle: "A Complete Frontmatter Reference"
author:
  - "Author One"
  - "Author Two"
date: "February 2026"
abstract: |
  This document demonstrates every frontmatter option available in the
  default Inkwell template. It compiles markdown to publication-quality
  PDF through Pandoc and XeLaTeX, with runnable code blocks, inline
  data binding, mermaid diagrams, and cross-references.
keywords: "Inkwell; literate programming; reproducible documents"

# --- Document class and page layout ---
# documentclass: article             # default: article
fontsize: 11pt                        # 10pt, 11pt, 12pt
# classoption:                        # passed to \documentclass
#   - twocolumn
#   - landscape
geometry: "margin=1in"                # any geometry package string
linestretch: 1.4                      # line spacing multiplier

# --- Fonts (XeLaTeX) ---
# mainfont: "Palatino"               # system font name
# mainfontoptions:
#   - BoldFont=Palatino Bold
# sansfont: "Helvetica"
# sansfontoptions: []
# monofont: "Fira Code"
# monofontoptions:
#   - Scale=0.85

# --- Hyperlink colors ---
# linkcolor: RoyalBlue               # internal links (default: RoyalBlue)
# citecolor: OliveGreen              # citation links (default: OliveGreen)
# urlcolor: RoyalBlue                # URL links (default: RoyalBlue)

# --- Front matter sections ---
toc: true                             # table of contents
lof: true                             # list of figures
lot: true                             # list of tables

# --- Bibliography ---
bibliography: references/refs.bib
link-citations: true

# --- Cross-reference prefixes (pandoc-crossref) ---
figPrefix: "Figure"
tblPrefix: "Table"
eqnPrefix: "Equation"
secPrefix: "Section"

# --- Custom LaTeX in the preamble ---
# header-includes: |
#   \usepackage{tikz}
#   \definecolor{accent}{HTML}{2E86AB}

# --- Inkwell styling ---
inkwell:
  code-bg: "#f5f5f5"                  # background color for code blocks
  code-border: true                   # border around code blocks
  code-rounded: true                  # rounded corners on code blocks
  code-font-size: small               # tiny, scriptsize, footnotesize, small, normalsize
  code-display: output                # default display: output, both, code, none
  tables: booktabs                    # booktabs, grid, plain
  table-font-size: small              # tiny, scriptsize, footnotesize, small, normalsize
  table-stripe: false                 # alternating row shading
  hanging-indent: false               # hanging indent for bibliography
  caption-style: above                # above or below figures/tables
  # columns: 2                        # force two-column layout
  python-env: ./venv                  # Python virtual environment path
---

# Introduction {#sec:intro}

This document demonstrates the default Inkwell template. It compiles markdown to publication-quality PDF through Pandoc [@macfarlane2023] and XeLaTeX, with code blocks that execute in place. The result is a literate programming workflow where analysis and writing coexist in a single file [@knuth1984]. Mermaid diagrams (@sec:diagrams) also compile inline as cross-referenceable SVG figures.

## Runnable Code: Fourier Partial Sums {#sec:fourier}

The Fourier series of a square wave [@fourier1822] converges pointwise but exhibits overshoot at discontinuities. The partial sum is given by @eq:fourier, and @Fig:fourier shows the convergence for increasing $n$.

\begin{equation}\label{eq:fourier}
f_n(x) = \sum_{k=1}^{n} \frac{4}{(2k-1)\pi} \sin\bigl((2k-1)x\bigr)
\end{equation}

```{python cache="false" file="scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums of a square wave for n = 1, 3, 5, 9." label="fourier"}
```

## Inline Code with Output {#sec:scatter}

@Fig:scatter is generated directly in the document using NumPy [@harris2020] and Matplotlib [@hunter2007]:

```{python display="both" output="scatter" caption="Simulated bivariate data with OLS regression line." label="scatter"}
import os, numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

rng = np.random.default_rng(42)
x = rng.normal(0, 1, 150)
y = 0.7 * x + rng.normal(0, 0.35, 150)

fig, ax = plt.subplots(figsize=(5, 3.5))
ax.scatter(x, y, s=14, alpha=0.6, color="#4A90D9")
m, b = np.polyfit(x, y, 1)
xs = np.sort(x)
ax.plot(xs, m * xs + b, color="#E74C3C", linewidth=1.5,
        label=f"$y = {m:.2f}x {'+' if b >= 0 else ''}{b:.2f}$")
ax.set_xlabel("$x$"); ax.set_ylabel("$y$")
ax.legend(); ax.grid(alpha=0.2)
fig.tight_layout()
fig.savefig(os.path.join(os.environ.get("INKWELL_OUTPUT_DIR", "."),
            "scatter.png"), dpi=200, bbox_inches="tight")
plt.close(fig)
r_val = np.corrcoef(x, y)[0, 1]
print(f"n = {len(x)}, r = {r_val:.3f}")
print(f"::inkwell scatter_n={len(x)}")
print(f"::inkwell scatter_r={r_val:.3f}")
print(f"::inkwell scatter_slope={m:.3f}")
print(f"::inkwell scatter_intercept={b:.3f}")
```

## Inline Data Binding {#sec:binding}

Code blocks can export named values to the document with `print("::inkwell key=value")` in their stdout. These values are then available in two ways.

**Variable substitution** uses double-brace syntax. Writing `{{scatter_n}}` in prose inserts the exported value directly: this dataset has {{scatter_n}} observations with Pearson $r = {{scatter_r}}$.

**Inline expressions** use `` `{python} expr` `` to evaluate arbitrary Python. All exported variables are pre-loaded, so you can cast, format, and compute:

- Formatted correlation: $r = `{python} f"{float(scatter_r):.2f}"`$
- Slope to one decimal: $\hat\beta \approx `{python} f"{float(scatter_slope):.1f}"`$
- Arithmetic: the slope-to-correlation ratio is `{python} f"{float(scatter_slope) / float(scatter_r):.2f}"`.

The full regression line from @sec:scatter is $\hat{y} = `{python} f"{float(scatter_slope):.3f}"`\,x `{python} f"+ {float(scatter_intercept):.3f}" if float(scatter_intercept) >= 0 else f"- {abs(float(scatter_intercept)):.3f}"`$, fitted to $n = {{scatter_n}}$ points.

## Tables {#sec:tables}

@Tbl:methods shows a static markdown pipe table. @Tbl:stats below is generated from a code block that writes a CSV file.

| Method    | Time (ms) | Accuracy (%) |
|-----------|----------:|-------------:|
| Baseline  |      12.5 |         91.2 |
| Proposed  |      10.1 |         93.8 |
| Optimized |       8.7 |         94.4 |

: Comparison of three methods on the benchmark dataset. {#tbl:methods}

Code blocks that write a `.csv` to the output directory are rendered as formatted tables:

```{python output="summary_stats" caption="Descriptive statistics for the simulated bivariate data." label="stats"}
import os, numpy as np

rng = np.random.default_rng(42)
x = rng.normal(0, 1, 150)
y = 0.7 * x + rng.normal(0, 0.35, 150)

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
with open(os.path.join(out, "summary_stats.csv"), "w") as f:
    f.write("Variable,n,Mean,Std,Min,Max\n")
    for name, vals in [("x", x), ("y", y)]:
        f.write(f"{name},{len(vals)},{vals.mean():.3f},{vals.std():.3f},{vals.min():.3f},{vals.max():.3f}\n")
```

## Math {#sec:math}

@Eq:euler, Euler's identity [@euler1748], connects five fundamental constants:

$$e^{i\pi} + 1 = 0$$ {#eq:euler}

@Eq:cauchy-schwarz is rendered inside a theorem environment:

::: {.theorem}
**Cauchy-Schwarz Inequality.** For all vectors $u, v$ in an inner product space,
$$|\langle u, v \rangle|^2 \leq \langle u, u \rangle \cdot \langle v, v \rangle$$ {#eq:cauchy-schwarz}
:::

## Diagrams {#sec:diagrams}

Mermaid diagrams render to SVG and are cross-referenceable like any figure. @Fig:pipeline shows the Inkwell compilation pipeline.

```{mermaid caption="The Inkwell compilation pipeline, from source markdown to final PDF." label="pipeline"}
graph LR
    A[Markdown + YAML] --> B[Run Code Blocks]
    B --> C[Inject Results]
    C --> D[Bind Variables]
    D --> E[Pandoc + XeLaTeX]
    E --> F[PDF]
```

## Environment

```{shell display="both"}
echo "Date: $(date '+%Y-%m-%d %H:%M')"
echo "Host: $(hostname -s), $(uname -s) $(uname -m)"
echo "Python: $(python3 --version 2>&1)"
echo "Pandoc: $(pandoc --version 2>/dev/null | head -1 || echo 'not installed')"
```

## References
