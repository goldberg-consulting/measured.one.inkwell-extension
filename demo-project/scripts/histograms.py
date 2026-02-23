import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import stats

rng = np.random.default_rng(42)
B = 2000
sample_sizes = [2, 5, 15, 50]

distributions = {
    "Exponential($\\lambda=1$)": {
        "draw": lambda n: rng.exponential(1.0, n),
        "mu": 1.0,
        "sigma2": 1.0,
    },
    "Uniform(0, 1)": {
        "draw": lambda n: rng.uniform(0, 1, n),
        "mu": 0.5,
        "sigma2": 1.0 / 12,
    },
    "Beta(2, 5)": {
        "draw": lambda n: rng.beta(2, 5, n),
        "mu": 2.0 / 7,
        "sigma2": (2.0 * 5) / (49 * 8),
    },
}

fig, axes = plt.subplots(len(distributions), len(sample_sizes),
                         figsize=(10, 7), constrained_layout=True)

for row, (name, dist) in enumerate(distributions.items()):
    for col, n in enumerate(sample_sizes):
        means = np.array([dist["draw"](n).mean() for _ in range(B)])
        ax = axes[row, col]
        ax.hist(means, bins=40, density=True, alpha=0.7,
                color="#4A90D9", edgecolor="white", linewidth=0.3)

        mu = dist["mu"]
        se = np.sqrt(dist["sigma2"] / n)
        xs = np.linspace(means.min(), means.max(), 200)
        ax.plot(xs, stats.norm.pdf(xs, mu, se), "k--", linewidth=1.2)

        if row == 0:
            ax.set_title(f"$n = {n}$", fontsize=10)
        if col == 0:
            ax.set_ylabel(name, fontsize=9)
        ax.tick_params(labelsize=7)

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
fig.savefig(os.path.join(out, "histograms.png"), dpi=200, bbox_inches="tight")
plt.close(fig)
print("Histograms generated.")
