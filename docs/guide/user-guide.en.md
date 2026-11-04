---
title: "Workforce Twin — User Guide"
subtitle: "A plain-language guide to modelling an office floor and testing what-if scenarios"
date: 2026-11-04
---

# Workforce Twin — User Guide

Workforce Twin is a **simulation of how work flows through an office**. You describe the office once: who works there, when they work, which systems they use, and which steps an order or a complaint goes through. The tool then "plays" that office for a number of simulated days, many times over, and reports what happened: how fast orders got done, where they queued, who was overloaded, how many missed the cut-off.

You then change one thing (30% more orders, one more person on the desk, the ERP down for two hours) and run again. The difference between the two runs is the answer to your "what if".

Nothing in this tool is a measurement of the real office. **Every number is an assumption you typed in**, and every result is an estimate from those assumptions. The tool says so on every result screen.

This guide is for people who have never seen the application. It walks through the screens, explains every field in everyday words, and ends with a worked example you can rebuild in ten minutes.

---

## 1. The ideas behind it

Before the screens, six words you will see everywhere.

| Word | What it means here | Example |
|---|---|---|
| **Department** | A group of staff who do the same kind of work. | Order desk, Credit control, Finance |
| **Pool / Person** | Who does the work. A *pool* is "6 interchangeable people"; a *person* is one named employee. Both have skills, working hours and an hourly cost. | Desk team ×6 |
| **Skill** | A label that says who may do a step. A step needs one skill; only staff with that skill pick it up. | phone, order_entry, credit_check |
| **System** | Software or equipment a step depends on. Systems can go down. | ERP, Phone system |
| **Workflow** | One kind of work from start to finish, drawn as steps. | "Order to invoice", "Complaint handling" |
| **Scenario** | The office as drawn, plus a few changes. The *Baseline* scenario has no changes. Every run simulates all scenarios so you can compare them. | "Orders +30%", "One more on the desk" |

And how a run works: new items (orders, calls, complaints) **arrive** at the rate you set. Each item walks through the workflow's **steps**. A step waits in a queue until someone with the right skill is free and on shift; then it takes a random time around the average you gave. Items that depend on a system wait while that system is down. At the end, the tool counts everything.

The clock starts on **Monday 00:00**. Times such as outages are given in minutes from that moment; the screens show the weekday and hour they mean.

---

## 2. Getting in

Open the web address your administrator gave you. The left sidebar lists the pages; the top bar holds the company picker, **Save** and **Run**.

![The top bar](img/19-topbar.png)

The first time, go to **Settings** and paste the **API key** you were given. The key identifies your company's workspace; every saved company and every run belongs to it. The browser remembers the key and your working draft, so a reload does not lose anything.

![Settings page](img/18-settings.png)

Two more things on Settings:

- **Show help hints.** Leave it on while you learn. Every important label has a small question mark; hover it for a one-sentence explanation.

  ![A help hint](img/20-hint.png)

- **Generate with Claude.** Describe the office in a few sentences ("an order desk of six, credit control of two, orders arrive by phone and e-mail, cut-off at 17:00…") and an AI drafts departments, people, workflows and scenarios. You edit everything afterwards. It is the fastest way to get a first draft; it is not required.

The example company used in this guide is in `example-company.json` next to this document. On Settings, paste it into the raw JSON box and press **Apply** to follow along.

---

## 3. Overview

![Overview](img/01-overview.png)

The Overview is the dashboard. It shows counts (departments, staff, workflows, scenarios), a health gauge, the **organization map**, the first process as a strip, the active scenarios, and the last run's headline figures with the difference against the baseline.

![Organization map](img/02-overview-orgmap.png)

The organization map draws departments as boxes and the hand-offs between them as lines. A hand-off is a step in one department followed by a step in another. The departments are laid out in the order work flows, entry at the top. The thickness of a line is how many hand-offs it carries across all workflows.

**Health** is a single 0–100 score built from four parts of the last run: delivery (share of items completed), SLA (share not breached), quality (share not reworked) and balance (how close staff utilization is to a healthy 75%). It is a quick read, not a target.

