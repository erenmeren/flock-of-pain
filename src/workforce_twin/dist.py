import random
from dataclasses import dataclass


@dataclass(frozen=True)
class Dist:
    kind: str
    a: float
    b: float = 0.0
    c: float = 0.0

    def sample(self, rng: random.Random) -> float:
        match self.kind:
            case "const":
                v = self.a
            case "uniform":
                v = rng.uniform(self.a, self.b)
            case "triangular":  # a=low, b=mode, c=high
                v = rng.triangular(self.a, self.c, self.b)
            case "lognormal":
                v = rng.lognormvariate(self.a, self.b)
            case "exponential":
                v = rng.expovariate(1 / self.a)
            case _:
                raise ValueError(f"unknown Dist kind: {self.kind}")
        return max(0.0, float(v))


def const(v: float) -> Dist:
    return Dist("const", v)


def uniform(a: float, b: float) -> Dist:
    return Dist("uniform", a, b)


def triangular(a: float, mode: float, b: float) -> Dist:
    return Dist("triangular", a, mode, b)


def lognormal(mean: float, sigma: float) -> Dist:
    return Dist("lognormal", mean, sigma)


def exponential(mean: float) -> Dist:
    return Dist("exponential", mean)
