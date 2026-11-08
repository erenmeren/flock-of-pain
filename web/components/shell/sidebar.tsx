"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, FlaskConical, LayoutDashboard, Network, Play, Scale, Settings, Workflow } from "lucide-react";
import { cn } from "cn";
import { useMounted, useTwin } from "@/lib/store";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/organization", label: "Organization", icon: Network },
  { href: "/processes", label: "Processes", icon: Workflow },
  { href: "/simulation", label: "Simulation", icon: Play },
  { href: "/scenarios", label: "Scenario Lab", icon: FlaskConical },
  { href: "/decisions", label: "Decisions", icon: Scale },
  { href: "/analysis", label: "Analysis", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Two overlapping discs, blue over orange: the product mark. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("relative block size-7 shrink-0", className)} aria-hidden>
      <span className="absolute inset-y-0 right-0 w-5 rounded-full bg-[var(--chart-2)] opacity-90" />
      <span className="absolute inset-y-0 left-0 w-5 rounded-full bg-primary shadow-[0_0_14px_-2px_var(--primary)]" />
    </span>
  );
}

export function Sidebar({ className }: { className?: string }) {
  const path = usePathname();
  const { authed, me: signedIn, draftStatus, selected, company } = useTwin();
  const mounted = useMounted();
  const me = mounted ? signedIn : null; // /auth/me can answer before this Suspense boundary hydrates
  const draft = !mounted || !company ? "Loading…" : draftStatus.state === "saving" ? "Saving…" : draftStatus.state === "saved" ? `Saved: ${selected}` : draftStatus.state === "failed" ? "Save failed" : "Unsaved";
  return (
    <aside data-shell className={cn("glass flex w-60 shrink-0 flex-col gap-6 rounded-2xl p-4", className)}>
      <Link href="/" className="flex items-center gap-3 px-1 pt-1">
        <Logo />
        <span>
          <span className="block text-[15px] font-semibold leading-tight tracking-tight">Workforce Twin</span>
          <span className="block text-[10px] text-muted-foreground">Simulate. Understand. Build.</span>
        </span>
      </Link>
      <nav className="flex flex-col gap-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined}
              className={cn("press flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm text-sidebar-foreground/70 hover:bg-white/[0.05] hover:text-sidebar-foreground",
                active && "bg-primary/12 text-sidebar-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_35%,transparent),0_12px_24px_-16px_var(--primary)]")}>
              <span className={cn("flex size-8 items-center justify-center rounded-lg", active ? "bg-primary text-primary-foreground shadow-[0_6px_16px_-6px_var(--primary)]" : "glass-inset")}>
                <Icon className="size-4" />
              </span>
              {label}
              {active && <span className="ml-auto mr-1 size-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]" />}
            </Link>
          );
        })}
      </nav>
      <div className="glass-inset mt-auto flex flex-col gap-2 rounded-xl p-3 text-xs">
        <p className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", me ? "bg-emerald-400 shadow-[0_0_8px_#34d399]" : "bg-amber-400 shadow-[0_0_8px_#fbbf24]")} />
          <span className="text-muted-foreground">API</span>
          <span className="ml-auto">{me ? "Connected" : mounted && authed ? "Not verified" : "Not signed in"}</span>
        </p>
        {me && (
          <p className="flex items-center gap-2" title={me.email ?? `tenant ${me.tenant}`}>
            <span className="min-w-0 truncate text-muted-foreground">{me.email ?? "API key"}</span>
            <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">{me.role}</span>
          </p>
        )}
        <p className="flex items-center gap-2" title={mounted ? company?.id : undefined}>
          <span className="size-2 rounded-full bg-primary/70" />
          <span className="text-muted-foreground">Draft</span>
          <span className="ml-auto truncate">{draft}</span>
        </p>
        {mounted && draftStatus.state === "failed" && <p className="break-words text-rose-400">{draftStatus.message}</p>}
      </div>
    </aside>
  );
}
