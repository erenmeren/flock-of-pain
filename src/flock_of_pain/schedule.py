from collections.abc import Iterator
from dataclasses import dataclass, field

MINUTES_PER_DAY = 1440
MINUTES_PER_WEEK = 10080


def weekday(t: float) -> int:
    return int(t // MINUTES_PER_DAY) % 7


@dataclass
class Schedule:
    weekday_hours: dict[int, tuple[float, float]]
    absences: list[tuple[float, float]] = field(default_factory=list)

    def _segments(self, lo: float, hi: float) -> Iterator[tuple[float, float]]:
        """On-shift segments (windows minus absences) overlapping [lo, hi), in order."""
        for day in range(int(lo // MINUTES_PER_DAY), int(hi // MINUTES_PER_DAY) + 1):
            if (h := self.weekday_hours.get(day % 7)) is None:
                continue
            start = max(lo, day * MINUTES_PER_DAY + h[0] * 60)
            end = min(hi, day * MINUTES_PER_DAY + h[1] * 60)
            for a, b in sorted(self.absences):
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
        for s, e in self._segments(t, t + 2 * MINUTES_PER_WEEK):
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
    return Schedule({d: (start_h, end_h) for d in days})
