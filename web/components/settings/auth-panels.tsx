"use client";

import { useEffect, useState } from "react";
import { KeyRound, Loader2, LockKeyhole, LogOut, Plus, Trash2, Users } from "lucide-react";
import { Panel } from "@/components/dashboard/kpi";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type ApiError, type Role, type UserRow, changePassword, createUser, deleteUser, listUsers, signup, updateUser } from "@/lib/api";
import { slug } from "@/lib/company";
import { useConfirm } from "@/lib/confirm";
import { useTwin } from "@/lib/store";

const FIELD = "h-9 min-w-32 flex-1 rounded-xl border-0 glass-inset dark:bg-transparent";
const MORE = "text-xs text-muted-foreground [&>summary]:cursor-pointer [&>summary]:hover:text-foreground";
const ROLES: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

/** Email and password first, an API key and tenant creation as the secondary paths. */
export function SignInPanel() {
  const t = useTwin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [tenant, setTenant] = useState("");
  const [invite, setInvite] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [signingUp, setSigningUp] = useState(false);
  const [shownKey, setShownKey] = useState("");

  const signIn = async () => {
    setPending(true);
    const ok = await t.signIn(email, password);
    setPending(false);
    if (ok) { setEmail(""); setPassword(""); }
  };
  const doSignup = async () => {
    setSigningUp(true);
    try {
      const r = await signup(slug(tenant), invite, newEmail || undefined, newPassword || undefined);
      if (newEmail) { // the session takes over from the key, which is never shown again
        setShownKey(r.key);
        await t.signIn(newEmail, newPassword);
      } else {
        t.changeKey(r.key); // the key is shown once by the API; the field above keeps it
        t.setError(null);
      }
      setTenant(""); setInvite(""); setNewEmail(""); setNewPassword("");
    } catch (e) { t.setError(e as ApiError); } finally { setSigningUp(false); }
  };

  return (
    <Panel title="Sign in" subtitle={t.me ? `Tenant ${t.me.tenant}` : "Your account for this workspace"} icon={KeyRound}>
      <div className="flex flex-col gap-3">
        {t.me ? (
          <div className="glass-inset flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 text-sm">
            <span className="min-w-0 truncate font-medium" title={t.me.email ?? undefined}>{t.me.email ?? "API key"}</span>
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">{t.me.role}</span>
            <Button variant="outline" size="sm" className="ml-auto rounded-full" onClick={t.signOut}><LogOut className="size-3.5" /> Sign out</Button>
          </div>
        ) : (
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); signIn(); }}>
            <Input type="email" autoComplete="username" className={FIELD} aria-label="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={pending} />
            <Input type="password" autoComplete="current-password" className={FIELD} aria-label="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={pending} />
            <Button type="submit" className="h-9 rounded-full px-4" disabled={pending || !email.trim() || !password}>{pending && <Loader2 className="size-4 animate-spin" />} Sign in</Button>
          </form>
        )}
        <details className={MORE} open={!!t.apiKey || undefined}>
          <summary>Use an API key</summary>
          <div className="mt-2 flex flex-col gap-2">
            {/* keyed so the stored key, read after mount, becomes the default */}
            <span className="flex items-center gap-1.5">
              <Input key={t.apiKey} type="password" autoComplete="off" className="h-9 rounded-xl border-0 font-mono glass-inset dark:bg-transparent" aria-label="api key" placeholder="tenant API key" defaultValue={t.apiKey}
                onBlur={(e) => { if (e.target.value !== t.apiKey) t.changeKey(e.target.value); }} />
              <Hint id="api_key" />
            </span>
            <p>Create one with <code className="font-mono">flock_of_pain tenant create</code>. Saved when the field loses focus; stored in this browser only. Replaces an email sign-in.</p>
          </div>
        </details>
        <details className={MORE}>
          <summary>Create a tenant with an invite code</summary>
          <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); doSignup(); }}>
            <Input className={FIELD} aria-label="tenant id" placeholder="Tenant id" value={tenant} onChange={(e) => setTenant(e.target.value)} disabled={signingUp} />
            <Input className={FIELD} aria-label="invite code" placeholder="Invite code" value={invite} onChange={(e) => setInvite(e.target.value)} disabled={signingUp} />
            <Input type="email" autoComplete="username" className={FIELD} aria-label="admin email" placeholder="Admin email (optional)" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} disabled={signingUp} />
            <Input type="password" autoComplete="new-password" className={FIELD} aria-label="admin password" placeholder="Password, 10+ characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={signingUp} />
            <Button type="submit" variant="outline" size="sm" className="h-9 rounded-full px-3" disabled={signingUp || !slug(tenant) || !invite || !newEmail !== !newPassword}>{signingUp ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Sign up</Button>
          </form>
        </details>
        {shownKey && <p className="break-all text-xs text-muted-foreground">Tenant API key, shown once: <code className="font-mono text-foreground">{shownKey}</code></p>}
      </div>
    </Panel>
  );
}