---

## 4. Organization

![Organization](img/03-organization.png)

The Organization page is the entry to four tables. Each has an **Add** button and inline editing: click a cell, type, press Tab or click away to commit.

### 4.1 Departments

![Departments](img/04-departments.png)

A department is a name and the staff in it. You cannot remove a department while a workflow step or a scenario still refers to it; the Remove button says so.

### 4.2 Pools and People

![Pools](img/05-pools.png)

A **pool** is the normal way to describe a team: "the desk team has six people with the skills *phone* and *order_entry*, costs £18 an hour each, and works Monday to Friday 08:00–13:00 and 14:00–17:30".

| Field | What to put |
|---|---|
| **Skills** | Comma-separated labels. A step is picked up only by staff whose skills include the step's required skill. Invent your own labels; keep them consistent. |
| **Cost/h** | Hourly cost of one member. Feeds the *Labor cost* figure. |
| **Overtime +%** | Extra pay for work done outside the schedule. `50` means time and a half. Empty means overtime costs the plain rate. |
| **Headcount** | How many pool members work at the same time. |
| **Schedule** | Working days and hours. **Add break** splits a day into two windows (a lunch break); **Remove break** merges them. |

![Schedule with a break](img/21-schedule-break.png)

A **person** is a named employee. Use people when individuals matter: a specialist with a unique skill, someone on a different shift, a planned absence. A person can belong to a pool (and then inherit its schedule) or stand alone. People also have a **Speed** multiplier: `2` finishes tasks twice as fast, `0.5` half as fast.

### 4.3 Systems

![Systems](img/06-systems.png)

A system is anything a step cannot proceed without: the ERP, the phone system, a label printer. Steps name the system they need. Planned downtime goes on the Scenario Lab page as an **outage**; while a system is down, the steps that need it wait and the time is recorded as blocked.

---

## 5. Processes

![Processes](img/07-processes.png)

Each card is one workflow with its step chain. **Edit** opens the canvas; **New workflow** creates an empty one. A card also shows the inflow rate and the total working time of the chain.

### 5.1 The canvas

![The canvas](img/08-canvas.png)

![The steps up close](img/08b-canvas-zoom.png)

The canvas is where you draw a process while someone describes it. It is deliberately forgiving: a step can exist with only a name; the department, skill and duration can be filled in later. Unfinished steps are marked and the Run button tells you what is missing.

- **Left palette.** Drag a department chip onto the canvas to create a step in that department. Drag the *Inflow* chip to add an entry channel.
- **Boxes** are steps. The colour is the department. The box shows who does it and how long it takes.
- **Arrows** mean "after". Drag from the bottom handle of one step to the top handle of the next. Several arrows into a step mean "after all of these". Two steps with no arrow between them run in parallel.
- **Inflow nodes** are where items enter: "Phone orders", "E-mail orders". Each has its own rate and hours and points at the first step(s) it feeds.
- **Focus** hides the sidebar and top bar; the canvas fits the window.

Click a box to open its **detail panel** on the right.

### 5.2 Step fields

![Step panel](img/09-canvas-step-panel.png)

| Field | What to put | Example |
|---|---|---|
| **Name** | What the step is. The id is derived from it. | Key in order |
| **Department** | Who does it. | Order desk |
| **Skill** | Which skill it needs, or **Waiting (nobody works)**. | order_entry |
| **Duration** | Average working minutes for one item. Real times vary around it. **Sigma** is the spread: 0.1 nearly fixed, 1 very variable. 0.4 is a sensible default. | 6 min, sigma 0.4 |
| **Fit from CSV…** | Have the tool derive the average and spread from real measurements: a CSV with one duration (minutes) per row. | |
| **System** | Business system the step needs. | ERP |
| **Branches** | Chance, in percent, that the item goes on to each following step. Steps with a chance are either/or: one of them runs, or none for the remainder up to 100%. Empty means "always". | Credit check 20% |
| **SLA (min)** | Target minutes from arrival to finishing this step. Later counts as a breach. | 60 |
| **Priority** | Higher wins when a worker chooses between waiting tasks under the *priority* policy. | 0 |
| **Fail %**, **Rework to**, **Retries** | Chance the step fails and the item goes back to an earlier step; how many times before it is dropped. | 10%, back to Investigate, 1 retry |
| **Release at hours** | Batch processing: items wait until the next of these hours of day before anyone can pick them up. | 12, 17.5 for invoice runs at noon and 17:30 |
| **Patience (min)** | Average minutes an item waits in the queue before it gives up (a caller hangs up). The item is then **abandoned**. Empty means it waits forever. | 3 |

