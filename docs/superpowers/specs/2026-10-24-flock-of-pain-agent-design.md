# Flock of Pain phase 2a: AI agent, prompt to company JSON

Date: 2026-10-24. Builds on `2026-10-24-flock-of-pain-io-api-design.md`.

## Intent

A company definition can come from a plain-language prompt. The agent turns
the prompt into the phase 1 JSON contract (`{"company", "scenarios"}`, the
shape `GET /example` returns) so the existing API, CLI and page consume it
unchanged.

## Design

- `flock_of_pain/agent.py`: `generate(prompt, ask=None, repairs=1) -> dict`.
  `ask(messages) -> str` is injectable; the default calls Claude
  (`claude-opus-5-5`, override with `FLOCK_MODEL`, auth from the SDK's
  environment resolution). System prompt = format rules + the Reynolds bundle
  as worked example, cached with `cache_control`.
- Output is validated by `company_from_dict` / `scenario_from_dict` /
  `materialize()`; on failure the loader's `path: message` goes back to the
  model once. Still invalid, API failure or refusal raise `AgentError`.
- Returned dicts are the exporter's canonical form, not the model's text.
- API: `POST /generate` `{"prompt"}` -> `{"company", "scenarios"}`;
  `AgentError` -> 502 `{"path": null, "message"}`.
- CLI: `generate PROMPT [--out path.json]`; `demo --company` accepts the
  bundle as well as a bare company.
- Web: prompt textarea + Generate button fills the two JSON textareas.

## Non-goals

Streaming, conversation history, scenario-only generation, JSON Schema
structured outputs (the loader is the validator), server-side refusal
fallbacks.
