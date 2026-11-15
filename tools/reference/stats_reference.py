"""
Reference values for evalbar's statistics, computed by other people's code.

    python tools/reference/stats_reference.py > test/fixtures/stats-reference.json

Not needed to run evalbar. It exists so that test/stats.test.ts compares the
TypeScript against implementations it shares no code with:

- Wilson and exact (Clopper-Pearson) intervals from statsmodels' proportion_confint,
  and the incomplete beta from scipy.special.
- McNemar's exact conditional p from statsmodels; the mid-p from scipy's
  binomial distribution, as Fagerland, Lydersen and Laake (2013) define it.
- Cohen's kappa and its asymptotic standard error from statsmodels' cohens_kappa.
- Tango's score interval for a paired difference (Tango 1998), with the
  constrained maximum likelihood found by numerical optimisation of the
  multinomial likelihood rather than by the closed-form root evalbar uses,
  and the limits found by root finding on the score statistic.
"""
import json
import math
import sys

import scipy
import statsmodels
from scipy import optimize, special, stats
from statsmodels.stats.contingency_tables import mcnemar
from statsmodels.stats.proportion import proportion_confint

Z = stats.norm.ppf(0.975)


def wilson(k, n):
    lo, hi = proportion_confint(k, n, alpha=0.05, method="wilson")
    return {"k": k, "n": n, "lo": lo, "hi": hi}


def exact(k, n):
    lo, hi = proportion_confint(k, n, alpha=0.05, method="beta")
    return {"k": k, "n": n, "lo": float(lo), "hi": float(hi)}


def mcnemar_ref(b, c):
    m = b + c
    if m == 0:
        return {"b": b, "c": c, "exact": 1.0, "midp": 1.0, "asymptotic": 1.0}
    k = min(b, c)
    exact = mcnemar([[0, b], [c, 0]], exact=True).pvalue
    midp = min(1.0, 2 * (stats.binom.cdf(k, m, 0.5) - 0.5 * stats.binom.pmf(k, m, 0.5)))
    asym = stats.chi2.sf((b - c) ** 2 / m, 1)
    return {"b": b, "c": c, "exact": float(exact), "midp": float(midp), "asymptotic": float(asym)}


def binom_ref(k, n, p0):
    """Twice the smaller tail, the doubling rule; scipy's binomtest uses another two-sided rule, so the tails are taken from its cdf."""
    exact = min(1.0, 2 * min(stats.binom.cdf(k, n, p0), stats.binom.sf(k - 1, n, p0)))
    z = (k / n - p0) / math.sqrt(p0 * (1 - p0) / n)
    return {"k": k, "n": n, "p0": p0, "exact": float(exact), "score": float(min(1.0, 2 * stats.norm.sf(abs(z))))}


def kappa_ref(tp, fn, fp, tn):
    """rows human pass and fail, columns judge pass and fail"""
    from statsmodels.stats.inter_rater import cohens_kappa
    r = cohens_kappa([[tp, fn], [fp, tn]], return_results=True)
    return {"table": [[tp, fn], [fp, tn]], "kappa": float(r.kappa), "std": float(r.std_kappa)}


def constrained_p21(x12, x21, n, d):
    """The MLE of p21 given p12 = p21 + d, by maximising the likelihood numerically."""
    rest = n - x12 - x21

    def nll(p21):
        p12 = p21 + d
        other = 1 - p12 - p21
        if p21 <= 0 or p12 <= 0 or other <= 0:
            return math.inf
        return -(x12 * math.log(p12) + x21 * math.log(p21) + rest * math.log(other))

    lo = max(0.0, -d) + 1e-12
    hi = (1 - d) / 2 - 1e-12
    r = optimize.minimize_scalar(nll, bounds=(lo, hi), method="bounded", options={"xatol": 1e-14, "maxiter": 2000})
    return r.x


def score(x12, x21, n, d):
    p21 = constrained_p21(x12, x21, n, d)
    var = n * (2 * p21 + d * (1 - d))
    return (x12 - x21 - n * d) / math.sqrt(var)


def tango(x12, x21, n):
    est = (x12 - x21) / n
    eps = 1e-9
    lo = -1.0 if est <= -1 + eps else optimize.brentq(lambda d: score(x12, x21, n, d) - Z, -1 + eps, est, xtol=1e-12)
    hi = 1.0 if est >= 1 - eps else optimize.brentq(lambda d: score(x12, x21, n, d) + Z, est, 1 - eps, xtol=1e-12)
    return {"x12": x12, "x21": x21, "n": n, "lo": lo, "hi": hi}


out = {
    "made_by": "python tools/reference/stats_reference.py",
    "python": sys.version.split()[0],
    "scipy": scipy.__version__,
    "statsmodels": statsmodels.__version__,
    "wilson": [wilson(k, n) for k, n in [(0, 10), (1, 10), (5, 10), (10, 10), (95, 100), (99, 100), (20, 20), (0, 2000), (3, 2000), (57, 60), (1000, 1200)]],
    "mcnemar": [mcnemar_ref(b, c) for b, c in [(1, 7), (1, 6), (0, 0), (0, 5), (3, 0), (10, 25), (40, 60), (500, 560)]],
    "exact": [exact(k, n) for k, n in [(0, 10), (1, 10), (5, 10), (10, 10), (95, 100), (99, 100), (20, 20), (0, 2000), (3, 2000), (17, 20), (1000, 1200)]],
    "betainc": [{"x": x, "a": a, "b": b, "value": float(special.betainc(a, b, x))} for x, a, b in [(0.3, 2.0, 5.0), (0.9, 17.0, 4.0), (0.5, 0.5, 0.5), (0.99, 950.0, 51.0), (0.1, 3.7, 12.2)]],
    "binom": [binom_ref(k, n, p0) for k, n, p0 in [(15, 20, 0.9), (16, 20, 0.9), (17, 20, 0.95), (190, 200, 0.9), (1, 10, 0.1), (10, 10, 0.5), (45, 50, 0.8), (3, 2000, 0.001)]],
    "normal_upper": [{"z": z, "upper": float(stats.norm.sf(z))} for z in (0.0, 0.5, 1.0, 1.959964, 2.5, 3.5, -1.0, -2.5)],
    "kappa": [kappa_ref(*t) for t in [(40, 5, 8, 47), (90, 2, 3, 5), (30, 20, 20, 30), (50, 0, 0, 50), (12, 3, 1, 84), (60, 10, 5, 25)]],
    "tango": [tango(x12, x21, n) for x12, x21, n in [(6, 1, 45), (1, 7, 21), (0, 0, 50), (5, 0, 40), (0, 5, 40), (30, 10, 200), (10, 10, 100), (3, 0, 2000)]],
}
json.dump(out, sys.stdout, indent=1)
sys.stdout.write("\n")
