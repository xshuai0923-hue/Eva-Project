import { describe, expect, it } from "vitest";
import { OpenProjectClient, OpenProjectHttpError } from "./openproject.js";
import { RequirementService } from "./service.js";
import type { FieldMap, HalCollection, Principal, ProjectResource, UserResource } from "./types.js";

const creator: Principal = { userId: "ziyun", displayName: "子芸", role: "user", openProjectLogin: "子芸" };
const outsider: Principal = { userId: "other", displayName: "Other", role: "user" };
const map: FieldMap = {
  defaultProjectIdentifier: "sclaw-test", typeHref: "/api/v3/types/1",
  fields: {}, statusHrefs: {}, completionStates: ["已完成"]
};
const collection = <T>(elements: T[]): HalCollection<T> => ({
  total: elements.length, count: elements.length, offset: 1, pageSize: 200, _embedded: { elements }
});
const filter = (parameters: Record<string, string>, field: string): string[] | undefined =>
  (JSON.parse(parameters.filters ?? "[]") as Array<Record<string, { values: string[] }>>)
    .find(item => item[field])?.[field]?.values;
type Membership = { id: number; _links: { project: { href: string }; principal: { href: string }; roles: Array<{ href: string }> } };

class ProjectApi extends OpenProjectClient {
  projects: ProjectResource[] = [];
  users: UserResource[] = [{ id: 11, login: "子芸", status: "active" }, { id: 12, login: "other", status: "active" }];
  roles = [{ id: 4, name: "成员" }];
  memberships: Membership[] = [];
  createCalls = 0;
  roleCalls = 0;
  membershipCalls: Array<{ projectId: number; userId: number; roleId: number }> = [];
  createError: Error | null = null;
  membershipError: Error | null = null;
  persistedMembership = true;
  visibleAfterGrant = true;
  readbackRole = 4;
  readbackUser = 11;
  extraRole = false;

  constructor() { super("http://test.invalid", "test-token"); }
  async getProject(identifier: string | number) {
    const project = this.projects.find(p => p.identifier === identifier || p.id === Number(identifier));
    if (!project) throw new OpenProjectHttpError(404, "not found", {});
    return project;
  }
  async listProjects(parameters: Record<string, string>) {
    let projects = this.projects;
    const ids = filter(parameters, "id");
    const userId = filter(parameters, "visible")?.[0];
    if (ids) projects = projects.filter(p => ids.includes(String(p.id)));
    if (userId) projects = projects.filter(p => p.public === true || (this.visibleAfterGrant && this.memberships.some(m =>
      m._links.project.href === `/api/v3/projects/${p.id}` && m._links.principal.href === `/api/v3/users/${userId}`)));
    return collection(projects);
  }
  async listUsers(parameters: Record<string, string>) {
    const login = filter(parameters, "login")?.[0];
    return collection(this.users.filter(u => u.login === login));
  }
  async getUser(id: number) {
    const user = this.users.find(u => u.id === id);
    if (!user) throw new OpenProjectHttpError(404, "not found", {});
    return user;
  }
  async listProjectTypes() { return collection([{ id: 1, name: "Task" }]); }
  async createProject(identifier: string, name: string) {
    this.createCalls++;
    if (this.createError) throw this.createError;
    const project = { id: 4, identifier, name, active: true, public: false };
    this.projects.push(project);
    return project;
  }
  async listProjectRoles() { this.roleCalls++; return collection(this.roles); }
  async createProjectMembership(projectId: number, userId: number, roleId: number) {
    this.membershipCalls.push({ projectId, userId, roleId });
    if (this.membershipError) throw this.membershipError;
    const membership = this.member(projectId, userId, roleId);
    if (this.persistedMembership) this.memberships.push(membership);
    return membership;
  }
  async getMembership(id: number) {
    const membership = this.memberships.find(m => m.id === id);
    if (!membership) throw new OpenProjectHttpError(404, "not persisted", {});
    return { ...membership, _links: { ...membership._links,
      principal: { href: `/api/v3/users/${this.readbackUser}` }, roles: [{ href: `/api/v3/roles/${this.readbackRole}` },
        ...(this.extraRole ? [{ href: "/api/v3/roles/6" }] : [])] } };
  }
  member(projectId = 4, userId = 11, roleId = 4): Membership {
    return { id: 20, _links: { project: { href: `/api/v3/projects/${projectId}` },
      principal: { href: `/api/v3/users/${userId}` }, roles: [{ href: `/api/v3/roles/${roleId}` }] } };
  }
}

