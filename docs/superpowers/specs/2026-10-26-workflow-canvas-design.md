# Workflow canvas: drag-and-drop process editor with inflows

Date: 2026-10-26. Status: approved 2026-10-26 (UI language: English only, no Turkish).

## 1. Intent

The person who knows the operation (the user's manager) narrates a process out loud; the user builds it on screen while listening, and the manager checks the picture as it grows. Today the workflow editor is a step table that asks for department, skill, duration distribution and dependencies up front, which stops a live narration cold. The canvas replaces that table with a diagram the manager recognises: boxes are steps, arrows are "after", colour is the department, and anything unknown stays visibly unknown until someone fills it in.

The purpose of the model is to see the flow, find where work piles up, and spot departments that are overloaded or idle. AI executors come later and are out of scope here.

## 2. Goals

- A process with the user's real shape can be drawn in a few minutes while someone talks: several entry channels (phone, e-mail, web, customer ERP integration), shared downstream steps, a few parallel branches.
- Every step can exist half-finished (no department, no skill, no duration) without blocking the rest. The simulation still runs; the gaps are visible on the card.
- The manager can read the diagram without help: step name, who does it, how long, what it waits for.
- Nothing in the engine changes. The Company JSON stays the single contract; new fields are additive and optional.

## 3. Non-goals and anti-goals

- No AI executor resource type; no "replace this step with AI" overlay.
- No undo/redo stack. The draft already survives reloads in localStorage; a wrong move is fixed by hand.
- No multi-select, copy/paste, or grouping on the canvas.
- No mobile layout (the app has none).
- No Turkish localisation in this project. The app is English end to end; the canvas keeps that. Localising the whole app is its own project.
- Anti-goal: a canvas that is prettier than the table but still demands every field before a card can exist. If a card cannot be created with just a name, the design failed.
- Anti-goal: losing the manager's layout on save or reload.

## 4. Where it lives

- Route `/processes/[id]` (`web/components/process/workflow-page.tsx`). The step table (`web/components/workflow-editor.tsx`) is removed; the canvas takes its place. The read-only step chain on the overview and on the `/processes` cards stays.
- The header keeps the workflow name (id derives from it, as everywhere now) and the Remove button. The "Arrivals / hour" and "Arrival window" boxes move into inflow nodes on the canvas.

## 5. Data model: inflows and layout

### 5.1 Contract change (`src/flock_of_pain/io.py`, mirrored in `web/lib/company.ts`)

A workflow gains two optional keys:

```json
{
  "id": "order", "name": "Customer order",
  "inflows": [
    {"id": "phone", "name": "Phone", "rate_per_hour": 3, "window": {"weekday_hours": {"0": [9, 17]}}, "entry": ["take_call"]},
    {"id": "web",   "name": "Website", "rate_per_hour": 10, "window": {"weekday_hours": {"0": [0, 24]}}, "entry": ["pick"]}
  ],
  "layout": {"phone": [40, 60], "web": [40, 200], "take_call": [260, 60], "pick": [480, 120]},
  "steps": [ ... as today ... ]
}
```

- `inflows`: list of `{id, name, rate_per_hour >= 0, window: Schedule, entry: [step ids, at least one, all existing]}`. Ids unique within the workflow and disjoint from step ids (they share the layout key space).
- `arrival` (today's single entry) stays valid. A workflow must have `arrival` or at least one inflow; having both is an error. A workflow with `arrival` behaves as one inflow named after the workflow whose entry is every step with an empty `depends_on`.
- `layout`: map from inflow or step id to `[x, y]` canvas coordinates. Unknown keys are dropped on load, missing keys are fine (auto layout fills them). The engine never reads it.
- `company_to_dict` writes both keys back unchanged, so saved companies and run requests round-trip the canvas.

### 5.2 Expansion before the engine (`src/flock_of_pain/scenario.py`)

The engine keeps one arrival per `Workflow`. `Scenario.materialize()` applies overlays as today, then calls `expand_inflows(company)` before the final `resolve()`. Expansion turns every workflow with `inflows` into one engine workflow per inflow:

- Engine workflow id: the canvas workflow id when there is exactly one inflow, else `f"{workflow.id}.{inflow.id}"`; name `f"{workflow.name} · {inflow.name}"` in the multi case. The single-inflow rule keeps KPI names stable for companies that exist today.
- Steps: the subgraph reachable from `inflow.entry` by following "successor" edges (step S follows T when T is in `S.depends_on`). `depends_on` is filtered to members of the subgraph, so entry steps start at arrival. `rework_to` pointing outside the subgraph becomes `null`.
- `arrival = ArrivalSpec(inflow.rate_per_hour, inflow.window)`.
- `layout` and `inflows` are not copied to engine workflows.

Overlays run before expansion, on the canvas form. `ArrivalMultiplier` with a `workflow_id` naming a workflow that has inflows scales every inflow's rate; with `workflow_id: null` it scales all arrivals and all inflows. This is the only overlay that touches arrivals.

Event logs, KPIs and ledgers therefore report per engine workflow, i.e. per channel. The web app shows no per-workflow results today; the per-channel ids appear in the `/simulate` response (`runs[].metrics.workflows`) and a per-channel table is a possible follow-up, not part of this project.

### 5.3 Saving a half-finished company (decided by the user on 2026-10-26)

A company that is still being narrated must be saveable to the server, so a session is safe and can be reopened elsewhere. The loader gains a draft mode: `company_from_dict(d, draft=True)` skips only the completeness checks (a step may have an empty `department_id` or `required_skill`, an inflow may have an empty `entry`, a workflow may have neither `arrival` nor `inflows`). Everything else stays: types, unknown keys, unique ids, references that are non-empty must exist, no cycles. `PUT /companies/{id}` loads in draft mode and stores the canonical form; `POST /simulate` and the CLI stay strict, so a run of an unfinished company returns the usual 422 with the step's path, and the client pre-check in 6.5 names the step first. Scenarios saved with a draft company are validated as today.

### 5.4 Validation rules (loader)

- Dependency graph of a workflow (including inflow entry edges) must be acyclic. Today's check, if any, stays; the UI refuses to draw a cycle.
- A step unreachable from every inflow is allowed (it is simply never run) and the UI marks it "not connected".
- The loader rejects a step with an empty `department_id` today and starts rejecting an empty `required_skill` too (builder's call: a task nobody can take queues forever, which is a modelling error, not a result). The web client must still hold such steps in its draft; see 6.5 and 6.9.
- An entry step keeps the dependencies it has inside its own inflow's subgraph. If inflow `phone` has entry `[A, B]` and `B.depends_on` contains `A`, then B waits for A in that channel and the `phone → B` arrow only marks membership. The canvas allows the arrow and does not warn; the panel's "Waits for" line shows A. (Builder's call.)

## 6. The canvas

### 6.1 Library and files

- `@xyflow/react` (React Flow 12) for pan, zoom, node drag, edge drawing and selection. This is the user's call accepted on 2026-10-26: a canvas with edges is not a few lines, and the project already accepts shadcn/base-ui dependencies.
- New: `web/components/process/canvas.tsx` (canvas, node and edge types, palette, side panel), `web/components/process/layout.ts` (auto layout, pure), `web/components/process/expand.ts` is not needed on the client; the client sends the canvas form to the API.
- Removed: `web/components/workflow-editor.tsx`. Keep `editor-fields.tsx` (NumInput, ScheduleEditor, IdTag are reused).
- Visual language: existing glass tokens (`glass`, `glass-inset`, `press`, `--ease-out`), department colours from `accent(index)` in `components/org/parts.tsx`, step numbers via `StepNumber`.

### 6.2 Layout of the page

Three columns inside the existing page frame: palette (left, ~11rem), canvas (centre, fills the rest, min height 32rem, max the viewport minus header), detail panel (right, 18rem, only when something is selected). The canvas has React Flow's controls (zoom, fit) bottom-left and a mini-map off.

### 6.3 Palette

- One chip per department, coloured with that department's accent, showing name and headcount. Drag a chip onto the canvas: a new step node appears at the drop point with `department_id` set, `required_skill` set to the department's first skill if it has exactly one, else empty, `duration` `{kind: "lognormal_mean", mean: 10, sigma: 0.4}`, name "New step" with the name input focused and selected. Click a chip (keyboard and touch fallback): same, placed in the first free spot right of the rightmost node.
- "+ Step" chip: a step with no department (grey).
- "+ Inflow" chip: a new inflow node with rate 1/h, weekday 9-17 window, no entry yet, name "New inflow".
- "Auto layout" button: recomputes positions for every node (6.6) and overwrites the layout.

### 6.4 Nodes and edges

- Step node (~13rem wide): left colour bar in the department accent (dashed grey when no department), name (inline input, commits on blur or Enter, id follows the name), subtitle `Department · 40 min`, a system chip when `system_id` is set, and a warning dot with a tooltip when something is missing (6.5). One target handle on the left, one source handle on the right.
- Inflow node: pill shape with an inbound-arrow icon, name, subtitle `3/h · Mon–Fri 9–17`. One source handle on the right.
- Edge from inflow to step: adds the step to `inflow.entry`. Edge from step A to step B: adds A to `B.depends_on`.
- Semantics are the engine's and are fixed: several arrows into a step mean "waits for all of them"; several arrows out of a step mean "all of them run". There is no either/or routing in this project (it would need a routing probability per edge, which is an engine change). The canvas makes this visible: a step with two or more incoming edges shows a small "waits for all" tag on its left handle, a step with two or more outgoing edges shows "all run" on its right handle, and the panel's "Waits for" line lists the predecessors. A manager who narrates "then it goes to credit check *or* straight to approval" currently has to model that as two inflows or accept both branches running; the builder puts one sentence saying so in the panel help text. Drawing an edge that would create a cycle is refused with a short toast-style message under the canvas ("That would loop back to Take call"). Duplicate edges are ignored.
- Selecting an edge and pressing Delete/Backspace, or clicking the small × on the hovered edge, removes it. A step whose last incoming edge is removed is still fine: it becomes an entry candidate; the "not connected" warning appears only if no inflow reaches it.
- Selecting a node and pressing Delete, or the Remove button in the panel, removes it after the app's confirm dialog ("Remove this step?" / "Remove this inflow?"). Removing a step also drops it from every `depends_on`, `rework_to` and inflow `entry`, exactly as `removeStep` does today.
- Node drag end writes `layout[id]`. Drag in progress does not touch the store.

### 6.5 Half-finished steps

The card shows a warning dot and the panel lists the reasons:

- no department ("Who does this?")
- no skill, or a skill nobody in that department has ("Nobody in Warehouse has `picking`")
- not reachable from any inflow ("Not connected to an inflow")

Save works with such steps (5.3). Run Simulation does not: the API rejects a step without `department_id` or `required_skill`, and the Topbar already shows the 422 message with its path. To make that message useful the client pre-checks before sending and shows the first problem as "Fix `Pack` on the Customer order canvas: who does this?" with a link to the workflow page. The engine's behaviour for an unknown skill (task queues forever) is unchanged and is what the ledger is for.

### 6.6 Auto layout (`layout.ts`, pure)

Longest-path layering: inflows in column 0; a step's column is 1 + max column of its predecessors (inflows count as predecessors of their entry steps); unreachable steps go after the last column. Rows: within a column, order by first appearance in `steps`; vertical spacing 7rem, horizontal 16rem. Used on first open of a workflow with no `layout`, on "Auto layout", and for any node without a stored position.

### 6.7 Detail panel

Opens when a node is selected; closes with Escape or clicking empty canvas.

Step: Name; Department (select, lists all departments); Skill (select of the department's skills, plus a free-text option so a new skill can be typed; typing a new skill does not add it to anyone, the warning explains that); Mean duration (minutes); System (select, "none"); SLA (minutes, optional). "Advanced" disclosure: Priority, Fail %, Rework to (select among predecessors and self), Retries, Duration kind and sigma (same options as today's table). Remove button at the bottom.

Inflow: Name; Rate per hour; Window (the existing ScheduleEditor). Remove button.

All fields use the existing uncontrolled commit-on-blur components so a half-typed number never hits the store.

### 6.8 Draft tolerance in the client

`checkCompany` in `web/lib/company.ts` is what decides whether a localStorage draft survives a reload (`store.tsx` drops a draft that fails it and loads the example). It must accept every state the canvas can produce mid-narration: a workflow with zero inflows and no `arrival`, an inflow with an empty `entry`, a step with an empty `department_id` or `required_skill`, and `layout` keys that match nothing. The API loader stays strict; the client's shape check does not.

### 6.9 Loading existing companies

A workflow that arrives with `arrival` and no `inflows` is shown with one inflow node named after the workflow, entry = steps with empty `depends_on`, and auto layout. The store does not rewrite the company until the user edits something on that canvas; the first edit converts the workflow to the `inflows` form (one inflow, same rate and window, `arrival` removed). Loading the Reynolds example therefore changes nothing on disk.

## 7. Other surfaces that must follow

- `web/lib/company.ts`: `Workflow` type gets `inflows?` and `layout?`, `arrival?` becomes optional; `checkCompany` accepts both forms; `renameInScenarios` unchanged.
- `web/components/process/step-chain.tsx`, the overview flow strip and `web/components/dashboard/org-map.tsx` (reads `w.arrival.rate_per_hour` for the inflow column): steps with no department render grey instead of crashing on `accent(-1)`; inflow rates sum over `inflows` when present.
- `web/components/process/workflow-page.tsx` header subtitle: replace `fmt(wf.arrival.rate_per_hour)` with the sum over inflows.
- `web/app/processes/page.tsx` cards: show "2 inflows · 7 steps".
- `web/components/scenario/overlay-editor.tsx`: the `arrival_multiplier` workflow picker is unchanged (it names canvas workflows).
- `src/flock_of_pain/agent.py`: the generation prompt keeps asking for `arrival`; the loader accepts it. No change.
- `README.md`: document `inflows` and `layout` under `POST /simulate` and the Web section.
- Tests: `tests/test_io.py` round trip with inflows and layout, both-forms error, single-inflow id rule, draft mode accepts the three incomplete states and strict mode rejects them; `tests/test_api.py` PUT of an unfinished company succeeds and simulate of it returns 422; `tests/test_scenario.py` (or new) expansion subgraph with a shared downstream step reached from two inflows, `rework_to` outside the subgraph becomes null, `ArrivalMultiplier` scales inflows; `web/scripts/check.ts` auto layout columns and cycle refusal.

## 8. Constraints

- Engine (`engine.py`, `scheduling.py`, `analytics.py`) untouched.
- Company JSON remains the only contract; the web client never needs the expanded form.
- Keep the surgical style of the codebase: pure helpers in `lib`/`ops`-style files with assert tests, uncontrolled inputs with key-based reset, glass tokens, no new global state.

## 9. Left to the builder

- Exact React Flow node/edge styling, handle sizes, zoom limits, fit-view behaviour.
- Whether the warning tooltip is native `title` or a small popover.
- How the pre-run check surfaces (Topbar alert vs. a banner on the canvas), as long as it names the step and links to it.
- Auto layout spacing constants.
