"use strict";
// 存储层：配置了 DATABASE_URL 就用 Postgres，否则写本地 JSON 文件。
// 每次保存都会留一份带版本号的备份，管理员可以回滚。

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const KEEP_BACKUPS = 200;

function summarize(state) {
  const sessions = Object.values(state.sessions || {});
  return {
    games: (state.games || []).length,
    sessions: sessions.length,
    signups: sessions.reduce((n, s) => n + (s.signups || []).length, 0),
  };
}

class FileStore {
  constructor(dir) {
    this.kind = "file";
    this.dir = dir;
    this.file = path.join(dir, "state.json");
    this.backupDir = path.join(dir, "backups");
  }
  async init() {
    await fsp.mkdir(this.backupDir, { recursive: true });
  }
  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, "utf8"));
      return { state: raw.state, revision: Number(raw.revision) || 0, updatedAt: raw.updatedAt };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      // 主文件损坏时退回最近的备份
      const list = await this.listBackups();
      if (list.length) {
        const b = await this.getBackup(list[0].revision);
        if (b) return b;
      }
      throw error;
    }
  }
  async save(state, revision, updatedAt) {
    const body = JSON.stringify({ revision, updatedAt, state });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, this.file);
    await fsp.writeFile(path.join(this.backupDir, `rev-${String(revision).padStart(8, "0")}.json`), body);
    const files = (await fsp.readdir(this.backupDir)).filter(f => /^rev-\d+\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) await fsp.unlink(path.join(this.backupDir, f)).catch(() => {});
  }
  async listBackups(limit = 60) {
    let files = [];
    try {
      files = (await fsp.readdir(this.backupDir)).filter(f => /^rev-\d+\.json$/.test(f)).sort().reverse().slice(0, limit);
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(this.backupDir, f), "utf8"));
        out.push({ revision: raw.revision, updatedAt: raw.updatedAt, ...summarize(raw.state) });
      } catch {}
    }
    return out;
  }
  async getBackup(revision) {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(this.backupDir, `rev-${String(revision).padStart(8, "0")}.json`), "utf8"));
      return { state: raw.state, revision: raw.revision, updatedAt: raw.updatedAt };
    } catch {
      return null;
    }
  }
}

class PgStore {
  constructor(url) {
    this.kind = "postgres";
    const { Pool } = require("pg");
    let connectionString = url;
    let local = false;
    try {
      const u = new URL(url);
      local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
      // 由下面的 ssl 选项统一控制 TLS
      u.searchParams.delete("sslmode");
      u.searchParams.delete("channel_binding");
      connectionString = u.toString();
    } catch {}
    // 默认校验证书（Neon 等托管商用的是公共 CA 证书）；个别自签证书的数据库可设 PGSSL_NO_VERIFY=1
    this.pool = new Pool({
      connectionString,
      ssl: local ? false : { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== "1" },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    this.pool.on("error", err => console.error("[pg] idle client error:", err.message));
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS bgc_state (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bgc_backup (
        revision INTEGER PRIMARY KEY,
        updated_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      );`);
  }
  async load() {
    const { rows } = await this.pool.query("SELECT revision, updated_at, data FROM bgc_state WHERE id = 'main'");
    if (!rows.length) return null;
    return { state: rows[0].data, revision: rows[0].revision, updatedAt: new Date(rows[0].updated_at).toISOString() };
  }
  // prevRevision：本实例认为数据库里当前的版本号。对不上说明别的实例（例如 Render 部署切换期间的旧实例）刚写过，
  // 抛出 REVISION_CONFLICT，由上层重新加载后再执行一次，避免互相覆盖丢报名
  async save(state, revision, updatedAt, prevRevision) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT revision FROM bgc_state WHERE id = 'main' FOR UPDATE");
      const current = rows.length ? rows[0].revision : 0;
      if (prevRevision !== undefined && current !== prevRevision) {
        throw Object.assign(new Error(`revision conflict: db=${current}, local=${prevRevision}`), { code: "REVISION_CONFLICT" });
      }
      await client.query(
        `INSERT INTO bgc_state (id, revision, updated_at, data) VALUES ('main', $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
        [revision, updatedAt, state],
      );
      await client.query(
        "INSERT INTO bgc_backup (revision, updated_at, data) VALUES ($1, $2, $3) ON CONFLICT (revision) DO UPDATE SET updated_at = EXCLUDED.updated_at, data = EXCLUDED.data",
        [revision, updatedAt, state],
      );
      await client.query("DELETE FROM bgc_backup WHERE revision <= $1", [revision - KEEP_BACKUPS]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async listBackups(limit = 60) {
    const { rows } = await this.pool.query("SELECT revision, updated_at, data FROM bgc_backup ORDER BY revision DESC LIMIT $1", [limit]);
    return rows.map(r => ({ revision: r.revision, updatedAt: new Date(r.updated_at).toISOString(), ...summarize(r.data) }));
  }
  async getBackup(revision) {
    const { rows } = await this.pool.query("SELECT revision, updated_at, data FROM bgc_backup WHERE revision = $1", [revision]);
    if (!rows.length) return null;
    return { state: rows[0].data, revision: rows[0].revision, updatedAt: new Date(rows[0].updated_at).toISOString() };
  }
}

async function createStore({ databaseUrl, dataDir }) {
  if (databaseUrl) {
    const store = new PgStore(databaseUrl);
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await store.init();
        return store;
      } catch (error) {
        lastError = error;
        console.error(`[pg] 连接失败（第 ${attempt} 次）：${error.message}`);
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
    throw lastError;
  }
  const store = new FileStore(dataDir);
  await store.init();
  return store;
}

module.exports = { createStore, FileStore, PgStore, summarize, fsExists: p => fs.existsSync(p) };
