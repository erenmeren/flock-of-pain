import random

from flock_of_pain.dist import const, exponential, lognormal, triangular, uniform


def test_const_ignores_rng():
    assert const(5).sample(random.Random(1)) == 5.0


def test_same_seed_same_samples():
    d = lognormal(3.0, 0.5)
    a = [d.sample(random.Random(7)) for _ in range(1)]
    b = [d.sample(random.Random(7)) for _ in range(1)]
    assert a == b


def test_uniform_in_range():
    rng = random.Random(3)
    assert all(10 <= uniform(10, 20).sample(rng) <= 20 for _ in range(100))


def test_exponential_mean_roughly():
    rng = random.Random(11)
    xs = [exponential(30).sample(rng) for _ in range(5000)]
    assert 27 < sum(xs) / len(xs) < 33


def test_never_negative():
    rng = random.Random(5)
    assert all(triangular(-5, 0, 1).sample(rng) >= 0 for _ in range(200))
