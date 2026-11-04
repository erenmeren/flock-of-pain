import math
import random
from datetime import datetime, timedelta

import pytest

from flock_of_pain.calibrate import fit_arrivals, fit_duration


def test_fit_arrivals_recovers_peak_hour():
    rng, ts = random.Random(1), []
    start = datetime(2026, 10, 5)  # a Monday; two weeks of weekdays, hours 9-17, 16:00 at 3x
    for day in range(14):
        d = start + timedelta(days=day)
        if d.weekday() >= 5:
            continue
        for h in range(9, 17):
            for _ in range(rng.randint(28, 32) * (3 if h == 16 else 1)):
                ts.append(d + timedelta(hours=h, seconds=rng.uniform(0, 3599)))
    out = fit_arrivals(ts)
    assert out["observed_days"] == 10
    mean = 30 * (7 + 3) / 8
    assert out["rate_per_hour"] == pytest.approx(mean, rel=0.05)
    assert out["profile"]["hours"]["16"] == pytest.approx(90 / mean, rel=0.05)
    assert set(out["profile"]["hours"]) <= {str(h) for h in range(9, 17)}
    assert all(abs(v - 1) < 0.1 for v in out["profile"]["weekdays"].values())


def test_fit_arrivals_needs_two():
    with pytest.raises(ValueError):
        fit_arrivals([datetime(2026, 10, 5)])


def test_fit_duration_recovers_lognormal():
    rng = random.Random(2)
    mean, sigma = 20, 0.5
    xs = [rng.lognormvariate(math.log(mean) - sigma ** 2 / 2, sigma) for _ in range(20000)] + [0, -3]
    out = fit_duration(xs)
    assert out["kind"] == "lognormal_mean" and out["n"] == 20000
    assert out["mean"] == pytest.approx(mean, rel=0.03) and out["sigma"] == pytest.approx(sigma, rel=0.03)
    assert out["p50"] < out["p90"]
    assert fit_duration([5, 5])["sigma"] == 0.05
    with pytest.raises(ValueError):
        fit_duration([5, 0, -1])
