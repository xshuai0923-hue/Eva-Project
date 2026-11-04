import type { OpenProjectApi } from "./openproject.js";
import { PrincipalStore } from "./principal-store.js";

export type WebAccount = { id: number; login: string; name: string; admin: boolean };

/** Called only after the HTTP layer verifies an administrator's session and origin. */
export class PrincipalAdmin {
  constructor(private readonly store: PrincipalStore, private readonly client: Pick<OpenProjectApi, "listUsers">) {}

  async accounts(): Promise<WebAccount[]> {
    const accounts: WebAccount[] = [];
    let loaded = 0;
    for (let offset = 1; ; offset++) {
      const page = await this.client.listUsers({ pageSize: "100", offset: String(offset) });
      for (const user of page._embedded.elements) {
        if (user.status === "active" && typeof user.login === "string" && user.login) {
          accounts.push({ id: user.id, login: user.login, name: user.name ?? user.login, admin: user.admin === true });
        }
      }
      loaded += page._embedded.elements.length;
      if (loaded >= page.total) return accounts;
      if (!page._embedded.elements.length) throw new Error("网页账号列表不完整，请稍后重试");
    }
  }

  async create(userId: string, displayName: string, login: string) {
    await this.account(login);
    return this.store.create(userId, displayName, login);
  }

  async link(userId: string, login: string | null, lockVersion: string) {
    const principal = this.store.list().find(p => p.userId === userId);
    if (!principal) throw new Error(`用户不存在：${userId}`);
    if (login !== null) {
      const account = await this.account(login);
      if (principal.role === "admin" && !account.admin) throw new Error("管理员 MCP 身份只能关联网页管理员账号");
    }
    return this.store.link(userId, login, lockVersion);
  }

  private async account(login: string): Promise<WebAccount> {
    if (typeof login !== "string" || !login) throw new Error("请选择关联网页账号");
    const account = (await this.accounts()).find(account => account.login === login);
    if (!account) throw new Error("网页账号不存在或未启用，请刷新账号列表");
    return account;
  }
}
