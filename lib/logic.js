"use strict";
// 纯逻辑：时间与场次（多轮）、数据规范化、按志愿排序自动分桌。不依赖存储与 HTTP，便于测试。

const DAY = 86400000;
const LEVELS = ["新手", "玩过一些", "老手能教"];
const PALETTE_COUNT = 8;
const GROUPS = ["身份类", "桌游", "特色"];
const ICON_KEYS = ["house", "gem", "flag", "shuriken", "bubble", "moon", "shield", "dice", "crown", "sub", "mask", "mug", "dice2", "letter", "tile", "spade"];
const MAX_ROUNDS = 4;
const MAX_PREFS = 30;

const DEFAULT_ROUNDS = Object.freeze([
  Object.freeze({ start: "18:30", end: "20:15" }),
  Object.freeze({ start: "20:15", end: "22:00" }),
]);
const DEFAULT_SETTINGS = Object.freeze({
  clubName: "开桌 · 桌游社",
  weekday: 5, // 0=周日 … 5=周五
  rounds: DEFAULT_ROUNDS,
  location: "R312",
  bookAheadWeeks: 3,
  tzOffsetMinutes: 480, // UTC+8（马来西亚 / 中国）
  announcement: "",
});

// ---------- 基础工具 ----------
const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};
// 控制字符 + 零宽 / 双向控制字符（防止“看起来同名”的冒名报名）
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
const cleanText = (value, max) =>
  String(value ?? "")
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
const cleanLine = (value, max) => cleanText(value, max * 2).replace(/\s+/g, " ").slice(0, max);
const nameKey = name => cleanLine(name, 40).normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "");

function parseHM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
const fmtHM = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const isDateKey = value => {
  const v = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  const y = Number(v.slice(0, 4));
  return !Number.isNaN(t) && y >= 2020 && y <= 2100 && new Date(t).toISOString().slice(0, 10) === v;
};
// 校验类错误：服务端会按 400 返回
const badInput = message => Object.assign(new Error(message), { status: 400 });
function dateKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
const addDays = (key, n) => dateKeyOf(Date.parse(`${key}T00:00:00Z`) + n * DAY);
const localDayStart = (key, tz) => Date.parse(`${key}T00:00:00Z`) - tz * 60000;
const weekdayOf = key => new Date(`${key}T00:00:00Z`).getUTCDay();
const isIso = v => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const isHash = v => /^[a-f0-9]{64}$/.test(String(v || ""));
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

// ---------- 轮次 ----------
// rounds：[{start:"18:30", end:"20:15"}, ...]，1–4 轮。无效时返回 null（由调用方决定回退）。
function normalizeRounds(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const r of list.slice(0, MAX_ROUNDS)) {
    const s = parseHM(r?.start);
    const e = parseHM(r?.end);
    if (s === null || e === null) return null;
    out.push({ start: fmtHM(s), end: fmtHM(e) });
  }
  return out.length ? out : null;
}

// ---------- 设置与桌游规范化 ----------
function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  // 旧版设置只有 time / endTime：按原时段平分成两轮
  let rounds = normalizeRounds(input?.rounds);
  if (!rounds && (s.time || s.endTime)) {
    const a = parseHM(s.time) ?? parseHM(DEFAULT_ROUNDS[0].start);
    let b = parseHM(s.endTime) ?? parseHM(DEFAULT_ROUNDS[1].end);
    if (b <= a) b += 24 * 60;
    const mid = a + Math.round((b - a) / 2 / 15) * 15;
    rounds = [{ start: fmtHM(a), end: fmtHM(mid) }, { start: fmtHM(mid), end: fmtHM(b) }];
  }
  rounds = rounds || DEFAULT_ROUNDS.map(r => ({ ...r }));
  return {
    clubName: cleanLine(s.clubName, 30) || DEFAULT_SETTINGS.clubName,
    weekday: clampInt(s.weekday, 0, 6, DEFAULT_SETTINGS.weekday),
    rounds,
    time: rounds[0].start,
    endTime: rounds[rounds.length - 1].end,
    location: cleanLine(s.location, 40) || DEFAULT_SETTINGS.location,
    bookAheadWeeks: clampInt(s.bookAheadWeeks, 1, 8, DEFAULT_SETTINGS.bookAheadWeeks),
    tzOffsetMinutes: clampInt(s.tzOffsetMinutes, -720, 840, DEFAULT_SETTINGS.tzOffsetMinutes),
    announcement: cleanText(s.announcement, 300),
  };
}

