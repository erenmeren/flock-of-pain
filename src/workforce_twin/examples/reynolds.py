"""Reynolds: a synthetic five-department company. Every number here is an assumed value."""
from math import log

from workforce_twin.dist import Dist, lognormal
from workforce_twin.model import ArrivalSpec, BusinessSystem, Company, Department, Resource, Step, Workflow
from workforce_twin.scenario import AddEmployee, ArrivalMultiplier, Scenario, SystemOutage
from workforce_twin.schedule import MINUTES_PER_DAY, Schedule, business_hours


def lognormal_minutes(m: float, s: float = 0.4) -> Dist:
    """Lognormal with mean m minutes (lognormal() takes the underlying normal's parameters)."""
    return lognormal(log(m) - s * s / 2, s)


def _emp(n: int, dept: str, skills: set[str], cost: float, schedule: Schedule | None, pool: str | None = None) -> Resource:
    return Resource(f"emp_{n:02d}", dept, skills, cost_per_hour=cost, name=f"Employee {n}",
                    schedule=schedule, pool_id=pool)


def _step(id: str, dept: str, skill: str, mean: float, fail: float, depends_on: list[str] | None = None,
          **kw) -> Step:
    return Step(id, id.replace("_", " ").title(), dept, skill, lognormal_minutes(mean),
                depends_on=depends_on or [], failure_prob=fail, max_retries=1, **kw)


def build() -> Company:
    std, early, part, four_day = (business_hours(9, 17), business_hours(8, 16), business_hours(9, 13),
                                  business_hours(8, 18, days=(0, 1, 2, 3)))
    on_leave = Schedule({d: (9, 17) for d in range(5)}, absences=[(7 * MINUTES_PER_DAY, 14 * MINUTES_PER_DAY)])
    cs_skills = {"order_review", "ticket_triage", "erp_entry", "customer_contact"}
    departments = [
        Department("cs", "Customer Support", [
            Resource("cs_pool", "cs", cs_skills, cost_per_hour=18.0, schedule=business_hours(9, 17), headcount=12),
            _emp(1, "cs", cs_skills, 18.0, None, "cs_pool"),  # carved: inherits pool schedule
            _emp(2, "cs", cs_skills, 18.0, None, "cs_pool"),
            _emp(3, "cs", cs_skills, 18.0, part, "cs_pool"),
            _emp(4, "cs", {"order_review", "erp_entry"}, 22.0, early),
            _emp(5, "cs", {"ticket_triage", "customer_contact"}, 20.0, std),
            _emp(6, "cs", cs_skills, 24.0, four_day),
        ]),
        Department("supply_chain", "Supply Chain", [
            Resource("sc_pool", "supply_chain", {"inventory", "logistics"}, cost_per_hour=24.0,
                     schedule=business_hours(8, 16), headcount=8),
            _emp(7, "supply_chain", {"inventory", "logistics"}, 24.0, None, "sc_pool"),
            _emp(8, "supply_chain", {"inventory", "logistics"}, 24.0, part, "sc_pool"),
            _emp(9, "supply_chain", {"inventory"}, 26.0, std),
            _emp(10, "supply_chain", {"logistics"}, 26.0, four_day),
            _emp(11, "supply_chain", {"inventory", "logistics"}, 28.0, std),
        ]),
        Department("finance", "Finance", [
            Resource("finance_pool", "finance", {"billing"}, cost_per_hour=32.0, schedule=business_hours(9, 17),
                     headcount=6),
            _emp(12, "finance", {"credit", "billing"}, 38.0, std),
            _emp(13, "finance", {"credit"}, 40.0, early),
            _emp(14, "finance", {"billing"}, 30.0, part),
            _emp(15, "finance", {"billing", "credit"}, 35.0, on_leave),
            _emp(16, "finance", {"billing"}, 32.0, four_day),
        ]),
        Department("sales", "Sales", [
            _emp(17, "sales", {"sales_ops"}, 28.0, std),
            _emp(18, "sales", {"sales_ops"}, 25.0, early),
            _emp(19, "sales", {"sales_ops"}, 25.0, part),
            _emp(20, "sales", {"sales_ops"}, 30.0, four_day),
        ]),
        Department("it", "IT", [
            _emp(21, "it", {"it_support"}, 34.0, std),
            _emp(22, "it", {"it_support"}, 32.0, early),
            _emp(23, "it", {"it_support"}, 38.0, four_day),
            _emp(24, "it", {"it_support"}, 36.0, std),
        ]),
    ]
    workflows = [
        Workflow("order_modification", "Customer Order Modification", [
            _step("intake", "cs", "order_review", 15, 0.03),
            _step("erp_update", "cs", "erp_entry", 20, 0.05, ["intake"], system_id="erp"),
            _step("inventory_check", "supply_chain", "inventory", 30, 0.04, ["erp_update"]),
            _step("price_adjust", "finance", "billing", 25, 0.03, ["erp_update"]),
            _step("reserve_stock", "supply_chain", "logistics", 20, 0.02, ["inventory_check"]),
            _step("invoice", "finance", "billing", 15, 0.06, ["price_adjust", "reserve_stock"]),
            _step("confirm_customer", "cs", "customer_contact", 10, 0.02, ["invoice"], sla_minutes=480),
        ], ArrivalSpec(6, business_hours(9, 17))),
        Workflow("support_ticket", "Support Ticket", [
            _step("triage", "cs", "ticket_triage", 15, 0.04),
            _step("resolve", "it", "it_support", 40, 0.08, ["triage"]),
            _step("close", "cs", "ticket_triage", 10, 0.02, ["resolve"]),
        ], ArrivalSpec(3, business_hours(9, 17))),
        Workflow("credit_check", "Credit Check", [
            _step("credit_request", "sales", "sales_ops", 20, 0.03),
            _step("credit_review", "finance", "credit", 45, 0.05, ["credit_request"]),
        ], ArrivalSpec(2, business_hours(9, 17))),
    ]
    c = Company("reynolds", "Reynolds", departments,
                [BusinessSystem("erp", "ERP"), BusinessSystem("crm", "CRM")], workflows)
    c.resolve()
    return c


def scenarios(base: Company) -> list[Scenario]:
    new_hire = Resource(id="cs_new", department_id="cs", skills={"order_review", "ticket_triage"},
                        cost_per_hour=18.0, schedule=business_hours(9, 17))
    return [
        Scenario("baseline", "baseline", base),
        Scenario("demand_plus_30", "demand_plus_30", base, [ArrivalMultiplier(1.3)]),
        Scenario("erp_outage_2h", "erp_outage_2h", base,
                 [SystemOutage("erp", 2 * 1440 + 10 * 60, 2 * 1440 + 12 * 60)]),
        Scenario("extra_cs_employee", "extra_cs_employee", base, [AddEmployee("cs", new_hire)]),
    ]
