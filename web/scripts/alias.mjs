// Resolves the `@/` path alias for `node scripts/check.ts` (Next/tsc resolve it via tsconfig paths).
import { registerHooks } from "node:module";

const WEB = new URL("../", import.meta.url);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) spec = new URL(spec.slice(2) + ".ts", WEB).href;
    return next(spec, ctx);
  },
});