const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
function normalizeVideo(v) {
  if (!v || typeof v !== "object") return null;
  const bvid = String(v.bvid || "").trim();
  if (!BVID_RE.test(bvid)) return null;
  return {
    bvid,
    title: cleanLine(v.title, 80),
    uploader: cleanLine(v.uploader, 40),
    duration: clampInt(v.duration ?? v.durationSec, 0, 36000, 0),
    cover: /^https:\/\/[a-z0-9.]*hdslb\.com\/[\w./-]+$/i.test(String(v.cover || "")) ? String(v.cover) : "",
  };
}

function slugify(name, taken) {
  let base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  if (!base) base = `g-${Math.abs(hashCode(String(name || ""))).toString(36).slice(0, 6) || "x"}`;
  let id = base;
  let i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  return id;
}

function normalizeGame(game, index, taken = new Set()) {
  const name = cleanLine(game?.name, 32);
  if (!name) throw badInput("桌游名称不能为空");
  let id = cleanLine(game?.id, 40).replace(/[^\w-]/g, "");
  if (!id || taken.has(id)) id = slugify(game?.en || name, taken);
  taken.add(id);
  const min = clampInt(game?.min, 1, 40, 2);
  const max = Math.max(min, clampInt(game?.max, 1, 40, Math.max(min, 4)));
  const tableSizeRaw = game?.tableSize === null || game?.tableSize === "" || game?.tableSize === undefined ? null : clampInt(game.tableSize, 1, 40, null);
  return {
    id,
    name,
    en: cleanLine(game?.en, 60),
    category: cleanLine(game?.category, 16) || "其他",
    group: GROUPS.includes(game?.group) ? game.group : "桌游",
    icon: ICON_KEYS.includes(game?.icon) ? game.icon : "",
    notice: cleanText(game?.notice, 120),
    min,
    max,
    minutes: clampInt(game?.minutes, 5, 600, 45),
    difficulty: clampInt(game?.difficulty, 1, 3, 2),
    intro: cleanText(game?.intro, 200),
    rules: cleanText(game?.rules, 3000),
    palette: Math.abs(clampInt(game?.palette, 0, 99, index)) % PALETTE_COUNT,
    copies: clampInt(game?.copies, 1, 20, 1),
    tableSize: tableSizeRaw === null ? null : Math.max(1, tableSizeRaw),
    active: game?.active !== false,
    video: normalizeVideo(game?.video),
    videoBackup: normalizeVideo(game?.videoBackup),
  };
}

// ---------- 报名记录 ----------
// prefs：按喜欢程度排好的游戏 id（第 1 个最想玩）；rounds：参加哪几轮（空数组 = 全部）
function normalizeSignup(raw, gameIds) {
  const name = cleanLine(raw?.name, 20);
  if (!name) return null;
  const source = Array.isArray(raw?.prefs) ? raw.prefs : [raw?.gameId, raw?.altGameId]; // 兼容旧版第一 / 第二志愿
  const prefs = [...new Set(source.filter(Boolean).map(String))].filter(id => !gameIds || gameIds.has(id)).slice(0, MAX_PREFS);
  if (!prefs.length) return null;
  const rounds = Array.isArray(raw?.rounds) ? [...new Set(raw.rounds.map(n => clampInt(n, 1, MAX_ROUNDS, 0)).filter(Boolean))].sort((a, b) => a - b) : [];
  const level = raw?.level === null || raw?.level === undefined || raw?.level === "" ? null : clampInt(raw.level, 0, 2, null);
  const createdAt = isIso(raw?.createdAt) ? raw.createdAt : new Date(0).toISOString();
  return {
    id: cleanLine(raw?.id, 40) || null,
    name,
    prefs,
    rounds,
    level,
    teach: Boolean(raw?.teach) && level !== 0,
    note: cleanText(raw?.note, 120),
    createdAt,
    updatedAt: isIso(raw?.updatedAt) ? raw.updatedAt : createdAt,
    prefsAt: isIso(raw?.prefsAt) ? raw.prefsAt : createdAt,
    tokenHash: isHash(raw?.tokenHash) ? raw.tokenHash : "",
    extraTokenHashes: (Array.isArray(raw?.extraTokenHashes) ? raw.extraTokenHashes : []).filter(isHash).slice(-5),
    pinHash: isHash(raw?.pinHash) ? raw.pinHash : "",
    checkedIn: Boolean(raw?.checkedIn),
    by: raw?.by === "admin" ? "admin" : raw?.by === "import" ? "import" : "self",
  };
}

