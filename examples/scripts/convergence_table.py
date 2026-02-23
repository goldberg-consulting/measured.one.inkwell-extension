import os
import csv
import numpy as np

x_jump = np.pi / 2
true_val = 1.0

rows = []
for n in [1, 3, 5, 9, 25, 50]:
    partial = sum(np.sin((2*k-1)*x_jump) / (2*k-1) for k in range(1, n+1)) * 4 / np.pi
    error = abs(partial - true_val)
    overshoot_x = np.linspace(0, np.pi, 5000)
    overshoot_y = sum(np.sin((2*k-1)*overshoot_x) / (2*k-1) for k in range(1, n+1)) * 4 / np.pi
    peak = np.max(overshoot_y)
    rows.append([n, f"{partial:.4f}", f"{error:.4f}", f"{peak:.4f}"])

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
with open(os.path.join(out, "convergence.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Terms (n)", "Value at x=pi/2", "Abs. Error", "Peak Overshoot"])
    w.writerows(rows)

print("Convergence table generated.")
