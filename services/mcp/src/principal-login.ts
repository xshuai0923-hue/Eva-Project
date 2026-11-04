import type { Principal } from "./types.js";

/** Missing preserves legacy mappings; null is an intentional unlink. */
export function principalLogin(principal: Principal): string | null {
  return principal.openProjectLogin === undefined ? principal.userId : principal.openProjectLogin;
}