function normalizeFrozen(f, gameIds, idSet) {
  if (!f || typeof f !== "object" || !isIso(f.at) || !Array.isArray(f.rounds)) return null;
  const rounds = f.rounds.slice(0, MAX_ROUNDS).map(r => {
    const tables = {};
    for (const [gid, list] of Object.entries(r?.tables || {})) {
      if (!gameIds.has(gid) || !Array.isArray(list)) continue;
      tables[gid] = list.slice(0, 20).map(t => (Array.isArray(t) ? t.map(String).filter(id => idSet.has(id)).slice(0, 40) : [])).filter(t => t.length);
    }
    const unassigned = (Array.isArray(r?.unassigned) ? r.unassigned : []).map(String).filter(id => idSet.has(id));
    return { tables, unassigned };
  });
  return { at: f.at, rounds };
}

function normalizeSession(key, raw, gameIds) {
  const s = raw || {};
  const out = {
    date: key,
    title: cleanLine(s.title, 30),
    rounds: normalizeRounds(s.rounds),
    location: cleanLine(s.location, 40),
    status: s.status === "cancelled" ? "cancelled" : "",
    note: cleanText(s.note, 200),
    extra: Boolean(s.extra),
    gameIds: Array.isArray(s.gameIds) ? [...new Set(s.gameIds.map(String).filter(id => gameIds.has(id)))] : [],
    tableSizes: {},
    copies: {},
    signups: [],
    frozen: null,
  };
  // 旧版单场次自定义了开始 / 结束时间：转成一整轮
  if (!out.rounds && (parseHM(s.time) !== null || parseHM(s.endTime) !== null) && (s.time || s.endTime)) {
    const a = parseHM(s.time) ?? parseHM(DEFAULT_ROUNDS[0].start);
    const b = parseHM(s.endTime) ?? parseHM(DEFAULT_ROUNDS[DEFAULT_ROUNDS.length - 1].end);
    out.rounds = [{ start: fmtHM(a), end: fmtHM(b) }];
  }
  for (const [id, v] of Object.entries(s.tableSizes || {})) if (gameIds.has(id)) out.tableSizes[id] = clampInt(v, 1, 40, 4);
  for (const [id, v] of Object.entries(s.copies || {})) if (gameIds.has(id)) out.copies[id] = clampInt(v, 1, 20, 1);
  const seenIds = new Set();
  for (const r of Array.isArray(s.signups) ? s.signups.slice(0, 500) : []) {
    const n = normalizeSignup(r, gameIds);
    if (!n) continue;
    if (!n.id || seenIds.has(n.id)) n.id = `s-${key}-${seenIds.size + 1}-${Math.abs(hashCode(n.name + n.createdAt)).toString(36)}`;
    seenIds.add(n.id);
    out.signups.push(n);
  }
  out.frozen = normalizeFrozen(s.frozen, gameIds, seenIds);
  return out;
}

function normalizeState(input) {
  const src = input && typeof input === "object" ? input : {};
  const taken = new Set();
  const games = (Array.isArray(src.games) ? src.games : []).slice(0, 120).map((g, i) => normalizeGame(g, i, taken));
  const gameIds = new Set(games.map(g => g.id));
  const sessions = {};
  for (const [key, raw] of Object.entries(src.sessions || {})) {
    if (!isDateKey(key)) continue;
    sessions[key] = normalizeSession(key, raw, gameIds);
  }
  const seededIds = [...new Set((Array.isArray(src.seededIds) ? src.seededIds : []).map(String))].slice(0, 500);
  const seedVersion = clampInt(src.seedVersion, 0, 1e6, 0);
  return { version: 5, settings: normalizeSettings(src.settings), games, sessions, seededIds, seedVersion, admins: normalizeAdmins(src.admins), auditLog: normalizeAudit(src.auditLog) };
}