describe("private project creator membership", () => {
  it("grants the mapped caller the explicit member role and verifies both membership and visibility", async () => {
    const api = new ProjectApi(), service = new RequirementService(api, map);
    const result = await service.createProject({ project: "sclaw-test", name: "SClaw" }, creator);
    expect(result.created).toBe(true);
    expect(api.membershipCalls).toEqual([{ projectId: 4, userId: 11, roleId: 4 }]);
    expect((await service.listProjects(creator)).items.map(p => p.identifier)).toContain("sclaw-test");
    expect(await service.types("sclaw-test", creator)).toBeDefined();
    expect((await service.listProjects(outsider)).items).toEqual([]);
    await expect(service.types("sclaw-test", outsider)).rejects.toThrow(/Project not found/);
  });

  it("supports the English default Member role without relying on a fixed role ID", async () => {
    const api = new ProjectApi(); api.roles = [{ id: 31, name: "Member" }]; api.readbackRole = 31;
    await new RequirementService(api, map).createProject({ project: "sclaw-test" }, creator);
    expect(api.membershipCalls[0]?.roleId).toBe(31);
  });

  it("does not create a second membership when the creator reuses the project", async () => {
    const api = new ProjectApi(), service = new RequirementService(api, map);
    await service.createProject({ project: "sclaw-test" }, creator);
    expect((await service.createProject({ project: "sclaw-test" }, creator)).created).toBe(false);
    expect(api.membershipCalls).toHaveLength(1);
  });

  it("refuses an existing hidden project without changing any membership or revealing its name", async () => {
    const api = new ProjectApi(); api.projects = [{ id: 4, identifier: "sclaw-test", name: "Secret name" }];
    await expect(new RequirementService(api, map).createProject({ project: "sclaw-test" }, creator))
      .rejects.toThrow(/^Project not found: sclaw-test$/);
    expect(api.createCalls).toBe(0); expect(api.membershipCalls).toEqual([]); expect(api.roleCalls).toBe(0);
  });

  it("keeps an existing reader role when reusing a visible project", async () => {
    const api = new ProjectApi(); api.projects = [{ id: 4, identifier: "sclaw-test", name: "SClaw" }];
    api.memberships = [api.member(4, 11, 5)];
    expect((await new RequirementService(api, map).createProject({ project: "sclaw-test" }, creator)).created).toBe(false);
    expect(api.memberships[0]?._links.roles).toEqual([{ href: "/api/v3/roles/5" }]);
    expect(api.membershipCalls).toEqual([]); expect(api.roleCalls).toBe(0);
  });

  it("reuses a public project without making the caller a member", async () => {
    const api = new ProjectApi(); api.projects = [{ id: 4, identifier: "sclaw-test", name: "Public", public: true }];
    expect((await new RequirementService(api, map).createProject({ project: "sclaw-test" }, creator)).created).toBe(false);
    expect(api.membershipCalls).toEqual([]); expect(api.roleCalls).toBe(0);
  });

  it("does not restore revoked membership when the original creator reuses the project", async () => {
    const api = new ProjectApi(), service = new RequirementService(api, map);
    await service.createProject({ project: "sclaw-test" }, creator);
    api.memberships = [];
    await expect(service.createProject({ project: "sclaw-test" }, creator)).rejects.toThrow(/Project not found/);
    expect(api.membershipCalls).toHaveLength(1);
  });

  it.each([null, "missing-login"])("rejects an unresolved caller (%s) before project creation", async login => {
    const api = new ProjectApi();
    await expect(new RequirementService(api, map).createProject({ project: "sclaw-test" }, { ...creator, openProjectLogin: login }))
      .rejects.toThrow(/account|关联/);
    expect(api.createCalls).toBe(0); expect(api.membershipCalls).toEqual([]);
  });

  it.each(["locked", "invited"])("rejects a %s webpage account before creating anything", async status => {
    const api = new ProjectApi(); api.users[0]!.status = status;
    await expect(new RequirementService(api, map).createProject({ project: "sclaw-test" }, creator)).rejects.toThrow(/active|启用/);
    expect(api.createCalls).toBe(0); expect(api.membershipCalls).toEqual([]);
  });

  it.each([{ roles: [{ id: 6, name: "项目管理员" }] }, { roles: [{ id: 4, name: "成员" }, { id: 31, name: "Member" }] }])(
    "fails before creating a project when the default member role is missing or ambiguous", async ({ roles }) => {
      const api = new ProjectApi(); api.roles = roles;
      await expect(new RequirementService(api, map).createProject({ project: "sclaw-test" }, creator)).rejects.toThrow(/Member|成员/);
      expect(api.createCalls).toBe(0); expect(api.membershipCalls).toEqual([]);
    }
  );

  it("reports a partial creation when granting membership fails, and never repairs it by expanding access on reuse", async () => {
    const api = new ProjectApi(); api.membershipError = new OpenProjectHttpError(422, "grant failed", {});
    const service = new RequirementService(api, map);
    await expect(service.createProject({ project: "sclaw-test" }, creator)).rejects.toThrow(/created.*membership.*administrator/s);
    await expect(service.createProject({ project: "sclaw-test" }, creator)).rejects.toThrow(/Project not found/);
    expect(api.createCalls).toBe(1); expect(api.membershipCalls).toHaveLength(1);
  });

  it.each(["not-persisted", "wrong-role", "wrong-user", "extra-role", "not-visible"])("does not report success for %s membership", async failure => {
    const api = new ProjectApi();
    if (failure === "not-persisted") api.persistedMembership = false;
    if (failure === "wrong-role") api.readbackRole = 6;
    if (failure === "wrong-user") api.readbackUser = 12;
    if (failure === "extra-role") api.extraRole = true;
    if (failure === "not-visible") api.visibleAfterGrant = false;
    await expect(new RequirementService(api, map).createProject({ project: "sclaw-test" }, creator))
      .rejects.toThrow(/created.*membership.*administrator/s);
  });

  it("never grants membership if another creator wins a concurrent creation", async () => {
    const api = new ProjectApi(); api.createError = new OpenProjectHttpError(422, "identifier taken", {});
    await expect(new RequirementService(api, map).createProject({ project: "sclaw-test" }, creator)).rejects.toThrow(/identifier taken/);
    expect(api.membershipCalls).toEqual([]);
  });
});
