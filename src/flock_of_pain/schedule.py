from collections.abc import Iterator
from dataclasses import dataclass, field

MINUTES_PER_DAY = 1440
MINUTES_PER_WEEK = 10080


def weekday(t: float) -> int:
    return int(t // MINUTES_PER_DAY) % 7


@dataclass
class Schedule:
    weekday_hours: dict[int, list[tuple[float, float]]]
    absences: list[tuple[float, float]] = field(default_factory=list)
    closed: list[tuple[float, float]] = field(default_factory=list)  # company holidays, sorted; set by Company.resolve

    def __post_init__(self):
        # a bare (start, end) pair is one window
        self.weekday_hours = {d: [tuple(h)] if h and isinstance(h[0], (int, float)) else [tuple(w) for w in h]
                              for d, h in self.weekday_hours.items()}

    def _segments(self, lo: float, hi: float) -> Iterator[tuple[float, float]]:
        """On-shift segments (windows minus absences) overlapping [lo, hi), in order."""
        # start a day early: an overnight shift (e.g. 22-30) from the previous day may still be running at lo
        for day in range(int(lo // MINUTES_PER_DAY) - 1, int(hi // MINUTES_PER_DAY) + 1):
            for h in self.weekday_hours.get(day % 7, ()):
                start = max(lo, day * MINUTES_PER_DAY + h[0] * 60)
                end = min(hi, day * MINUTES_PER_DAY + h[1] * 60)
                for a, b in sorted([*self.absences, *self.closed]):
                    if b <= start or a >= end:
                        continue
                    if a > start:
                        yield start, a
                    start = max(start, b)
                if start < end:
                    yield start, end

    def is_on(self, t: float) -> bool:
        return any(s <= t < e for s, e in self._segments(t, t + 1))

    def next_on(self, t: float) -> float | None:
        # look past the last holiday: a long closure must not read as "never on again"
        for s, e in self._segments(t, max(t, self.closed[-1][1] if self.closed else t) + 2 * MINUTES_PER_WEEK):
            if e > t:
                return max(s, t)
        return None

    def next_off(self, t: float) -> float:
        for s, e in self._segments(t, t + MINUTES_PER_DAY + 1):
            if s <= t < e:
                return e
        raise ValueError(f"not on shift at {t}")

    def on_minutes(self, start: float, end: float) -> float:
        return sum(e - s for s, e in self._segments(start, end))


def business_hours(start_h: float, end_h: float, days=(0, 1, 2, 3, 4)) -> Schedule:
    return Schedule({d: [(start_h, end_h)] for d in days})
