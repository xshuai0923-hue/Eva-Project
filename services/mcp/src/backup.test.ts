import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  attachmentFiles,
  BackupBusyError,
  BackupInputError,
  BackupService,
  expiredDailyBackups,
  nextScheduledRun,
  parseSettings,
  scheduleDue,
  stampOf,
  type Exec,
  type ScheduleState
} from "./backup.js";

const settings = { enabled: true, time: "03:30", keepDays: 14 };
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute, 0);

describe("backup settings", () => {
  it("accepts a time of day and a number of days to keep", () => {
    expect(parseSettings({ enabled: false, time: "23:05", keepDays: 30 })).toEqual({ enabled: false, time: "23:05", keepDays: 30 });
  });

  it.each([
    [{ enabled: true, time: "3:30", keepDays: 14 }],
    [{ enabled: true, time: "24:00", keepDays: 14 }],
    [{ enabled: true, time: "03:30", keepDays: 0 }],
    [{ enabled: true, time: "03:30", keepDays: 2.5 }],
    [{ enabled: "yes", time: "03:30", keepDays: 14 }]
  ])("refuses %j", input => {
    expect(() => parseSettings(input)).toThrow(BackupInputError);
  });
});

describe("the daily schedule", () => {
  it("waits for the set time", () => {
    expect(scheduleDue(at(24, 3, 29), settings, undefined)).toBe(false);
    expect(nextScheduledRun(at(24, 3, 29), settings, undefined)).toEqual(at(24, 3, 30));
  });

  it("runs once a day from the set time on, catching up after the server was off", () => {
    expect(scheduleDue(at(24, 3, 30), settings, undefined)).toBe(true);
    expect(scheduleDue(at(24, 21, 0), settings, { day: "2026-09-23", attempts: 1, lastAttemptAt: at(23, 3, 30).toISOString(), succeeded: true })).toBe(true);
  });

  it("does not run again the same day after it succeeded", () => {
    const done: ScheduleState = { day: "2026-09-24", attempts: 1, lastAttemptAt: at(24, 3, 30).toISOString(), succeeded: true };
    expect(scheduleDue(at(24, 23, 59), settings, done)).toBe(false);
    expect(nextScheduledRun(at(24, 23, 59), settings, done)).toEqual(at(25, 3, 30));
  });

  it("retries a failed attempt an hour later, three attempts a day at most", () => {
    const failed = (attempts: number): ScheduleState =>
      ({ day: "2026-09-24", attempts, lastAttemptAt: at(24, 3, 30).toISOString(), succeeded: false });
    expect(scheduleDue(at(24, 4, 29), settings, failed(1))).toBe(false);
    expect(nextScheduledRun(at(24, 4, 0), settings, failed(1))).toEqual(at(24, 4, 30));
    expect(scheduleDue(at(24, 4, 30), settings, failed(1))).toBe(true);
    expect(scheduleDue(at(24, 9, 0), settings, failed(3))).toBe(false);
  });

  it("never runs while switched off", () => {
    const off = { ...settings, enabled: false };
    expect(scheduleDue(at(24, 12, 0), off, undefined)).toBe(false);
    expect(nextScheduledRun(at(24, 12, 0), off, undefined)).toBeNull();
  });
});

describe("keeping daily backups", () => {
  it("removes only daily backups older than the kept days, never the one just taken", () => {
    const now = at(24, 12, 0);
    const names = ["20260909-033000", "20260911-033000", "20260920-033000", "state.json", "20260908-033000.partial"];
    expect(expiredDailyBackups(names, now, 14)).toEqual(["20260909-033000"]);
    expect(expiredDailyBackups(names, now, 14, "20260909-033000")).toEqual([]);
  });
});

describe("counting attachments in an archive", () => {
  it("counts attachment files, not directories or macOS metadata", () => {
    const listing = [
      "assets/", "assets/files/attachment/file/1/", "assets/files/attachment/file/1/a.png",
      "assets/files/attachment/file/1/._a.png", "assets/files/attachment/file/2/b.pdf", "assets/files/other/x"
    ].join("\n");
    expect(attachmentFiles(listing)).toBe(2);
  });
});

// --- The service, against a scratch directory and a stand-in for the database tools ---

const COUNTS = "5 10 20 2 30 3 1";

type Call = { command: string; args: string[] };

class FakeTools {
  calls: Call[] = [];
  failRestoreIntoScratch = false;
  failDump = false;
  packResult: { code: number; stdout: string; stderr: string } | null = null;