### 5.3 Waiting steps

![Wait step](img/10-canvas-wait-step.png)

Choose **Waiting (nobody works)** as the skill when time passes but no one in the office is working: waiting for the customer to confirm, for a supplier quote, for a credit reference. The step still belongs to a department (so the waiting time is attributed somewhere) and has a duration, but it uses no staff and never queues. It shows with a dashed border and an hourglass.

### 5.4 Inflows and the demand profile

![Inflow panel with demand profile](img/11-canvas-inflow-profile.png)

An inflow has a **rate** (average new items per hour while its window is open), a **window** (days and hours when items arrive) and **entry** steps. Work on an item can continue after the window closes; only arrivals stop.

Real demand is not flat. Open **Demand profile** to shape it by hour of day and by weekday. Values are **percent of the normal rate**: `100` is normal, `200` doubles the rate in that hour, `0` stops arrivals. A typical order desk might be at 60% at 08:00 and 240% in the hour before cut-off.

**Fit from CSV…** derives the rate and the profile from history: export one timestamp per order from your order system (ISO format such as `2026-10-06T09:14:00`), one per row, and pick the file. The tool reports how many arrivals over how many days it used.

### 5.5 Cut-off hour

![Cut-off hour](img/22-canvas-cutoff.png)

Many office processes are not "done within N minutes" but "done before the cut-off". Set the workflow's **Cut-off hour** (for example `18` when every order must be invoiced by 18:00). Every item that starts before it is due at that hour today; items started after it are due tomorrow. The **Missed cut-off %** figure counts items not finished in time, and the **Earliest due date** policy (Section 7) lets staff work on the most urgent item first.

---

## 6. Scenario Lab

![Scenario Lab](img/12-scenarios.png)

A scenario is the office you drew plus a few **overlays**: changes that apply to that scenario only. **Baseline** has none. Every run simulates all scenarios with the same random draws, so differences between them come from the change, not from chance.

![An overlay](img/13-scenario-overlay.png)

| Overlay | What it does | Example |
|---|---|---|
| **Demand change** | More or less work arrives, for one workflow or all. Enter a percent: `+30` means 30% more items, `-20` means 20% fewer. Optionally only in a **time window** (a seasonal peak: from day 20 to day 40). | Orders +30% |
| **System outage** | A system is down between two moments. Steps that need it wait. | ERP down Tuesday 10:00–12:00 |
| **Add employee** | One more person in a department, with skills, cost, speed and schedule. | A temp on the desk |
| **Remove resource** | A person or a whole pool is gone. | Credit control down to zero |
| **Set pool headcount** | The pool has this many people instead. | Desk team 7 instead of 6 |
| **Absence** | A person is away between two moments. | Sick day on Wednesday |

The page also lists the base company's **planned outages**, which every scenario sees.

Good scenarios change **one thing** each. "Orders +30%" tells you whether the desk copes with growth. "One more on the desk" tells you what the extra person buys. Both at once tells you less.

---

## 7. Simulation

![Simulation](img/14-simulation.png)

This is where you run. The settings card on the left:

![Simulation settings](img/15-simulation-settings.png)

