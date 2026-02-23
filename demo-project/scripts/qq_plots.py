import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import stats

rng = np.random.default_rng(42)
B = 2000
n = 50

sources = {
    "Exponential": lambda: rng.exponential(1.0, n),
    "Uniform": lambda: rng.uniform(0, 1, n),
    "Beta(2,5)": lambda: rng.beta(2, 5, n),
}

fig, axes = plt.subplots(1, 3, figsize=(10, 3.2), constrained_layout=True)

for ax, (name, draw) in zip(axes, sources.items()):
    means = np.array([draw().mean() for _ in range(B)])
    (osm, osr), (slope, intercept, _) = stats.probplot(means, dist="norm")
    ax.scatter(osm, osr, s=4, alpha=0.3, color="#4A90D9", edgecolors="none")
    line_x = np.array([osm.min(), osm.max()])
    ax.plot(line_x, slope * line_x + intercept, "r-", linewidth=1.2)
    ax.set_title(name, fontsize=10)
    ax.set_xlabel("Theoretical quantiles", fontsize=8)
    ax.set_ylabel("Sample quantiles", fontsize=8)
    ax.tick_params(labelsize=7)
    ax.grid(alpha=0.2)

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
fig.savefig(os.path.join(out, "qq_plots.png"), dpi=200, bbox_inches="tight")
plt.close(fig)
print("QQ plots generated.")
