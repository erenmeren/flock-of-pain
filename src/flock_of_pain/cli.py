import argparse
import json
from pathlib import Path

from flock_of_pain.engine import RunConfig
from flock_of_pain.examples import reynolds
from flock_of_pain.experiment import compare, off_shift_minutes, run_experiment, top_ledger
from flock_of_pain.io import company_from_dict, company_to_dict, scenario_from_dict
from flock_of_pain.scheduling import POLICIES


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="flock_of_pain")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="run the Reynolds example scenarios")
    demo.add_argument("--days", type=float, default=10)
    demo.add_argument("--reps", type=int, default=5)
    demo.add_argument("--seed", type=int, default=42)
    demo.add_argument("--policy", choices=sorted(POLICIES), default="priority")
    demo.add_argument("--events-dir", type=Path)
    demo.add_argument("--company", type=Path, help="company JSON (default: built-in Reynolds)")
    export = sub.add_parser("export-example", help="write the Reynolds company as JSON")
    export.add_argument("path", type=Path)
    gen = sub.add_parser("generate", help="describe a company in words; Claude writes the company + scenarios JSON")
    gen.add_argument("prompt")
    gen.add_argument("--out", type=Path, help="write here instead of stdout")
    args = parser.parse_args(argv)
    if args.command == "export-example":
        args.path.write_text(json.dumps(company_to_dict(reynolds.build()), indent=2))
        return 0
    if args.command == "generate":
        from flock_of_pain.agent import generate  # optional dependency
        text = json.dumps(generate(args.prompt), indent=2)
        if args.out:
            args.out.write_text(text)
        else:
            print(text)
        return 0

    config = RunConfig(seed=args.seed, horizon_minutes=args.days * 1440, replications=args.reps, policy=args.policy)
    if args.company:
        d = json.loads(args.company.read_text())
        if "company" in d:  # bundle from `generate`: its own scenarios
            base = company_from_dict(d["company"])
            scenarios = [scenario_from_dict(s, base) for s in d["scenarios"]]
        else:
            scenarios = reynolds.scenarios(company_from_dict(d))
    else:
        scenarios = reynolds.scenarios(reynolds.build())
    results = [run_experiment(s.name, s, config) for s in scenarios]
    print(compare(results))
    for r in results:
        print(f"\nTop blocked time: {r.name}")
        print(f"OFF_SHIFT per run: {off_shift_minutes(r):.1f}")
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