| Setting | Meaning | Advice |
|---|---|---|
| **Seed** | Starting point of the random draws. The same seed gives the same result. | Leave it; change it to see a different random week. |
| **Days** | Simulated days per run. | 10–30. Short runs are noisy; a run starting empty needs a day or two to fill up. |
| **Replications** | How many times each scenario is re-run with different draws. Figures are averaged. | 5–10. More is smoother but slower. |
| **Policy** | How a free worker picks the next task. *priority*: highest step priority first. *fifo*: oldest first. *least_loaded*: longest queue first. *edd* (earliest due date): the item whose cut-off is soonest first. | *edd* when you use cut-offs; otherwise *priority*. |
| **Common random numbers** | Every scenario gets the same arrivals and the same working times, so the comparison isolates your change. | Leave on. |
| **Include events for playback** | Records every event so you can replay the run step by step. Only for short runs (days × reps × scenarios ≤ 30). | Off for comparisons, on when you want to watch a day unfold. |
| **Save run** | Stores the result on the server so it appears under **Run history** on Analysis. | On once the model is stable. |

Press **Run** in the top bar. A few seconds later the right side shows, per scenario, the headline figures, a **blocked-time ledger** (where items waited and why: off shift, everyone busy, system down, batch hold) and, if you recorded events, a **Playback** card with a time slider.

There is a limit on run size (days × replications × scenarios, by default 2000 run-days). If you exceed it the error message tells you the numbers.

---

## 8. Analysis

![Analysis](img/16-analysis.png)

Analysis compares the scenarios of the last run (or of a saved run from **Run history**). The KPI table shows each figure per scenario and the difference against the first scenario.

![KPI table](img/17-analysis-kpis.png)

| Figure | Plain meaning | Read it as |
|---|---|---|
| **Throughput / day** | Items completed per simulated day. | Higher is better. If it is below what arrives per day, a backlog is building. |
| **Completion rate** | Share of arrived items that finished within the run. | Below 1 means the office does not keep up. |
| **Cycle time p50 / p90** | Half of the items finish within p50 minutes; 90% within p90. Includes queueing, waiting steps and nights. | p90 is what your slowest normal customers experience. |
| **Wait p90** | 90% of waits for a free worker are shorter than this. | The queue, on its own. |
| **SLA breach rate** | Share of step executions finished after their SLA target. | |
| **Missed cut-off %** | Share of items not finished by the workflow's cut-off hour. | The order-desk number. |
| **Abandoned %** | Share of items that gave up waiting (patience ran out). | Lost calls. |
| **Rework rate** | Share of step executions that failed and were redone. | |
| **Mean utilization** | Busy share of staff during their shifts. | Around 0.75 is healthy. Near 1 is a bottleneck; below 0.5 is spare capacity. |
| **Labor cost** | Hours worked × hourly cost, overtime at the overtime rate. | |
| **Overtime h/day** | Hours worked outside schedules per day, all staff. | |
| **Cost per completed** | Labor cost ÷ completed items. | The efficiency figure. |

Further down: **utilization per department**, which shows where the bottleneck is, and the **Workflow breakdown**, one row per workflow and entry channel, so you can see that phone orders miss the cut-off while e-mail orders do not.

---

## 9. A worked example: the order desk

Rebuild this in ten minutes to get a feel for the tool. (It is the `example-company.json` next to this guide; you can also paste that on Settings.)

**The office.** Four departments:

- *Order desk*: pool of 6, skills `phone, order_entry`, £18/h, overtime +50%, Mon–Fri 08:00–13:00 and 14:00–17:30.
- *Credit control*: pool of 3, skill `credit_check`, £22/h, same hours.
- *Finance*: pool of 3, skill `invoicing`, £22/h, Mon–Fri 08:00–13:00 and 14:00–18:00.
- *Customer care*: pool of 3, skills `phone, complaint`, £19/h.

Two systems: *ERP*, *Phone system*.

**Workflow "Order to invoice"**, cut-off 18:00 (every order must be invoiced by six), two inflows:

- *Phone orders*: 14/hour, Mon–Fri 08:00–17:30, demand profile 60% at 08:00 rising to 240% at 17:00. Entry: *Answer call*.
- *E-mail orders*: 6/hour, same hours. Entry: *Key in order*.

