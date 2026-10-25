"use client";

import { createElement } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, Building2, Cpu, Headset, Landmark, type LucideIcon, Network, Package, Server, TrendingUp, Users } from "lucide-react";
import { cn } from "cn";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { parseSkills } from "@/components/org/ops";

export const ORG_LINKS = [
  { href: "/organization", label: "Overview", icon: Network },
  { href: "/organization/departments", label: "Departments", icon: Building2 },
  { href: "/organization/people", label: "People", icon: Users },
  { href: "/organization/pools", label: "Pools", icon: Boxes },
  { href: "/organization/systems", label: "Systems", icon: Server },
];

/** Accent color per department index, cycling the five chart tokens. */
export const accent = (i: number) => `var(--chart-${(i % 5) + 1})`;

const DEPT_ICONS: LucideIcon[] = [Headset, Package, Landmark, TrendingUp, Cpu];
/** Icon per department index, cycling in step with `accent` so a department keeps one colour and one glyph everywhere. */
export const deptIcon = (i: number) => DEPT_ICONS[i % DEPT_ICONS.length];

/** Coloured glowing disc with the department's icon: the node used on the org map, cards and tables. */
export function DeptMark({ index, className, size = "size-9" }: { index: number; className?: string; size?: string }) {
  const color = accent(index);
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full text-white [&_svg]:size-[45%]", size, className)}
      style={{ background: `radial-gradient(circle at 30% 30%, color-mix(in oklch, ${color}, white 25%), ${color} 70%)`, boxShadow: `0 0 0 1px oklch(1 0 0 / 0.12) inset, 0 6px 18px -6px ${color}, 0 0 20px -8px ${color}` }} aria-hidden>
      {createElement(deptIcon(index))}
    </span>
  );
}

export function OrgNav() {
  const path = usePathname();
  return (
    <nav className="flex flex-wrap gap-1 rounded-xl bg-card/60 p-1 ring-1 ring-foreground/10 w-fit">
      {ORG_LINKS.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} aria-current={path === href ? "page" : undefined}
          className={cn("flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
            path === href && "bg-primary/15 text-foreground ring-1 ring-primary/40 shadow-[0_0_12px_-4px_var(--primary)]")}>
          <Icon className="size-4" /> {label}
        </Link>
      ))}
    </nav>
  );
}

export const Loading = () => <p className="text-sm text-muted-foreground">Loading…</p>;

/** A titled card holding a table; `action` sits top right (add buttons). */
export function TableCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {action && <CardAction className="flex items-center gap-2">{action}</CardAction>}
      </CardHeader>
      <CardContent className="overflow-x-auto">{children}</CardContent>
    </Card>
  );
}

export function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span className="rounded-full bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground ring-1 ring-foreground/10"
      style={color ? { color, boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 40%, transparent)` } : undefined}>
      {children}
    </span>
  );
}

export function StatusDot({ ok, title }: { ok: boolean; title?: string }) {
  return <span title={title} className={cn("inline-block size-2 rounded-full", ok ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-amber-400 shadow-[0_0_6px_#fbbf24]")} />;
}

/** Comma-separated skills, committed on blur so a trailing comma or space can be typed. */
export function SkillsInput({ id, skills, onCommit }: { id: string; skills: string[]; onCommit: (s: string[]) => void }) {
  return <Input key={skills.join(",")} aria-label={`skills of ${id}`} className="w-48" defaultValue={skills.join(", ")}
    onBlur={(e) => { const s = parseSkills(e.target.value); if (s.join(",") !== skills.join(",")) onCommit(s); }} />;
}