/** For a user signed in with email; an API key has no password. The API ends the user's other sessions and keeps this one. */
export function PasswordPanel() {
  const { me } = useTwin();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  if (!me?.email) return null;
  const mismatch = !!repeat && next !== repeat;

  const submit = async () => {
    setPending(true);
    setNote(null);
    try {
      await changePassword(current, next);
      setCurrent(""); setNext(""); setRepeat("");
      setNote({ ok: true, text: "Password changed. Your other sessions are signed out." });
    } catch (e) {
      const err = e as ApiError;
      setNote({ ok: false, text: err.status === 429 ? "Too many attempts. Wait a minute and try again."
        : err.path === "current" ? "The current password is wrong."
        : err.path === "new" ? `New password: ${err.message}` : err.message });
    } finally { setPending(false); }
  };

  return (
    <Panel title="Change password" subtitle={me.email} icon={LockKeyhole}>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {/* the hidden username lets a password manager file the new password under this account */}
        <input type="email" autoComplete="username" value={me.email} readOnly hidden />
        <Input type="password" autoComplete="current-password" className={FIELD} aria-label="current password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={pending} />
        <div className="flex flex-wrap gap-2">
          <Input type="password" autoComplete="new-password" className={FIELD} aria-label="new password" placeholder="New password, 10+ characters" value={next} onChange={(e) => setNext(e.target.value)} disabled={pending} />
          <Input type="password" autoComplete="new-password" className={FIELD} aria-label="repeat new password" aria-invalid={mismatch || undefined} placeholder="Repeat new password" value={repeat} onChange={(e) => setRepeat(e.target.value)} disabled={pending} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="outline" size="sm" className="h-9 rounded-full px-3" disabled={pending || !current || !next || next !== repeat}>{pending && <Loader2 className="size-3.5 animate-spin" />} Change password</Button>
          {mismatch ? <p role="alert" className="text-xs text-rose-400">The new passwords do not match.</p>
            : note && <p role={note.ok ? "status" : "alert"} className={note.ok ? "text-xs text-emerald-400" : "text-xs text-rose-400"}>{note.text}</p>}
        </div>
      </form>
    </Panel>
  );
}

/** Tenant users, for admins. A change to your own account ends your session, so it signs you out. */
export function UsersPanel() {
  const { me, setError, signOut } = useTwin();
  const confirm = useConfirm();
  const admin = me?.role === "admin";
  const tenant = me?.tenant;
  const [users, setUsers] = useState<UserRow[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [reset, setReset] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    if (!admin) return;
    let live = true;
    listUsers().then((u) => { if (live) setUsers(u); }).catch(setError);
    return () => { live = false; };
  }, [admin, tenant, setError]);
  if (!admin) return null;

  const change = async (fn: () => Promise<unknown>, who?: string) => {
    try {
      await fn();
      setError(null);
      if (who && who === me.email) {
        await signOut();
        setError({ path: "session", message: "Your account changed, sign in again." });
      } else setUsers(await listUsers());
      return true;
    } catch (e) { setError(e as ApiError); return false; }
  };
  const SELF = " This is your own account: you will be signed out.";
  const setUserRole = async (u: UserRow, r: Role) => {
    if (u.email === me.email && !(await confirm(`Change your role to ${r}?${SELF}`, { title: "Change your own role?", action: "Change" }))) return;
    change(() => updateUser(u.email, { role: r }), u.email);
  };
  const remove = async (u: UserRow) => {
    if (!(await confirm(`${u.email} can no longer sign in.${u.email === me.email ? SELF : ""}`, { title: "Remove this user?", action: "Remove", destructive: true }))) return;
    change(() => deleteUser(u.email), u.email);
  };
  const add = async () => { if (await change(() => createUser(email, password, role))) { setEmail(""); setPassword(""); } };
  const resetPassword = async () => {
    if (!reset) return;
    if (reset.email === me.email && !(await confirm(`Set a new password?${SELF}`, { title: "Reset your own password?", action: "Reset" }))) return;
    if (await change(() => updateUser(reset.email, { password: reset.password }), reset.email)) setReset(null);
  };

  return (
    <Panel title="Users" subtitle={`${users.length} in tenant ${tenant}`} icon={Users}>
      <div className="flex flex-col gap-3">
        <Table>
          <TableHeader className="[&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
            <TableRow><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Added</TableHead><TableHead className="text-right">Actions</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.email} className="hover:bg-white/[0.03]">
                <TableCell>{u.email}{u.email === me.email && <span className="ml-2 text-xs text-muted-foreground">you</span>}</TableCell>
                <TableCell>
                  <Select value={u.role} items={ROLES} onValueChange={(r) => r && r !== u.role && setUserRole(u, r as Role)}>
                    <SelectTrigger aria-label={`role of ${u.email}`} className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(ROLES).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-xs tabular-nums text-muted-foreground">{u.created_at.replace("T", " ").replace("+00:00", "")}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {reset?.email === u.email ? (
                      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); resetPassword(); }}>
                        <Input type="password" autoComplete="new-password" autoFocus className="h-8 w-44 rounded-xl border-0 glass-inset dark:bg-transparent" aria-label={`new password for ${u.email}`} placeholder="New password, 10+ characters" value={reset.password} onChange={(e) => setReset({ email: u.email, password: e.target.value })} />
                        <Button type="submit" variant="outline" size="sm" className="rounded-full" disabled={!reset.password}>Set</Button>
                        <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => setReset(null)}>Cancel</Button>
                      </form>
                    ) : <Button variant="outline" size="sm" className="rounded-full" onClick={() => setReset({ email: u.email, password: "" })}>Reset password</Button>}
                    <Button variant="destructive" size="sm" className="rounded-full" onClick={() => remove(u)}><Trash2 className="size-3.5" /> Remove</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {users.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground">No users yet.</TableCell></TableRow>}
          </TableBody>
        </Table>
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input type="email" autoComplete="off" className={FIELD} aria-label="new user email" placeholder="New user email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input type="password" autoComplete="new-password" className={FIELD} aria-label="new user password" placeholder="Password, 10+ characters" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Select value={role} items={ROLES} onValueChange={(r) => r && setRole(r as Role)}>
            <SelectTrigger aria-label="new user role" className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(ROLES).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
          </Select>
          <Button type="submit" variant="outline" size="sm" className="h-9 rounded-full px-3" disabled={!email.trim() || !password}><Plus className="size-3.5" /> Add user</Button>
        </form>
      </div>
    </Panel>
  );
}
