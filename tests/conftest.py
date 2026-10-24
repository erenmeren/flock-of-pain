from workforce_twin.dist import const
from workforce_twin.model import (
    ArrivalSpec, BusinessSystem, Company, Department, Resource, Step, Workflow,
)
from workforce_twin.schedule import business_hours


def tiny_company(rate_per_hour: float = 0.0, pool_headcount: int = 3) -> Company:
    sched = business_hours(9, 17)
    pool = Resource("cs_pool", "cs", {"support"}, schedule=sched, headcount=pool_headcount)
    e1 = Resource("e1", "cs", {"support"}, pool_id="cs_pool", name="E1")
    c = Company(
        "tiny", "Tiny",
        [Department("cs", "Customer Service", [pool, e1])],
        [BusinessSystem("erp", "ERP")],
        [Workflow(
            "w", "W",
            [Step("a", "A", "cs", "support", const(10), system_id="erp"),
             Step("b", "B", "cs", "support", const(5), depends_on=["a"])],
            ArrivalSpec(rate_per_hour, business_hours(9, 17)),
        )],
    )
    c.resolve()
    return c
