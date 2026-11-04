import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Backups of this instance, kept and run by the MCP itself (#237).
 *
 * The first version was a host script plus a launchd job that had to be installed over
 * SSH with sudo. Brian wanted backups to be something the system does and shows, on a
 * page, not a job set up from a terminal (2026-09-24). The MCP already starts with the
 * instance, so it keeps the schedule, takes the backups and restores one on request;
 * the page under the avatar menu is where an administrator sees and runs all of it.
 *
 * A backup holds what a release takes before it switches versions
 * (deploy/bin/evaproject-release): the database dump, the attachments and the three
 * runtime files. A dump counts only once pg_restore can list it, and the counts taken
 * just before and after it bound what a restore of it must contain.
 *
 * Daily backups live in daily/ and are pruned by age. The release backups beside it are
 * listed and can be restored or deleted here, but nothing prunes them.
 */

export const BACKUP_NAME = /^\d{8}-\d{6}$/;

export type BackupKind = "daily" | "release";
export type BackupOrigin = "scheduled" | "manual" | "before-restore" | "release";
export type BackupSettings = { enabled: boolean; time: string; keepDays: number };
export type StepState = "pending" | "running" | "done" | "failed";

export type BackupJob = {
  id: string;
  type: "backup" | "restore";
  origin?: BackupOrigin;
  target?: { kind: BackupKind; name: string };
  state: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  steps: { label: string; state: StepState }[];
  /** The backup a backup job made, or the one a restore took of the data it replaced. */
  backupName?: string;
  /** A restore got as far as switching the live data; until then it has not changed. */
  liveTouched?: boolean;
  error?: string;
  /** Something that went wrong without failing the job. */
  warning?: string;
};

export type BackupEntry = {
  kind: BackupKind;
  name: string;
  createdAt: string;
  origin: BackupOrigin;
  sizeBytes: number;
  /** Entries pg_restore listed when the backup was taken; null when it was not recorded. */
  entries: number | null;
  attachments: number | null;
  /** Both the dump and the attachments are there, so it can be restored. */
  complete: boolean;
};

export type ScheduleState = { day: string; attempts: number; lastAttemptAt: string; succeeded: boolean };
export type LastBackup = { at: string; ok: boolean; origin: BackupOrigin; name?: string; error?: string };

export type BackupOverview = {
  settings: BackupSettings;
  timezone: string;
  nextRun: string | null;
  lastBackup: LastBackup | null;
  job: BackupJob | null;
  backups: BackupEntry[];
  freeBytes: number | null;
};

export type BackupPaths = {
  /** Release backups sit directly in it; daily backups and the state file in daily/. */
  root: string;
  /** OpenProject's attachments directory, the one its containers mount. */
  assetsDir: string;
  runtimeFiles: { env: string; principals: string; fieldMap: string };
};

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (command: string, args: string[], env: Record<string, string>) => Promise<ExecResult>;

export type BackupDeps = {
  paths: BackupPaths;
  databaseUrl: string;
  exec?: Exec;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Whether the instance answers normally; asked after a restore has switched data. */
  instanceHealthy?: () => Promise<boolean>;
  flushCache?: () => Promise<void>;
  log?: (line: string) => void;
};

export class BackupInputError extends Error {}
export class BackupBusyError extends Error {}
export class BackupNotFoundError extends Error {}
class BackupError extends Error {}

export const DEFAULT_SETTINGS: BackupSettings = { enabled: true, time: "03:30", keepDays: 14 };

const DAILY = "daily";
const STATE_FILE = "state.json";
const META_FILE = "backup.json";
const DUMP = "openproject.dump";
const ASSETS = "assets.tar.gz";
const COUNTS = "counts.txt";
const RUNTIME_COPIES = [".env", "principals.json", "field-map.json"] as const;
/** Work directories inside the attachments directory. Never part of a backup. */
const WORK_PREFIX = ".evaproject-";
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const COUNT_LABELS = ["工作包", "最大工作包号", "日志", "附件", "自定义字段值", "用户", "项目"] as const;
const ATTACHMENTS_INDEX = 3;
// The same query the release, the first daily script and the drill ran, so counts.txt
// reads the same whichever of them wrote it.
const COUNTS_SQL = "SELECT concat_ws(' ', (SELECT count(*) FROM work_packages), " +
  "(SELECT coalesce(max(id), 0) FROM work_packages), (SELECT count(*) FROM journals), " +
  "(SELECT count(*) FROM attachments), (SELECT count(*) FROM custom_values), " +
  "(SELECT count(*) FROM users), (SELECT count(*) FROM projects));";

const BACKUP_STEPS = ["转储数据库", "打包附件", "复制运行配置", "清理过期备份"];
const RESTORE_STEPS = ["检查备份", "先备份当前数据", "恢复到临时库", "核对内容", "解开附件", "切换到恢复的数据", "确认系统正常"];

// --- Time ---------------------------------------------------------------------------
// Everything below is in the process's own time zone: the container is started with the
// server's (TZ), so 03:30 on the page is 03:30 on the server's clock.

const pad = (value: number) => String(value).padStart(2, "0");

export function stampOf(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function timeOfStamp(name: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!match) throw new BackupInputError(`不是备份的名字：${name}`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  return new Date(year, month - 1, day, hour, minute, second);
}

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function slotOf(now: Date, time: string): Date {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
}

// --- Rules --------------------------------------------------------------------------

export function parseSettings(input: unknown): BackupSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BackupInputError("设置格式无效");
  const { enabled, time, keepDays } = input as Record<string, unknown>;
  if (typeof enabled !== "boolean") throw new BackupInputError("自动备份的开关无效");
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new BackupInputError("时间要写成 24 小时制，比如 03:30");
  }
  if (typeof keepDays !== "number" || !Number.isInteger(keepDays) || keepDays < 1 || keepDays > 365) {
    throw new BackupInputError("保留天数要在 1 到 365 之间");
  }
  return { enabled, time, keepDays };
}

