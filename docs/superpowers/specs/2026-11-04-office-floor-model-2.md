# Office-floor model, part 2: batch release, abandonment, overtime cost, common random numbers, CSV calibration

Date: 2026-11-04. Status: approved by the user 2026-11-04 ("disarida kalanlari da bitirebilirsin"). Follows `2026-11-04-office-floor-model.md`; same rules: additive, optional, pinned hashes unchanged, RNG drawn only for features a company uses.

## 1. Batch release (`release_hours` on a step)

```json
{"id": "invoice_run", "...": "...", "release_hours": [12, 17]}
```

- Optional list of hour-of-day values `0 <= h < 24` (fractions allowed), sorted, distinct. Tasks for this step are created and queued as today but held: they get `Reason.BATCH_HOLD` (new) and are not dispatchable until the next release time on or after their creation (any day; the engine schedules one heap callback per release moment that has held tasks, not one per task). At release the engine retags each held task to the normal reason (`OFF_SHIFT` / `ALL_RESOURCES_BUSY` / `NO_ELIGIBLE_RESOURCE`) and dispatches.
- `queued_at` stays the creation time, so wait percentiles include the hold. The blocked-time ledger shows `BATCH_HOLD` rows per department; `top_ledger` does not exclude it.
- Wait steps cannot have `release_hours` (`SchemaError`). Draft mode accepts anything well-formed.
- Playback (`web/lib/playback.ts`): a held task counts as queued.

## 2. Abandonment (`patience` on a step)

```json
{"id": "answer_call", "...": "...", "patience": {"kind": "lognormal_mean", "mean": 4, "sigma": 0.6}}
```

- Optional `Dist`. When a task for this step is queued, the engine draws one patience value and schedules a callback at `queued_at + patience`. If the task is still queued then (not started, not cancelled), it is abandoned: new event `TASK_ABANDONED` for the task, then the instance is cancelled like a failed instance today (`_cancel_queued`, `WORKFLOW` not completed). A task that starts before its patience runs out ignores the callback.
- Only meaningful on queueable steps; a wait step rejects `patience`.
- Analytics per workflow: `abandoned` (count of `TASK_ABANDONED`) and `abandon_rate = abandoned / started`. `abandon_rate` joins `KPI_KEYS` after `deadline_miss_rate`. Web `KPI_LABEL` / `BASE_KPIS` / `hints.ts`: "Abandoned %". Abandoned instances count as not completed in `completion_rate` (same as cancelled today).

## 3. Overtime cost (`overtime_rate` on a resource)

```json
{"id": "desk_pool", "cost_per_hour": 18, "overtime_rate": 1.5, "...": "..."}
```

- Optional multiplier `>= 1`, default absent = today's behaviour (overrun costs the plain rate). Busy minutes outside the resource's shift windows (analytics already computes `overrun[r.id]`) are charged at `cost_per_hour * overtime_rate`; on-shift busy minutes at `cost_per_hour`.
- New per-resource metric `overtime_minutes` (= overrun), summed into the department and a company-level `overtime_minutes`; `labor_cost` includes the premium. New KPI key `overtime_hours_per_day` (company overtime minutes / 60 / horizon days) after `labor_cost`. Web label "Overtime h/day".
- Pools: `overtime_rate` applies to the pool; a carved-out person inherits it like the schedule unless set.
- No engine change (tasks still overrun; nothing is paused).

## 4. Common random numbers (`crn` in run config)

```json
"config": {"seed": 42, "days": 30, "replications": 5, "policy": "priority", "crn": true}
```

