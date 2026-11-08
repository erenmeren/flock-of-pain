// Pure draft bookkeeping behind store.tsx: undo history, its keyboard shortcuts, the autosave gate and the edit-conflict check.
import type { ApiError, Bundle } from "@/lib/api";

export const HISTORY_CAP = 50;
export const COALESCE_MS = 600;

export type History<T> = { past: T[]; future: T[]; at: number }; // at: time of the last edit, 0 = the next edit starts a new step
export const emptyHistory = <T,>(): History<T> => ({ past: [], future: [], at: 0 });

/** `prev` is the state before the edit made at `now`. An edit soon after the previous one joins its step. */
export function record<T>(h: History<T>, prev: T, now: number): History<T> {
  const joined = h.at > 0 && now - h.at < COALESCE_MS;
  return { past: joined ? h.past : [...h.past, prev].slice(-HISTORY_CAP), future: [], at: now };
}

export function undo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (!h.past.length) return null;
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future], at: 0 }, state: h.past[h.past.length - 1] };
}

export function redo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (!h.future.length) return null;
  return { history: { past: [...h.past, current], future: h.future.slice(1), at: 0 }, state: h.future[0] };
}

/** Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl+Y redo. */
export function undoKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): "undo" | "redo" | null {
  if ((!e.ctrlKey && !e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  return k === "y" && e.ctrlKey && !e.shiftKey ? "redo" : null;
}

/** rev counts edits, saved is the rev the server has. rev 0 means no edit since this page loaded: a restored draft is not written until it is edited. */
export type SaveSync = { rev: number; saved: number };

export function shouldAutosave(a: { companyId: string; selected: string; canWrite: boolean; sync: SaveSync; failedRev: number | null; saving: boolean; conflict: boolean }): boolean {
  return !!a.companyId && a.selected === a.companyId && a.canWrite && a.sync.rev > 0 && a.sync.rev !== a.sync.saved && a.failedRev !== a.sync.rev && !a.saving && !a.conflict;
}

/** The saved version a draft was loaded from or last written as. */
export type SaveBase = { id: string; updated_at: string };

/** The PUT body: the base version only when it belongs to the company being written, so a first save sends none. */
export function saveBody(bundle: Bundle, base: SaveBase | null, id: string): Bundle & { base_updated_at?: string } {
  return base?.id === id ? { ...bundle, base_updated_at: base.updated_at } : bundle;
}

/** Someone else saved `id` since our base: the version to overwrite with "mine", or null when the error is not that conflict. */
export function conflictOf(e: unknown, id: string): SaveBase | null {
  const x = e as ApiError;
  return x?.status === 409 && x.path === "base_updated_at" && typeof x.updated_at === "string" ? { id, updated_at: x.updated_at } : null;
}
