# Workflow Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workflow step table with a drag-and-drop canvas (React Flow) where a process with several entry channels ("inflows") can be drawn half-finished, saved as a draft, and simulated once complete.

**Architecture:** The Company JSON gains two optional per-workflow keys, `inflows` and `layout`; `arrival` stays valid. The Python loader validates them (strict for simulate/CLI, `draft=True` for `PUT /companies`) and `Scenario.materialize()` expands every multi-inflow workflow into one engine workflow per inflow before the final `resolve()`, so the engine is untouched. The web client keeps the canvas form; pure graph helpers (`graph.ts`, `layout.ts`) are tested with asserts, `canvas.tsx` renders them with `@xyflow/react`, `panel.tsx` edits the selected node.

**Tech Stack:** Python 3.12+ stdlib (loader, expansion), pytest via `uv`; Next.js 16 / React 19 / Tailwind v4 / shadcn base-nova, `@xyflow/react` 12, `node --import ./scripts/alias.mjs scripts/check.ts` for web asserts.

**Spec:** `docs/superpowers/specs/2026-10-26-workflow-canvas-design.md` (read §5 before Tasks 1–3, §6 before Tasks 5–6).

## Global Constraints

- `engine.py`, `scheduling.py`, `analytics.py` are not modified (spec §8).
- Company JSON stays the only contract; the web client never builds the expanded form (§8).
- New JSON keys are additive and optional: `inflows`, `layout` on a workflow; `arrival` remains valid; `arrival` + `inflows` on one workflow is an error (§5.1).
- Engine workflow id after expansion: the workflow id when it has exactly one inflow, else `f"{workflow.id}.{inflow.id}"`; name `f"{workflow.name} · {inflow.name}"` in the multi case (§5.2).
- Draft mode skips only completeness checks: empty `department_id`, empty `required_skill`, inflow with empty `entry`, workflow with neither `arrival` nor `inflows`. Everything else (types, unknown keys, unique ids, non-empty references exist, acyclic) stays in both modes (§5.3).
- Strict mode now rejects an empty `required_skill` (§5.4).
- UI copy is English only; no Turkish anywhere (approved 2026-10-26).
- No undo, no multi-select, no copy/paste, no mobile layout (§3).
- Inputs on the canvas and panel are uncontrolled commit-on-blur (`NumInput`, `ScheduleEditor`, keyed `Input`) so a half-typed value never hits the store (§6.7).
- Auto layout constants: column 256 px (16rem), row 112 px (7rem) (§6.6).
- Visual tokens: `glass`, `glass-inset`, `press`, `--ease-out`, `accent(index)`; a step with no department is grey `oklch(0.5 0 0)` (§6.1, §7).
- The working tree already holds uncommitted earlier work (confirm dialog, derived ids). Commit steps add only the paths they list; never `git add -A`.
- File-structure call by the planner: the spec lists `canvas.tsx` and `layout.ts`; this plan also splits pure graph edits into `web/components/process/graph.ts` and the detail panel into `web/components/process/panel.tsx` so each file holds one responsibility.

## Review Focus

1. Renaming a step on the canvas (its id follows the name) must carry the new id into every `depends_on`, `rework_to`, inflow `entry` and `layout` key; a stale reference makes the API reject the company. Test `renameStep` in Task 4.
2. Removing a step must drop it from inflow `entry` lists and from `layout`, not only from `depends_on`/`rework_to`; a dangling `entry` makes strict and draft loads fail. Test `removeNode` in Task 4 and `test_inflow_unknown_entry_rejected` in Task 1.
3. A saved company whose `layout` names an id that no longer exists must load (keys dropped), otherwise an old draft is unopenable. `test_unknown_layout_key_dropped` in Task 1.
4. Run Simulation on a workflow that has no inflow at all, or an inflow that enters no step, must be refused client-side with the workflow named, not with a bare 422. `blockingIssue` asserts in Task 4, wiring in Task 7.
5. `ArrivalMultiplier` with `workflow_id` naming a multi-inflow workflow must scale every inflow, and `workflow_id: null` must scale inflows and `arrival`-form workflows alike. `test_arrival_multiplier_scales_inflows` in Task 2.

---

### Task 1: Model and loader: `Inflow`, optional `arrival`, `layout`, draft mode

**Files:**
- Modify: `src/flock_of_pain/model.py` (`Workflow` L65-69, `Company.resolve` L109-161)
- Modify: `src/flock_of_pain/io.py` (`_items` L68, `_workflow_from_dict` L192-200, `company_from_dict` L217-230, `company_to_dict` L233-245)
- Test: `tests/test_io.py`, `tests/test_model.py`