// ---------- 协作管理员与操作记录 ----------
const MAX_ADMINS = 20;
const MAX_AUDIT = 500;
function normalizeAdmins(list) {
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const id = String(a?.id || "");
    if (!/^a[0-9a-f]{8}$/.test(id) || seen.has(id)) continue;
    if (!isHash(a?.keyHash)) continue;
    const name = cleanLine(a?.name, 20);
    if (!name) continue;
    seen.add(id);
    out.push({ id, name, keyHash: a.keyHash, createdAt: isIso(a?.createdAt) ? a.createdAt : new Date(0).toISOString() });
    if (out.length >= MAX_ADMINS) break;
  }
  return out;
}
function normalizeAudit(list) {
  return (Array.isArray(list) ? list : [])
    .filter(e => e && isIso(e.at))
    .slice(-MAX_AUDIT)
    .map(e => ({ at: e.at, actor: cleanLine(e.actor, 24) || "?", action: cleanLine(e.action, 40), detail: cleanLine(e.detail, 160) }));
}

// 旧版（v3：{games, events:[{id,title,date,time,location,gameIds,capacities,signups:[{id,name,gameId}]}]}）导入
// 旧游戏按 id 或名称对应到现有游戏；同一场次同名去重；保留原报名顺序；不收窄现有场次的游戏清单。
function migrateLegacy(legacy, base) {
  if (!legacy || typeof legacy !== "object" || !Array.isArray(legacy.games) || !Array.isArray(legacy.events)) throw badInput("备份格式不正确");
  const target = normalizeState(base);
  const taken = new Set(target.games.map(g => g.id));
  const idMap = new Map(); // 旧 id → 现有 id
  legacy.games.forEach((g, i) => {
    if (!g || typeof g !== "object") return;
    const oldId = String(g.id || "");
    const name = cleanLine(g.name, 32);
    const match = target.games.find(x => x.id === oldId) || target.games.find(x => name && x.name === name);
    if (match) {
      if (oldId) idMap.set(oldId, match.id);
      return;
    }
    try {
      const ng = normalizeGame(g, target.games.length + i, taken);
      target.games.push(ng);
      if (oldId) idMap.set(oldId, ng.id);
    } catch {}
  });
  const gameIds = new Set(target.games.map(g => g.id));
  const mapId = id => idMap.get(String(id)) || (gameIds.has(String(id)) ? String(id) : "");
  const tz = target.settings.tzOffsetMinutes;
  let imported = 0;
  for (const ev of legacy.events) {
    if (!ev || typeof ev !== "object" || !isDateKey(ev.date)) continue;
    const key = ev.date;
    const isNew = !target.sessions[key];
    const sess = target.sessions[key] || normalizeSession(key, { extra: weekdayOf(key) !== target.settings.weekday }, gameIds);
    if (ev.title && !sess.title) sess.title = cleanLine(ev.title, 30);
    if (isNew && (parseHM(ev.time) !== null || ev.location)) {
      if (parseHM(ev.time) !== null) sess.rounds = [{ start: fmtHM(parseHM(ev.time)), end: target.settings.endTime }];
      if (ev.location) sess.location = cleanLine(ev.location, 40);
    }
    const ids = Array.isArray(ev.gameIds) ? [...new Set(ev.gameIds.map(mapId).filter(Boolean))] : [];
    if (ids.length && (isNew || sess.gameIds.length)) sess.gameIds = [...new Set([...sess.gameIds, ...ids])];
    const caps = ev.capacities && typeof ev.capacities === "object" ? ev.capacities : {};
    for (const [id, cap] of Object.entries(caps)) {
      const m = mapId(id);
      if (m && sess.tableSizes[m] === undefined) sess.tableSizes[m] = clampInt(cap, 1, 40, 4);
    }
    const names = new Set(sess.signups.map(s => nameKey(s.name)));
    const usedIds = new Set(sess.signups.map(s => s.id));
    const dayStart = localDayStart(key, tz);
    (Array.isArray(ev.signups) ? ev.signups : []).forEach((p, idx) => {
      if (!p || typeof p !== "object") return;
      const n = normalizeSignup({ name: p.name, prefs: [mapId(p.gameId)], by: "import", createdAt: new Date(dayStart + idx * 1000).toISOString() }, gameIds);
      if (!n || names.has(nameKey(n.name))) return;
      let id = `legacy-${key}-${cleanLine(p.id, 24).replace(/[^\w-]/g, "") || idx}`;
      while (usedIds.has(id)) id += "x";
      n.id = id;
      usedIds.add(id);
      names.add(nameKey(n.name));
      sess.signups.push(n);
      imported++;
    });
    target.sessions[key] = sess;
  }
  return { state: target, imported };
}

