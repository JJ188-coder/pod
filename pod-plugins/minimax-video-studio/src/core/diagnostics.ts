import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_BASE_URL, loadConfig, readCredentials } from "./config.js";
import { countActive, listBatches, openDb } from "./db.js";
import { credentialsPath, dataDir, dbPath, ensureDir } from "./paths.js";

export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DiagnosticReport {
  ok: boolean;
  ready: boolean;
  node: string;
  sqlite: string | null;
  data_dir: string;
  data_dir_mode: string | null;
  db_path: string;
  credentials: {
    configured: boolean;
    source: "env" | "file" | "none";
    file_exists: boolean;
    file_mode: string | null;
  };
  base_url: string;
  asset_encoding: string;
  allow_private_network: boolean;
  pending_batches: number;
  active_jobs: number;
  cli_path: string | null;
  server_bundle: string | null;
  checks: DiagnosticCheck[];
}

function modeOf(target: string): string | null {
  try {
    return `0${(fs.statSync(target).mode & 0o777).toString(8)}`;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function collectDiagnostics(options: {
  cliPath?: string;
  serverBundle?: string;
} = {}): DiagnosticReport {
  const checks: DiagnosticCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeOk = Number.isFinite(nodeMajor) && nodeMajor >= 22;
  checks.push({
    name: "node",
    ok: nodeOk,
    detail: `Node ${process.version}（需要 >= 22.5，推荐 24）`,
  });

  const dir = dataDir();
  let dataWritable = false;
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "ok", { mode: 0o600 });
    fs.unlinkSync(probe);
    dataWritable = true;
  } catch (error) {
    checks.push({ name: "data_dir", ok: false, detail: `数据目录不可写：${errorMessage(error)}` });
  }
  if (dataWritable) {
    checks.push({ name: "data_dir", ok: true, detail: dir });
  }
  const dirMode = modeOf(dir);
  if (dataWritable && dirMode && dirMode !== "0700") {
    checks.push({ name: "data_dir_mode", ok: false, detail: `目录权限为 ${dirMode}，建议 0700。` });
  }

  let sqliteVersion: string | null = null;
  let dbOk = false;
  let dbDetail = "";
  try {
    sqliteVersion = String(
      (new DatabaseSync(":memory:").prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
    );
    const db = openDb();
    const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    const value = Object.values(integrity)[0];
    db.close();
    dbOk = value === "ok";
    dbDetail = dbOk ? `${dbPath()}（integrity ok）` : `完整性检查失败：${String(value)}`;
  } catch (error) {
    dbDetail = `无法打开数据库：${errorMessage(error)}`;
  }
  checks.push({ name: "sqlite", ok: sqliteVersion !== null, detail: sqliteVersion ? `SQLite ${sqliteVersion}` : "不可用" });
  checks.push({ name: "database", ok: dbOk, detail: dbDetail });

  const stored = readCredentials();
  const credentialFile = credentialsPath();
  const fileExists = fs.existsSync(credentialFile);
  const fileMode = modeOf(credentialFile);
  if (fileExists && fileMode && fileMode !== "0600") {
    checks.push({ name: "credentials_mode", ok: false, detail: `凭据文件权限为 ${fileMode}，建议 0600。` });
  }

  let baseUrl = DEFAULT_BASE_URL;
  let assetEncoding = "data_url";
  let allowPrivateNetwork = false;
  let apiKeySource: "env" | "file" | "none" = "none";
  try {
    const config = loadConfig();
    baseUrl = config.baseUrl;
    assetEncoding = config.assetEncoding;
    allowPrivateNetwork = config.allowPrivateNetwork;
    apiKeySource = config.apiKeySource;
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: errorMessage(error) });
  }

  const credentialsConfigured = apiKeySource !== "none";
  checks.push({
    name: "credentials",
    ok: credentialsConfigured,
    detail: credentialsConfigured
      ? `已配置（来源：${apiKeySource === "env" ? "环境变量" : "本地凭据文件"}）`
      : "未配置 API Key，运行 node dist/cli.js setup",
  });

  let pendingBatches = 0;
  let activeJobs = 0;
  if (dbOk) {
    try {
      const db = openDb();
      pendingBatches = listBatches(db, { unfinishedOnly: true, limit: 100 }).length;
      activeJobs = countActive(db);
      db.close();
    } catch {
      // 已在上面的数据库检查中报告。
    }
  }

  const cliPath = options.cliPath ?? null;
  const serverBundle = options.serverBundle ?? null;
  if (serverBundle) {
    const exists = fs.existsSync(serverBundle);
    checks.push({ name: "server_bundle", ok: exists, detail: exists ? serverBundle : `缺少 ${serverBundle}` });
  }

  const ok = checks.filter((check) => check.name !== "credentials").every((check) => check.ok);

  return {
    ok,
    ready: ok && credentialsConfigured,
    node: process.version,
    sqlite: sqliteVersion,
    data_dir: dir,
    data_dir_mode: dirMode,
    db_path: dbPath(),
    credentials: {
      configured: credentialsConfigured,
      source: apiKeySource,
      file_exists: fileExists,
      file_mode: fileMode,
    },
    base_url: baseUrl,
    asset_encoding: assetEncoding,
    allow_private_network: allowPrivateNetwork,
    pending_batches: pendingBatches,
    active_jobs: activeJobs,
    cli_path: cliPath,
    server_bundle: serverBundle,
    checks,
  };
}
