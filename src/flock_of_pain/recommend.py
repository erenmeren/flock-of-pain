"""Rule-based advice for office managers from one scenario's results (pure; no LLM)."""
from collections import defaultdict

from flock_of_pain.analytics import LedgerRow
from flock_of_pain.events import Reason
from flock_of_pain.experiment import Stat
from flock_of_pain.model import Company

OVERLOADED_HIGH, OVERLOADED_MEDIUM = 0.90, 0.80  # department utilization
UNDERUSED = 0.30
MIN_WAIT_MINUTES = 60.0  # per run; less than this is not worth a recommendation
DEADLINE_HIGH, DEADLINE_MEDIUM = 0.10, 0.02
ABANDON_HIGH, ABANDON_MEDIUM = 0.05, 0.01
REWORK_HIGH, REWORK_MEDIUM = 0.20, 0.10
_SEVERITY_ORDER = {"high": 0, "medium": 1, "info": 2}
_WAIT_KINDS = {Reason.ALL_RESOURCES_BUSY: "wait_staff", Reason.NO_ELIGIBLE_RESOURCE: "wait_skill", Reason.SYSTEM_DOWN: "wait_system",
               Reason.BATCH_HOLD: "wait_batch", Reason.OFF_SHIFT: "wait_off_shift"}


def _rate_rule(out: list[dict], summary: dict[str, Stat], key: str, high: float, medium: float, kind: str, text: str) -> None:
    rate = summary[key].mean if key in summary else 0.0
    if rate >= medium:
        out.append({"severity": "high" if rate >= high else "medium", "kind": kind, "department_id": None,
                    "message": text.format(rate=f"{rate:.0%}")})


def _top_wait(ledger: list[LedgerRow], company: Company) -> tuple[dict | None, float]:
    """The largest waiting reason that is not off-shift, and its minutes."""
    totals: dict[Reason, float] = defaultdict(float)
    for row in ledger:
        if row.reason is not None:
            totals[row.reason] += row.minutes
    top = min(totals, key=lambda r: (-totals[r], r), default=None)
    if top is None or totals[top] < MIN_WAIT_MINUTES:
        return None, 0.0
    row = max((r for r in ledger if r.reason == top), key=lambda r: (r.minutes, r.department_id, r.blocker_id or ""))
    dept = next((d.name for d in company.departments if d.id == row.department_id), row.department_id)
    system = next((s.name for s in company.systems if s.id == row.blocker_id), row.blocker_id or "a system")
    hours = f"about {row.minutes / 60:.1f} hours per run"
    message = {
        Reason.ALL_RESOURCES_BUSY: f"The biggest wait is for free staff, most of it in {dept}: {hours}. Consider adding staff there.",
        Reason.NO_ELIGIBLE_RESOURCE: f"Work in {dept} waits because nobody there has the skill it needs: {hours}. "
                                     "Train someone or assign a person with that skill.",
        Reason.SYSTEM_DOWN: f"The biggest wait is the {system} system being down, most of it in {dept}: {hours}. "
                            "Plan outages outside working hours or arrange a fallback.",
        Reason.BATCH_HOLD: f"The biggest wait is work held for a batch release in {dept}: {hours}. Consider releasing batches more often.",
    }[top]
    return {"severity": "medium", "kind": _WAIT_KINDS[top], "department_id": row.department_id, "message": message}, totals[top]


def recommend(summary: dict[str, Stat], ledger: list[LedgerRow], off_shift_minutes: float, company: Company) -> list[dict]:
    """[{severity, kind, department_id, message}], most severe first. ledger excludes off-shift waiting, which comes separately."""
    out: list[dict] = []
    for d in company.departments:
        util = summary.get(f"util_{d.id}")
        if util is None or not d.resources:
            continue
        if util.mean >= OVERLOADED_MEDIUM:
            out.append({"severity": "high" if util.mean >= OVERLOADED_HIGH else "medium", "kind": "overloaded", "department_id": d.id,
                        "message": f"{d.name} is busy {util.mean:.0%} of its working time, which leaves little room for peaks. "
                                   "Consider adding staff or moving work elsewhere."})
        elif util.mean < UNDERUSED:
            out.append({"severity": "info", "kind": "underused", "department_id": d.id,
                        "message": f"{d.name} is busy only {util.mean:.0%} of its working time. "
                                   "It may have room to take on other work."})
    wait, wait_minutes = _top_wait(ledger, company)
    if wait:
        out.append(wait)
    # overnight waits are usually the largest, so they sit beside the top actionable wait, never in place of it
    if off_shift_minutes >= MIN_WAIT_MINUTES and off_shift_minutes > wait_minutes:
        out.append({"severity": "info", "kind": _WAIT_KINDS[Reason.OFF_SHIFT], "department_id": None,
                    "message": f"The biggest wait is for the next shift to start: about {off_shift_minutes / 60:.1f} hours per run in total. "
                               "Consider longer hours, or a shift that covers the time when work piles up."})
    _rate_rule(out, summary, "deadline_miss_rate", DEADLINE_HIGH, DEADLINE_MEDIUM, "deadline_miss",
               "{rate} of cases miss their daily cut-off. Consider more staff before the cut-off or an earlier start.")
    _rate_rule(out, summary, "abandon_rate", ABANDON_HIGH, ABANDON_MEDIUM, "abandonment",
               "{rate} of cases are given up while waiting in a queue. Shorter queues at the busiest steps would keep them.")
    _rate_rule(out, summary, "rework_rate", REWORK_HIGH, REWORK_MEDIUM, "rework",
               "{rate} of work attempts fail and have to be repeated. Look for the cause at the steps that fail most.")
    return sorted(out, key=lambda r: (_SEVERITY_ORDER[r["severity"]], r["kind"], r["department_id"] or "", r["message"]))
