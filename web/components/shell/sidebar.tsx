"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, FlaskConical, LayoutDashboard, Network, Play, Settings, Workflow } from "lucide-react";
import { cn } from "cn";
import { useTwin } from "@/lib/store";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/organization", label: "Organization", icon: Network },
  { href: "/processes", label: "Processes", icon: Workflow },
  { href: "/simulation", label: "Simulation", icon: Play },
  { href: "/scenarios", label: "Scenario Lab", icon: FlaskConical },
  { href: "/analysis", label: "Analysis", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const path = usePathname();
  const { apiKey, selected, company } = useTwin();
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-6 border-r border-sidebar-border bg-sidebar p-4">
      <Link href="/" className="flex items-center gap-2 px-2">
        <span className="size-7 rounded-full bg-[linear-gradient(135deg,var(--primary),oklch(0.75_0.17_60))] shadow-[0_0_16px_var(--primary)]" />
        <span>
          <span className="block text-base font-semibold leading-tight">Workforce Twin</span>
          <span className="block text-[10px] text-muted-foreground">Simulate. Understand. Build.</span>
        </span>
      </Link>
      <nav className="flex flex-col gap-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined}
              className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                active && "bg-sidebar-accent text-sidebar-foreground ring-1 ring-primary/40 shadow-[inset_0_0_12px_-6px_var(--primary)]")}>
              <Icon className="size-4" /> {label}
              {active && <span className="ml-auto size-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]" />}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-2 rounded-lg bg-sidebar-accent/60 p-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-2"><span className={cn("size-2 rounded-full", apiKey ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-amber-400")} />{apiKey ? "API key set" : "No API key"}</p>
        <p className="truncate" title={company?.id}>{selected ? `Saved: ${selected}` : company ? "Unsaved draft" : "Loading…"}</p>
      </div>
    </aside>
  );
}
