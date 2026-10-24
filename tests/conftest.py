from workforce_twin.dist import const
from workforce_twin.model import (
    ArrivalSpec, BusinessSystem, Company, Department, Resource, Step, Workflow,
)
from workforce_twin.schedule import business_hours


def tiny_company(
    rate_per_hour: float = 0.0, pool_headcount: int = 3, employees: int = 1,
    steps: list[Step] | None = None,
) -> Company:
    sched = business_hours(9, 17)
    pool = Resource("cs_pool", "cs", {"support"}, schedule=sched, headcount=pool_headcount)
    staff = [
        Resource(f"e{i}", "cs", {"support"}, pool_id="cs_pool", name=f"E{i}")
        for i in range(1, employees + 1)
    ]
    c = Company(
        "tiny", "Tiny",
        [Department("cs", "Customer Service", [pool, *staff])],
        [BusinessSystem("erp", "ERP")],
        [Workflow(
            "w", "W",
            steps or [Step("a", "A", "cs", "support", const(10), system_id="erp"),
                      Step("b", "B", "cs", "support", const(5), depends_on=["a"])],
            ArrivalSpec(rate_per_hour, business_hours(9, 17)),
        )],
    )
    c.resolve()
    return c
