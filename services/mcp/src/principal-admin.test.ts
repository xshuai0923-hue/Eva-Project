import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrincipalStore } from "./principal-store.js";
import { PrincipalAdmin } from "./principal-admin.js";
import type { UserResource } from "./types.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true })));
function setup(users: UserResource[]) {
  const dir = mkdtempSync(join(tmpdir(), "eva-admin-"));
  dirs.push(dir);
  const principals = [{ userId: "admin", displayName: "Admin", role: "admin" as const, token: "a".repeat(64), active: true }];
  const path = join(dir, "principals.json");
  writeFileSync(path, JSON.stringify({ principals }));
  const store = new PrincipalStore(path, principals);
  // Deliberately paginate at one account to catch a selector that only reads page one.
  const listUsers = vi.fn(async ({ offset }: Record<string, string>) => ({
    total: users.length, count: 1, pageSize: 1, offset: Number(offset),
    _embedded: { elements: users.slice(Number(offset) - 1, Number(offset)) }
  }));
  return { store, admin: new PrincipalAdmin(store, { listUsers }), listUsers };
}
const active = (login: string, admin = false): UserResource => ({ id: 10, login, name: "同名显示名称", status: "active", admin });

describe("linking only real, active webpage accounts", () => {
  it("paginates and selects by exact login, never by display name", async () => {
    const { admin, store, listUsers } = setup([active("first"), active("李多吉")]);
    const result = await admin.create("liduoji", "李多吉", "李多吉");
    expect(result.principal.openProjectLogin).toBe("李多吉");
    expect(store.findByOpenProjectLogin("李多吉")?.userId).toBe("liduoji");
    expect(listUsers).toHaveBeenCalledTimes(2);
    await expect(admin.create("other", "同名显示名称", "同名显示名称")).rejects.toThrow(/不存在/);
  });

  it("rejects locked, invited and missing accounts without creating an identity", async () => {
    const { admin, store } = setup([ { ...active("locked"), status: "locked" }, { ...active("invited"), status: "invited" } ]);
    for (const login of ["locked", "invited", "missing", ""]) {
      await expect(admin.create("test", "Test", login)).rejects.toThrow();
    }
    expect(store.list()).toHaveLength(1);
    expect(await admin.accounts()).toEqual([]);
  });

  it("does not promote an ordinary webpage user by linking it to an administrator MCP identity", async () => {
    const { admin, store } = setup([active("ordinary"), active("new-admin", true)]);
    const version = store.list()[0]!.lockVersion;
    await expect(admin.link("admin", "ordinary", version)).rejects.toThrow(/管理员/);
    await expect(admin.link("admin", null, version)).rejects.toThrow(/管理员/);
    expect((await admin.link("admin", "new-admin", version)).role).toBe("admin");
  });

  it("allows unlinking a user whose webpage account has been deleted", async () => {
    const { admin, store } = setup([]);
    store.create("old", "Old", "deleted");
    const old = store.list().find(p => p.userId === "old")!;
    expect((await admin.link("old", null, old.lockVersion)).openProjectLogin).toBeNull();
  });
});
