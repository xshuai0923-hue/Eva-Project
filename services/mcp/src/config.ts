import { readFileSync } from "node:fs";
import { z } from "zod/v4";

import type { BackupPaths } from "./backup.js";
import type { FieldKind, FieldMap, ManagedPrincipal } from "./types.js";

/**
 * Every kind a generated field map may carry.
 *
 * This list is a runtime value, so TypeScript cannot tell on its own that it still
 * matches FieldKind -- and it once did not. "formattable" was added to FieldKind and
 * written by the bootstrap for every long-text field, but never added here, so the
 * first field map regenerated after that change failed to parse and the server would
 * not boot at all. The assertion below is what makes the two impossible to drift
 * apart again: leave a kind out and this file stops compiling.
 */
const FIELD_KINDS = ["text", "bool", "list", "int", "formattable"] as const;
type UncoveredKind = Exclude<FieldKind, (typeof FIELD_KINDS)[number]>;
const _everyKindIsParseable: UncoveredKind extends never ? true : never = true;
void _everyKindIsParseable;

const fieldDefinitionSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(FIELD_KINDS),
  multi: z.boolean().optional(),
  options: z.record(z.string(), z.string()).optional()
});

const fieldMapSchema = z.object({
  defaultProjectIdentifier: z.string().min(1),
  typeHref: z.string().min(1),
  // Optional: a map generated before handoffs existed must still load, otherwise the
  // MCP would fail to start against an older deployment.
  handoffTypeHref: z.string().min(1).optional(),
  requirementTypeHrefs: z.array(z.string().min(1)).optional(),
  handoffStatusHrefs: z.record(z.string(), z.string()).optional(),
  handoffCompletionStates: z.array(z.string()).optional(),
  fields: z.record(z.string(), fieldDefinitionSchema),
  statusHrefs: z.record(z.string(), z.string()),
  completionStates: z.array(z.string()).min(1)
});

export type AppConfig = {
  port: number;
  allowedHosts: string[];
  openProjectBaseUrl: string;
  openProjectPublicUrl: string;
  openProjectApiToken: string;
  mcpPrincipalsFile: string;
  mcpPrincipals: ManagedPrincipal[];
  fieldMap: FieldMap;
  /** Set when this instance keeps its own backups (the backup page, #237). */
  backup: BackupConfig | null;
};

export type BackupConfig = { paths: BackupPaths; databaseUrl: string; cacheAddress: string };

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const fieldMapPath = requiredEnv("OPENPROJECT_FIELD_MAP_FILE");
  const fieldMap = fieldMapSchema.parse(
    JSON.parse(readFileSync(fieldMapPath, "utf8"))
  ) as FieldMap;
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
  const mcpPrincipalsFile = requiredEnv("MCP_PRINCIPALS_FILE");
  const principals = principalsSchema.parse(
    JSON.parse(readFileSync(mcpPrincipalsFile, "utf8"))
  ).principals;

  return {
    port: z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? "8081"),
    allowedHosts: (process.env.MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1,mcp")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean),
    openProjectBaseUrl: requiredEnv("OPENPROJECT_BASE_URL").replace(/\/$/, ""),
    openProjectPublicUrl: requiredEnv("OPENPROJECT_PUBLIC_URL").replace(/\/$/, ""),
    openProjectApiToken: requiredEnv("OPENPROJECT_API_TOKEN"),
    mcpPrincipalsFile,
    mcpPrincipals: principals,
    fieldMap,
    backup: loadBackupConfig(mcpPrincipalsFile, fieldMapPath)
  };
}

function loadBackupConfig(principalsFile: string, fieldMapFile: string): BackupConfig | null {
  const root = process.env.EVAPROJECT_BACKUP_DIR;
  if (!root) return null;
  return {
    paths: {
      root,
      assetsDir: process.env.EVAPROJECT_ASSETS_DIR ?? "/evaproject-data/assets",
      runtimeFiles: { env: requiredEnv("EVAPROJECT_RUNTIME_ENV_FILE"), principals: principalsFile, fieldMap: fieldMapFile }
    },
    databaseUrl: requiredEnv("EVAPROJECT_DATABASE_URL"),
    cacheAddress: process.env.EVAPROJECT_CACHE_ADDRESS ?? "cache:11211"
  };
}
