export type FieldKind = "text" | "bool" | "list" | "int" | "formattable";

export type FieldDefinition = {
  key: string;
  kind: FieldKind;
  multi?: boolean;
  options?: Record<string, string>;
};

export type FieldMap = {
  defaultProjectIdentifier: string;
  typeHref: string;
  /** Absent in field maps written before handoffs existed; callers must tolerate that. */
  handoffTypeHref?: string;
  requirementTypeHrefs?: string[];
  handoffStatusHrefs?: Record<string, string>;
  handoffCompletionStates?: string[];
  fields: Record<string, FieldDefinition>;
  statusHrefs: Record<string, string>;
  completionStates: string[];
};

export type HalLink = {
  href: string | null;
  title?: string;
};

export type WorkPackage = {
  id: number;
  lockVersion: number;
  subject: string;
  description?: {
    format?: string;
    raw?: string;
    html?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  _links: Record<string, HalLink | HalLink[] | undefined>;
  _embedded?: Record<string, unknown>;
  [key: string]: unknown;
};

export type HalCollection<T> = {
  total: number;
  count: number;
  pageSize: number;
  offset: number;
  _embedded: {
    elements: T[];
  };
};

export type ProjectResource = {
  id: number;
  identifier: string;
  name: string;
  active?: boolean;
  public?: boolean;
  _links?: Record<string, HalLink | HalLink[] | undefined>;
};

export type ProjectRole = { id: number; name: string };

export type ProjectMembership = {
  id: number;
  _links: { project: HalLink; principal: HalLink; roles: HalLink[] };
};

export type WorkPackageType = {
  id: number;
  name: string;
  isMilestone?: boolean;
};

export type Relation = {
  id: number;
  type: string;
  reverseType?: string;
  description?: string | null;
  _links: {
    from: HalLink;
    to: HalLink;
  };
};

export type Attachment = {
  id: number;
  fileName: string;
  fileSize?: number;
  contentType?: string;
  createdAt?: string;
  _links: Record<string, HalLink | undefined>;
};

export type RequirementSummary = {
  id: string | null;
  workPackageId: number;
  project: string | null;
  title: string;
  typeId: number | null;
  typeName: string | null;
  state: string | null;
  status: string | null;
  modules: string[];
  responsibleAgent: string | null;
  claimedAgent: string | null;
  claimedSession: string | null;
  priority: string | null;
  requesterType: string | null;
  requesterName: string | null;
  requesterId: string | null;
  visibility: "公开" | "私有" | null;
  ownerUserId: string | null;
  updatedAt: string | null;
  lockVersion: number;
  parentWorkPackageId?: number | null;
  parentTitle?: string | null;
};

export type UserResource = {
  id: number;
  login: string;
  name?: string;
  status?: string;
  admin?: boolean;
};

export type ActivityResource = {
  id: number;
  createdAt?: string;
  version?: number;
  comment?: { raw?: string };
  details?: Array<{ raw?: string }>;
  _links?: Record<string, HalLink | undefined>;
};

export type Principal = {
  userId: string;
  displayName: string;
  role: "user" | "admin";
  /**
   * The OpenProject login this identity answers to, when the two names differ. Project
   * visibility is OpenProject's own judgement, so it has to be asked in its terms.
   */
  openProjectLogin?: string | null | undefined;
  /**
   * The channel this request came through: the agent behind an MCP call, or 网页 for the
   * pool page. Writes are signed with it; see signature.ts. Not part of the identity, so
   * the managed principal on disk never carries it.
   */
  via?: string | undefined;
};

export type ManagedPrincipal = Omit<Principal, "via"> & {
  token: string;
  active: boolean;
  /**
   * The OpenProject login this identity belongs to, when it differs from `userId`.
   * The two naming schemes are independent — an instance's admin may be `admin` while
   * the MCP knows the same person as `brian` — so the join is stated, never guessed.
   * Absent means the login equals `userId`; null explicitly removes the association.
   */
  openProjectLogin?: string | null | undefined;
  linkedAt?: string | undefined;
  createdAt?: string | undefined;
  rotatedAt?: string | undefined;
  revokedAt?: string | undefined;
};

export type HandoffSummary = {
  id: string | null;
  workPackageId: number;
  project: string | null;
  title: string;
  thread: string | null;
  handoffState: string | null;
  previous: string | null;
  expectedAgent: string | null;
  repository: string | null;
  branch: string | null;
  baseCommit: string | null;
  todoTotal: number | null;
  todoDone: number | null;
  claimedAgent: string | null;
  claimedSession: string | null;
  sourceSessionId: string | null;
  visibility: "公开" | "私有" | null;
  ownerUserId: string | null;
  updatedAt: string | null;
  lockVersion: number;
};