**Interfaces:**
- Produces: `model.Inflow(id: str, name: str, rate_per_hour: float, window: Schedule, entry: list[str])` dataclass.
- Produces: `model.Workflow(id, name, steps, arrival: ArrivalSpec | None = None, inflows: list[Inflow] = [], layout: dict[str, tuple[float, float]] = {})` (positional `arrival` keeps today's callers working).
- Produces: `Company.resolve(self, draft: bool = False) -> None`.
- Produces: `io.company_from_dict(d: dict, draft: bool = False) -> Company`.
- Produces: `company_to_dict` writes `"arrival"` when set, else `"inflows"` (a list, possibly empty); writes `"layout"` only when non-empty, values as `[x, y]` lists.

- [ ] **Step 1: Write the failing loader tests**

Append to `tests/test_io.py`:

```python
def _inflow_company():
    d = company_to_dict(reynolds.build())
    w = d["workflows"][0]
    first = w["steps"][0]["id"]
    del w["arrival"]
    w["inflows"] = [
        {"id": "phone", "name": "Phone", "rate_per_hour": 3, "window": {"weekday_hours": {"0": [9, 17]}}, "entry": [first]},
        {"id": "web", "name": "Website", "rate_per_hour": 10, "window": {"weekday_hours": {"0": [0, 24]}}, "entry": [first]},
    ]
    w["layout"] = {"phone": [40, 60], first: [260, 60]}
    return d

def test_inflows_and_layout_round_trip():
    d = _inflow_company()
    assert company_to_dict(company_from_dict(d)) == d

def test_unknown_layout_key_dropped():
    d = _inflow_company()
    d["workflows"][0]["layout"]["ghost"] = [1, 2]
    assert "ghost" not in company_to_dict(company_from_dict(d))["workflows"][0]["layout"]

def test_inflow_rate_range_and_unknown_key():
    d = _inflow_company()
    d["workflows"][0]["inflows"][0]["rate_per_hour"] = -1
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == "workflows[0].inflows[0].rate_per_hour"
    d = _inflow_company()
    d["workflows"][0]["inflows"][1]["bogus"] = 1
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == "workflows[0].inflows[1].bogus"

def test_arrival_and_inflows_both_is_error():
    d = _inflow_company()
    d["workflows"][0]["arrival"] = {"rate_per_hour": 1, "window": {"weekday_hours": {"0": [9, 17]}}}
    with pytest.raises(ModelError, match="not both"):
        company_from_dict(d)

def test_inflow_unknown_entry_rejected_in_both_modes():
    d = _inflow_company()
    d["workflows"][0]["inflows"][0]["entry"] = ["nope"]
    for draft in (False, True):
        with pytest.raises(ModelError, match="nope"):
            company_from_dict(d, draft=draft)

def test_inflow_id_must_not_clash_with_step_id():
    d = _inflow_company()
    d["workflows"][0]["inflows"][0]["id"] = d["workflows"][0]["steps"][0]["id"]
    with pytest.raises(ModelError, match="clashes"):
        company_from_dict(d)

@pytest.mark.parametrize("patch", [
    lambda w: w["steps"][0].__setitem__("department_id", ""),
    lambda w: w["steps"][0].__setitem__("required_skill", ""),
    lambda w: w["inflows"][0].__setitem__("entry", []),
])
def test_draft_accepts_what_strict_rejects(patch):
    d = _inflow_company()
    patch(d["workflows"][0])
    with pytest.raises(ModelError):
        company_from_dict(d)
    assert company_to_dict(company_from_dict(d, draft=True)) == d

def test_draft_accepts_workflow_without_entries():
    d = _inflow_company()
    d["workflows"][0]["inflows"] = []
    del d["workflows"][0]["layout"]
    with pytest.raises(ModelError, match="arrival or inflows"):
        company_from_dict(d)
    assert company_to_dict(company_from_dict(d, draft=True)) == d

def test_empty_required_skill_rejected_in_arrival_form():
    d = company_to_dict(reynolds.build())
    d["workflows"][0]["steps"][0]["required_skill"] = ""
    with pytest.raises(ModelError, match="required_skill"):
        company_from_dict(d)
    company_from_dict(d, draft=True)
```

Append to `tests/test_model.py` (add `import pytest`, `from conftest import tiny_company` and `ModelError` to its imports if missing):

```python
def test_workflow_defaults_and_inflow_checks():
    from flock_of_pain.model import Inflow
    from flock_of_pain.schedule import business_hours
    c = tiny_company()
    w = c.workflow("w")
    assert w.inflows == [] and w.layout == {}
    w.inflows = [Inflow("phone", "Phone", 1, business_hours(9, 17), ["a"])]
    with pytest.raises(ModelError, match="not both"):
        c.resolve()
    w.arrival = None
    c.resolve()
    w.inflows.append(Inflow("phone", "Again", 1, business_hours(9, 17), ["a"]))
    with pytest.raises(ModelError, match="duplicate inflow id"):
        c.resolve()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_io.py tests/test_model.py -q`
Expected: the new tests FAIL (`TypeError: unexpected keyword 'draft'`, `KeyError`/`SchemaError: unknown key inflows`, `ImportError: Inflow`).

- [ ] **Step 3: Extend `model.py`**

Add `@dataclass class Inflow` (fields in the Interfaces block) above `Workflow`. Change `Workflow.arrival` to `ArrivalSpec | None = None`, add `inflows: list[Inflow] = field(default_factory=list)` and `layout: dict[str, tuple[float, float]] = field(default_factory=dict)`.

In `Company.resolve(self, draft: bool = False)`:
- Add `(f"inflow in workflow {w.id}", w.inflows)` to the duplicate-id loop (message becomes `duplicate inflow in workflow w id: phone`; the test matches `duplicate inflow`).
- Per workflow, before the step loop: `arrival is not None and inflows` → `ModelError(f"workflow {w.id}: give arrival or inflows, not both")`; `not draft and arrival is None and not inflows` → `ModelError(f"workflow {w.id}: needs arrival or inflows")`; an inflow id in the step id set → `ModelError(f"workflow {w.id}: inflow id {i.id} clashes with a step id")`; `not draft and not i.entry` → `ModelError(f"inflow {i.id}: entry is empty")`; any entry not in the step ids → `ModelError(f"inflow {i.id}: unknown entry step {e}")`.
- In the step loop: skip the department check when `draft and s.department_id == ""`; add `if not draft and not s.required_skill: raise ModelError(f"step {s.id}: empty required_skill")`.

- [ ] **Step 4: Extend `io.py`**

- `_items(d, key, path, build, default=_REQUIRED)` passes `default` to `_get`.
- Add `_inflow_from_dict(d: dict, path: str) -> Inflow`: `id`, `name` str; `rate_per_hour` float with `_check(... >= 0, "must be >= 0")`; `window` via `schedule_from_dict`; `entry` via `_strs`; then `_done`.
- `_workflow_from_dict`: `arrival` becomes optional (`_get(d, "arrival", path, dict, None)`, build `ArrivalSpec` only when present); `inflows = _items(d, "inflows", path, _inflow_from_dict, [])`; `layout`: `_get(d, "layout", path, dict, {})`, every key must be `str` and every value passes `_pair(v, _join(lp, k))`; keep only keys in step ids ∪ inflow ids. Build `Workflow(id, name, steps, arrival, inflows, layout)`.
- `company_from_dict(d, draft=False)` calls `c.resolve(draft)`.
- `company_to_dict`: per workflow write `"arrival"` when `w.arrival is not None` else `"inflows": [...]` with `window` via `schedule_to_dict` and `entry` as a list; `"layout": {k: list(v)}` only when `w.layout`. Order keys `id, name, arrival|inflows, layout, steps` so the round-trip tests compare equal to the dicts built above (dict equality ignores order; the order is for humans).

- [ ] **Step 5: Run the tests**

Run: `uv run pytest -q`
Expected: all pass, including `test_round_trip_example_is_stable` (the Reynolds JSON has no new keys and must not gain any).

- [ ] **Step 6: Commit**

```bash
git add src/flock_of_pain/model.py src/flock_of_pain/io.py tests/test_io.py tests/test_model.py
git commit -m "feat(io): workflow inflows and layout, draft-mode loader, empty required_skill rejected"
```

---

### Task 2: `expand_inflows` and overlays on the canvas form

**Files:**
- Modify: `src/flock_of_pain/scenario.py` (`ArrivalMultiplier.apply` L17-26, `Scenario.materialize` L100-106)
- Test: `tests/test_scenario.py`

**Interfaces:**
- Consumes: `model.Inflow`, `Workflow.inflows`, `Workflow.layout`, `Company.resolve(draft)` from Task 1.
- Produces: `scenario.expand_inflows(c: Company) -> None` (in place; `c.workflows` is replaced by engine workflows; workflows in `arrival` form are left as they are).
- Produces: `Scenario.materialize(self, draft: bool = False) -> Company`: deepcopy, `resolve(draft)`, overlays, `expand_inflows`, `resolve(draft)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_scenario.py`:

```python
from flock_of_pain.dist import const
from flock_of_pain.engine import Engine, RunConfig
from flock_of_pain.model import Inflow, Step
from flock_of_pain.scenario import expand_inflows


def _canvas_company():
    # a -> b -> c (c reworks to b), a -> d; phone enters at a, web enters at c
    c = tiny_company(steps=[
        Step("a", "A", "cs", "support", const(10)),
        Step("b", "B", "cs", "support", const(5), depends_on=["a"]),
        Step("c", "C", "cs", "support", const(5), depends_on=["b"], failure_prob=0.1, rework_to="b"),
        Step("d", "D", "cs", "support", const(5), depends_on=["a"]),
    ])
    w = c.workflow("w")
    w.arrival = None
    w.inflows = [Inflow("phone", "Phone", 3, business_hours(9, 17), ["a"]),
                 Inflow("web", "Web", 10, business_hours(0, 24), ["c"])]
    w.layout = {"phone": (0, 0), "a": (256, 0)}
    c.resolve()
    return c


def test_expand_inflows_splits_per_channel():
    c = _canvas_company()
    expand_inflows(c)
    assert [w.id for w in c.workflows] == ["w.phone", "w.web"]
    phone, web = c.workflows
    assert phone.name == "W · Phone" and phone.arrival.rate_per_hour == 3
    assert [s.id for s in phone.steps] == ["a", "b", "c", "d"]
    assert c.step("w.phone", "c").rework_to == "b"
    assert [s.id for s in web.steps] == ["c"]
    assert web.steps[0].depends_on == [] and web.steps[0].rework_to is None
    assert web.arrival.rate_per_hour == 10 and web.inflows == [] and web.layout == {}
    c.resolve()
    Engine(c, RunConfig(seed=1, horizon_minutes=1440)).run()  # the expanded form is engine-ready


def test_expand_single_inflow_keeps_workflow_id():
    c = _canvas_company()
    c.workflow("w").inflows.pop()
    expand_inflows(c)
    assert [w.id for w in c.workflows] == ["w"] and c.workflows[0].name == "W"


def test_expand_entry_step_keeps_in_subgraph_dependency():
    c = _canvas_company()
    c.workflow("w").inflows[1].entry = ["a", "b"]
    expand_inflows(c)
    assert c.step("w.web", "b").depends_on == ["a"]


def test_expand_leaves_arrival_form_alone():
    c = tiny_company(rate_per_hour=2)
    before = copy.deepcopy(c)
    expand_inflows(c)
    assert c == before


def test_arrival_multiplier_scales_inflows():
    base = _canvas_company()
    c = Scenario("s", "S", base, [ArrivalMultiplier(2, "w")]).materialize()
    assert [w.arrival.rate_per_hour for w in c.workflows] == [6, 20]
    c = Scenario("s", "S", base, [ArrivalMultiplier(2)]).materialize()
    assert [w.arrival.rate_per_hour for w in c.workflows] == [6, 20]
    assert base.workflow("w").inflows[0].rate_per_hour == 3  # base untouched


def test_materialize_draft_tolerates_incomplete_company():
    base = _canvas_company()
    base.workflow("w").inflows[1].entry = []
    base.workflow("w").steps[0].department_id = ""
    with pytest.raises(ModelError):
        Scenario("s", "S", base, []).materialize()
    Scenario("s", "S", base, []).materialize(draft=True)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_scenario.py -q`
Expected: FAIL with `ImportError: cannot import name 'expand_inflows'`.

- [ ] **Step 3: Implement in `scenario.py`**

`expand_inflows(c)`: for each workflow with `inflows`, build `succ: dict[str, list[str]]` (T → steps whose `depends_on` contains T). For each inflow, BFS from `inflow.entry` over `succ`; keep steps in their original order; `copy.deepcopy` each kept step, filter `depends_on` to the kept set, set `rework_to = None` when it is not in the kept set; `ArrivalSpec(inflow.rate_per_hour, inflow.window)`; id/name per the Global Constraints rule. Replace `c.workflows` with the new list, preserving the position of untouched `arrival`-form workflows.

`ArrivalMultiplier.apply`: in the matching workflows, scale `w.arrival.rate_per_hour` when `w.arrival` is not None and every `i.rate_per_hour` in `w.inflows`.

`materialize(draft=False)`: `c.resolve(draft)` → overlays → `expand_inflows(c)` → `c.resolve(draft)`.

- [ ] **Step 4: Run the tests**

Run: `uv run pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/flock_of_pain/scenario.py tests/test_scenario.py
git commit -m "feat(scenario): expand inflows into engine workflows before a run; multiplier scales inflows"
```

---

### Task 3: API draft save, strict simulate, README

**Files:**
- Modify: `src/flock_of_pain/api.py` (`_load` L90-100, `put_company` L154-160)
- Modify: `README.md` (API section L29-41, Web section L52-58)
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: `company_from_dict(d, draft)`, `Scenario.materialize(draft)`.
- Produces: `_load(company_d, scenarios_d, draft: bool = False)`; `PUT /companies/{id}` loads with `draft=True`; `POST /simulate` unchanged (strict).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
def test_put_draft_company_then_simulate_422():
    ex = client.get("/example").json()
    ex["company"]["workflows"][0]["steps"][0]["department_id"] = ""
    r = client.put("/companies/reynolds", json=ex)
    assert r.status_code == 200, r.text
    assert client.get("/companies/reynolds").json()["company"]["workflows"][0]["steps"][0]["department_id"] == ""
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"], "config": {"seed": 1, "days": 1}})
    assert r.status_code == 422 and "department_id" in r.json()["message"]


def test_simulate_with_inflows():
    ex = client.get("/example").json()
    w = ex["company"]["workflows"][0]
    first = w["steps"][0]["id"]
    del w["arrival"]
    w["inflows"] = [{"id": "phone", "name": "Phone", "rate_per_hour": 2, "window": {"weekday_hours": {"0": [9, 17]}}, "entry": [first]},
                    {"id": "web", "name": "Web", "rate_per_hour": 2, "window": {"weekday_hours": {"0": [9, 17]}}, "entry": [first]}]
    w["layout"] = {"phone": [0, 0]}
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"][:1], "config": {"seed": 1, "days": 1}})
    assert r.status_code == 200, r.text
    r = client.put("/companies/reynolds", json=ex)
    assert r.json()["company"]["workflows"][0]["layout"] == {"phone": [0, 0]}
```

(`test_put_draft_company_then_simulate_422` relies on `store.save_company` returning the stored bundle, which `test_company_store_endpoints` already asserts; if it returns only metadata, read it back with `GET` instead.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_api.py -q`
Expected: `test_put_draft_company_then_simulate_422` FAILS with status 422 on the PUT.

- [ ] **Step 3: Implement**

`_load(company_d, scenarios_d, draft=False)`: pass `draft` to `company_from_dict` and to `s.materialize(draft=draft)`. `put_company` calls `_load(body.company, body.scenarios, draft=True)`.

README API section: after the `PUT /companies/{id}` sentence add that it accepts a draft (steps without department or skill, inflows without entries, workflows without inflows are stored; `/simulate` rejects them with 422). Under `POST /simulate` add one bullet: a workflow carries either `arrival` or `inflows` (`[{id, name, rate_per_hour, window, entry: [step ids]}]`); each inflow runs as its own engine workflow (`order.phone`, `order.web`; the workflow id itself when there is one inflow) and KPIs are reported per channel; `layout` (`{id: [x, y]}`) is stored and ignored by the engine. Web section: replace "click Edit for the step table" with "click Edit for the canvas: drag department chips in as steps, connect them with arrows, add inflow nodes for each entry channel".

- [ ] **Step 4: Run the tests**

Run: `uv run pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/flock_of_pain/api.py tests/test_api.py README.md
git commit -m "feat(api): PUT /companies accepts drafts; document inflows and layout"
```

---

### Task 4: Web contract and pure graph helpers

**Files:**
- Modify: `web/lib/company.ts` (`Workflow` type L31, `checkCompany` L65-86)
- Create: `web/components/process/graph.ts`
- Create: `web/components/process/layout.ts`
- Modify: `web/scripts/check.ts`

**Interfaces:**
- Produces (`company.ts`): `type Inflow = { id: string; name: string; rate_per_hour: number; window: Schedule; entry: string[] }`; `type Pos = [number, number]`; `Workflow = { id; name; arrival?: { rate_per_hour; window }; inflows?: Inflow[]; layout?: Record<string, Pos>; steps: Step[] }`. `checkCompany` accepts a workflow with `arrival`, with `inflows`, or with neither; `inflows` must be an array of objects with string `id` and array `entry`; `layout` must be an object when present.
- Produces (`graph.ts`), all pure, never mutating inputs:
  - `inflowsOf(wf: Workflow): Inflow[]`: `wf.inflows` when the key is present; else when `arrival` is present one implicit inflow `{ id: idFor(wf.name, stepIds, "inflow"), name: wf.name, rate_per_hour, window, entry: steps with empty depends_on }`; else `[]`.
  - `toInflows(wf: Workflow): Workflow`: returns `wf` unchanged when `inflows` is present; otherwise `{ ...wf, inflows: inflowsOf(wf) }` with `arrival` deleted.
  - `rateOf(wf: Workflow): number`: sum of `inflowsOf(wf)` rates.
  - `reachable(wf: Workflow): Set<string>`: step ids reached from any inflow entry by following successor edges.
  - `wouldCycle(wf: Workflow, from: string, to: string): boolean`: true when `from` transitively depends on `to` (or `from === to`).
  - `connect(wf: Workflow, from: string, to: string): Workflow | null`: `from` an inflow id → `to` appended to its `entry`; `from` a step id → appended to `to.depends_on`; returns the same `wf` object when the edge already exists; `null` when `wouldCycle`.
  - `disconnect(wf: Workflow, from: string, to: string): Workflow`: inverse; a `rework_to` equal to the removed dependency becomes `null`.
  - `removeNode(wf: Workflow, id: string): Workflow`: removes the step or inflow, drops the id from every `depends_on`, `rework_to` (→ `null`), inflow `entry`, and `layout`.
  - `renameStep(wf: Workflow, from: string, to: string): Workflow`: id change followed in `steps[i].id`, `depends_on`, `rework_to`, `entry`, `layout`.
  - `renameInflow(wf: Workflow, from: string, to: string): Workflow`: id and `layout` key.
  - `addStep(wf: Workflow, dept: Department | null, pos: Pos): { wf: Workflow; id: string }`: step named "New step", id `idFor("New step", stepIds ∪ inflowIds, "step")`, `department_id: dept?.id ?? ""`, `required_skill` = the department's only distinct skill when it has exactly one, else `""`, `duration: { kind: "lognormal_mean", mean: 10, sigma: 0.4 }`, `depends_on: []`, `layout[id] = pos`.
  - `addInflow(wf: Workflow, pos: Pos): { wf: Workflow; id: string }`: name "New inflow", id `idFor("New inflow", stepIds ∪ inflowIds, "inflow")`, rate 1, `weekdays9to5()`, `entry: []`.
  - `nextFreePos(wf: Workflow): Pos`: `[maxX + 256, yOfRightmost]` over `layout`; `[0, 0]` when empty.
  - `type Issue = { blocking: boolean; text: string }`; `stepIssues(c: Company, wf: Workflow, st: Step, reach = reachable(wf)): Issue[]` in this order: `department_id === ""` → `{blocking: true, text: "Who does this?"}`; `required_skill === ""` → `{blocking: true, text: "What skill is needed?"}`; skill set but nobody in that department has it → `{blocking: false, text: "Nobody in ${dept.name} has \`${skill}\`"}`; `!reach.has(st.id)` → `{blocking: false, text: "Not connected to an inflow"}`.
  - `blockingIssue(c: Company): { workflowId: string; message: string } | null`: first of, in workflow order: no inflows at all → `"${wf.name} has no inflow"`; an inflow with empty `entry` → `"Fix \`${inflow.name}\` on the ${wf.name} canvas: it enters no step"`; a step with a blocking issue → `"Fix \`${st.name}\` on the ${wf.name} canvas: ${issue.text.toLowerCase()}"`.
- Produces (`layout.ts`): `COL = 256`, `ROW = 112`; `autoLayout(wf: Workflow): Record<string, Pos>` (inflows column 0, step column = 1 + max predecessor column with inflows counting as predecessors of their entries, unreachable steps after the last column; rows by first appearance in `inflowsOf`/`steps`, `y = row * ROW`, `x = col * COL`); `fillLayout(wf: Workflow): Record<string, Pos>` = stored positions, missing ids taken from `autoLayout(wf)`.

- [ ] **Step 1: Write the failing asserts**

Append to `web/scripts/check.ts` (before the final `console.log("ok")`, which should move to the end of the file):

```ts
import { addStep, blockingIssue, connect, inflowsOf, rateOf, removeNode, renameStep, stepIssues, toInflows, wouldCycle } from "@/components/process/graph";
import { autoLayout, fillLayout } from "@/components/process/layout";
// extend the existing `@/lib/company` import line with `type Workflow, checkCompany`

// arrival form reads as one implicit inflow and converts without touching the original
const imp = inflowsOf(wf);
assert.equal(imp.length, 1); assert.equal(imp[0].id, "inflow"); assert.deepEqual(imp[0].entry, ["1", "2", "3", "4"]);
assert.equal(rateOf(wf), 1);
const conv = toInflows(wf);
assert.equal(conv.arrival, undefined); assert.equal(conv.inflows!.length, 1); assert.equal(toInflows(conv), conv); assert.equal(wf.arrival.rate_per_hour, 1);

// edges, cycles, duplicates
const cw: Workflow = { id: "w", name: "W", steps: wf.steps, inflows: [{ id: "phone", name: "Phone", rate_per_hour: 3, window: sched, entry: ["1"] }], layout: { phone: [0, 0] } };
const c1 = connect(cw, "1", "2")!;
assert.deepEqual(c1.steps[1].depends_on, ["1"]);
assert.equal(connect(c1, "1", "2"), c1);
assert.equal(wouldCycle(c1, "2", "1"), true); assert.equal(connect(c1, "2", "1"), null);
const c2 = connect(c1, "phone", "2")!;
assert.deepEqual(c2.inflows![0].entry, ["1", "2"]); assert.equal(connect(c2, "phone", "2"), c2);

// rename and remove follow every reference
const ren = renameStep(c2, "1", "one");
assert.equal(ren.steps[0].id, "one"); assert.deepEqual(ren.steps[1].depends_on, ["one"]); assert.deepEqual(ren.inflows![0].entry, ["one", "2"]);
const gone = removeNode({ ...c2, layout: { ...c2.layout, "1": [5, 5] } }, "1");
assert.equal(gone.steps.length, 3); assert.deepEqual(gone.steps[0].depends_on, []); assert.deepEqual(gone.inflows![0].entry, ["2"]); assert.equal(gone.layout!["1"], undefined);
assert.equal(removeNode(c2, "phone").inflows!.length, 0);

// new step from a department chip: one distinct skill is prefilled
const { wf: withStep, id: newId } = addStep(c2, c.departments[0], [10, 20]);
assert.equal(newId, "new_step"); assert.equal(withStep.steps[4].required_skill, "s"); assert.deepEqual(withStep.layout!.new_step, [10, 20]);
assert.equal(addStep(c2, null, [0, 0]).wf.steps[4].department_id, "");

// auto layout: inflow col 0, 1 col 1, 2 col 2, unreachable 3 and 4 after the last column
const L = autoLayout(c1);
assert.deepEqual([L.phone, L["1"], L["2"], L["3"], L["4"]], [[0, 0], [256, 0], [512, 0], [768, 0], [768, 112]]);
assert.deepEqual(fillLayout(c1).phone, [0, 0]); assert.deepEqual(fillLayout(c1)["2"], [512, 0]);

// issues and the pre-run check
const bare = { ...step("x", ""), required_skill: "" };
assert.deepEqual(stepIssues(c, c1, bare, new Set()).map((i) => `${i.blocking ? "!" : ""}${i.text}`), ["!Who does this?", "!What skill is needed?", "Not connected to an inflow"]);
assert.deepEqual(stepIssues(c, c1, step("3", "b")).map((i) => i.text), ["Nobody in B has `s`", "Not connected to an inflow"]);
assert.equal(blockingIssue({ ...c, workflows: [c1] }), null);
assert.equal(blockingIssue({ ...c, workflows: [{ ...c1, steps: [bare, ...c1.steps] }] })!.message, "Fix `x` on the W canvas: who does this?");
assert.equal(blockingIssue({ ...c, workflows: [{ ...c1, inflows: [] }] })!.message, "W has no inflow");
assert.equal(blockingIssue({ ...c, workflows: [{ ...c1, inflows: [{ ...c1.inflows![0], entry: [] }] }] })!.workflowId, "w");

// checkCompany keeps every half-finished draft the canvas can produce
checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [bare], inflows: [{ id: "i", name: "i", rate_per_hour: 1, window: sched, entry: [] }], layout: { ghost: [1, 2] } }] });
checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [] }] });
assert.throws(() => checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [], inflows: [{ id: 3 }] }] }));
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test`
Expected: FAIL, module `@/components/process/graph` not found.

- [ ] **Step 3: Implement `company.ts` changes, `graph.ts`, `layout.ts`**

Follow the Interfaces block. In `checkCompany`, replace the `isObj(w.arrival) && ...` clause with: `arrival` absent or shaped as today; `inflows` absent or an array of objects with string `id` and array `entry`; `layout` absent or `isObj`. Error text: `"workflows must be a list of objects with steps, durations and an arrival or inflows"`.

- [ ] **Step 4: Run the asserts, types and lint**

Run: `cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: `ok`, no type or lint errors (`workflow-page.tsx`, `processes/page.tsx`, `org-map.tsx` still compile because `wf.arrival` is now optional: fix any `possibly undefined` errors there with `rateOf(wf)`; Task 7 finishes those surfaces).

- [ ] **Step 5: Commit**

```bash
git add web/lib/company.ts web/components/process/graph.ts web/components/process/layout.ts web/scripts/check.ts
git commit -m "feat(web): inflows/layout contract, pure canvas graph helpers and auto layout"
```

---

### Task 5: The canvas

**Files:**
- Modify: `web/package.json` (add `@xyflow/react`)
- Create: `web/components/process/canvas.tsx`
- Modify: `web/components/process/workflow-page.tsx`
- Delete: `web/components/workflow-editor.tsx`

**Interfaces:**
- Consumes: everything in Task 4's `graph.ts` and `layout.ts`; `useConfirm` from `@/lib/confirm`; `IdTag`, `NumInput` from `@/components/editor-fields`; `accent`, `INLINE_INPUT` from `@/components/org/parts`; `durationMean`, `idFor` from `@/lib/company`; `windowSummary`, `unskilled` from `step-chain.tsx`.
- Produces: `export function ProcessCanvas({ wf, company, onChange }: { wf: Workflow; company: Company; onChange: (w: Workflow) => void })`. Every edit goes through `const edit = (f: (w: Workflow) => Workflow) => onChange(f(toInflows(wf)))`, so the first edit converts an `arrival`-form workflow (§6.9). Internally it owns `selected: string | null` and renders `DetailPanel` from Task 6 when set (until Task 6 lands, render nothing in that slot).

- [ ] **Step 1: Install React Flow**

Run: `cd web && npm install @xyflow/react@^12`
Expected: `package.json` lists `"@xyflow/react": "^12.x"`; `npx tsc --noEmit` still passes.

- [ ] **Step 2: Build `canvas.tsx`**

Decisions the implementer cannot make alone:
- Top of file: `"use client"; import "@xyflow/react/dist/style.css";`. Wrap the component body in `<ReactFlowProvider>` so `useReactFlow().screenToFlowPosition` is available for drops.
- `nodes`/`edges` state via `useNodesState` / `useEdgesState`, re-synced in a `useEffect` whenever `wf`, `company` or `selected` changes: positions from `fillLayout(wf)`; node type `"inflow"` for `inflowsOf(wf)` and `"step"` for steps; edge ids `` `${from}->${to}` `` (inflow → entry step, dependency → step), `type: "default"`, `deletable: true`.
- `nodeTypes = { step: StepNode, inflow: InflowNode }` defined at module scope (React Flow warns when recreated).
- Step node (`~13rem`, `glass-inset rounded-xl`): 3 px left bar in `accent(deptIndex)` or dashed grey; name as an uncontrolled `<Input className={`nodrag ${INLINE_INPUT}`} key={st.name} defaultValue={st.name}>` committing on blur and on Enter (Enter blurs), commit = `edit(w => renameStep({...w, steps: ...name}, st.id, idFor(name, otherIds, "step", st.id)))` where `otherIds` = other step ids ∪ inflow ids; subtitle `${deptName || "no department"} · ${mean} min`; system chip when `system_id`; amber warning dot with `title={issues.map(i => i.text).join("\n")}` when `stepIssues` is non-empty (native title, planner's call); `<Handle type="target" position={Position.Left}>` and `<Handle type="source" position={Position.Right}>`; tag `waits for all` beside the left handle when `fanIn >= 2` and `all run` beside the right handle when `fanOut >= 2` (§6.4).
- Inflow node: pill `rounded-full glass-inset` with `ArrowDownToLine` icon, name input (same commit pattern, ids via `renameInflow` with base `"inflow"`), subtitle `${fmt(rate, 2)}/h · ${windowSummary(window)}`; one source handle on the right.
- New-node focus: state `focusId: string | null`; the step/inflow node receives `data.focus === true` and its name input has `autoFocus` and `onFocus={(e) => e.currentTarget.select()}`; `focusId` resets to `null` on that input's blur.
- `onNodeDragStop={(_, n) => edit(w => ({ ...w, layout: { ...w.layout, [n.id]: [Math.round(n.position.x), Math.round(n.position.y)] } }))}`; drag in progress touches only React Flow state.
- `onConnect={({ source, target }) => { const next = connect(toInflows(wf), source, target); if (next === null) setToast(`That would loop back to ${stepName(target)}`); else if (next !== toInflows(wf)) onChange(next); }}` (a duplicate edge is ignored silently).
- Edge type `"flow"` (module-scope `edgeTypes`): `BaseEdge` on `getBezierPath`, plus an `EdgeLabelRenderer` holding a 16 px round × button at the path midpoint, visible only while the edge is selected or hovered (`group`/`group-hover`), `onClick` → `edit(w => disconnect(w, source, target))` (§6.4).
- `deleteKeyCode={["Delete", "Backspace"]}`; `onBeforeDelete={async ({ nodes }) => nodes.length === 0 || confirm(nodes[0].type === "inflow" ? "Its arrows are removed with it." : "Its arrows are removed with it.", { title: nodes[0].type === "inflow" ? "Remove this inflow?" : "Remove this step?", action: "Remove", destructive: true })}`; `onDelete={({ nodes, edges }) => edit(w => { let n = w; for (const e of edges) n = disconnect(n, e.source, e.target); for (const x of nodes) n = removeNode(n, x.id); return n; })}`. Deleting a node never prompts for its edges separately.
- `onSelectionChange={({ nodes }) => setSelected(nodes[0]?.id ?? null)}`; Escape and empty-canvas clicks deselect through React Flow's defaults, which closes the panel.
- Toast: `const [toast, setToast] = useState<string | null>(null)`; a `useEffect` clears it after 3000 ms; rendered under the canvas as `text-xs text-amber-400`.
- Palette (left column, `w-44`): one chip per department (`accent(i)` dot, name, `deptHeadcount`), `draggable` with `onDragStart={(e) => e.dataTransfer.setData("application/x-flock-dept", d.id)}`; "+ Step" chip (same with `""`); "+ Inflow" chip (`application/x-flock-inflow`); "Auto layout" button → `edit(w => ({ ...w, layout: autoLayout(w) }))` then `fitView()`. Clicking a chip adds at `nextFreePos(wf)`.
- Canvas wrapper: `onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}`, `onDrop` reads the two data keys, `pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })`, calls `addStep`/`addInflow`, `onChange(result.wf)`, `setFocusId(result.id)`, `setSelected(result.id)`.
- `<ReactFlow colorMode="dark" fitView minZoom={0.3} maxZoom={1.5} nodesConnectable nodeTypes={nodeTypes} ...>` with `<Controls showInteractive={false} />`; no `MiniMap`, no `Background`. Container `glass rounded-2xl` with `min-h-[32rem] h-[calc(100vh-14rem)]`.
- Layout: `grid gap-4 grid-cols-[11rem_1fr]`, becomes `grid-cols-[11rem_1fr_18rem]` when `selected` is set.
- Help text under the palette, one sentence (§6.4): "Several arrows into a step mean it waits for all of them; several arrows out mean all of them run. An either/or split is modelled as two inflows."

- [ ] **Step 3: Wire `workflow-page.tsx`, delete the table**

Replace the `Panel "Process flow"` and `<WorkflowCard>` with: a header row (`IconTile`, name `Input` with the `idFor(..., "workflow", wf.id)` rename exactly as `WorkflowCard` did it, `IdTag`, Remove button calling `onRemove`) and `<ProcessCanvas wf={wf} company={company} onChange={onChange} />`. Subtitle: `` `${wf.id} · ${fmt(rateOf(wf), 2)}/h · ${n} inflow${n === 1 ? "" : "s"} · mean cycle ${fmt(cycleMean(wf))} min` `` with `n = inflowsOf(wf).length`. Delete `web/components/workflow-editor.tsx`; move `withMean` to `panel.tsx` in Task 6 (temporarily keep it in `canvas.tsx` if Task 6 is not yet done, exported).

- [ ] **Step 4: Type-check, lint, and run the app**

Run: `cd web && npx tsc --noEmit && npm run lint && npm test`
Expected: clean.

Then with the dev servers running (API on :8000, web on :3000), drive it headlessly as in earlier sessions (chromium `--remote-debugging-port=9222` plus a CDP script in the scratchpad; kill with the saved PID, never `pkill -f`): open `/processes/order` for the Reynolds example and screenshot. Expected: one inflow node named after the workflow at column 0, steps laid out left to right, arrows between dependent steps, no console errors. Drop a department chip, type a name, press Enter: a new step with the typed name and the department colour; `localStorage.flock_draft` now holds `inflows` for that workflow and no `arrival`.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/components/process/canvas.tsx web/components/process/workflow-page.tsx
git rm web/components/workflow-editor.tsx
git commit -m "feat(web): drag-and-drop process canvas with inflow nodes replaces the step table"
```

