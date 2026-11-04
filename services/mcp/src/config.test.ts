import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

// A map small enough to read, shaped like the one the bootstrap writes.
function fieldMap(kind: string): unknown {
  return {
    defaultProjectIdentifier: "eva-project",
    typeHref: "/api/v3/types/1",
    fields: {
      requirementId: { key: "customField1", kind: "text" },
      claimScope: { key: "customField11", kind, multi: false, options: {} }
    },
    statusHrefs: { 待认领: "/api/v3/statuses/1" },
    completionStates: ["已完成"]
  };
}

const saved = { ...process.env };

function configFor(map: unknown, openProjectLogin?: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "evaproject-config-"));
  const mapPath = join(dir, "field-map.json");
  const principalsPath = join(dir, "principals.json");
  writeFileSync(mapPath, JSON.stringify(map));
  writeFileSync(principalsPath, JSON.stringify({
    principals: [{
      token: "0".repeat(32),
      userId: "brian",
      displayName: "Brian",
      role: "admin",
      ...(openProjectLogin !== undefined ? { openProjectLogin } : {})
    }]
  }));
  process.env.OPENPROJECT_FIELD_MAP_FILE = mapPath;
  process.env.MCP_PRINCIPALS_FILE = principalsPath;
  process.env.OPENPROJECT_BASE_URL = "http://web:8080/";
  process.env.OPENPROJECT_PUBLIC_URL = "http://192.0.2.10:8080/";
  process.env.OPENPROJECT_API_TOKEN = "token";
  return loadConfig();
}

afterEach(() => {
  process.env = { ...saved };
});

describe("the field kinds a generated map may carry", () => {
  // The bootstrap writes "formattable" for every long-text custom field, and
  // record-service reads exactly that to submit the value as { raw }. This schema was
  // the one place that never learned the word, so the first map regenerated after the
  // change failed to parse and the server would not start -- the failure was a boot
  // loop with a ZodError, nowhere near the script that had written the file.
  it("loads a map whose long-text field is marked formattable", () => {
    const config = configFor(fieldMap("formattable"));

    expect(config.fieldMap.fields.claimScope?.kind).toBe("formattable");
  });

  it.each(["text", "bool", "list", "int", "formattable"])("loads a map carrying %s", kind => {
    expect(configFor(fieldMap(kind)).fieldMap.fields.claimScope?.kind).toBe(kind);
  });

  it("still refuses a kind nothing knows how to write", () => {
    expect(() => configFor(fieldMap("markdown"))).toThrow();
  });
});


describe("instance host boundary", () => {
  it("loads explicitly unlinked identities without restoring legacy matching", () => {
    expect(configFor(fieldMap("text"), null).mcpPrincipals[0]?.openProjectLogin).toBeNull();
  });
  it("allows only local service hosts unless explicitly configured", () => {
    delete process.env.MCP_ALLOWED_HOSTS;
    expect(configFor(fieldMap("text")).allowedHosts).toEqual(["localhost", "127.0.0.1", "mcp"]);
  });

  it("uses the instance's explicitly configured host allowlist", () => {
    process.env.MCP_ALLOWED_HOSTS = "works.example.test, mcp.works.example.test";
    expect(configFor(fieldMap("text")).allowedHosts).toEqual(["works.example.test", "mcp.works.example.test"]);
  });
});
