"""Fit arrival profiles and duration distributions from observed data (pure functions)."""
import math
from collections import Counter
from datetime import datetime
from statistics import fmean, pstdev

from flock_of_pain.analytics import percentile


def fit_arrivals(timestamps: list[datetime]) -> dict:
    """Mean hourly rate plus hour-of-day and weekday multipliers; dates without arrivals are not observed."""
    if len(timestamps) < 2:
        raise ValueError("need at least 2 timestamps")
    per_date = Counter(t.date() for t in timestamps)
    hour_rate = {h: n / len(per_date) for h, n in sorted(Counter(t.hour for t in timestamps).items())}
    rate = fmean(hour_rate.values())
    by_weekday: dict[int, list[int]] = {}
    for d, n in per_date.items():
        by_weekday.setdefault(d.weekday(), []).append(n)
    weekday_mean = {d: fmean(ns) for d, ns in sorted(by_weekday.items())}
    overall = fmean(weekday_mean.values())
    mults = lambda m, base: {str(k): r for k, v in m.items() if (r := round(v / base, 2)) != 1.0}
    return {"rate_per_hour": rate, "profile": {"hours": mults(hour_rate, rate), "weekdays": mults(weekday_mean, overall)},
            "observed_days": len(per_date)}


def fit_duration(minutes: list[float]) -> dict:
    """Lognormal by mean and log-sd (population), sigma clamped to [0.05, 2]; non-positive values are dropped."""
    xs = [x for x in minutes if math.isfinite(x) and x > 0]
    if len(xs) < 2:
        raise ValueError("need at least 2 positive durations")
    sigma = min(2.0, max(0.05, pstdev(math.log(x) for x in xs)))
    return {"kind": "lognormal_mean", "mean": fmean(xs), "sigma": sigma, "n": len(xs),
            "p50": percentile(xs, 50), "p90": percentile(xs, 90)}
