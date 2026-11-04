export type AdminAccess = "authorized" | "unauthenticated" | "forbidden" | "unavailable";

export async function openProjectAdminAccess(
  cookie: string | undefined,
  openProjectBaseUrl: string,
  fetcher: typeof fetch = fetch
): Promise<AdminAccess> {
  if (!cookie) return "unauthenticated";

  try {
    const result = await fetcher(`${openProjectBaseUrl}/api/v3/users/me`, {
      headers: {
        Accept: "application/hal+json, application/json",
        Cookie: cookie,
        "X-Requested-With": "XMLHttpRequest"
      },
      redirect: "manual"
    });
    if (!result.ok) {
      return [301, 302, 303, 307, 308, 401, 403].includes(result.status)
        ? "unauthenticated"
        : "unavailable";
    }

    const user = await result.json() as { admin?: boolean; status?: string };
    return user.admin === true && user.status !== "locked" ? "authorized" : "forbidden";
  } catch {
    return "unavailable";
  }
}

export type SessionUser = {
  login: string;
  name: string;
  admin: boolean;
};

export type SessionAccess =
  | { status: "authorized"; user: SessionUser }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

/**
 * Identifies the signed-in OpenProject user behind a browser session.
 *
 * `openProjectAdminAccess` keeps only the admin bit, which is all the user-management
 * page needs. A page that reads requirements or handoffs needs the identity itself,
 * because visibility is decided by comparing it against the record's owner.
 */
export async function openProjectSessionUser(
  cookie: string | undefined,
  openProjectBaseUrl: string,
  fetcher: typeof fetch = fetch
): Promise<SessionAccess> {
  if (!cookie) return { status: "unauthenticated" };

  try {
    const result = await fetcher(`${openProjectBaseUrl}/api/v3/users/me`, {
      headers: {
        Accept: "application/hal+json, application/json",
        Cookie: cookie,
        "X-Requested-With": "XMLHttpRequest"
      },
      redirect: "manual"
    });
    if (!result.ok) {
      return [301, 302, 303, 307, 308, 401, 403].includes(result.status)
        ? { status: "unauthenticated" }
        : { status: "unavailable" };
    }

    const user = await result.json() as { login?: string; name?: string; admin?: boolean; status?: string };
    if (typeof user.login !== "string" || user.status === "locked") {
      return { status: "unauthenticated" };
    }
    return {
      status: "authorized",
      user: { login: user.login, name: user.name ?? user.login, admin: user.admin === true }
    };
  } catch {
    return { status: "unavailable" };
  }
}
