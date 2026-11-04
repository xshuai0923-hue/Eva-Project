import type {
  ActivityResource,
  Attachment,
  HalCollection,
  ProjectResource,
  ProjectRole,
  ProjectMembership,
  Relation,
  UserResource,
  WorkPackage,
  WorkPackageType
} from "./types.js";

export interface OpenProjectApi {
  canCreateWorkPackages(projectId: number, userId: number): Promise<boolean>;
  canEditWorkPackages(projectId: number, userId: number): Promise<boolean>;
  getProject(identifier: string | number): Promise<ProjectResource>;
  listProjectTypes(projectId: number): Promise<HalCollection<WorkPackageType>>;
  createProject(identifier: string, name: string): Promise<ProjectResource>;
  listProjectRoles(): Promise<HalCollection<ProjectRole>>;
  createProjectMembership(projectId: number, userId: number, roleId: number): Promise<ProjectMembership>;
  getMembership(id: number): Promise<ProjectMembership>;
  listProjects(parameters: Record<string, string>): Promise<HalCollection<ProjectResource>>;
  getWorkPackage(id: number): Promise<WorkPackage>;
  listProjectWorkPackages(
    projectId: number,
    parameters: Record<string, string>
  ): Promise<HalCollection<WorkPackage>>;
  /** Across projects; a `project` filter says which. */
  listWorkPackages(parameters: Record<string, string>): Promise<HalCollection<WorkPackage>>;
  listUsers(parameters: Record<string, string>): Promise<HalCollection<UserResource>>;
  getUser(id: number): Promise<UserResource>;
  listActivities(workPackageId: number): Promise<HalCollection<ActivityResource>>;
  createActivity(workPackageId: number, comment: string): Promise<ActivityResource>;
  createWorkPackage(projectId: number, payload: Record<string, unknown>): Promise<WorkPackage>;
  updateWorkPackage(id: number, payload: Record<string, unknown>): Promise<WorkPackage>;
  listRelations(workPackageId: number): Promise<HalCollection<Relation>>;
  createRelation(
    fromId: number,
    toId: number,
    type: "blocks" | "requires" | "relates"
  ): Promise<Relation>;
  listAttachments(workPackage: WorkPackage): Promise<Attachment[]>;
  uploadAttachment(workPackageId: number, fileName: string, content: Uint8Array, contentType: string, description?: string): Promise<Attachment>;
  uploadMarkdown(
    workPackageId: number,
    fileName: string,
    content: string,
    description?: string
  ): Promise<Attachment>;
  readAttachment(attachment: Attachment): Promise<string>;
}

export class OpenProjectHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "OpenProjectHttpError";
    this.status = status;
    this.body = body;
  }
}

export class OpenProjectClient implements OpenProjectApi {
  async canCreateWorkPackages(projectId: number, userId: number): Promise<boolean> {
    return this.hasCapability(projectId, userId, "work_packages/create");
  }

  async canEditWorkPackages(projectId: number, userId: number): Promise<boolean> {
    return this.hasCapability(projectId, userId, "work_packages/update");
  }

  private async hasCapability(projectId: number, userId: number, action: string): Promise<boolean> {
    const params = new URLSearchParams({ filters: JSON.stringify([
      { principal: { operator: "=", values: [String(userId)] } },
      { context: { operator: "=", values: [`w${projectId}`] } },
      { action: { operator: "=", values: [action] } }
    ]), pageSize: "1" });
    const result = await this.request<HalCollection<unknown>>(`/api/v3/capabilities?${params}`);
    return result.total > 0;
  }
  private readonly authorization: string;

