import argparse
from pathlib import Path

from workforce_twin.engine import RunConfig
from workforce_twin.examples import reynolds
from workforce_twin.experiment import compare, run_experiment, top_ledger
from workforce_twin.scheduling import POLICIES


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="workforce_twin")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="run the Reynolds example scenarios")
    demo.add_argument("--days", type=float, default=10)
    demo.add_argument("--reps", type=int, default=5)
    demo.add_argument("--seed", type=int, default=42)
    demo.add_argument("--policy", choices=sorted(POLICIES), default="priority")
    demo.add_argument("--events-dir", type=Path)
    args = parser.parse_args(argv)

    config = RunConfig(seed=args.seed, horizon_minutes=args.days * 1440, replications=args.reps, policy=args.policy)
    results = [run_experiment(s.name, s, config) for s in reynolds.scenarios(reynolds.build())]
    print(compare(results))
    for r in results:
        print(f"\nTop blocked time: {r.name}")
        print("department | reason | blocker | minutes | count")
        for row in top_ledger(r):
            print(f"{row.department_id} | {row.reason or '-'} | {row.blocker_id or '-'} | "
                  f"{row.minutes:.1f} | {row.count:.1f}")
        if args.events_dir:
            args.events_dir.mkdir(parents=True, exist_ok=True)
            for run in r.runs:
                lines = (e.to_json() + "\n" for e in run.events)
                (args.events_dir / f"{r.name}-{run.seed}.jsonl").write_text("".join(lines))
    return 0
