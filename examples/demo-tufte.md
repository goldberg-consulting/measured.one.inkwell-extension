---
template: tufte
title: "On the Principles of Analytical Display"
# subtitle: "A Companion Guide"
author: "Inkwell"
date: "February 2026"
abstract: |
  Good information design relies on showing the data above all else.
  This handout demonstrates the Tufte layout through margin notes,
  sidenotes, margin figures, and full-width displays, all authored in
  Markdown and compiled through Inkwell.

# --- Class options ---
classoption:
  - justified                         # justified text (default is ragged-right)
  - a4paper                           # or: letterpaper (default)
  # - sfsidenotes                     # sans-serif sidenotes

# --- Hyperlink colors ---
# linkcolor: DarkSlateBlue            # internal links (default: DarkSlateBlue)
# citecolor: DarkSlateBlue            # citation links (default: DarkSlateBlue)
# urlcolor: DarkSlateBlue             # URL links (default: DarkSlateBlue)

# --- Front matter sections ---
# toc: true                           # table of contents
# lof: true                           # list of figures
# lot: true                           # list of tables

# --- Bibliography ---
bibliography: references/refs.bib
link-citations: true

# --- Cross-reference prefixes ---
figPrefix: "Figure"
tblPrefix: "Table"
eqnPrefix: "Equation"
secPrefix: "Section"

# --- Custom LaTeX in the preamble ---
# header-includes: |
#   \usepackage{tikz}

# --- Inkwell styling ---
inkwell:
  code-display: output                # default display: output, both, code, none
  # code-bg: "#f5f5f5"
  # code-border: true
  # code-rounded: true
  # code-font-size: small             # tiny, scriptsize, footnotesize, small, normalsize
  # tables: booktabs                  # booktabs, grid, plain
  # table-font-size: small
  # python-env: ./venv
---

# Data-Ink and Visual Evidence {#sec:data-ink}

\newthought{The fundamental principle} of analytical design is to show the
data. Every bit of ink on a graphic requires a reason. If the ink
does not tell the viewer something new, it should be erased.

\marginnote{Edward Tufte introduced the \emph{data-ink ratio} in \emph{The Visual Display of Quantitative Information} (1983).}

Consider the ratio of data-ink to total ink in a graphic. A chart burdened
with gridlines, redundant labels, and decorative hatching distracts from
the numbers it purports to present. Maximize the data-ink ratio, within
reason, and the result is a clearer picture.

## The Anscombe Quartet {#sec:anscombe}

\newthought{In 1973, the statistician} Francis Anscombe constructed four
datasets that share nearly identical summary statistics yet look
completely different when plotted.

\marginnote{Anscombe's quartet demonstrates why visualization matters: $\bar{x} = 9$, $\bar{y} \approx 7.5$, and $r^2 = 0.67$ for all four sets, yet the patterns differ radically.}

The quartet drives home a simple lesson: always plot your data.
Summary statistics alone can mislead.

```python
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

x1 = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5]
y1 = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68]
x2 = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5]
y2 = [9.14, 8.14, 8.74, 8.77, 9.26, 8.10, 6.13, 3.10, 9.13, 7.26, 4.74]
x3 = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5]
y3 = [7.46, 6.77, 12.74, 7.11, 7.81, 8.84, 6.08, 5.39, 8.15, 6.42, 5.73]
x4 = [8, 8, 8, 8, 8, 8, 8, 19, 8, 8, 8]
y4 = [6.58, 5.76, 7.71, 8.84, 8.47, 7.04, 5.25, 12.50, 5.56, 7.91, 6.89]

fig, axes = plt.subplots(2, 2, figsize=(6, 5), sharex=True, sharey=True)
for ax, (x, y, label) in zip(
    axes.flat,
    [(x1, y1, "I"), (x2, y2, "II"), (x3, y3, "III"), (x4, y4, "IV")],
):
    ax.scatter(x, y, s=20, color="steelblue", edgecolors="none")
    m, b = np.polyfit(x, y, 1)
    xs = np.linspace(3, 20, 50)
    ax.plot(xs, m * xs + b, color="gray", linewidth=0.8)
    ax.set_title(f"Set {label}", fontsize=10)
    ax.set_xlim(3, 20)
    ax.set_ylim(2, 14)
    ax.tick_params(labelsize=8)

fig.supxlabel("x", fontsize=10)
fig.supylabel("y", fontsize=10)
fig.tight_layout()
os.makedirs("figures", exist_ok=True)
plt.savefig("figures/anscombe.pdf", bbox_inches="tight")
plt.close()
```

![Anscombe's quartet: four datasets with identical summary statistics but distinct patterns.](figures/anscombe.pdf){#fig:anscombe}

As @fig:anscombe shows, the four sets share the same mean, variance, and
correlation, yet the visual stories are entirely different.

# Margin Figures and Full-Width Display {#sec:layout}

\newthought{The wide margin} of the Tufte layout serves as a parallel
channel of communication. Figures, notes, and annotations in the margin
let the main text flow without interruption.

\begin{marginfigure}
\centering
\includegraphics[width=\linewidth]{figures/anscombe.pdf}
\caption{The same Anscombe quartet, placed in the margin for reference.}
\end{marginfigure}

Standard figures appear in the main column with their captions set in the
margin by the Tufte class. Margin figures (above) fit small supporting
graphics alongside the narrative.

## Full-Width Sections {#sec:fullwidth}

\begin{fullwidth}

When a table or figure demands the full page width, the \texttt{fullwidth}
environment extends into the margin area. This is useful for wide tables
or panoramic figures that lose clarity when constrained.

| Dataset | $n$ | $\bar{x}$ | $\bar{y}$ | $s_x$ | $s_y$ | $r$ |
|---------|-----|-----------|-----------|--------|--------|-------|
| I       | 11  | 9.0       | 7.50      | 3.32   | 2.03   | 0.816 |
| II      | 11  | 9.0       | 7.50      | 3.32   | 2.03   | 0.816 |
| III     | 11  | 9.0       | 7.50      | 3.32   | 2.03   | 0.816 |
| IV      | 11  | 9.0       | 7.50      | 3.32   | 2.03   | 0.816 |

: Summary statistics of the Anscombe quartet. {#tbl:anscombe-stats}

\end{fullwidth}

# Mathematical Notation {#sec:math}

\newthought{Clear mathematical} typography supports analytical reasoning.
The sample Pearson correlation coefficient is:

$$r = \frac{\sum_{i=1}^{n} (x_i - \bar{x})(y_i - \bar{y})}{\sqrt{\sum_{i=1}^{n}(x_i - \bar{x})^2 \sum_{i=1}^{n}(y_i - \bar{y})^2}}$$ {#eq:pearson}

@eq:pearson gives $r \approx 0.816$ for each of the four Anscombe sets,
reinforcing the point that correlation is not causation, and that graphs
are not optional.