  readonly exec: Exec = async (command, args) => {
    this.calls.push({ command, args });
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const sql = args.at(-1) ?? "";
    if (command === "psql") {
      if (sql.includes("concat_ws")) return ok(`${COUNTS}\n`);
      if (sql.includes("schema_migrations")) return ok("1\n2\n");
      if (sql.includes("FROM pg_database")) return ok("openproject\npostgres\n");
      return ok();
    }
    if (command === "pg_dump") {
      if (this.failDump) return { code: 1, stdout: "", stderr: "pg_dump: error: connection refused\n" };
      writeFileSync(args[args.indexOf("-f") + 1] ?? "", "dump");
      return ok();
    }
    if (command === "pg_restore") {
      if (args[0] === "--list") return ok(";\n; Archive\n1; 0 0 TABLE public work_packages postgres\n");
      if (this.failRestoreIntoScratch) return { code: 1, stdout: "", stderr: "pg_restore: error: could not execute query\n" };
      return ok();
    }
    if (command === "tar") {
      if (args[0] === "-czf") {
        writeFileSync(args[1] ?? "", "archive");
        return this.packResult ?? ok();
      }
      if (args[0] === "-tzf") return ok("assets/\nassets/files/attachment/file/1/a.png\nassets/files/attachment/file/2/b.png\n");
      if (args[0] === "-xzf") {
        const into = args[args.indexOf("-C") + 1] ?? "";
        mkdirSync(join(into, "assets", "files"), { recursive: true });
        writeFileSync(join(into, "assets", "files", "restored.txt"), "from the backup");
        return ok();
      }
    }
    return { code: 127, stdout: "", stderr: `${command}: not found` };
  };

  statements(): string[] {
    return this.calls.filter(call => call.command === "psql" && call.args.includes("postgres")).map(call => call.args.at(-1) ?? "");
  }
}

let root: string;
let backupRoot: string;
let assets: string;
let runtime: string;
let tools: FakeTools;
let healthy: boolean;

function service(): BackupService {
  return new BackupService({
    paths: {
      root: backupRoot,
      assetsDir: assets,
      runtimeFiles: {
        env: join(runtime, ".env"),
        principals: join(runtime, "principals.json"),
        fieldMap: join(runtime, "field-map.json")
      }
    },
    databaseUrl: "postgres://postgres:secret@db/openproject",
    exec: tools.exec,
    now: () => at(24, 21, 0),
    sleep: async () => undefined,
    instanceHealthy: async () => healthy
  });
}

/** A backup like the ones a release leaves beside daily/. */
function releaseBackup(name: string, fieldMap = "{\"map\":1}"): string {
  const dir = join(backupRoot, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "openproject.dump"), "dump");
  writeFileSync(join(dir, "assets.tar.gz"), "archive");
  writeFileSync(join(dir, "field-map.json"), fieldMap);
  writeFileSync(join(dir, "counts.txt"), `before ${COUNTS}\nafter ${COUNTS}\n`);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evaproject-backup-"));
  backupRoot = join(root, "backup");
  assets = join(root, "assets");
  runtime = join(root, "runtime");
  for (const dir of [join(backupRoot, "daily"), join(assets, "files"), runtime]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(assets, "files", "current.txt"), "live attachment");
  writeFileSync(join(runtime, ".env"), "SECRET=1\n");
  writeFileSync(join(runtime, "principals.json"), "{}");
  writeFileSync(join(runtime, "field-map.json"), "{\"map\":1}");
  tools = new FakeTools();
  healthy = true;
});

describe("taking a backup", () => {
  it("writes a complete backup into daily/ and prunes only expired daily backups", async () => {
    mkdirSync(join(backupRoot, "daily", "20260901-033000"));
    releaseBackup("20260901-100000");
    const backups = service();

    const job = backups.startBackup();
    await backups.idle();

    expect(job.state).toBe("succeeded");
    const name = job.backupName ?? "";
    expect(readdirSync(join(backupRoot, "daily", name)).sort())
      .toEqual([".env", "assets.tar.gz", "backup.json", "counts.txt", "field-map.json", "openproject.dump", "principals.json"]);
    expect(existsSync(join(backupRoot, "daily", "20260901-033000"))).toBe(false);
    expect(existsSync(join(backupRoot, "20260901-100000"))).toBe(true);

    const overview = await backups.overview();
    expect(overview.lastBackup).toMatchObject({ ok: true, origin: "manual", name });
    expect(overview.backups.map(entry => [entry.kind, entry.name, entry.origin])).toEqual([
      ["daily", name, "manual"],
      ["release", "20260901-100000", "release"]
    ]);
    expect(overview.backups[0]).toMatchObject({ entries: 1, attachments: 2, complete: true });
  });

  it("leaves nothing half-written behind when the dump fails, and says why", async () => {
    tools.failDump = true;
    const backups = service();

    const job = backups.startBackup();
    await backups.idle();

    expect(job.state).toBe("failed");
    expect(job.error).toContain("connection refused");
    expect(readdirSync(join(backupRoot, "daily")).filter(name => name !== "state.json")).toEqual([]);
    expect((await backups.overview()).lastBackup).toMatchObject({ ok: false, origin: "manual" });
  });

  // The web container chowns every attachment when it starts, which a release does right
  // as the MCP catches up on the day's backup; GNU tar reports that with status 1.
  it("keeps a backup whose attachments changed while they were packed", async () => {
    tools.packResult = { code: 1, stdout: "", stderr: "tar: assets: file changed as we read it\n" };
    const backups = service();

    const job = backups.startBackup();
    await backups.idle();

    expect(job.state).toBe("succeeded");
    expect(existsSync(join(backupRoot, "daily", job.backupName ?? "", "assets.tar.gz"))).toBe(true);
  });

  it("fails a backup whose attachments could not be packed", async () => {
    tools.packResult = { code: 2, stdout: "", stderr: "tar: assets.tar.gz: Cannot write: No space left on device\n" };
    const backups = service();

    const job = backups.startBackup();
    await backups.idle();

    expect(job.state).toBe("failed");
    expect(job.error).toContain("附件打包失败");
    expect(readdirSync(join(backupRoot, "daily")).filter(name => name !== "state.json")).toEqual([]);
  });

  it("runs one job at a time", async () => {
    const backups = service();
    backups.startBackup();
    expect(() => backups.startBackup()).toThrow(BackupBusyError);
    await backups.idle();
  });
});