- `RunConfig.crn: bool = False`. With `false` the engine uses the single `random.Random(seed)` stream exactly as today (hashes unchanged). With `true` each random purpose gets its own stream, seeded from a stable hash so the same scenario element draws the same numbers regardless of what else changed: `random.Random(int.from_bytes(hashlib.sha256(f"{seed}:{kind}:{key}".encode()).digest()[:8], "big"))` where `kind:key` is one of `arrival:<workflow id>` (inter-arrival and profile thinning), `duration:<workflow id>/<step id>`, `failure:<workflow id>/<step id>`, `branch:<workflow id>/<step id>`, `patience:<workflow id>/<step id>`. Streams are created lazily and cached per engine. Replication i uses `seed + i` as today.
- Effect: adding an employee or changing a schedule in a scenario no longer moves arrival times or the k-th duration draw of a step, so scenario deltas are mostly signal. Test: baseline vs. `AddEmployee` scenario under `crn=True` produce identical arrival event times; under `crn=False` they differ.
- Web: Simulation page checkbox "Common random numbers" (hint explains: same arrivals and durations across scenarios so differences come from the change, not the dice), default on for new drafts (`DEFAULT_CONFIG.crn = true`). `run_config_from_dict` accepts `crn`; `io` writes it. The determinism test for `crn=True` pins nothing; it only asserts two runs with the same seed are identical.

## 5. CSV calibration (`calibrate.py`, `/calibrate/*`, CLI, web buttons)

New module `src/flock_of_pain/calibrate.py`, pure functions:

- `fit_arrivals(timestamps: list[datetime]) -> dict` returns `{"rate_per_hour": float, "profile": {"hours": {...}, "weekdays": {...}}, "observed_days": int}`. Method: group by calendar date; `hour_rate[h]` = count at hour-of-day h / number of observed dates; `weekday_mean[d]` = mean daily count over dates falling on weekday d; `rate_per_hour` = mean of `hour_rate` over hours that have any arrivals; `hours[h] = hour_rate[h] / rate_per_hour` for hours with arrivals (others omitted = the window decides); `weekdays[d] = weekday_mean[d] / mean(weekday_mean over observed weekdays)`; multipliers rounded to 2 decimals, values equal to 1.0 omitted. Fewer than 2 timestamps raises `ValueError`.
- `fit_duration(minutes: list[float]) -> dict` returns `{"kind": "lognormal_mean", "mean": m, "sigma": s}` with `m` the arithmetic mean and `s` the standard deviation of `log(x)` (population), clamped to `[0.05, 2.0]`; values `<= 0` are dropped; fewer than 2 valid values raises `ValueError`. Also returns `"n"` and `"p50"`, `"p90"` for the UI to show.
- API (tenant key required): `POST /calibrate/arrivals` body `{"timestamps": ["2026-10-06T09:14:00", ...]}` (ISO 8601, naive or with offset; offsets are converted to local wall time by dropping tzinfo after `astimezone()` is NOT applied, i.e. the wall clock in the string is what counts); `POST /calibrate/durations` body `{"minutes": [..]}`. Both 422 on `ValueError` via the existing `SchemaError` path. Cap lists at 100000 entries (422 above).
- CLI: `calibrate arrivals <file.csv> [--column N]` and `calibrate durations <file.csv> [--column N]` read the given column (default 0, header row skipped when it does not parse) and print the JSON result.
- Web: in the inflow panel's Demand profile disclosure a "Fit from CSV…" file button: parses the first column of the file in the browser (lines split, `Date.parse`-able values kept), posts to `/calibrate/arrivals`, applies `rate_per_hour` and `profile` to the inflow, and shows "n arrivals over d days". In the step panel's duration editor a "Fit from CSV…" button that posts the first numeric column to `/calibrate/durations` and applies the returned dist, showing n / p50 / p90. Both use `lib/api.ts` helpers `fitArrivals`, `fitDurations`.

## 6. Acceptance

- `pytest -q` green, pinned hashes unchanged, `examples/reynolds.json` round-trips byte-identically.
- Tests: held tasks are not dispatched before the release hour and all start at/after it; `BATCH_HOLD` ledger row; abandonment fires only for tasks still queued and never after start, `abandon_rate` KPI; overtime premium arithmetic on a hand-built case and `overtime_hours_per_day`; CRN arrival identity across scenarios and `crn=False` unchanged hash; `fit_arrivals` on a synthetic 2-week dataset with a 16:00 peak reproduces a `hours["16"]` multiplier near the generating one, `fit_duration` on lognormal samples recovers mean/sigma within tolerance; API 422 cases; CLI prints JSON.
- Web: lint, tsc, `npm test`, build green; asserts for the CSV first-column parser and for `checkCompany` on `release_hours`, `patience`, `overtime_rate`, `crn`.
