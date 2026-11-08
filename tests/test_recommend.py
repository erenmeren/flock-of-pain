from conftest import tiny_company
from flock_of_pain.analytics import LedgerRow
from flock_of_pain.events import Reason
from flock_of_pain.experiment import Stat, run_experiment, off_shift_minutes, top_ledger
from flock_of_pain.engine import RunConfig
from flock_of_pain.model import Company, Department
from flock_of_pain.recommend import recommend
from flock_of_pain.scenario import Scenario


def stat(x):
    return Stat(x, x, x, x, x, x)


def calm(**kw):
    """A summary no rule fires on."""
    return {k: stat(v) for k, v in {"util_cs": 0.6, "deadline_miss_rate": 0.0, "abandon_rate": 0.0, "rework_rate": 0.0, **kw}.items()}


def by_kind(recs):
    return {r["kind"]: r for r in recs}


def test_calm_summary_gives_nothing():
    assert recommend(calm(), [], 0.0, tiny_company()) == []


def test_overloaded_uses_name_and_figure():
    r = by_kind(recommend(calm(util_cs=0.95), [], 0.0, tiny_company()))["overloaded"]
    assert r["severity"] == "high" and r["department_id"] == "cs"
    assert "Customer Service" in r["message"] and "95%" in r["message"] and "'cs'" not in r["message"]
    assert by_kind(recommend(calm(util_cs=0.82), [], 0.0, tiny_company()))["overloaded"]["severity"] == "medium"


def test_underused():
    r = by_kind(recommend(calm(util_cs=0.1), [], 0.0, tiny_company()))["underused"]
    assert r["severity"] == "info" and "Customer Service" in r["message"] and "10%" in r["message"]


def test_department_without_resources_is_not_underused():
    company = Company("c", "C", [Department("empty", "Empty", [])], [], [])
    assert recommend({"util_empty": stat(0.0)}, [], 0.0, company) == []


def test_top_waiting_reason_each_kind():
    company = tiny_company()
    for reason, kind, word in [(Reason.ALL_RESOURCES_BUSY, "wait_staff", "staff"),
                               (Reason.NO_ELIGIBLE_RESOURCE, "wait_skill", "skill"),
                               (Reason.BATCH_HOLD, "wait_batch", "batch"),
                               (Reason.SYSTEM_DOWN, "wait_system", "ERP")]:
        blocker = "erp" if reason == Reason.SYSTEM_DOWN else None
        recs = recommend(calm(), [LedgerRow("cs", reason, blocker, 600.0, 3)], 0.0, company)
        assert [r["kind"] for r in recs] == [kind]
        assert recs[0]["department_id"] == "cs" and "Customer Service" in recs[0]["message"]
        assert word in recs[0]["message"] and "10.0 hours" in recs[0]["message"]


def test_only_the_top_reason_counts_and_reasons_sum_across_departments():
    company = tiny_company()
    company.departments.append(Department("ops", "Operations", []))
    rows = [LedgerRow("cs", Reason.BATCH_HOLD, None, 500.0, 1), LedgerRow("cs", Reason.ALL_RESOURCES_BUSY, None, 400.0, 1),
            LedgerRow("ops", Reason.ALL_RESOURCES_BUSY, None, 300.0, 1)]
    kinds = [r["kind"] for r in recommend(calm(), rows, 0.0, company)]
    assert kinds == ["wait_staff"]


def test_off_shift_passed_separately():
    rows = [LedgerRow("cs", Reason.ALL_RESOURCES_BUSY, None, 100.0, 1)]
    recs = recommend(calm(), rows, 1200.0, tiny_company())
    assert [r["kind"] for r in recs] == ["wait_staff", "wait_off_shift"]
    assert recs[1]["department_id"] is None and recs[1]["severity"] == "info" and "20.0 hours" in recs[1]["message"]


def test_small_waits_and_unknown_reason_are_ignored():
    rows = [LedgerRow("cs", Reason.ALL_RESOURCES_BUSY, None, 59.0, 1), LedgerRow("cs", None, None, 5000.0, 1)]
    assert recommend(calm(), rows, 30.0, tiny_company()) == []


def test_rate_rules():
    for key, kind, value, severity in [("deadline_miss_rate", "deadline_miss", 0.2, "high"), ("deadline_miss_rate", "deadline_miss", 0.05, "medium"),
                                       ("abandon_rate", "abandonment", 0.1, "high"), ("abandon_rate", "abandonment", 0.02, "medium"),
                                       ("rework_rate", "rework", 0.3, "high"), ("rework_rate", "rework", 0.15, "medium")]:
        recs = recommend(calm(**{key: value}), [], 0.0, tiny_company())
        assert [(r["kind"], r["severity"], r["department_id"]) for r in recs] == [(kind, severity, None)]
        assert f"{value:.0%}" in recs[0]["message"]


def test_ordering_severity_first_and_deterministic():
    company = tiny_company()
    company.departments.append(Department("ops", "Operations", list(company.departments[0].resources)))
    summary = calm(util_cs=0.1, util_ops=0.99, rework_rate=0.15, abandon_rate=0.9)
    rows = [LedgerRow("cs", Reason.BATCH_HOLD, None, 600.0, 1)]
    recs = recommend(summary, rows, 0.0, company)
    assert [r["severity"] for r in recs] == ["high", "high", "medium", "medium", "info"]
    assert [r["kind"] for r in recs] == ["abandonment", "overloaded", "rework", "wait_batch", "underused"]
    assert recs == recommend(dict(reversed(list(summary.items()))), rows, 0.0, company)
    assert all(set(r) == {"severity", "kind", "department_id", "message"} for r in recs)


def test_real_experiment_output_is_accepted():
    company = tiny_company(rate_per_hour=30, pool_headcount=1, employees=0)
    res = run_experiment("s", Scenario("s", "S", company), RunConfig(seed=1, horizon_minutes=2 * 1440), keep_events=False)
    kinds = {r["kind"] for r in recommend(res.summary, top_ledger(res), off_shift_minutes(res), company)}
    assert "overloaded" in kinds


def test_off_shift_does_not_hide_the_top_actionable_wait():
    company = tiny_company()
    dept = company.departments[0].id
    ledger = [LedgerRow(dept, Reason.ALL_RESOURCES_BUSY, None, 120.0, 3)]
    assert {r["kind"] for r in recommend({}, ledger, 6000.0, company)} == {"wait_staff", "wait_off_shift"}
    assert [r["kind"] for r in recommend({}, ledger, 60.0, company)] == ["wait_staff"]  # smaller than the actionable wait