/**
 * Whether the scheduled backup should start now.
 *
 * Once a day, from the set time on. A server that was off at that time catches up when
 * it comes back, rather than skipping the day. A failed attempt is retried an hour
 * later, at most three attempts a day, so a database that was restarting at 03:30 does
 * not cost the day's backup — and one that stays broken is not hammered every minute.
 */
export function scheduleDue(now: Date, settings: BackupSettings, schedule: ScheduleState | undefined): boolean {
  if (!settings.enabled) return false;
  if (now < slotOf(now, settings.time)) return false;
  if (!schedule || schedule.day !== localDay(now)) return true;
  if (schedule.succeeded || schedule.attempts >= MAX_ATTEMPTS) return false;
  return now.getTime() - Date.parse(schedule.lastAttemptAt) >= RETRY_AFTER_MS;
}

export function nextScheduledRun(now: Date, settings: BackupSettings, schedule: ScheduleState | undefined): Date | null {
  if (!settings.enabled) return null;
  if (scheduleDue(now, settings, schedule)) return now;
  const today = slotOf(now, settings.time);
  if (now < today) return today;
  if (schedule && schedule.day === localDay(now) && !schedule.succeeded && schedule.attempts < MAX_ATTEMPTS) {
    return new Date(Date.parse(schedule.lastAttemptAt) + RETRY_AFTER_MS);
  }
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}

/** Daily backups older than the keep window. Never `keep`, the one just taken. */
export function expiredDailyBackups(names: string[], now: Date, keepDays: number, keep?: string): string[] {
  const cutoff = now.getTime() - keepDays * DAY_MS;
  return names.filter(name => BACKUP_NAME.test(name) && name !== keep && timeOfStamp(name).getTime() < cutoff);
}

/**
 * Attachment files in an archive listing. macOS tar writes AppleDouble companions
 * ("._name") for files with extended attributes; they are not attachments.
 */
export function attachmentFiles(listing: string): number {
  return listing.split("\n").filter(line =>
    line.includes("/attachment/") && !line.endsWith("/") && !basename(line).startsWith("._")).length;
}

export function parseCounts(line: string): number[] {
  const values = line.trim().split(/\s+/).map(Number);
  if (values.length !== COUNT_LABELS.length || values.some(value => !Number.isInteger(value))) {
    throw new BackupError(`条数读不全：${line.trim() || "（空）"}`);
  }
  return values;
}

/** The counts a restore produced that fall outside what the backup held while it was taken. */
export function countsOutside(restored: number[], before: number[], after: number[]): string[] {
  return COUNT_LABELS.filter((_, index) => {
    const value = restored[index] ?? -1;
    return value < (before[index] ?? 0) || value > (after[index] ?? 0);
  });
}

// --- Processes ------------------------------------------------------------------------

export const spawnExec: Exec = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_000);
  });
  child.on("error", reject);
  child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
});

export function databaseTarget(url: string): { name: string; env: Record<string, string> } {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "openproject";
  return {
    name,
    env: {
      PGHOST: parsed.hostname,
      PGPORT: parsed.port || "5432",
      PGUSER: decodeURIComponent(parsed.username) || "postgres",
      PGPASSWORD: decodeURIComponent(parsed.password),
      PGDATABASE: name
    }
  };
}

