import { describe, expect, it, vi } from "vitest";

import { openProjectAdminAccess } from "./admin-auth.js";

describe("OpenProject administrator access", () => {
  it("requires a login cookie", async () => {
    const fetcher = vi.fn();

    await expect(openProjectAdminAccess(undefined, "http://openproject", fetcher)).resolves.toBe("unauthenticated");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows only an active administrator", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ admin: true, status: "active" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));

    await expect(openProjectAdminAccess("session=valid", "http://openproject", fetcher)).resolves.toBe("authorized");
  });

  it("rejects a signed-in non-administrator", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ admin: false, status: "active" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));

    await expect(openProjectAdminAccess("session=valid", "http://openproject", fetcher)).resolves.toBe("forbidden");
  });

  it("distinguishes an unavailable OpenProject service", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(openProjectAdminAccess("session=valid", "http://openproject", fetcher)).resolves.toBe("unavailable");
  });
});