---

### Task 6: Detail panel

**Files:**
- Create: `web/components/process/panel.tsx`
- Modify: `web/components/process/canvas.tsx` (render the panel in the third column)

**Interfaces:**
- Consumes: `connect`, `disconnect`, `stepIssues`, `reachable` from `graph.ts`; `NumInput`, `ScheduleEditor`, `clamp` from `editor-fields.tsx`; `Select` family from `@/components/ui/select`; `Input` with a `<datalist>`.
- Produces: `export function DetailPanel({ wf, company, selected, onChange, onClose, onRemove }: { wf: Workflow; company: Company; selected: string; onChange: (w: Workflow) => void; onClose: () => void; onRemove: () => void })`. `wf` is already in inflows form (the canvas passes `toInflows(wf)`); `onClose` deselects; `onRemove` is the canvas's confirm-then-`removeNode` for the selected node.
- Produces: `export function withMean(d: Dist, mean: number): Dist` (moved verbatim from the deleted `workflow-editor.tsx`).

- [ ] **Step 1: Build `panel.tsx`**

Step panel, top to bottom (§6.7), each field a `Label` over a control, all `w-full`:
- Issues list first when non-empty: one amber line per `stepIssues` entry; the skill issue line ends with "Typing a skill here does not give it to anyone; add it on the People page."
- Department: `Select` over `company.departments` (`items` `{[id]: name}`), plus a first item `"__none__": "— none —"`; changing it keeps `required_skill` when the new department has it, else sets the department's single skill or `""` (same rule as `addStep`).
- Skill: `<Input key={`${st.department_id}:${st.required_skill}`} list={`skills-${st.id}`} defaultValue={st.required_skill}>` committing on blur, with `<datalist id={`skills-${st.id}`}>` of the department's distinct skills, sorted.
- Mean duration: `NumInput min={0.01} lo={0.01}` → `withMean`; when `durationMean` is `null` show "duration kind `{kind}`: edit in the JSON tab".
- System: `Select` with `"__none__": "none"` plus systems.
- SLA minutes: keyed number `Input`, blank → `null` (copy the table's handler).
- "Waits for" line: predecessor names joined by ", " or "nothing (entry step)".
- `<details>` "Advanced": Priority (`NumInput lo={-1e9} hi={1e9}`), Fail % (`NumInput hi={100}`), Rework to (`Select` of none / self / predecessors), Retries (`NumInput`), Sigma (`NumInput lo={0.05} hi={3}`, only when `duration.kind === "lognormal_mean"`; planner's call: no duration-kind picker, other kinds stay JSON-tab only as today).
- Remove button (`variant="ghost"`, `Trash2`) → `onRemove`.

Inflow panel: Name (keyed `Input`, rename through `renameInflow` with `idFor(name, otherIds, "inflow", inflow.id)`), Rate per hour (`NumInput min={0}`), Window (`ScheduleEditor id={`inflow ${inflow.id}`}`), "Enters at" line listing entry step names, Remove button.

Panel chrome: `glass rounded-2xl p-4 flex flex-col gap-3 rise`, a close `×` button top-right calling `onClose`.

- [ ] **Step 2: Wire into the canvas and verify**

In `canvas.tsx` render `<DetailPanel wf={toInflows(wf)} company={company} selected={selected} onChange={onChange} onClose={() => setSelected(null)} onRemove={removeSelected} />` when `selected` is set and the id still exists. `removeSelected` = confirm (same copy as `onBeforeDelete`) then `edit(w => removeNode(w, selected))` and `setSelected(null)`.

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: clean.

Headless check: select a step, change its department via the panel, blur a new mean of 25: the node subtitle shows the new department and `25 min`; press Escape: the panel closes; click Remove, confirm: the node and its arrows are gone and `depends_on` of its successors no longer names it (inspect `localStorage.flock_draft`).

- [ ] **Step 3: Commit**

```bash
git add web/components/process/panel.tsx web/components/process/canvas.tsx
git commit -m "feat(web): canvas detail panel for steps and inflows"
```

---

### Task 7: Surfaces that read `arrival`, and the pre-run check

**Files:**
- Modify: `web/app/processes/page.tsx` (`add` L21-25, subtitle L37)
- Modify: `web/components/dashboard/org-map.tsx:64`
- Modify: `web/components/dashboard/flow.tsx:15`
- Modify: `web/lib/api.ts` (`ApiError` L40)
- Modify: `web/lib/store.tsx` (`run` L142-152)
- Modify: `web/components/shell/topbar.tsx` (error Alert L36-41)
- Modify: `web/scripts/check.ts`

**Interfaces:**
- Consumes: `inflowsOf`, `rateOf`, `blockingIssue` from `graph.ts`.
- Produces: `ApiError = { path: string | null; message: string; href?: string }`.

- [ ] **Step 1: Add the assert for the new-workflow shape**

Append to `web/scripts/check.ts`:

```ts
import { newWorkflow } from "@/components/process/graph";
const nw = newWorkflow("Customer order", ["order"]);
assert.equal(nw.id, "customer_order"); assert.equal(nw.arrival, undefined); assert.equal(nw.inflows!.length, 1); assert.deepEqual(nw.inflows![0].entry, []); assert.equal(nw.steps.length, 0);
```

Run: `cd web && npm test`
Expected: FAIL, `newWorkflow` is not exported.

- [ ] **Step 2: Implement**

- `graph.ts`: `export function newWorkflow(name: string, takenIds: Iterable<string>): Workflow` → `{ id: idFor(name, takenIds, "workflow"), name, inflows: [{ id: "new_inflow", name: "New inflow", rate_per_hour: 1, window: weekdays9to5(), entry: [] }], layout: { new_inflow: [0, 0] }, steps: [] }` (one inflow node so the canvas never opens empty).
- `processes/page.tsx`: `add` uses `newWorkflow("New workflow", ids)`; card subtitle `` `${n} inflow${n === 1 ? "" : "s"} · ${fmt(rateOf(wf), 2)}/h · ${steps} step(s) · mean cycle …` `` with `n = inflowsOf(wf).length`.
- `org-map.tsx:64`: `fmt(rateOf(w), 1)`.
- `flow.tsx:15`: `const color = (id: string) => (di.has(id) ? accent(di.get(id)!) : "oklch(0.5 0 0)")`.
- `api.ts`: add `href?: string` to `ApiError`.
- `store.tsx` `run`: inside the `act` callback, before `simulate`, `const issue = blockingIssue(company); if (issue) { setError({ path: "company", message: issue.message, href: `/processes/${encodeURIComponent(issue.workflowId)}` }); return; }`.
- `topbar.tsx`: inside `AlertDescription`, after the message, `{t.error.href && <Link href={t.error.href} className="ml-2 underline">Open canvas</Link>}`.

- [ ] **Step 3: Verify**

Run: `cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: clean.

Headless: on the Reynolds draft drop a "+ Step" chip (no department) and press Run Simulation. Expected: no network call to `/simulate`; the top-bar alert reads `Fix \`New step\` on the Customer order canvas: who does this?` with an "Open canvas" link to that workflow. Remove the step, run again: the simulation runs and the Analysis page lists the workflow once (single inflow keeps the id).

- [ ] **Step 4: Commit**

```bash
git add web/app/processes/page.tsx web/components/dashboard/org-map.tsx web/components/dashboard/flow.tsx web/lib/api.ts web/lib/store.tsx web/components/shell/topbar.tsx web/components/process/graph.ts web/scripts/check.ts
git commit -m "feat(web): inflow-aware process cards and overview, client pre-run check with canvas link"
```

---

### Task 8: End-to-end check and graph refresh

**Files:**
- No new code expected; fixes found here go into the file that owns them.

- [ ] **Step 1: Full test run**

Run: `uv run pytest -q && cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: all green.

- [ ] **Step 2: Narration scenario in the browser**

With both servers up, headless CDP script: create an empty company "Acme" on Settings, add departments "Customer Support" and "Warehouse" (each with one pool that has one skill), add a workflow "Order", open its canvas, add a second inflow, drop a Customer Support step and a Warehouse step, connect inflow 1 → step 1 → step 2 and inflow 2 → step 2, Save. Expected: `PUT /companies/acme` returns 200; `GET /companies/acme` round-trips `inflows` and `layout`; reload shows the same positions; Run Simulation returns 200 and the Analysis page shows `order.<inflow1>` and `order.<inflow2>` rows. Then delete step 2 from the canvas, confirm: both inflows drop it from `entry`, Save still succeeds (draft with an inflow entering nothing), Run is refused with the inflow named.

- [ ] **Step 3: Refresh the knowledge graph and commit any fixes**

Run: `graphify update .`
Expected: `graphify-out/graph.json` updated without errors.

```bash
git add <only files changed by fixes in this task>
git commit -m "fix(web): canvas end-to-end fixes"
```
