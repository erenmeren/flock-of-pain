"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import { CircleHelp } from "lucide-react";
import { HINTS, useHintsOn } from "@/lib/hints";

/** A small question mark that explains a label on hover or focus. Renders nothing when hints are off or the id is unknown. */
export function Hint({ id }: { id: string }) {
  const on = useHintsOn();
  const text = HINTS[id];
  if (!on || !text) return null;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={150} render={<span tabIndex={0} role="button" aria-label={`what is ${id.replace(/_/g, " ")}`} />}
        className="inline-flex cursor-help align-middle text-muted-foreground/60 outline-none hover:text-primary focus-visible:text-primary data-[popup-open]:text-primary">
        <CircleHelp className="size-3.5" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={6} className="z-50">
          <Tooltip.Popup className="glass max-w-64 rounded-xl px-3 py-2 text-xs font-normal normal-case tracking-normal text-foreground">{text}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
