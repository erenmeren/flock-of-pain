"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Trash2, TriangleAlert } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogMedia, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmOptions = { title?: string; action?: string; destructive?: boolean };
type Confirm = (message: string, opts?: ConfirmOptions) => Promise<boolean>;
type Pending = { message: string; opts: ConfirmOptions };

const Ctx = createContext<Confirm | null>(null);

/** In-app replacement for window.confirm: one glass dialog, resolved by its buttons. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolve = useRef<(ok: boolean) => void>(() => {});
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirm = useCallback<Confirm>((message, opts = {}) => new Promise((r) => {
    resolve.current = r;
    setPending({ message, opts });
  }), []);
  const close = (ok: boolean) => { setPending(null); resolve.current(ok); };
  const destructive = !!pending?.opts.destructive;
  return (
    <Ctx.Provider value={confirm}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) close(false); }}>
        <AlertDialogContent initialFocus={cancelRef}>
          <AlertDialogHeader>
            <AlertDialogMedia className={destructive ? "bg-rose-400/15 text-rose-400 ring-rose-400/8" : undefined}>
              {destructive ? <Trash2 strokeWidth={2.25} /> : <TriangleAlert strokeWidth={2.25} />}
            </AlertDialogMedia>
            <AlertDialogTitle>{pending?.opts.title ?? "Are you sure?"}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} onClick={() => close(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => close(true)}
              className={destructive ? "bg-[linear-gradient(180deg,color-mix(in_oklch,var(--color-rose-500),white_12%),var(--color-rose-500))] text-white shadow-[0_0_0_1px_oklch(1_0_0/0.1)_inset,0_8px_24px_-8px_var(--color-rose-500),0_0_32px_-12px_var(--color-rose-500)]! hover:brightness-110" : undefined}>
              {pending?.opts.action ?? "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): Confirm {
  const c = useContext(Ctx);
  if (!c) throw new Error("useConfirm outside ConfirmProvider");
  return c;
}
