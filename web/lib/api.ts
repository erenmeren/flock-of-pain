export type Stat = { mean: number; p10: number; p50: number; p90: number };
export type LedgerRow = {
  department_id: string;
  reason: string | null;
  blocker_id: string | null;
  minutes: number;
  count: number;
};
export type SimEvent = {
  t: number;
  kind: string;
  task_id: string | null;
  instance_id: string | null;
  workflow_id: string | null;
  step_id: string | null;
  department_id: string | null;
  resource_id: string | null;
  system_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
};
export type RunResult = { seed: number; metrics: Record<string, unknown>; events?: SimEvent[] };
export type ScenarioResult = {
  id: string;
  name: string;
  summary: Record<string, Stat>;
  ledger: LedgerRow[];
  off_shift_minutes: number;
  runs: RunResult[];
};
export type SimulateResponse = {
  disclaimer: string;
  kpi_keys: string[];
  scenarios: ScenarioResult[];
};
export type ApiError = { path: string | null; message: string };

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function getExample(): Promise<{ company: unknown; scenarios: unknown[] }> {
  const res = await fetch(`${API}/example`);
  if (!res.ok) throw { path: null, message: `GET /example failed: ${res.status}` } as ApiError;
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return res.json();
  const j = await res.json().catch(() => null);
  // FastAPI validation errors carry `detail` instead of {path, message}
  if (j && typeof j.message === "string") throw j as ApiError;
  throw {
    path: null,
    message: j?.detail ? JSON.stringify(j.detail) : `POST ${path} failed: ${res.status}`,
  } as ApiError;
}

export function simulate(body: unknown): Promise<SimulateResponse> {
  return post("/simulate", body);
}

export function generate(prompt: string): Promise<{ company: unknown; scenarios: unknown[] }> {
  return post("/generate", { prompt });
}
