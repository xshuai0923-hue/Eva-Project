import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

import { z } from "zod/v4";

import type { ManagedPrincipal } from "./types.js";
import { principalLogin } from "./principal-login.js";

const principalsSchema = z.object({
  principals: z.array(z.object({
    token: z.string().min(32),
    userId: z.string().min(1),
    displayName: z.string().min(1),
    role: z.enum(["user", "admin"]),
    openProjectLogin: z.string().min(1).nullable().optional(),
    linkedAt: z.string().optional(),
    active: z.boolean().default(true),
    createdAt: z.string().optional(),
    rotatedAt: z.string().optional(),
    revokedAt: z.string().optional()
  })).min(1)
});

export type PrincipalSummary = Omit<ManagedPrincipal, "token"> & {
  tokenFingerprint: string;
  lockVersion: string;
};

export class PrincipalConflictError extends Error {}

export class PrincipalStore {
  private modifiedAt = 0;

  constructor(
    private readonly filePath: string,
    private readonly principals: ManagedPrincipal[]
  ) {
    this.modifiedAt = this.fileModifiedAt();
  }

  list(): PrincipalSummary[] {
    this.refreshIfChanged();
    return this.principals
      .map(principal => this.summary(principal))
      .sort((left, right) => left.userId.localeCompare(right.userId));
  }

  /**
   * Finds the MCP identity behind an OpenProject login.
   *
   * The two identity spaces are joined here and nowhere else. A principal may name the
   * login explicitly; otherwise the login is assumed to equal `userId`. Returning null
   * when nothing matches is deliberate: it is what lets the web UI apply exactly the
   * same visibility rules as the MCP rather than inventing a second set.
   */
  findByOpenProjectLogin(login: string): ManagedPrincipal | null {
    this.refreshIfChanged();
    const matches = this.principals.filter(principal => principalLogin(principal) === login);
    return matches.length === 1 && matches[0]!.active ? matches[0]! : null;
  }

  /**
   * The OpenProject login of an identity, revoked ones included: it names who signed an
   * entry in the history, and revoking a token does not change who wrote the old ones.
   */
  openProjectLoginOf(userId: string): string | null {
    this.refreshIfChanged();
    const principal = this.principals.find(item => item.userId === userId);
    return principal ? principalLogin(principal) : null;
  }

  authenticate(header: string | undefined): ManagedPrincipal | null {
    const prefix = "Bearer ";
    if (!header?.startsWith(prefix)) return null;
    this.refreshIfChanged();
    const received = Buffer.from(header.slice(prefix.length));
    for (const principal of this.principals) {
      if (!principal.active) continue;
      const expected = Buffer.from(principal.token);
      if (received.length === expected.length && timingSafeEqual(received, expected)) {
        return principal;
      }
    }
    return null;
  }

  create(userId: string, displayName: string, openProjectLogin: string): { principal: PrincipalSummary; token: string } {
    this.refreshIfChanged();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(userId)) {
      throw new Error("用户 ID 只能包含字母、数字、点、下划线和连字符");
    }
    const name = displayName.trim();
    if (!name) throw new Error("显示名称不能为空");
    if (this.principals.some(principal => principal.userId === userId)) {
      throw new Error(`用户已存在：${userId}`);
    }
    this.checkLogin(openProjectLogin);
    const token = randomBytes(32).toString("hex");
    const principal: ManagedPrincipal = {
      token,
      userId,
      displayName: name,
      role: "user",
      openProjectLogin,
      active: true,
      createdAt: new Date().toISOString()
    };
    this.principals.push(principal);
    this.persist();
    return { principal: this.summary(principal), token };
  }

  link(userId: string, login: string | null, lockVersion: string): PrincipalSummary {
    this.refreshIfChanged();
    const principal = this.find(userId);
    if (typeof lockVersion !== "string" || !lockVersion) throw new Error("缺少 lockVersion，请刷新后重试");
    if (lockVersion !== this.version(principal)) throw new PrincipalConflictError("用户配置已变更，请刷新后重试");
    if (login === null && principal.role === "admin") throw new Error("不能解除管理员的网页账号关联");
    if (login !== null) this.checkLogin(login, userId);
    const updated = { ...principal, openProjectLogin: login, linkedAt: new Date().toISOString() };
    const index = this.principals.indexOf(principal);
    this.principals[index] = updated;
    try {
      this.persist();
    } catch (error) {
      this.principals[index] = principal;
      throw error;
    }
    return this.summary(updated);
  }

  private checkLogin(login: string, exceptUserId?: string): void {
    if (typeof login !== "string" || !login.trim()) throw new Error("请选择关联网页账号");
    const duplicate = this.principals.find(p => p.userId !== exceptUserId && principalLogin(p) === login);
    if (duplicate) throw new Error(`网页账号 ${login} 已关联 MCP 用户 ${duplicate.userId}，请先解除原关联`);
  }

  rotate(userId: string): { principal: PrincipalSummary; token: string } {
    this.refreshIfChanged();
    const principal = this.find(userId);
    if (principal.role === "admin") throw new Error("管理员 Token 需通过主机恢复流程轮换");
    const token = randomBytes(32).toString("hex");
    principal.token = token;
    principal.active = true;
    principal.rotatedAt = new Date().toISOString();
    delete principal.revokedAt;
    this.persist();
    return { principal: this.summary(principal), token };
  }

  revoke(userId: string): PrincipalSummary {
    this.refreshIfChanged();
    const principal = this.find(userId);
    if (principal.role === "admin") throw new Error("不能吊销管理员帐号");
    principal.token = randomBytes(32).toString("hex");
    principal.active = false;
    principal.revokedAt = new Date().toISOString();
    this.persist();
    return this.summary(principal);
  }

  private find(userId: string): ManagedPrincipal {
    const principal = this.principals.find(item => item.userId === userId);
    if (!principal) throw new Error(`用户不存在：${userId}`);
    return principal;
  }

  private summary(principal: ManagedPrincipal): PrincipalSummary {
    const { token, ...safe } = principal;
    return {
      ...safe,
      lockVersion: this.version(principal),
      tokenFingerprint: createHash("sha256").update(token).digest("hex").slice(0, 12)
    };
  }

  private version(principal: ManagedPrincipal): string {
    return createHash("sha256").update(JSON.stringify(principal)).digest("hex");
  }

  private refreshIfChanged(): void {
    const modifiedAt = this.fileModifiedAt();
    if (modifiedAt === this.modifiedAt) return;
    const loaded = principalsSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8"))).principals;
    this.principals.splice(0, this.principals.length, ...loaded);
    this.modifiedAt = modifiedAt;
  }

  private persist(): void {
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ principals: this.principals }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
    this.modifiedAt = this.fileModifiedAt();
  }

  private fileModifiedAt(): number {
    return statSync(this.filePath).mtimeMs;
  }
}
