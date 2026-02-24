---
title: "Inkwell Default Template Demo"
author: "Inkwell"
date: "February 2026"
linestretch: 1.4
geometry: "margin=1in"
toc: true
lof: true
lot: true
# header-includes: |
#   \usepackage{xcolor}
#   \setlength{\parindent}{0pt}
bibliography: references/refs.bib
link-citations: true
inkwell:
  code-bg: "#f5f5f5"
  code-border: true
  code-font-size: small
  tables: booktabs
  table-font-size: small
  hanging-indent: true
  code-display: output
  python-env: ./venv
---

# Introduction

This document demonstrates the default Inkwell template. It compiles markdown to publication-quality PDF through Pandoc [@macfarlane2023] and XeLaTeX, with code blocks that execute in place. The result is a literate programming workflow where analysis and writing coexist in a single file [@knuth1984].

## Runnable Code: Fourier Partial Sums

The Fourier series of a square wave [@fourier1822] converges pointwise but exhibits overshoot at discontinuities. The partial sum is:

\begin{equation}\label{eq:fourier}
f_n(x) = \sum_{k=1}^{n} \frac{4}{(2k-1)\pi} \sin\bigl((2k-1)x\bigr)
\end{equation}

```{python file="scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums of a square wave for n = 1, 3, 5, 9."}
```

## Inline Code with Output

Generate a scatter plot directly in the document using NumPy [@harris2020] and Matplotlib [@hunter2007]:

```{python display="both" output="scatter" caption="Simulated bivariate data with OLS regression line."}
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
print(f"n = {len(x)}, r = {np.corrcoef(x, y)[0,1]:.3f}")
```

## Tables

Static markdown tables work as expected:

| Method    | Time (ms) | Accuracy (%) |
|-----------|----------:|-------------:|
| Baseline  |      12.5 |         91.2 |
| Proposed  |      10.1 |         93.8 |
| Optimized |       8.7 |         94.4 |

: Comparison of three methods on the benchmark dataset.

Tables can also be generated from code. A block that writes a `.csv` to the output directory is rendered as a formatted table:

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

## Math

Euler's identity [@euler1748] connects five fundamental constants:

$$e^{i\pi} + 1 = 0$$

A theorem environment rendered by the template:

::: {.theorem}
**Cauchy-Schwarz Inequality.** For all vectors $u, v$ in an inner product space,
$$|\langle u, v \rangle|^2 \leq \langle u, u \rangle \cdot \langle v, v \rangle$$
:::

## Environment

```{shell display="both"}
echo "Date: $(date '+%Y-%m-%d %H:%M')"
echo "Host: $(hostname -s), $(uname -s) $(uname -m)"
echo "Python: $(python3 --version 2>&1)"
echo "Pandoc: $(pandoc --version 2>/dev/null | head -1 || echo 'not installed')"
```

## References
