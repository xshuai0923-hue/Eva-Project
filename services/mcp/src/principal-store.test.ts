import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrincipalStore } from "./principal-store.js";
import type { ManagedPrincipal } from "./types.js";

const temporaryDirectories: string[] = [];

function storeWith(principals: ManagedPrincipal[]): { store: PrincipalStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "evaproject-principals-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "principals.json");
  writeFileSync(path, JSON.stringify({ principals }));
  return { store: new PrincipalStore(path, structuredClone(principals)), path };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe("principal management", () => {
  it("creates a user and returns the token only in the creation result", () => {
    const { store, path } = storeWith([{
      token: "a".repeat(64),
      userId: "brian",
      displayName: "Brian",
      role: "admin",
      active: true
    }]);

    const created = store.create("alice", "Alice", "网页 Alice");

    expect(created.token).toHaveLength(64);
    expect(created.principal).not.toHaveProperty("token");
    expect(store.list().find(user => user.userId === "alice")).not.toHaveProperty("token");
    expect(JSON.parse(readFileSync(path, "utf8")).principals).toContainEqual(
      expect.objectContaining({ userId: "alice", displayName: "Alice", openProjectLogin: "网页 Alice", active: true, token: created.token })
    );
  });

  it("invalidates the old token when rotating", () => {
    const originalToken = "b".repeat(64);
    const { store } = storeWith([{
      token: originalToken,
      userId: "alice",
      displayName: "Alice",
      role: "user",
      active: true
    }]);

    const rotated = store.rotate("alice");

    expect(store.authenticate(`Bearer ${originalToken}`)).toBeNull();
    expect(store.authenticate(`Bearer ${rotated.token}`)?.userId).toBe("alice");
  });

  it("revokes a user without exposing a replacement token", () => {
    const originalToken = "c".repeat(64);
    const { store } = storeWith([{
      token: originalToken,
      userId: "alice",
      displayName: "Alice",
      role: "user",
      active: true
    }]);

    const revoked = store.revoke("alice");

    expect(revoked.active).toBe(false);
    expect(revoked).not.toHaveProperty("token");
    expect(store.authenticate(`Bearer ${originalToken}`)).toBeNull();
  });

  it("protects the administrator from routine rotation and revocation", () => {
    const { store } = storeWith([{
      token: "d".repeat(64),
      userId: "brian",
      displayName: "Brian",
      role: "admin",
      active: true
    }]);

    expect(() => store.rotate("brian")).toThrow(/管理员/);
    expect(() => store.revoke("brian")).toThrow(/管理员/);
  });
});

describe("joining OpenProject logins to MCP identities", () => {
  const principal = (overrides: Partial<ManagedPrincipal> = {}): ManagedPrincipal => ({
    token: "t".repeat(40), userId: "brian", displayName: "Brian", role: "admin", active: true, ...overrides
  });

  it("matches the login to userId when no mapping is stated", () => {
    const { store } = storeWith([principal()]);
    expect(store.findByOpenProjectLogin("brian")?.userId).toBe("brian");
  });

  it("matches a login that differs from the userId when the mapping is stated", () => {
    const { store } = storeWith([principal({ openProjectLogin: "admin" })]);
    expect(store.findByOpenProjectLogin("admin")?.userId).toBe("brian");
  });

  it("stops matching on userId once a different login is stated", () => {
    const { store } = storeWith([principal({ openProjectLogin: "admin" })]);
    expect(store.findByOpenProjectLogin("brian")).toBeNull();
  });

  it("returns null for a login with no identity rather than guessing one", () => {
    const { store } = storeWith([principal()]);
    expect(store.findByOpenProjectLogin("someone-else")).toBeNull();
  });

  it("ignores a revoked identity", () => {
    const { store } = storeWith([principal({ active: false, openProjectLogin: "admin" })]);
    expect(store.findByOpenProjectLogin("admin")).toBeNull();
  });

  it("links an existing identity without changing its token, ID, role or enabled state", () => {
    const existing = principal({ userId: "liduoji", displayName: "李多吉", role: "user", active: false });
    const { store, path } = storeWith([existing]);
    const linked = store.link("liduoji", "李多吉", store.list()[0]!.lockVersion);
    expect(linked.openProjectLogin).toBe("李多吉");
    expect(JSON.parse(readFileSync(path, "utf8")).principals[0]).toMatchObject(existing);
    expect(linked.lockVersion).not.toBe(storeWith([existing]).store.list()[0]!.lockVersion);
  });

  it("explicitly unlinking stops legacy userId matching, including after reload", () => {
    const { store, path } = storeWith([principal({ role: "user" })]);
    store.link("brian", null, store.list()[0]!.lockVersion);
    expect(store.findByOpenProjectLogin("brian")).toBeNull();
    expect(store.openProjectLoginOf("brian")).toBeNull();
    const reloaded = new PrincipalStore(path, JSON.parse(readFileSync(path, "utf8")).principals);
    expect(reloaded.findByOpenProjectLogin("brian")).toBeNull();
    expect(reloaded.authenticate(`Bearer ${"t".repeat(40)}`)?.openProjectLogin).toBeNull();
  });

  it("rejects duplicates, including legacy mappings reserved by revoked identities", () => {
    const { store } = storeWith([principal({ role: "user", active: false })]);
    expect(() => store.create("other", "Other", "brian")).toThrow(/已关联/);
    store.create("alice", "Alice", "李多吉");
    expect(() => store.link("brian", "李多吉", store.list().find(p => p.userId === "brian")!.lockVersion)).toThrow(/已关联/);
  });

  it("requires a login on creation and rejects a stale edit without overwriting", () => {
    const { store } = storeWith([principal({ role: "user" })]);
    expect(() => store.create("alice", "Alice", "")).toThrow(/网页账号/);
    const version = store.list()[0]!.lockVersion;
    store.link("brian", "李多吉", version);
    expect(() => store.link("brian", "Alice", version)).toThrow(/刷新/);
    expect(store.findByOpenProjectLogin("李多吉")?.userId).toBe("brian");
    expect(() => store.link("brian", null, undefined as unknown as string)).toThrow(/lockVersion/);
  });

  it("does not silently choose one identity when a legacy file has ambiguous mappings", () => {
    const { store } = storeWith([principal(), principal({ userId: "other", openProjectLogin: "brian" })]);
    expect(store.findByOpenProjectLogin("brian")).toBeNull();
  });

  it("refuses to overwrite an externally edited file and authenticates its current token", () => {
    const { store, path } = storeWith([principal({ role: "user" })]);
    const version = store.list()[0]!.lockVersion;
    const changed = principal({ role: "user", token: "z".repeat(64), openProjectLogin: "李多吉" });
    writeFileSync(path, JSON.stringify({ principals: [changed] }));
    const later = new Date(Date.now() + 1000);
    utimesSync(path, later, later);
    expect(() => store.link("brian", "wrong", version)).toThrow(/刷新/);
    expect(store.authenticate(`Bearer ${"t".repeat(40)}`)).toBeNull();
    expect(store.authenticate(`Bearer ${changed.token}`)?.openProjectLogin).toBe("李多吉");
    expect(JSON.parse(readFileSync(path, "utf8")).principals[0]).toEqual(changed);
  });

  it("keeps the original mapping in memory when saving the file fails", () => {
    const { store, path } = storeWith([principal({ role: "user" })]);
    const original = store.list()[0]!;
    mkdirSync(`${path}.tmp`);
    expect(() => store.link("brian", "李多吉", original.lockVersion)).toThrow();
    expect(store.list()).toEqual([original]);
    expect(store.findByOpenProjectLogin("brian")?.userId).toBe("brian");
    expect(store.findByOpenProjectLogin("李多吉")).toBeNull();
  });
});
