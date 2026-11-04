import { describe, expect, it } from "vitest";
import { requireLockVersion } from "./record-service.js";

describe("client record versions", () => {
  it.each([undefined, null, "3", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid or missing versions (%s)", value => {
      expect(() => requireLockVersion(value)).toThrow("记录版本");
    }
  );
  it("accepts the initial version zero as well as later versions", () => {
    expect(requireLockVersion(0)).toBe(0);
    expect(requireLockVersion(3)).toBe(3);
  });
});