/** Rails keeps its cache in memcached; data restored under it must not be answered from it. */
export function flushMemcached(address: string): Promise<void> {
  const [host = "cache", port = "11211"] = address.split(":");
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: Number(port) });
    socket.setTimeout(5000);
    socket.on("connect", () => socket.write("flush_all\r\n"));
    socket.on("data", data => {
      socket.end();
      if (data.toString().startsWith("OK")) resolve(); else reject(new Error(data.toString().trim()));
    });
    socket.on("timeout", () => { socket.destroy(); reject(new Error("缓存服务没有响应")); });
    socket.on("error", reject);
  });
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, "\"\"")}"`;
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

function lastLine(text: string): string {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 300);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- The service ----------------------------------------------------------------------

type StoredState = {
  settings: BackupSettings;
  schedule?: ScheduleState;
  lastBackup?: LastBackup;
  job?: BackupJob;
};

type Mark = (label: string, state: StepState) => Promise<void>;

export class BackupService {
  private readonly paths: BackupPaths;
  private readonly exec: Exec;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly instanceHealthy: () => Promise<boolean>;
  private readonly flushCache: () => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly db: { name: string; env: Record<string, string> };
  private state: StoredState = { settings: { ...DEFAULT_SETTINGS } };
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: BackupDeps) {
    this.paths = deps.paths;
    this.exec = deps.exec ?? spawnExec;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.instanceHealthy = deps.instanceHealthy ?? (async () => true);
    this.flushCache = deps.flushCache ?? (async () => undefined);
    this.log = deps.log ?? (() => undefined);
    this.db = databaseTarget(deps.databaseUrl);
  }

  private get dailyDir(): string {
    return join(this.paths.root, DAILY);
  }

  /** Loads the saved state, clears what an interrupted job left behind, starts the clock. */
  async start(intervalMs = 30_000): Promise<void> {
    await mkdir(this.dailyDir, { recursive: true });
    this.state = await this.readState();
    if (this.state.job?.state === "running") {
      this.state.job = {
        ...this.state.job,
        state: "failed",
        finishedAt: this.now().toISOString(),
        error: "任务进行中服务重启了，这次没有做完"
      };
      await this.writeState();
    }
    await this.clearLeftovers();
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
    await this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Waits for the job in progress, if any. */
  async idle(): Promise<void> {
    await this.running;
  }

  async tick(): Promise<void> {
    try {
      const now = this.now();
      if (this.running || !scheduleDue(now, this.state.settings, this.state.schedule)) return;
      const day = localDay(now);
      const attempts = this.state.schedule?.day === day ? this.state.schedule.attempts : 0;
      this.state.schedule = { day, attempts: attempts + 1, lastAttemptAt: now.toISOString(), succeeded: false };
      this.launch(this.newJob("backup", BACKUP_STEPS, { origin: "scheduled" }), async (job, mark) => {
        const name = await this.backupWithRecord(job, "scheduled", mark);
        if (this.state.schedule?.day === day) this.state.schedule.succeeded = true;
        return name;
      });
    } catch (error) {
      this.log(`backup schedule: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async overview(): Promise<BackupOverview> {
    const [daily, release] = await Promise.all([this.listIn(this.dailyDir, "daily"), this.listIn(this.paths.root, "release")]);
    const backups = [...daily, ...release].sort((left, right) => right.name.localeCompare(left.name));
    let freeBytes: number | null = null;
    try {
      const disk = await statfs(this.paths.root);
      // Blocks are counted in the fragment size. The shared folder a container sees
      // reports a 1 MiB bsize over 4 KiB fragments, which multiplied out to hundreds of
      // terabytes free.
      freeBytes = disk.bavail * ((disk as { frsize?: number }).frsize || disk.bsize);
    } catch {
      freeBytes = null;
    }
    const next = nextScheduledRun(this.now(), this.state.settings, this.state.schedule);
    return {
      settings: this.state.settings,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      nextRun: next ? next.toISOString() : null,
      lastBackup: this.state.lastBackup ?? null,
      job: this.state.job ?? null,
      backups,
      freeBytes
    };
  }

  async saveSettings(input: unknown): Promise<BackupOverview> {
    this.state.settings = parseSettings(input);
    await this.writeState();
    return this.overview();
  }

  startBackup(): BackupJob {
    this.assertIdle();
    return this.launch(this.newJob("backup", BACKUP_STEPS, { origin: "manual" }),
      (job, mark) => this.backupWithRecord(job, "manual", mark));
  }

  async startRestore(kind: string, name: string, confirm: unknown): Promise<BackupJob> {
    const source = await this.locate(kind, name);
    if (confirm !== name) throw new BackupInputError(`请输入 ${name} 确认恢复`);
    this.assertIdle();
    return this.launch(this.newJob("restore", RESTORE_STEPS, { target: { kind: kind as BackupKind, name } }),
      (job, mark) => this.restore(job, source, mark));
  }

  async entry(kind: string, name: string): Promise<BackupEntry> {
    const dir = await this.locate(kind, name);
    return this.describe(dir, kind as BackupKind, name);
  }

  async remove(kind: string, name: string): Promise<void> {
    const dir = await this.locate(kind, name);
    const job = this.state.job;
    if (this.running && job?.target?.kind === kind && job.target.name === name) {
      throw new BackupBusyError("这份备份正在用来恢复，不能删除");
    }
    await rm(dir, { recursive: true, force: true });
  }

  /** Where a backup is, for streaming it out as one archive. */
  async archiveSource(kind: string, name: string): Promise<{ parent: string; name: string }> {
    const dir = await this.locate(kind, name);
    return { parent: dirname(dir), name };
  }

  // --- Jobs ---------------------------------------------------------------------------

  private assertIdle(): void {
    if (this.running) throw new BackupBusyError("已有备份或恢复在进行，等它结束再试");
  }

  private newJob(type: BackupJob["type"], labels: string[], extra: Pick<BackupJob, "origin" | "target">): BackupJob {
    const now = this.now();
    return {
      id: `${type}-${stampOf(now)}`,
      type,
      ...extra,
      state: "running",
      startedAt: now.toISOString(),
      steps: labels.map(label => ({ label, state: "pending" as StepState }))
    };
  }

  private launch(job: BackupJob, work: (job: BackupJob, mark: Mark) => Promise<string | void>): BackupJob {
    this.state.job = job;
    const mark: Mark = async (label, state) => {
      const step = job.steps.find(candidate => candidate.label === label);
      if (step) step.state = state;
      await this.writeState();
    };
    this.running = (async () => {
      try {
        await this.writeState();
        const name = await work(job, mark);
        if (name) job.backupName = name;
        job.state = "succeeded";
      } catch (error) {
        job.state = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        for (const step of job.steps) if (step.state === "running") step.state = "failed";
        this.log(`backup job ${job.id} failed: ${job.error}`);
      } finally {
        job.finishedAt = this.now().toISOString();
        this.running = null;
        await this.writeState().catch(error => this.log(`backup state: ${String(error)}`));
      }
    })();
    return job;
  }

  /**
   * A backup job's own run, recorded as the latest backup. Pruning failing afterwards
   * does not undo a backup that was taken; it is reported beside it.
   */
  private async backupWithRecord(job: BackupJob, origin: BackupOrigin, mark: Mark): Promise<string> {
    let name: string;
    try {
      name = await this.takeBackup(origin, mark);
    } catch (error) {
      this.state.lastBackup = {
        at: this.now().toISOString(),
        ok: false,
        origin,
        error: error instanceof Error ? error.message : String(error)
      };
      throw error;
    }
    this.state.lastBackup = { at: this.now().toISOString(), ok: true, origin, name };
    await mark("清理过期备份", "running");
    try {
      await this.prune(name);
      await mark("清理过期备份", "done");
    } catch (error) {
      await mark("清理过期备份", "failed");
      job.warning = `过期备份没有清掉：${error instanceof Error ? error.message : String(error)}`;
    }
    return name;
  }

  /**
   * Takes one backup into daily/. It is written under a .partial name and renamed only
   * when complete, so a half-written backup never looks like a finished one.
   */
  private async takeBackup(origin: BackupOrigin, mark: Mark): Promise<string> {
    const name = await this.freshName();
    const partial = join(this.dailyDir, `${name}.partial`);
    await mkdir(partial, { mode: 0o700 });
    try {
      await mark("转储数据库", "running");
      const before = await this.counts(this.db.name);
      await this.run("pg_dump", ["-Fc", "-d", this.db.name, "-f", join(partial, DUMP)], "数据库转储失败");
      const after = await this.counts(this.db.name);
      await writeFile(join(partial, COUNTS), `before ${before.join(" ")}\nafter ${after.join(" ")}\n`, { mode: 0o600 });
      const entries = await this.dumpEntries(join(partial, DUMP));
      await mark("转储数据库", "done");

      await mark("打包附件", "running");
      await this.packAssets(join(partial, ASSETS));
      const attachments = attachmentFiles(await this.run("tar", ["-tzf", join(partial, ASSETS)], "附件包读不出来"));
      await mark("打包附件", "done");

      await mark("复制运行配置", "running");
      const { env, principals, fieldMap } = this.paths.runtimeFiles;
      const sources = [env, principals, fieldMap];
      for (const [index, file] of RUNTIME_COPIES.entries()) {
        const source = sources[index];
        if (source) await copyFile(source, join(partial, file));
      }
      await mark("复制运行配置", "done");

      await writeFile(join(partial, META_FILE), `${JSON.stringify({
        origin, createdAt: this.now().toISOString(), entries, attachments
      }, null, 2)}\n`, { mode: 0o600 });
      // Readable by the owner only, as the release's backups are: the dump is every
      // record, and .env and principals.json are the instance's secrets.
      for (const file of await readdir(partial)) await chmod(join(partial, file), 0o600);
      await rename(partial, join(this.dailyDir, name));
      return name;
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Puts the database and the attachments back to what a backup holds.
   *
   * Nothing live is touched until the backup has been restored into a scratch database
   * and checked there: its counts inside what was recorded while it was taken, its
   * attachment files matching its attachment rows, and its schema and field map the
   * ones this version runs on. Only then are the two databases swapped by renaming, and
   * the attachment directory's contents with them. If the instance does not answer
   * normally afterwards, the swap is undone. A backup of the current data is taken
   * first either way, so a restore of the wrong backup can itself be restored away.
   */
  private async restore(job: BackupJob, source: string, mark: Mark): Promise<void> {
    const stamp = stampOf(this.now()).replace("-", "_");
    const scratch = `${this.db.name}_restore_${stamp}`;
    const unpacked = join(this.paths.assetsDir, `${WORK_PREFIX}restore-${stamp}`);
    let scratchCreated = false;
    try {
      await mark("检查备份", "running");
      for (const file of [DUMP, ASSETS]) {
        if (!await exists(join(source, file))) throw new BackupError(`这份备份缺少 ${file}，不能恢复`);
      }
      await this.dumpEntries(join(source, DUMP));
      await this.assertSameFieldMap(source);
      await mark("检查备份", "done");

      await mark("先备份当前数据", "running");
      job.backupName = await this.takeBackup("before-restore", async () => undefined);
      await mark("先备份当前数据", "done");

      await mark("恢复到临时库", "running");
      await this.sql(`CREATE DATABASE ${quoteIdent(scratch)}`, "建临时库失败");
      scratchCreated = true;
      await this.run("pg_restore", [
        "-d", scratch, "--no-owner", "--no-privileges", "--exit-on-error", join(source, DUMP)
      ], "恢复到临时库失败");
      await mark("恢复到临时库", "done");

      await mark("核对内容", "running");
      const restored = await this.counts(scratch);
      const recorded = await this.recordedCounts(source);
      if (recorded) {
        const off = countsOutside(restored, recorded.before, recorded.after);
        if (off.length > 0) throw new BackupError(`恢复出来的${off.join("、")}不在备份时的范围里，这份转储不完整`);
      } else if (restored[0] === 0 || restored[5] === 0 || restored[6] === 0) {
        throw new BackupError("恢复出来的库里没有工作包、用户或项目，不像一份完整的备份");
      }
      await this.assertSameMigrations(scratch);
      const files = attachmentFiles(await this.run("tar", ["-tzf", join(source, ASSETS)], "附件包读不出来"));
      if (files !== restored[ATTACHMENTS_INDEX]) {
        throw new BackupError(`附件包里有 ${files} 个附件文件，数据库里有 ${restored[ATTACHMENTS_INDEX]} 条附件记录，对不上`);
      }
      await mark("核对内容", "done");

      await mark("解开附件", "running");
      await mkdir(unpacked);
      await this.run("tar", ["-xzf", join(source, ASSETS), "--exclude=._*", "-C", unpacked], "解开附件失败");
      const extracted = join(unpacked, basename(this.paths.assetsDir));
      if (!await exists(extracted)) throw new BackupError("附件包里没有附件目录");
      await mark("解开附件", "done");

      await mark("切换到恢复的数据", "running");
      job.liveTouched = true;
      const replacedDb = await this.switchDatabase(scratch, stamp);
      scratchCreated = false;
      let replacedAssets: string;
      try {
        replacedAssets = await this.switchAssets(extracted, stamp);
      } catch (error) {
        await this.unswitchDatabase(replacedDb, scratch);
        scratchCreated = true;
        throw error;
      }
      try {
        await this.flushCache();
      } catch (error) {
        job.warning = `缓存没有清掉（${error instanceof Error ? error.message : String(error)}），个别页面可能要过一会儿才显示恢复后的内容`;
      }
      await mark("切换到恢复的数据", "done");

      await mark("确认系统正常", "running");
      if (!await this.waitHealthy()) {
        await this.unswitchAssets(replacedAssets);
        await this.unswitchDatabase(replacedDb, scratch);
        scratchCreated = true;
        throw new BackupError("切换后系统没有正常响应，已经退回恢复前的数据");
      }
      await this.sql(`DROP DATABASE IF EXISTS ${quoteIdent(replacedDb)}`, "删除被替换的库失败").catch(error => {
        this.log(`backup restore: ${String(error)}`);
      });
      await rm(replacedAssets, { recursive: true, force: true });
      await mark("确认系统正常", "done");
    } finally {
      if (scratchCreated) {
        await this.sql(`DROP DATABASE IF EXISTS ${quoteIdent(scratch)}`, "删除临时库失败").catch(error => {
          this.log(`backup restore: ${String(error)}`);
        });
      }
      await rm(unpacked, { recursive: true, force: true });
    }
  }

  /**
   * Makes the scratch database the live one. Connections to the live one are closed
   * and refused first — a database cannot be renamed while anyone is connected, and the
   * application reconnects on its own — then the live one steps aside under a name of
   * its own and the scratch one takes its name.
   */
  private async switchDatabase(scratch: string, stamp: string): Promise<string> {
    const live = this.db.name;
    const replaced = `${live}_replaced_${stamp}`;
    await this.sql(`ALTER DATABASE ${quoteIdent(live)} WITH ALLOW_CONNECTIONS false`, "停止新连接失败");
    try {
      await this.renameWhenFree(live, replaced);
    } catch (error) {
      await this.sql(`ALTER DATABASE ${quoteIdent(live)} WITH ALLOW_CONNECTIONS true`, "恢复连接失败").catch(() => undefined);
      throw error;
    }
    try {
      await this.sql(`ALTER DATABASE ${quoteIdent(scratch)} RENAME TO ${quoteIdent(live)}`, "启用恢复的库失败");
    } catch (error) {
      await this.sql(`ALTER DATABASE ${quoteIdent(replaced)} RENAME TO ${quoteIdent(live)}`, "退回原库失败");
      await this.sql(`ALTER DATABASE ${quoteIdent(live)} WITH ALLOW_CONNECTIONS true`, "恢复连接失败");
      throw error;
    }
    return replaced;
  }

  private async unswitchDatabase(replaced: string, scratch: string): Promise<void> {
    const live = this.db.name;
    await this.sql(`ALTER DATABASE ${quoteIdent(live)} WITH ALLOW_CONNECTIONS false`, "停止新连接失败");
    await this.renameWhenFree(live, scratch);
    await this.sql(`ALTER DATABASE ${quoteIdent(replaced)} RENAME TO ${quoteIdent(live)}`, "退回原库失败");
    await this.sql(`ALTER DATABASE ${quoteIdent(live)} WITH ALLOW_CONNECTIONS true`, "恢复连接失败");
  }

  private async renameWhenFree(from: string, to: string): Promise<void> {
    const terminate = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
      `WHERE datname = ${quoteLiteral(from)} AND pid <> pg_backend_pid()`;
    for (let attempt = 1; ; attempt += 1) {
      await this.sql(terminate, "断开数据库连接失败");
      const result = await this.exec("psql", ["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atc",
        `ALTER DATABASE ${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`], this.db.env);
      if (result.code === 0) return;
      if (attempt >= 10 || !/being accessed by other users/.test(result.stderr)) {
        throw new BackupError(`切换数据库失败：${lastLine(result.stderr) || `退出码 ${result.code}`}`);
      }
      await this.sleep(500);
    }
  }

  /**
   * Swaps what is inside the attachments directory, not the directory itself: the
   * application's containers mount that directory, and a renamed one would stay mounted
   * under its new name.
   */
  private async switchAssets(extracted: string, stamp: string): Promise<string> {
    const assets = this.paths.assetsDir;
    const replaced = join(assets, `${WORK_PREFIX}replaced-${stamp}`);
    await mkdir(replaced);
    const current = (await readdir(assets)).filter(name => !name.startsWith(WORK_PREFIX));
    const movedOut: string[] = [];
    try {
      for (const name of current) {
        await rename(join(assets, name), join(replaced, name));
        movedOut.push(name);
      }
      for (const name of await readdir(extracted)) await rename(join(extracted, name), join(assets, name));
    } catch (error) {
      for (const name of await readdir(assets)) {
        if (!name.startsWith(WORK_PREFIX)) await rm(join(assets, name), { recursive: true, force: true });
      }
      for (const name of movedOut) await rename(join(replaced, name), join(assets, name));
      await rm(replaced, { recursive: true, force: true });
      throw new BackupError(`切换附件失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return replaced;
  }

  private async unswitchAssets(replaced: string): Promise<void> {
    const assets = this.paths.assetsDir;
    for (const name of await readdir(assets)) {
      if (!name.startsWith(WORK_PREFIX)) await rm(join(assets, name), { recursive: true, force: true });
    }
    for (const name of await readdir(replaced)) await rename(join(replaced, name), join(assets, name));
    await rm(replaced, { recursive: true, force: true });
  }

  private async waitHealthy(): Promise<boolean> {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      if (await this.instanceHealthy().catch(() => false)) return true;
      await this.sleep(5000);
    }
    return false;
  }

  /**
   * The MCP reads its field map at start and writes by it; a database restored from
   * before the map last changed would not have the fields it names.
   */
  private async assertSameFieldMap(source: string): Promise<void> {
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(join(source, "field-map.json"), "utf8"));
    } catch {
      throw new BackupError("这份备份里没有字段映射（field-map.json），不能在页面上恢复");
    }
    const current: unknown = JSON.parse(await readFile(this.paths.runtimeFiles.fieldMap, "utf8"));
    if (!isDeepStrictEqual(saved, current)) {
      throw new BackupError("这份备份的字段结构和现在不一样（来自之前的版本），不能在页面上直接恢复");
    }
  }

  /** A database from another OpenProject version would not match the code now running. */
  private async assertSameMigrations(scratch: string): Promise<void> {
    const versions = async (database: string) => new Set((await this.run("psql",
      ["-d", database, "-Atc", "SELECT version FROM schema_migrations"], "读不出数据库版本")).split("\n").filter(Boolean));
    const [live, saved] = await Promise.all([versions(this.db.name), versions(scratch)]);
    const differ = [...live].some(version => !saved.has(version)) || [...saved].some(version => !live.has(version));
    if (differ) throw new BackupError("这份备份来自另一个 OpenProject 版本，不能在页面上直接恢复");
  }

  // --- Pieces -------------------------------------------------------------------------

  private async run(command: string, args: string[], failure: string): Promise<string> {
    const result = await this.exec(command, args, this.db.env);
    if (result.code !== 0) throw new BackupError(`${failure}：${lastLine(result.stderr) || `退出码 ${result.code}`}`);
    return result.stdout;
  }

  /**
   * GNU tar ends with status 1 when something it was reading changed underneath it, and
   * the archive it wrote is still whole. The web container's entrypoint chowns every
   * attachment each time it starts, which is exactly what a release does right as the
   * MCP starts and catches up on the day's backup: the first one on production failed
   * this way. Attachments are never rewritten in place, and a restore checks the files
   * in the archive against the attachment rows, so that status is taken as done.
   */
  private async packAssets(target: string): Promise<void> {
    const result = await this.exec("tar", [
      "-czf", target, `--exclude=${WORK_PREFIX}*`,
      "-C", dirname(this.paths.assetsDir), basename(this.paths.assetsDir)
    ], this.db.env);
    if (result.code === 0) return;
    if (result.code === 1 && /file changed as we read it/.test(result.stderr)) {
      this.log(`backup: attachments changed while packed, kept: ${lastLine(result.stderr)}`);
      return;
    }
    throw new BackupError(`附件打包失败：${lastLine(result.stderr) || `退出码 ${result.code}`}`);
  }

  private sql(statement: string, failure: string): Promise<string> {
    return this.run("psql", ["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atc", statement], failure);
  }

  private async counts(database: string): Promise<number[]> {
    return parseCounts(await this.run("psql", ["-d", database, "-Atc", COUNTS_SQL], "数据库查不了"));
  }

  private async dumpEntries(file: string): Promise<number> {
    const listing = await this.run("pg_restore", ["--list", file], "转储读不出来");
    const entries = listing.split("\n").filter(line => line.trim() && !line.startsWith(";")).length;
    if (entries === 0) throw new BackupError("转储读不出条目，这份备份不能用");
    return entries;
  }

  private async recordedCounts(source: string): Promise<{ before: number[]; after: number[] } | null> {
    let text: string;
    try {
      text = await readFile(join(source, COUNTS), "utf8");
    } catch {
      return null;
    }
    const line = (label: string) => text.split("\n").find(candidate => candidate.startsWith(`${label} `))?.slice(label.length + 1);
    const before = line("before");
    const after = line("after");
    if (before === undefined || after === undefined) return null;
    return { before: parseCounts(before), after: parseCounts(after) };
  }

  /** A name no backup has yet: two taken in the same second wait for the next one. */
  private async freshName(): Promise<string> {
    for (;;) {
      const name = stampOf(this.now());
      if (!await exists(join(this.dailyDir, name)) && !await exists(join(this.dailyDir, `${name}.partial`))) return name;
      await this.sleep(1000);
    }
  }

  private async prune(keep: string): Promise<void> {
    const names = await readdir(this.dailyDir);
    for (const name of expiredDailyBackups(names, this.now(), this.state.settings.keepDays, keep)) {
      await rm(join(this.dailyDir, name), { recursive: true, force: true });
    }
    for (const name of names.filter(candidate => candidate.endsWith(".partial"))) {
      await rm(join(this.dailyDir, name), { recursive: true, force: true });
    }
  }

  private async locate(kind: string, name: string): Promise<string> {
    if (kind !== "daily" && kind !== "release") throw new BackupInputError("备份类别无效");
    if (!BACKUP_NAME.test(name)) throw new BackupInputError("备份名称无效");
    const dir = kind === "daily" ? join(this.dailyDir, name) : join(this.paths.root, name);
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      // Reported below.
    }
    throw new BackupNotFoundError(`没有这份备份：${name}`);
  }

  private async listIn(dir: string, kind: BackupKind): Promise<BackupEntry[]> {
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && BACKUP_NAME.test(entry.name))
        .map(entry => entry.name);
    } catch {
      return [];
    }
    return Promise.all(names.map(name => this.describe(join(dir, name), kind, name)));
  }

  private async describe(dir: string, kind: BackupKind, name: string): Promise<BackupEntry> {
    const files = await readdir(dir);
    let sizeBytes = 0;
    for (const file of files) {
      try {
        sizeBytes += (await stat(join(dir, file))).size;
      } catch {
        // A file removed while listing counts as nothing.
      }
    }
    let meta: { origin?: BackupOrigin; entries?: number; attachments?: number } = {};
    if (files.includes(META_FILE)) {
      try {
        meta = JSON.parse(await readFile(join(dir, META_FILE), "utf8")) as typeof meta;
      } catch {
        meta = {};
      }
    }
    return {
      kind,
      name,
      createdAt: timeOfStamp(name).toISOString(),
      origin: kind === "release" ? "release" : meta.origin ?? "scheduled",
      sizeBytes,
      entries: typeof meta.entries === "number" ? meta.entries : null,
      attachments: typeof meta.attachments === "number" ? meta.attachments : null,
      complete: files.includes(DUMP) && files.includes(ASSETS)
    };
  }

  /**
   * What a job cut short by a restart leaves: a half-written backup, a scratch database,
   * unpacked attachments. And the one state that matters most — the live database
   * renamed aside with its replacement not yet in place — is put back first.
   */
  private async clearLeftovers(): Promise<void> {
    try {
      for (const name of await readdir(this.dailyDir)) {
        if (name.endsWith(".partial")) await rm(join(this.dailyDir, name), { recursive: true, force: true });
      }
      for (const name of await readdir(this.paths.assetsDir)) {
        if (name.startsWith(`${WORK_PREFIX}restore-`)) await rm(join(this.paths.assetsDir, name), { recursive: true, force: true });
      }
      const databases = (await this.sql("SELECT datname FROM pg_database", "读不出数据库列表")).split("\n").filter(Boolean);
      const live = this.db.name;
      const replaced = databases.filter(name => name.startsWith(`${live}_replaced_`)).sort();
      if (!databases.includes(live) && replaced.length > 0) {
        const latest = replaced.pop() as string;
        await this.sql(`ALTER DATABASE ${quoteIdent(latest)} RENAME TO ${quoteIdent(live)}`, "退回原库失败");
        await this.sql(`ALTER DATABASE ${quoteIdent(live)} WITH ALLOW_CONNECTIONS true`, "恢复连接失败");
        this.log(`backup: put ${latest} back as ${live} after an interrupted restore`);
      }
      for (const name of databases.filter(candidate => candidate.startsWith(`${live}_restore_`))) {
        await this.sql(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`, "删除临时库失败");
      }
    } catch (error) {
      this.log(`backup cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readState(): Promise<StoredState> {
    try {
      const saved = JSON.parse(await readFile(join(this.dailyDir, STATE_FILE), "utf8")) as Partial<StoredState>;
      let settings = { ...DEFAULT_SETTINGS };
      try {
        settings = parseSettings(saved.settings);
      } catch {
        // A damaged setting falls back to the defaults rather than stopping backups.
      }
      return {
        settings,
        ...(saved.schedule ? { schedule: saved.schedule } : {}),
        ...(saved.lastBackup ? { lastBackup: saved.lastBackup } : {}),
        ...(saved.job ? { job: saved.job } : {})
      };
    } catch {
      return { settings: { ...DEFAULT_SETTINGS } };
    }
  }

  private async writeState(): Promise<void> {
    const file = join(this.dailyDir, STATE_FILE);
    await writeFile(`${file}.tmp`, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
}
