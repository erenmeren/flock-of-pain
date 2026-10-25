"use client";

import { PageHeader } from "@/components/page";
import { useTwin } from "@/lib/store";

export default function Overview() {
  const { company } = useTwin();
  return <PageHeader title="Overview" subtitle={company?.name} />;
}