Steps:

1. **Answer call** — Order desk, `phone`, 4 min, Phone system, **patience 3 min** (callers hang up after about three minutes).
2. **Key in order** — Order desk, `order_entry`, 6 min, ERP. **Branch: 20% → Credit check.**
3. **Credit check** — Credit control, `credit_check`, 12 min.
4. **Await customer** — Credit control, **Waiting (nobody works)**, 30 min.
5. **Confirm order** — Order desk, `order_entry`, 3 min, after *Key in order* and *Await customer*.
6. **Invoice** — Finance, `invoicing`, 1 min, **release at 12 and 17.5** (invoices go out in two daily runs, at noon and 17:30).

**Workflow "Complaint handling"**: 3/hour, Mon–Fri 9–17. *Log complaint* (Customer care, `phone`, 8 min) → *Investigate* (`complaint`, 25 min, fails 10% and is redone once) → *Resolve* (`phone`, 5 min).

**Scenarios:** Baseline · Orders +30% (order workflow only) · One more on the desk (headcount 7) · ERP down Tuesday 10:00–12:00.

**Run** with 10 days, 5 replications, policy *edd*, common random numbers on.

**How to read the result.** Look at the order workflow's *Missed cut-off %* and *Abandoned %* across the four scenarios. In the baseline about one order in six misses the 18:00 cut-off and about one caller in seven hangs up. Nearly every missed order arrived in the 16:00–17:30 peak: by the time it has been keyed in, credit-checked and confirmed, the desk has closed. "One more on the desk" cuts the hang-ups but does not improve the cut-offs; it even raises them a little, because more calls get answered and more orders reach the afternoon bottleneck. That tells you the desk is not the constraint for lateness; the afternoon peak and the credit path are. "Orders +30%" raises hang-ups further. The ERP outage shows up as a bulge of blocked time in the ledger on Tuesday and a dip in that day's throughput. The next scenarios to try are the ones the result suggests: a later cut-off, an extra invoice run, or a shorter customer wait.

Then change one number and run again. That loop is the whole tool.

---

## 10. Getting real numbers in

The model is only as good as its inputs. In order of value:

1. **Arrival rates and profile.** Export one timestamp per order/call for four normal weeks and use **Fit from CSV…** on the inflow. This is the single biggest improvement over a guess.
2. **Step durations.** Ten honest stopwatch measurements per step are enough for **Fit from CSV…** on the duration. Use the *working* time, not the elapsed time; queueing is what the simulation adds.
3. **Branch percentages.** Count how many orders went to credit check last month, divided by all orders.
4. **Schedules, headcounts, cut-offs.** You already know these.
5. **Patience.** Your phone system's abandoned-call report gives the average time to hang-up.

Everything else (failure rates, overtime, outages) can start as a round-number guess and be refined when a result looks wrong.

---

## 11. Saving, loading and sharing

- **Save** (top bar) stores the draft under its company id on the server, for your API key's workspace. The company picker in the top bar lists saved companies and the built-in *Reynolds* example.
- The browser keeps your working draft between visits. If a draft ever fails to load (for example after an update that tightened a rule), it is kept under a separate key and an error tells you; nothing is silently lost.
- **Settings → Raw JSON** shows the whole company and scenarios as text. Copy it to share a model with a colleague; they paste it and press **Apply**. **Download** saves the same as a file.

---

## 12. Limits and good habits

- All figures are **estimates from assumptions**. Use them to compare options, not to promise a service level.
- Start small: one workflow, the real departments, round numbers. Run. Only then add detail where the result is sensitive to it.
- Change **one thing per scenario**.
- Run **at least 5 replications** before trusting a difference; a single run is one random week.
- A run that starts empty takes a day or two to fill up; 10 days or more smooths that out.
- Hours outside the schedule: a task that is running at shift end is finished (at overtime cost); new tasks wait for the next shift.
- Weekends: nothing arrives unless an inflow window says so; staff are off unless a schedule says so.
