import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
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
ax.set_xlabel("$x$")
ax.set_ylabel("$y$")
ax.legend()
ax.grid(alpha=0.2)
fig.tight_layout()

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
fig.savefig(os.path.join(out, "scatter.png"), dpi=200, bbox_inches="tight")
plt.close(fig)

r = np.corrcoef(x, y)[0, 1]
print(f"n = {len(x)}, r = {r:.3f}, slope = {m:.3f}")

print(f"::inkwell sample_n={len(x)}")
print(f"::inkwell corr_r={r:.3f}")
print(f"::inkwell slope={m:.3f}")
print(f"::inkwell intercept={b:.3f}")