  constructor(
    private readonly baseUrl: string,
    apiToken: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {
    this.authorization = `Basic ${Buffer.from(`apikey:${apiToken}`).toString("base64")}`;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", this.authorization);
    headers.set("Accept", "application/hal+json, application/json");
    if (init.body && !(init.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }

    const response = await this.fetchFn(new URL(path, this.baseUrl), {
      ...init,
      headers
    });

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => "");
      throw new OpenProjectHttpError(
        response.status,
        `OpenProject ${init.method ?? "GET"} ${path} returned ${response.status}`,
        body
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  getWorkPackage(id: number): Promise<WorkPackage> {
    return this.request(`/api/v3/work_packages/${id}`);
  }

  getProject(identifier: string | number): Promise<ProjectResource> {
    return this.request(`/api/v3/projects/${encodeURIComponent(String(identifier))}`);
  }

  listProjectTypes(projectId: number): Promise<HalCollection<WorkPackageType>> {
    return this.request(`/api/v3/projects/${projectId}/types`);
  }

  createProject(identifier: string, name: string): Promise<ProjectResource> {
    return this.request("/api/v3/projects", {
      method: "POST",
      body: JSON.stringify({ identifier, name, active: true, public: false })
    });
  }

  listProjectRoles(): Promise<HalCollection<ProjectRole>> {
    const filters = JSON.stringify([
      { grantable: { operator: "=", values: ["t"] } },
      { unit: { operator: "=", values: ["project"] } }
    ]);
    return this.request(`/api/v3/roles?filters=${encodeURIComponent(filters)}&pageSize=200`);
  }

  createProjectMembership(projectId: number, userId: number, roleId: number): Promise<ProjectMembership> {
    return this.request("/api/v3/memberships", {
      method: "POST",
      body: JSON.stringify({
        _links: {
          project: { href: `/api/v3/projects/${projectId}` },
          principal: { href: `/api/v3/users/${userId}` },
          roles: [{ href: `/api/v3/roles/${roleId}` }]
        },
        _meta: { sendNotifications: false }
      })
    });
  }

  getMembership(id: number): Promise<ProjectMembership> {
    return this.request(`/api/v3/memberships/${id}`);
  }

  listProjects(parameters: Record<string, string>): Promise<HalCollection<ProjectResource>> {
    const query = new URLSearchParams(parameters);
    return this.request(`/api/v3/projects?${query}`);
  }

  listProjectWorkPackages(
    projectId: number,
    parameters: Record<string, string>
  ): Promise<HalCollection<WorkPackage>> {
    const query = new URLSearchParams(parameters);
    return this.request(`/api/v3/projects/${projectId}/work_packages?${query}`);
  }

  listWorkPackages(parameters: Record<string, string>): Promise<HalCollection<WorkPackage>> {
    const query = new URLSearchParams(parameters);
    return this.request(`/api/v3/work_packages?${query}`);
  }

  listUsers(parameters: Record<string, string>): Promise<HalCollection<UserResource>> {
    const query = new URLSearchParams(parameters);
    return this.request(`/api/v3/users?${query}`);
  }

  getUser(id: number): Promise<UserResource> {
    return this.request(`/api/v3/users/${id}`);
  }

  listActivities(workPackageId: number): Promise<HalCollection<ActivityResource>> {
    return this.request(`/api/v3/work_packages/${workPackageId}/activities`);
  }

  createActivity(workPackageId: number, comment: string): Promise<ActivityResource> {
    return this.request(`/api/v3/work_packages/${workPackageId}/activities`, {
      method: "POST",
      body: JSON.stringify({ comment: { raw: comment } })
    });
  }

  createWorkPackage(projectId: number, payload: Record<string, unknown>): Promise<WorkPackage> {
    return this.request(`/api/v3/projects/${projectId}/work_packages`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  updateWorkPackage(
    id: number,
    payload: Record<string, unknown>
  ): Promise<WorkPackage> {
    return this.request(`/api/v3/work_packages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  }

  listRelations(workPackageId: number): Promise<HalCollection<Relation>> {
    const filters = JSON.stringify([
      { involved: { operator: "=", values: [String(workPackageId)] } }
    ]);
    return this.request(`/api/v3/relations?filters=${encodeURIComponent(filters)}&pageSize=200`);
  }

  createRelation(
    fromId: number,
    toId: number,
    type: "blocks" | "requires" | "relates"
  ): Promise<Relation> {
    return this.request(`/api/v3/work_packages/${fromId}/relations`, {
      method: "POST",
      body: JSON.stringify({
        type,
        _links: { to: { href: `/api/v3/work_packages/${toId}` } }
      })
    });
  }

  async listAttachments(workPackage: WorkPackage): Promise<Attachment[]> {
    const link = workPackage._links.attachments;
    const href = Array.isArray(link) ? undefined : link?.href;
    if (!href) {
      return [];
    }
    const collection = await this.request<HalCollection<Attachment>>(href);
    return collection._embedded.elements;
  }

  uploadMarkdown(
    workPackageId: number,
    fileName: string,
    content: string,
    description?: string
  ): Promise<Attachment> {
    return this.uploadAttachment(workPackageId, fileName, Buffer.from(content, "utf8"), "text/markdown; charset=utf-8", description);
  }

  uploadAttachment(
    workPackageId: number,
    fileName: string,
    content: Uint8Array,
    contentType: string,
    description?: string
  ): Promise<Attachment> {
    const form = new FormData();
    const metadata: Record<string, string> = { fileName };
    if (description) {
      metadata.description = description;
    }
    form.append("metadata", JSON.stringify(metadata));
    form.append("file", new Blob([new Uint8Array(content)], { type: contentType }), fileName);
    return this.request(`/api/v3/work_packages/${workPackageId}/attachments`, {
      method: "POST",
      body: form
    });
  }

  async readAttachment(attachment: Attachment): Promise<string> {
    const link = attachment._links.downloadLocation ?? attachment._links.staticDownloadLocation;
    if (!link?.href) {
      throw new Error(`Attachment ${attachment.id} has no download link`);
    }
    const response = await this.fetchFn(new URL(link.href, this.baseUrl), {
      headers: { Authorization: this.authorization }
    });
    if (!response.ok) {
      throw new OpenProjectHttpError(
        response.status,
        `OpenProject GET ${link.href} returned ${response.status}`,
        await response.text().catch(() => "")
      );
    }
    return response.text();
  }
}
