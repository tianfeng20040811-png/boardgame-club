"use strict";
// 纯逻辑：时间与场次计算、数据规范化、自动分桌。不依赖存储与 HTTP，便于测试。

const DAY = 86400000;
const LEVELS = ["没玩过", "玩过几次", "熟练能教"];
const PALETTE_COUNT = 8;
const GROUPS = ["身份类", "桌游", "特色"];
const ICON_KEYS = ["house", "gem", "flag", "shuriken", "bubble", "moon", "shield", "dice", "crown", "sub", "mask", "mug", "dice2", "letter", "tile", "spade"];

const DEFAULT_SETTINGS = Object.freeze({
  clubName: "开桌 · 桌游社",
  weekday: 5, // 0=周日 … 5=周五
  time: "18:30",
  endTime: "22:00",
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
// 控制字符 + 零宽/双向控制字符（防止“看起来同名”的冒名报名）
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
const fmtHM = minutes => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
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

// ---------- 设置与桌游规范化 ----------
function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  return {
    clubName: cleanLine(s.clubName, 30) || DEFAULT_SETTINGS.clubName,
    weekday: clampInt(s.weekday, 0, 6, DEFAULT_SETTINGS.weekday),
    time: parseHM(s.time) === null ? DEFAULT_SETTINGS.time : fmtHM(parseHM(s.time)),
    endTime: parseHM(s.endTime) === null ? DEFAULT_SETTINGS.endTime : fmtHM(parseHM(s.endTime)),
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
function normalizeSignup(raw, offered) {
  const name = cleanLine(raw?.name, 20);
  const gameId = String(raw?.gameId || "");
  if (!name) return null;
  if (offered && !offered.has(gameId)) return null;
  let altGameId = raw?.altGameId ? String(raw.altGameId) : "";
  if (altGameId === gameId || (offered && altGameId && !offered.has(altGameId))) altGameId = "";
  const level = raw?.level === null || raw?.level === undefined || raw?.level === "" ? null : clampInt(raw.level, 0, 2, null);
  const createdAt = isIso(raw?.createdAt) ? raw.createdAt : new Date(0).toISOString();
  return {
    id: cleanLine(raw?.id, 40) || null,
    name,
    gameId,
    altGameId,
    level,
    teach: Boolean(raw?.teach) && level !== 0,
    note: cleanText(raw?.note, 120),
    createdAt,
    updatedAt: isIso(raw?.updatedAt) ? raw.updatedAt : createdAt,
    altAt: isIso(raw?.altAt) ? raw.altAt : createdAt,
    tokenHash: /^[a-f0-9]{64}$/.test(String(raw?.tokenHash || "")) ? raw.tokenHash : "",
    checkedIn: Boolean(raw?.checkedIn),
    by: raw?.by === "admin" ? "admin" : raw?.by === "import" ? "import" : "self",
  };
}
function isIso(v) {
  return typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

function normalizeSession(key, raw, gameIds) {
  const s = raw || {};
  const out = {
    date: key,
    title: cleanLine(s.title, 30),
    time: parseHM(s.time) === null ? "" : fmtHM(parseHM(s.time)),
    endTime: parseHM(s.endTime) === null ? "" : fmtHM(parseHM(s.endTime)),
    location: cleanLine(s.location, 40),
    status: s.status === "cancelled" ? "cancelled" : "",
    note: cleanText(s.note, 200),
    extra: Boolean(s.extra),
    gameIds: Array.isArray(s.gameIds) ? [...new Set(s.gameIds.map(String).filter(id => gameIds.has(id)))] : [],
    tableSizes: {},
    copies: {},
    signups: [],
  };
  for (const [id, v] of Object.entries(s.tableSizes || {})) if (gameIds.has(id)) out.tableSizes[id] = clampInt(v, 1, 40, 4);
  for (const [id, v] of Object.entries(s.copies || {})) if (gameIds.has(id)) out.copies[id] = clampInt(v, 1, 20, 1);
  const seenIds = new Set();
  for (const r of Array.isArray(s.signups) ? s.signups.slice(0, 500) : []) {
    const n = normalizeSignup(r, null);
    if (!n || !gameIds.has(n.gameId)) continue;
    if (n.altGameId && !gameIds.has(n.altGameId)) n.altGameId = "";
    if (!n.id || seenIds.has(n.id)) n.id = `s-${key}-${seenIds.size + 1}-${Math.abs(hashCode(n.name + n.createdAt)).toString(36)}`;
    seenIds.add(n.id);
    out.signups.push(n);
  }
  return out;
}
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
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
  return { version: 4, settings: normalizeSettings(src.settings), games, sessions, seededIds, seedVersion };
}

// 旧版（v3：{games, events:[{id,title,date,time,location,gameIds,capacities,signups:[{id,name,gameId}]}]}）→ v4
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
    if (isNew && parseHM(ev.time) !== null) sess.time = fmtHM(parseHM(ev.time));
    if (isNew && ev.location) sess.location = cleanLine(ev.location, 40);
    const ids = Array.isArray(ev.gameIds) ? [...new Set(ev.gameIds.map(mapId).filter(Boolean))] : [];
    // 已有场次如果是“全部游戏开放”（空清单），保持不变，避免把它收窄成旧活动的几款
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
      const n = normalizeSignup({ name: p.name, gameId: mapId(p.gameId), by: "import", createdAt: new Date(dayStart + idx * 1000).toISOString() }, gameIds);
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

// ---------- 场次 ----------
function sessionTiming(key, stored, settings) {
  const tz = settings.tzOffsetMinutes;
  const time = stored?.time || settings.time;
  const endTime = stored?.endTime || settings.endTime;
  const startMin = parseHM(time);
  let endMin = parseHM(endTime);
  if (endMin <= startMin) endMin += 24 * 60;
  const dayStart = localDayStart(key, tz);
  return { time, endTime, startAt: dayStart + startMin * 60000, endAt: dayStart + endMin * 60000 };
}

function sessionStatus(stored, timing, now) {
  if (stored?.status === "cancelled") return "cancelled";
  if (now >= timing.endAt) return "ended";
  if (now >= timing.startAt) return "live";
  return "open";
}

// 公开列出的场次：按设置自动生成的未来 N 周 + 管理员加开的场次 + 已有报名的未结束场次
// （改了活动日或预约周数后，已有人报名的场次不会凭空消失）
function upcomingKeys(state, now) {
  const settings = state.settings;
  const tz = settings.tzOffsetMinutes;
  const todayKey = dateKeyOf(now + tz * 60000);
  // 从昨天找起：跨过午夜仍在进行的场次也要算
  let first = addDays(todayKey, -1);
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
// 参与分桌的游戏：可报名的 + 已有报名用到的（游戏停用或移出清单后，已报名的人照常保留座位）
function allocGameIds(state, stored) {
  const ids = openGameIds(state, stored);
  const set = new Set(ids);
  const exists = new Set(state.games.map(g => g.id));
  for (const s of stored?.signups || []) {
    for (const id of [s.gameId, s.altGameId]) {
      if (id && exists.has(id) && !set.has(id)) {
        set.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}
const offeredGameIds = openGameIds;

// ---------- 自动分桌 ----------
// 1) 第一志愿优先：所有人按报名先后坐进第一志愿，坐满为止。
// 2) 坐不下的人按“设定第二志愿的时间”排队转第二志愿（只转到仍开放报名的游戏），再不行就进第一志愿候补。
// 3) 截止后（final）只做能减少“缺人桌”总缺口的调整：把凑不齐的玩家转到第二志愿，绝不让局面更糟。
// 4) 每款游戏桌数 ≤ 拥有套数；人数够时各桌均衡，否则先坐满、最后一桌标注“还差几人”。
// 5) 熟练 / 愿意教学的玩家优先分散到不同桌带新人。
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

function allocate(stored, games, ids, final, openIds) {
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
  const cids = Object.keys(conf);
  const open = new Set(openIds || cids);
  const seated = Object.fromEntries(cids.map(id => [id, []]));
  const waitlist = Object.fromEntries(cids.map(id => [id, []]));
  const orphans = [];
  const hasRoom = id => Boolean(conf[id]) && seated[id].length < conf[id].capacity;
  const byCreated = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const list = [...(stored?.signups || [])].sort(byCreated);
  const overflow = [];
  for (const s of list) {
    if (hasRoom(s.gameId)) seated[s.gameId].push({ s, via: "first" });
    else overflow.push(s);
  }
  overflow.sort((a, b) => (a.altAt || a.createdAt).localeCompare(b.altAt || b.createdAt) || a.id.localeCompare(b.id));
  for (const s of overflow) {
    const alt = s.altGameId;
    if (alt && alt !== s.gameId && open.has(alt) && hasRoom(alt)) seated[alt].push({ s, via: "alt" });
    else if (conf[s.gameId]) waitlist[s.gameId].push(s);
    else orphans.push(s);
  }
  for (const id of cids) waitlist[id].sort(byCreated);
  if (final) {
    for (let round = 0; round < 200; round++) {
      let best = null;
      for (const src of cids) {
        const n = seated[src].length;
        if (!n || shortfall(n, conf[src]) === 0) continue;
        for (const e of seated[src]) {
          const dst = e.via === "first" ? e.s.altGameId : "";
          if (!dst || dst === src || !open.has(dst) || !hasRoom(dst)) continue;
          const m = seated[dst].length;
          const delta = shortfall(n - 1, conf[src]) + shortfall(m + 1, conf[dst]) - shortfall(n, conf[src]) - shortfall(m, conf[dst]);
          if (delta < 0 && (!best || delta < best.delta)) best = { src, dst, e, delta };
        }
      }
      if (!best) break;
      seated[best.src] = seated[best.src].filter(x => x !== best.e);
      seated[best.dst].push({ s: best.e.s, via: "alt" });
    }
  }
  const pub = (e, via) => ({ id: e.id, name: e.name, level: e.level, teach: e.teach, via });
  const result = {};
  let seatedTotal = 0;
  let tablesReady = 0;
  let waitTotal = 0;
  for (const id of cids) {
    const { size, copies, capacity, min } = conf[id];
    const entries = seated[id];
    const n = entries.length;
    seatedTotal += n;
    waitTotal += waitlist[id].length;
    const tables = splitTables(n, conf[id]).map((target, i) => ({ no: i + 1, target, players: [] }));
    const isGuide = e => e.s.teach || e.s.level === 2;
    const guides = entries.filter(isGuide);
    const others = entries.filter(e => !isGuide(e));
    guides.forEach((e, i) => {
      const t = tables.find((_, j) => j >= i % tables.length && tables[j].players.length < tables[j].target) || tables.find(x => x.players.length < x.target);
      t.players.push(pub(e.s, e.via));
    });
    for (const e of others) tables.find(t => t.players.length < t.target).players.push(pub(e.s, e.via));
    const outTables = tables.map(t => ({ no: t.no, players: t.players, short: Math.max(0, min - t.players.length) }));
    tablesReady += outTables.filter(t => t.short === 0).length;
    const forming = outTables.some(t => t.short > 0);
    result[id] = {
      size,
      copies,
      capacity,
      min,
      open: open.has(id),
      count: n,
      seatsLeft: Math.max(0, capacity - n),
      need: forming ? outTables.find(t => t.short > 0).short : 0,
      status: n === 0 ? "empty" : capacity - n <= 0 ? "full" : forming ? "forming" : "ok",
      tables: outTables,
      waitlist: waitlist[id].map(s => pub(s, "wait")),
    };
  }
  return {
    games: result,
    orphans: orphans.map(s => pub(s, "orphan")),
    totals: { signups: list.length, seated: seatedTotal, tablesReady, waitlist: waitTotal + orphans.length },
  };
}

// 生成一个场次的完整视图（公开 / 管理员）
function sessionView(state, key, now, { admin = false } = {}) {
  const stored = state.sessions[key];
  const timing = sessionTiming(key, stored, state.settings);
  const status = sessionStatus(stored, timing, now);
  const offered = openGameIds(state, stored);
  const allIds = allocGameIds(state, stored);
  const alloc = allocate(stored, state.games, allIds, status !== "open", offered);
  const view = {
    id: key,
    date: key,
    weekday: weekdayOf(key),
    title: stored?.title || "",
    time: timing.time,
    endTime: timing.endTime,
    startAt: timing.startAt,
    endAt: timing.endAt,
    location: stored?.location || state.settings.location,
    status,
    note: stored?.note || "",
    extra: Boolean(stored?.extra),
    gameIds: offered,
    allGameIds: allIds,
    customGames: Boolean(stored?.gameIds?.length),
    tableSizes: stored?.tableSizes || {},
    copies: stored?.copies || {},
    alloc,
  };
  if (admin) {
    view.signups = (stored?.signups || []).map(({ tokenHash, ...rest }) => rest);
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
  normalizeSettings,
  normalizeGame,
  normalizeVideo,
  normalizeSignup,
  normalizeSession,
  normalizeState,
  migrateLegacy,
  sessionTiming,
  sessionStatus,
  upcomingKeys,
  offeredGameIds,
  openGameIds,
  allocGameIds,
  splitTables,
  shortfall,
  allocate,
  sessionView,
  publicGame,
};