describe("restoring a backup", () => {
  it("asks for the backup's name before anything happens", async () => {
    releaseBackup("20260920-100000");
    await expect(service().startRestore("release", "20260920-100000", "yes")).rejects.toThrow(BackupInputError);
    expect(tools.calls).toEqual([]);
  });

  it("refuses names that are not backups", async () => {
    await expect(service().startRestore("release", "../runtime", "../runtime")).rejects.toThrow(BackupInputError);
    await expect(service().remove("daily", "..")).rejects.toThrow(BackupInputError);
  });

  it("switches the database and the attachments to the backup's", async () => {
    releaseBackup("20260920-100000");
    const backups = service();

    const job = await backups.startRestore("release", "20260920-100000", "20260920-100000");
    await backups.idle();

    expect(job.state).toBe("succeeded");
    expect(job.backupName).toMatch(/^\d{8}-\d{6}$/);
    expect(existsSync(join(backupRoot, "daily", job.backupName ?? "", "openproject.dump"))).toBe(true);
    const renames = tools.statements().filter(statement => statement.includes("RENAME"));
    expect(renames).toEqual([
      `ALTER DATABASE "openproject" RENAME TO "openproject_replaced_${stampOf(at(24, 21, 0)).replace("-", "_")}"`,
      `ALTER DATABASE "openproject_restore_${stampOf(at(24, 21, 0)).replace("-", "_")}" RENAME TO "openproject"`
    ]);
    expect(readFileSync(join(assets, "files", "restored.txt"), "utf8")).toBe("from the backup");
    expect(existsSync(join(assets, "files", "current.txt"))).toBe(false);
    expect(readdirSync(assets)).toEqual(["files"]);
  });

  it("leaves the live data alone when the backup does not restore", async () => {
    releaseBackup("20260920-100000");
    tools.failRestoreIntoScratch = true;
    const backups = service();

    const job = await backups.startRestore("release", "20260920-100000", "20260920-100000");
    await backups.idle();

    expect(job.state).toBe("failed");
    expect(job.error).toContain("恢复到临时库失败");
    expect(job.liveTouched).toBeUndefined();
    expect(tools.statements().some(statement => statement.includes("ALTER DATABASE \"openproject\""))).toBe(false);
    expect(tools.statements().some(statement => statement.startsWith("DROP DATABASE IF EXISTS \"openproject_restore_"))).toBe(true);
    expect(readFileSync(join(assets, "files", "current.txt"), "utf8")).toBe("live attachment");
    expect(readdirSync(assets)).toEqual(["files"]);
  });

  it("refuses a backup whose fields differ from this version's, before touching anything", async () => {
    releaseBackup("20260920-100000", "{\"map\":0}");
    const backups = service();

    const job = await backups.startRestore("release", "20260920-100000", "20260920-100000");
    await backups.idle();

    expect(job.state).toBe("failed");
    expect(job.error).toContain("字段结构");
    expect(tools.calls.some(call => call.command === "pg_dump")).toBe(false);
    expect(tools.statements()).toEqual([]);
  });

  it("puts everything back when the instance does not answer after the switch", async () => {
    releaseBackup("20260920-100000");
    healthy = false;
    const backups = service();

    const job = await backups.startRestore("release", "20260920-100000", "20260920-100000");
    await backups.idle();

    expect(job.state).toBe("failed");
    expect(job.error).toContain("已经退回");
    expect(job.liveTouched).toBe(true);
    const renames = tools.statements().filter(statement => statement.includes("RENAME"));
    expect(renames.at(-1)).toMatch(/^ALTER DATABASE "openproject_replaced_\d{8}_\d{6}" RENAME TO "openproject"$/);
    expect(readFileSync(join(assets, "files", "current.txt"), "utf8")).toBe("live attachment");
    expect(existsSync(join(assets, "files", "restored.txt"))).toBe(false);
    expect(readdirSync(assets)).toEqual(["files"]);
  });
});