// ---------- 场次与轮次时间 ----------
function roundsOf(stored, settings) {
  return stored?.rounds || settings.rounds;
}
// 各轮的绝对时间；时间往回走（如 23:30 → 00:30）视为跨过午夜
function roundTimings(key, stored, settings) {
  const day = localDayStart(key, settings.tzOffsetMinutes);
  let last = -1;
  return roundsOf(stored, settings).map((r, i) => {
    let s = parseHM(r.start);
    while (s < last) s += 24 * 60;
    let e = parseHM(r.end);
    while (e <= s) e += 24 * 60;
    last = e > s ? s : last;
    return { index: i + 1, start: r.start, end: r.end, startAt: day + s * 60000, endAt: day + e * 60000 };
  });
}
function sessionTiming(key, stored, settings) {
  const rounds = roundTimings(key, stored, settings);
  return {
    time: rounds[0].start,
    endTime: rounds[rounds.length - 1].end,
    startAt: rounds[0].startAt,
    endAt: Math.max(...rounds.map(r => r.endAt)),
    rounds,
  };
}

function sessionStatus(stored, timing, now) {
  if (stored?.status === "cancelled") return "cancelled";
  if (now >= timing.endAt) return "ended";
  if (now >= timing.startAt) return "live";
  return "open";
}

// 公开列出的场次：按设置自动生成的未来 N 周 + 管理员加开的场次 + 已有报名的未结束场次
function upcomingKeys(state, now) {
  const settings = state.settings;
  const tz = settings.tzOffsetMinutes;
  const todayKey = dateKeyOf(now + tz * 60000);
  let first = addDays(todayKey, -1); // 从昨天找起：跨过午夜仍在进行的场次也要算
  first = addDays(first, (settings.weekday - weekdayOf(first) + 7) % 7);
  while (sessionTiming(first, state.sessions[first], settings).endAt <= now) first = addDays(first, 7);
  const keys = new Set();
  for (let i = 0; i < settings.bookAheadWeeks; i++) keys.add(addDays(first, i * 7));
  for (const [key, s] of Object.entries(state.sessions)) {
    if (!s.extra && !s.signups.length) continue;
    if (sessionTiming(key, s, settings).endAt > now) keys.add(key);
  }
  return [...keys].sort();
}

// 本场接受新报名的游戏：自定义清单 ∩ 开放中的游戏；没有自定义清单就是全部开放中的游戏
function openGameIds(state, stored) {
  const active = state.games.filter(g => g.active).map(g => g.id);
  if (stored?.gameIds?.length) {
    const set = new Set(active);
    return stored.gameIds.filter(id => set.has(id));
  }
  return active;
}
// 参与分桌的游戏：可报名的 + 已有报名志愿里出现过的（游戏停用后，已报名的人照常参与分桌）
function allocGameIds(state, stored) {
  const ids = openGameIds(state, stored);
  const set = new Set(ids);
  const exists = new Set(state.games.map(g => g.id));
  for (const s of stored?.signups || []) {
    for (const id of s.prefs) {
      if (exists.has(id) && !set.has(id)) {
        set.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}
const offeredGameIds = openGameIds;

// ---------- 自动分桌 ----------
// 每桌人数：人数够开多桌时各桌均衡；否则先坐满、最后一桌可能不足（由上层避免）
function splitTables(n, conf) {
  if (n <= 0) return [];
  const { size, copies, min } = conf;
  const k = Math.min(copies, Math.ceil(n / size));
  const base = Math.floor(n / k);
  const extra = n % k;
  if (k > 1 && base >= min) return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
  const sizes = [];
  let rest = n;
  for (let i = 0; i < k; i++) {
    const t = Math.min(size, rest);
    sizes.push(t);
    rest -= t;
  }
  return sizes;
}
const shortfall = (n, conf) => splitTables(n, conf).reduce((sum, t) => sum + Math.max(0, conf.min - t), 0);
// 不超过 n、且分桌后每桌都能凑齐的最大人数
function fullTablesCap(n, conf) {
  for (let m = n; m > 0; m--) if (shortfall(m, conf) === 0) return m;
  return 0;
}

function gameConf(stored, games, ids) {
  const byId = Object.fromEntries(games.map(g => [g.id, g]));
  const conf = {};
  for (const id of ids) {
    const g = byId[id];
    if (!g) continue;
    // 每桌人数不能低于游戏最少人数，否则“成桌”就没有意义
    const size = Math.max(g.min, clampInt(stored?.tableSizes?.[id] ?? g.tableSize ?? g.max, 1, 40, g.max));
    const copies = clampInt(stored?.copies?.[id] ?? g.copies ?? 1, 1, 20, 1);
    conf[id] = { size, copies, capacity: size * copies, min: g.min };
  }
  return conf;
}

const attends = (s, round) => !s.rounds.length || s.rounds.includes(round);
const byPrefsAt = (a, b) => a.prefsAt.localeCompare(b.prefsAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

// 单轮分桌（志愿排序 + 逐个淘汰凑不齐的游戏）：
// 1) 每人按报名（或最近一次修改志愿）先后，依次落到自己排序最靠前、仍在候选、且没满的游戏；
// 2) 若有游戏分到的人数凑不够最少人数，淘汰其中人数最少的一款，选它的人顺延到各自下一个志愿，重来；
// 3) 若某游戏人数够但分桌后会剩一张缺人的桌，就收紧它的名额，让多出来的人顺延；
// 4) 直到没有可淘汰或可收紧的为止。最后仍没地方去的人列为“暂未分到”。
// prior：这一晚前几轮已经分到的游戏（同一人不重复玩同一款）
function allocateRound(players, conf, open, prior) {
  const ids = Object.keys(conf);
  const order = [...players].sort(byPrefsAt);
  const cand = new Map(order.map(p => [p.id, p.prefs.filter(g => conf[g] && !(prior.get(p.id) || new Set()).has(g))]));
  const anyInterest = Object.fromEntries(ids.map(id => [id, order.filter(p => cand.get(p.id).includes(id)).length]));
  const alive = new Set(ids);
  const caps = Object.fromEntries(ids.map(id => [id, conf[id].capacity]));
  let assign = new Map();
  for (let iter = 0; iter < 300; iter++) {
    const counts = Object.fromEntries(ids.map(id => [id, 0]));
    assign = new Map();
    for (const p of order) {
      for (const g of cand.get(p.id)) {
        if (alive.has(g) && counts[g] < caps[g]) {
          counts[g]++;
          assign.set(p.id, g);
          break;
        }
      }
    }
    // 先收紧：已经够人的游戏若会剩一张缺人的桌，把多出来的人放出去，让他们有机会帮别的游戏凑齐
    let trimmed = false;
    for (const g of ids) {
      if (!alive.has(g) || counts[g] < conf[g].min || shortfall(counts[g], conf[g]) === 0) continue;
      caps[g] = fullTablesCap(counts[g], conf[g]);
      trimmed = true;
    }
    if (trimmed) continue;
    // 再淘汰：优先淘汰“把所有可能顺延过来的人都算上也凑不齐”的游戏
    const weak = ids.filter(g => alive.has(g) && counts[g] > 0 && counts[g] < conf[g].min);
    if (!weak.length) break;
    const formed = g => alive.has(g) && counts[g] >= conf[g].min;
    const potential = g => counts[g] + order.filter(p2 => assign.get(p2.id) !== g && !formed(assign.get(p2.id)) && cand.get(p2.id).includes(g)).length;
    const pot = Object.fromEntries(weak.map(g => [g, potential(g)]));
    const hopeless = weak.filter(g => pot[g] < conf[g].min);
    const pool = hopeless.length ? hopeless : weak;
    pool.sort((a, b) => (hopeless.length ? pot[a] - pot[b] : 0) || counts[a] - counts[b] || pot[a] - pot[b] || anyInterest[a] - anyInterest[b] || a.localeCompare(b));
    alive.delete(pool[0]);
  }
  // 按游戏分组，再分成各桌（熟练 / 愿意教学的人优先分散到不同桌）
  const tables = {};
  for (const g of ids) {
    const entries = order.filter(p => assign.get(p.id) === g);
    tables[g] = distribute(entries, conf[g]);
  }
  const unassigned = order.filter(p => !assign.has(p.id));
  return { tables, unassigned };
}

function distribute(entries, conf) {
  const sizes = splitTables(entries.length, conf);
  const tables = sizes.map(target => ({ target, players: [] }));
  const isGuide = p => p.teach || p.level === 2;
  const guides = entries.filter(isGuide);
  const others = entries.filter(p => !isGuide(p));
  guides.forEach((p, i) => {
    const t = tables.find((_, j) => j >= i % tables.length && tables[j].players.length < tables[j].target) || tables.find(x => x.players.length < x.target);
    t.players.push(p);
  });
  for (const p of others) tables.find(t => t.players.length < t.target).players.push(p);
  return tables.map(t => t.players);
}

// 把分好的桌子整理成公开数据
function roundResult(meta, conf, open, tablesByGame, unassigned) {
  const pub = (s, gameId) => ({ id: s.id, name: s.name, level: s.level, teach: s.teach, rank: gameId ? s.prefs.indexOf(gameId) + 1 : 0 });
  const games = {};
  let seated = 0;
  let tablesReady = 0;
  for (const [g, c] of Object.entries(conf)) {
    const list = tablesByGame[g] || [];
    const count = list.reduce((n, t) => n + t.length, 0);
    seated += count;
    const tables = list.map((t, i) => ({ no: i + 1, players: t.map(s => pub(s, g)), short: Math.max(0, c.min - t.length) }));
    tablesReady += tables.filter(t => t.short === 0 && t.players.length).length;
    games[g] = {
      size: c.size,
      copies: c.copies,
      capacity: c.capacity,
      min: c.min,
      open: open.has(g),
      count,
      seatsLeft: Math.max(0, c.capacity - count),
      status: count === 0 ? "empty" : c.capacity - count <= 0 ? "full" : tables.some(t => t.short) ? "forming" : "ok",
      tables,
    };
  }
  return {
    ...meta,
    games,
    unassigned: unassigned.map(s => pub(s, "")),
    totals: { players: seated + unassigned.length, seated, tablesReady, unassigned: unassigned.length },
  };
}

// 整场分桌：逐轮进行，每轮排除这个人前几轮已经分到的游戏
function allocateSession(stored, games, allIds, openIds, timings) {
  const conf = gameConf(stored, games, allIds);
  const open = new Set(openIds);
  const signups = stored?.signups || [];
  const prior = new Map();
  const rounds = timings.map(t => {
    const players = signups.filter(s => attends(s, t.index));
    const { tables, unassigned } = allocateRound(players, conf, open, prior);
    for (const [g, list] of Object.entries(tables)) for (const t2 of list) for (const p of t2) prior.set(p.id, new Set([...(prior.get(p.id) || []), g]));
    return roundResult(t, conf, open, tables, unassigned);
  });
  return finishAlloc(rounds, signups, Object.keys(conf));
}

// 活动开始后锁定的分桌：按锁定时的桌子还原，删掉已取消的人；之后新加的人只往有空位的桌子里插，不打乱已开局的桌
function applyFrozen(stored, games, allIds, openIds, timings) {
  const conf = gameConf(stored, games, allIds);
  const open = new Set(openIds);
  const signups = stored.signups;
  const byId = new Map(signups.map(s => [s.id, s]));
  const prior = new Map();
  const rounds = timings.map((t, i) => {
    const fr = stored.frozen.rounds[i];
    const attendees = signups.filter(s => attends(s, t.index));
    const here = new Set(attendees.map(s => s.id));
    const tables = {};
    const placed = new Set();
    if (fr) {
      for (const [g, list] of Object.entries(fr.tables)) {
        if (!conf[g]) continue;
        tables[g] = list.map(ids => ids.filter(id => here.has(id) && !placed.has(id) && (placed.add(id), true)).map(id => byId.get(id))).filter(x => x.length);
      }
    }
    const unassigned = fr ? fr.unassigned.filter(id => here.has(id) && !placed.has(id)).map(id => byId.get(id)) : [];
    unassigned.forEach(s => placed.add(s.id));
    let newcomers = attendees.filter(s => !placed.has(s.id)).sort(byPrefsAt);
    if (!fr) {
      // 锁定后才新增的轮次：照常为这一轮分桌
      const r = allocateRound(newcomers, conf, open, prior);
      Object.assign(tables, r.tables);
      unassigned.push(...r.unassigned);
      newcomers = [];
    }
    for (const s of newcomers) {
      const done = prior.get(s.id) || new Set();
      let ok = false;
      for (const g of s.prefs) {
        if (!conf[g] || done.has(g)) continue;
        const t = (tables[g] || []).find(x => x.length < conf[g].size);
        if (t) {
          t.push(s);
          ok = true;
          break;
        }
      }
      if (!ok) unassigned.push(s);
    }
    for (const [g, list] of Object.entries(tables)) for (const tb of list) for (const p of tb) prior.set(p.id, new Set([...(prior.get(p.id) || []), g]));
    return roundResult(t, conf, open, tables, unassigned);
  });
  return finishAlloc(rounds, signups, Object.keys(conf));
}

function finishAlloc(rounds, signups, ids) {
  const interest = Object.fromEntries(ids.map(id => [id, { first: 0, any: 0 }]));
  for (const s of signups) {
    s.prefs.forEach((g, i) => {
      if (!interest[g]) return;
      interest[g].any++;
      if (i === 0) interest[g].first++;
    });
  }
  return {
    rounds,
    interest,
    totals: {
      signups: signups.length,
      tablesReady: rounds.reduce((n, r) => n + r.totals.tablesReady, 0),
      unassigned: rounds.reduce((n, r) => n + r.totals.unassigned, 0),
    },
  };
}

// 锁定当前分桌（活动开始时由服务端调用）
function freezeAllocation(alloc, at) {
  return {
    at,
    rounds: alloc.rounds.map(r => ({
      tables: Object.fromEntries(Object.entries(r.games).filter(([, g]) => g.tables.length).map(([gid, g]) => [gid, g.tables.map(t => t.players.map(p => p.id))])),
      unassigned: r.unassigned.map(p => p.id),
    })),
  };
}

// 生成一个场次的完整视图（公开 / 管理员）
function sessionView(state, key, now, { admin = false } = {}) {
  const stored = state.sessions[key];
  const timing = sessionTiming(key, stored, state.settings);
  const status = sessionStatus(stored, timing, now);
  const offered = openGameIds(state, stored);
  const allIds = allocGameIds(state, stored);
  const useFrozen = Boolean(stored?.frozen) && status !== "open";
  const alloc = useFrozen ? applyFrozen(stored, state.games, allIds, offered, timing.rounds) : allocateSession(stored, state.games, allIds, offered, timing.rounds);
  const view = {
    id: key,
    date: key,
    weekday: weekdayOf(key),
    title: stored?.title || "",
    time: timing.time,
    endTime: timing.endTime,
    startAt: timing.startAt,
    endAt: timing.endAt,
    rounds: timing.rounds.map(r => ({ ...r, status: status === "cancelled" ? "cancelled" : now >= r.endAt ? "ended" : now >= r.startAt ? "live" : "open" })),
    customRounds: Boolean(stored?.rounds),
    location: stored?.location || state.settings.location,
    status,
    note: stored?.note || "",
    extra: Boolean(stored?.extra),
    gameIds: offered,
    allGameIds: allIds,
    customGames: Boolean(stored?.gameIds?.length),
    tableSizes: stored?.tableSizes || {},
    copies: stored?.copies || {},
    frozen: useFrozen,
    needsFreeze: Boolean(stored?.signups?.length) && !stored?.frozen && (status === "live" || status === "ended"),
    alloc,
  };
  if (admin) {
    view.signups = (stored?.signups || []).map(({ tokenHash, extraTokenHashes, pinHash, ...rest }) => ({ ...rest, hasPin: Boolean(pinHash) }));
  }
  return view;
}

function publicGame(g) {
  const { active, ...rest } = g;
  return { ...rest, active };
}

module.exports = {
  DAY,
  LEVELS,
  GROUPS,
  ICON_KEYS,
  MAX_ROUNDS,
  MAX_PREFS,
  DEFAULT_ROUNDS,
  DEFAULT_SETTINGS,
  BVID_RE,
  clampInt,
  cleanText,
  cleanLine,
  nameKey,
  parseHM,
  isDateKey,
  dateKeyOf,
  addDays,
  weekdayOf,
  normalizeRounds,
  normalizeSettings,
  normalizeGame,
  normalizeVideo,
  normalizeSignup,
  normalizeSession,
  normalizeState,
  normalizeAdmins,
  normalizeAudit,
  MAX_ADMINS,
  MAX_AUDIT,
  migrateLegacy,
  roundTimings,
  sessionTiming,
  sessionStatus,
  upcomingKeys,
  offeredGameIds,
  openGameIds,
  allocGameIds,
  splitTables,
  shortfall,
  gameConf,
  allocateRound,
  allocateSession,
  applyFrozen,
  freezeAllocation,
  sessionView,
  publicGame,
};
