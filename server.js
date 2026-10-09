"use strict";
// 开桌 · 桌游社 —— 零框架 Node 服务：静态页面 + JSON API。
// 环境变量：PORT、ADMIN_KEY（管理员密钥）、DATABASE_URL（可选，Postgres）、DATA_DIR（可选，文件存储目录）

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const L = require("./lib/logic");
const { createStore } = require("./lib/store");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = String(process.env.ADMIN_KEY || process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || "").trim();
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data", "runtime");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const MAX_SIGNUPS_PER_SESSION = 300;

let store;
let state;
let revision = 0;
let updatedAt = new Date().toISOString();
let storeError = "";

// ---------- 工具 ----------
const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const nowMs = () => Date.now();
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const clone = value => JSON.parse(JSON.stringify(value));
const REPLACE = Symbol("replace");

function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
// 客户端 IP：优先用 CDN 写入、客户端无法伪造的头；否则取 X-Forwarded-For 最右侧（离我们最近的代理写入的那一个）
function clientIp(req) {
  const direct = String(req.headers["cf-connecting-ip"] || req.headers["true-client-ip"] || "").trim();
  if (direct && direct.length <= 64) return direct;
  const xff = String(req.headers["x-forwarded-for"] || "");
  if (xff && xff.length <= 512) {
    const parts = xff.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return req.socket.remoteAddress || "unknown";
}

// 内存限流：键做哈希、总量封顶、按窗口及时清理，防止被大量伪造请求撑爆内存
const buckets = new Map();
const MAX_BUCKETS = 20000;
const bucketKey = (req, name) => `${name}:${sha256(clientIp(req)).slice(0, 16)}`;
function recent(key, windowMs) {
  const now = nowMs();
  const entry = buckets.get(key);
  if (!entry) return [];
  entry.ts = entry.ts.filter(t => now - t < windowMs);
  return entry.ts;
}
function isLimited(key, limit, windowMs) {
  return recent(key, windowMs).length >= limit;
}
function hit(key, windowMs) {
  const list = recent(key, windowMs);
  list.push(nowMs());
  buckets.delete(key);
  buckets.set(key, { ts: list, windowMs });
  while (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
}
function rateLimit(req, name, limit, windowMs) {
  const key = bucketKey(req, name);
  if (isLimited(key, limit, windowMs)) fail(429, "操作太频繁了，请稍后再试");
  hit(key, windowMs);
}
setInterval(() => {
  const now = nowMs();
  for (const [key, entry] of buckets) if (!entry.ts.some(t => now - t < entry.windowMs)) buckets.delete(key);
}, 60000).unref();

// 管理员认证：每个请求只判定一次；只统计“密钥错误”的次数（按 IP 和全局），超限后连正确密钥也先拒绝一段时间
const ADMIN_FAIL_WINDOW = 600000;
// 两种身份：所有者（环境变量 ADMIN_KEY）和协作管理员（所有者在后台添加，各自一把密钥，数据库里只存哈希）
const OWNER = Object.freeze({ role: "owner", id: "owner", name: "所有者" });
function checkAdmin(req) {
  if (req._admin !== undefined) return req._admin;
  const key = String(req.headers["x-admin-key"] || "");
  if (!ADMIN_KEY || !key) return (req._admin = null);
  let who = null;
  if (safeEqual(key, ADMIN_KEY)) return (req._admin = OWNER);
  // 数据存储不可用时无法核对协作管理员，返回 503 而不是“密钥错误”
  if (storeError || !store) fail(503, "数据存储暂时不可用，请稍后再试");
  const ipKey = bucketKey(req, "adminfail");
  if (key.length <= 128) {
    const h = Buffer.from(sha256(key), "hex");
    for (const a of state.admins || []) {
      if (crypto.timingSafeEqual(h, Buffer.from(a.keyHash, "hex"))) {
        who = { role: "admin", id: a.id, name: a.name };
        break;
      }
    }
  }
  if (!who) {
    if (isLimited(ipKey, 10, ADMIN_FAIL_WINDOW)) fail(429, "密钥错误次数过多，请 10 分钟后再试");
    const seen = `${ipKey}:${sha256(key).slice(0, 16)}`;
    if (!isLimited(seen, 1, ADMIN_FAIL_WINDOW)) {
      hit(seen, ADMIN_FAIL_WINDOW);
      hit(ipKey, ADMIN_FAIL_WINDOW);
    }
  }
  return (req._admin = who);
}
const isAdminRequest = req => Boolean(checkAdmin(req));
function requireAdmin(req, { owner = false } = {}) {
  if (!ADMIN_KEY) fail(403, "服务器未设置管理员密钥（环境变量 ADMIN_KEY），管理功能已关闭");
  const who = checkAdmin(req);
  if (!who) fail(401, "管理员密钥不正确，或已被撤销");
  if (owner && who.role !== "owner") fail(403, "只有所有者可以进行这个操作");
  return who;
}
// 操作记录：随同一次写入一起保存（要么都成功，要么都不写）
function auditEntry(who, action, detail, at) {
  return { at, actor: who.role === "owner" ? "所有者" : who.name, action, detail: String(detail || "").slice(0, 160) };
}

// ---------- 状态读写（串行化；数据库里版本号对不上时说明有别的实例写过，重新加载后再试一次） ----------
let chain = Promise.resolve();
// audit：{ who, action, detail } 或 (结果, draft) => 同样的对象；who 为空（普通访客）时不记录
function mutate(fn, audit) {
  const run = chain.then(async () => {
    if (storeError || !store) fail(503, "数据存储暂时不可用，请稍后再试");
    for (let attempt = 0; attempt < 6; attempt++) {
      const draft = clone(state);
      const out = await fn(draft);
      const target = out && out[REPLACE] ? out[REPLACE] : draft;
      const stamp = new Date().toISOString();
      const log = typeof audit === "function" ? audit(out && out[REPLACE] ? out.result : out, draft) : audit;
      if (log && log.who && log.who.role === "admin") {
        if (!(draft.admins || []).some(a => a.id === log.who.id)) fail(401, "管理员密钥不正确，或已被撤销");
        const rk = `adminwrite:${log.who.id}`;
        if (isLimited(rk, 300, 600000)) fail(429, "操作太频繁了，请稍后再试");
        hit(rk, 600000);
      }
      const strip = x => JSON.stringify({ ...x, auditLog: undefined });
      if (strip(L.normalizeState(target)) === strip(state)) return out && out[REPLACE] ? out.result : out;
      if (log && log.who) target.auditLog = [...(target.auditLog || []), auditEntry(log.who, log.action, log.detail, stamp)];
      const next = L.normalizeState(target);
      const nextRevision = revision + 1;
      try {
        await store.save(next, nextRevision, stamp, revision);
      } catch (error) {
        if (error.code === "REVISION_CONFLICT") {
          await new Promise(r => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
          const fresh = await store.load();
          if (fresh) {
            state = L.normalizeState(fresh.state);
            revision = fresh.revision;
            updatedAt = fresh.updatedAt || updatedAt;
          }
          continue;
        }
        throw error;
      }
      state = next;
      revision = nextRevision;
      updatedAt = stamp;
      return out && out[REPLACE] ? out.result : out;
    }
    fail(409, "数据刚被更新，请刷新后重试");
  });
  chain = run.catch(() => {});
  return run;
}

function loadSeed() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "seed.json"), "utf8"));
  } catch {
    return { games: [] };
  }
}

// 种子合并：只在种子文件的 seedVersion 升级时执行一次。
// 新游戏只自动添加一次（管理员删掉后不会再冒出来）；已有游戏只补空缺字段，不覆盖管理员的修改。
function mergeSeed(target, seed) {
  const version = Number(seed.seedVersion) || 0;
  if (version <= (target.seedVersion || 0)) return false;
  target.seedVersion = version;
  let changed = true;
  const seeded = new Set(target.seededIds || []);
  const taken = new Set(target.games.map(g => g.id));
  for (const [i, sg] of (seed.games || []).entries()) {
    const g = target.games.find(x => x.id === sg.id);
    if (!g) {
      if (!seeded.has(sg.id)) {
        try {
          target.games.push(L.normalizeGame(sg, target.games.length + i, taken));
          changed = true;
        } catch {}
      }
    } else {
      for (const field of ["video", "videoBackup"]) {
        if (!g[field] && sg[field]) {
          g[field] = L.normalizeVideo(sg[field]);
          changed = true;
        }
      }
      for (const field of ["en", "icon"]) {
        if (!g[field] && sg[field]) {
          g[field] = sg[field];
          changed = true;
        }
      }
    }
    if (!seeded.has(sg.id)) {
      seeded.add(sg.id);
      changed = true;
    }
  }
  target.seededIds = [...seeded];
  return changed;
}

async function connectStore(seed) {
  const s = await createStore({ databaseUrl: DATABASE_URL, dataDir: DATA_DIR });
  const loaded = await s.load();
  if (loaded) {
    let next = L.normalizeState(loaded.state);
    let rev = loaded.revision;
    let stamp = loaded.updatedAt || new Date().toISOString();
    if (mergeSeed(next, seed)) {
      next = L.normalizeState(next);
      const stamp2 = new Date().toISOString();
      await s.save(next, rev + 1, stamp2, rev);
      rev += 1;
      stamp = stamp2;
    }
    return { s, next, rev, stamp };
  }
  const next = L.normalizeState({ games: seed.games, sessions: {}, seededIds: (seed.games || []).map(g => g.id), seedVersion: seed.seedVersion });
  const stamp = new Date().toISOString();
  await s.save(next, 1, stamp, 0);
  return { s, next, rev: 1, stamp };
}

async function boot() {
  const seed = loadSeed();
  // 存储不可用前先放一份只读的游戏库，页面能浏览，但报名接口返回 503
  state = L.normalizeState({ games: seed.games, sessions: {} });
  const attempt = async () => {
    try {
      const { s, next, rev, stamp } = await connectStore(seed);
      store = s;
      state = next;
      revision = rev;
      updatedAt = stamp;
      storeError = "";
      console.log(`[store] ${store.kind} 已就绪，数据版本 v${revision}`);
      return true;
    } catch (error) {
      store = null;
      storeError = error.message || error.code || String(error) || "数据存储不可用";
      console.error("[store] 初始化失败，30 秒后重试：", error);
      return false;
    }
  };
  if (!(await attempt())) {
    const timer = setInterval(async () => {
      if (await attempt()) clearInterval(timer);
    }, 30000);
  }
  if (!ADMIN_KEY) console.warn("[admin] 未设置 ADMIN_KEY，管理后台不可用");
  else if (ADMIN_KEY.length < 12) console.warn("[admin] ADMIN_KEY 太短，建议至少 12 位随机字符");
}

// ---------- 快照 ----------
function publicSettings(s) {
  return { clubName: s.clubName, weekday: s.weekday, rounds: s.rounds, time: s.time, endTime: s.endTime, location: s.location, bookAheadWeeks: s.bookAheadWeeks, tzOffsetMinutes: s.tzOffsetMinutes, announcement: s.announcement };
}
const freezing = new Set();
function scheduleFreeze(views) {
  for (const v of views) {
    if (!v.needsFreeze || freezing.has(v.id) || storeError || !store) continue;
    freezing.add(v.id);
    mutate(draft => {
      const stored = draft.sessions[v.id];
      if (!stored || stored.frozen || !stored.signups.length) return;
      const view = L.sessionView(draft, v.id, nowMs());
      if (view.status === "open") return;
      stored.frozen = L.freezeAllocation(view.alloc, new Date().toISOString());
    })
      .catch(err => console.error("[freeze]", err.message))
      .finally(() => freezing.delete(v.id));
  }
}
function publicSnapshot() {
  const now = nowMs();
  const sessions = L.upcomingKeys(state, now).map(key => L.sessionView(state, key, now));
  scheduleFreeze(sessions);
  return {
    revision,
    updatedAt,
    serverNow: now,
    settings: publicSettings(state.settings),
    games: state.games.map(L.publicGame),
    teachers: L.publicTeachers(state.teachers),
    sessions,
    adminEnabled: Boolean(ADMIN_KEY),
    readOnly: Boolean(storeError),
  };
}
function adminSnapshot(who) {
  const now = nowMs();
  const keys = new Set([...Object.keys(state.sessions), ...L.upcomingKeys(state, now)]);
  return {
    ...publicSnapshot(),
    settings: state.settings,
    storage: store ? store.kind : "none",
    storeError,
    allSessions: [...keys].sort().reverse().map(key => L.sessionView(state, key, now, { admin: true })),
    me: who ? { role: who.role, name: who.role === "owner" ? "所有者" : who.name } : null,
    admins: who && who.role === "owner" ? (state.admins || []).map(({ keyHash, ...a }) => a) : [],
    teacherList: (state.teachers || []).map(({ tokenHash, ...t }) => t),
    auditLog: (state.auditLog || []).slice(-200).reverse(),
  };
}

// ---------- 报名 ----------
function statusMessage(status, location) {
  if (status === "cancelled") return "这一场已停办，请选择其他场次";
  if (status === "live") return `活动已经开始，线上报名已截止。可以直接到 ${location} 找组织者现场加入`;
  if (status === "ended") return "这一场已经结束了";
  return "这一场暂不接受报名";
}

function findSignup(draft, id) {
  for (const [key, sess] of Object.entries(draft.sessions)) {
    const index = sess.signups.findIndex(s => s.id === id);
    if (index >= 0) return { key, sess, index, signup: sess.signups[index] };
  }
  return null;
}

// 旧版页面（缓存）还会发 gameId / altGameId：转成志愿排序
function prefsFromBody(body) {
  if (Array.isArray(body.prefs)) return body.prefs;
  if ("gameId" in body) return [body.gameId, body.altGameId];
  return null;
}
function applySignupFields(target, body, offered, isAdmin, roundCount) {
  if ("name" in body) target.name = L.cleanLine(body.name, 20);
  const prefs = prefsFromBody(body);
  if (prefs) {
    const clean = [...new Set(prefs.filter(Boolean).map(String))].slice(0, L.MAX_PREFS);
    if (clean.some(id => !offered.has(id))) fail(400, "志愿里有本场没开放的游戏，请刷新页面后重选");
    target.prefs = clean;
  }
  if ("rounds" in body) {
    const raw = Array.isArray(body.rounds) ? body.rounds : [];
    const list = [...new Set(raw.map(n => L.clampInt(n, 1, L.MAX_ROUNDS, 0)).filter(n => n >= 1 && n <= roundCount))].sort((a, b) => a - b);
    if (raw.length && !list.length) fail(400, "请至少选择参加一轮");
    target.rounds = list.length === roundCount ? [] : list;
  }
  if ("level" in body) target.level = body.level === null || body.level === "" ? null : L.clampInt(body.level, 0, 2, null);
  if ("teach" in body) target.teach = Boolean(body.teach);
  if (Array.isArray(body.teachGames)) target.teach = false; // 旧版「愿意教学」改由讲规名单表示
  if ("note" in body) target.note = L.cleanText(body.note, 120);
  if (isAdmin && "checkedIn" in body) target.checkedIn = Boolean(body.checkedIn);
  if (target.level === 0) target.teach = false;
  if (!target.name) fail(400, "请填写称呼");
  if (!target.prefs || !target.prefs.length) fail(400, "请至少选一款想玩的游戏");
}
const PIN_RE = /^\d{4}$/;
const pinHashOf = (id, pin) => sha256(`pin:${id}:${pin}`);

// 报名表里勾的「我能讲规的游戏」：只往长期讲规名单里添加，不会删除（撤下在游戏库里操作）
// 普通访客和游戏库挂名共用同一个每 IP 名额（10 分钟 30 条），一次最多 10 款，防止借报名表刷满名单
const TEACH_LIMIT = 30;
const TEACH_PER_REQUEST = 10;
function teachRoom(req, isAdmin) {
  if (isAdmin) return L.MAX_PREFS;
  return Math.min(TEACH_PER_REQUEST, Math.max(0, TEACH_LIMIT - recent(bucketKey(req, "teach-ok"), SIGNUP_WINDOW).length));
}
function countTeachAdds(req, isAdmin, n) {
  if (isAdmin) return;
  for (let i = 0; i < n; i++) hit(bucketKey(req, "teach-ok"), SIGNUP_WINDOW);
}
// 只返回这个称呼还没挂过的游戏，再按名额截断
function teachGamesFromBody(draft, body, isAdmin, level, room, name) {
  if (!Array.isArray(body.teachGames) || level === 0) return [];
  const ok = new Set(draft.games.filter(g => isAdmin || g.active).map(g => g.id));
  const k = L.nameKey(name);
  const listed = new Set((draft.teachers || []).filter(t => L.nameKey(t.name) === k).map(t => t.gameId));
  return [...new Set(body.teachGames.map(String))].filter(id => ok.has(id) && !listed.has(id)).slice(0, room);
}
// 这个凭证名下的全部挂名（重试时也能把挂名的 id 交回设备）
const ownedTeachers = (draft, tokenHash) => (tokenHash ? (draft.teachers || []).filter(t => t.tokenHash === tokenHash).map(t => ({ id: t.id, gameId: t.gameId })) : []);
function addTeacherEntries(draft, name, gameIds, tokenHash, by) {
  const k = L.nameKey(name);
  const created = [];
  draft.teachers = draft.teachers || [];
  for (const gameId of gameIds) {
    if (draft.teachers.some(t => t.gameId === gameId && L.nameKey(t.name) === k)) continue;
    if (draft.teachers.length >= L.MAX_TEACHERS || draft.teachers.filter(t => t.gameId === gameId).length >= L.MAX_TEACHERS_PER_GAME) continue;
    const t = { id: `t${crypto.randomBytes(6).toString("hex")}`, gameId, name, createdAt: new Date().toISOString(), tokenHash: tokenHash || "", by };
    draft.teachers.push(t);
    created.push({ id: t.id, gameId });
  }
  return created;
}

const CLIENT_ID_RE = /^s[0-9a-f]{12}$/;
const CLIENT_TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const SIGNUP_WINDOW = 600000;

const gameNameOf = id => state.games.find(g => g.id === id)?.name || id || "";
async function createSignup(req, body) {
  const who = checkAdmin(req);
  const admin = Boolean(who);
  // 只把“成功的报名”计入每 IP 配额（校园网很多人共用一个出口 IP）；失败请求另有更宽的上限防刷
  const okKey = bucketKey(req, "signup-ok");
  const failKey = bucketKey(req, "signup-fail");
  if (!admin && (isLimited(okKey, 80, SIGNUP_WINDOW) || isLimited(failKey, 150, SIGNUP_WINDOW))) fail(429, "操作太频繁了，请稍后再试");
  try {
    if (body.website) fail(400, "提交失败，请刷新页面后重试");
    const key = String(body.sessionId || "");
    if (!L.isDateKey(key)) fail(400, "请选择场次");
    // 设备端自己生成 id 和凭证：就算网络中途断了，设备上也已经保存，可以重试或查到这条报名
    const clientId = CLIENT_ID_RE.test(String(body.id || "")) ? body.id : "";
    const clientToken = clientId && CLIENT_TOKEN_RE.test(String(body.token || "")) ? body.token : "";
    const room = teachRoom(req, admin);
    const result = await mutate(draft => {
      const now = nowMs();
      if (clientId) {
        const existing = findSignup(draft, clientId);
        if (existing) {
          if (clientToken && existing.signup.tokenHash && safeEqual(sha256(clientToken), existing.signup.tokenHash)) {
            // 重试：把第一次提交时顺手挂的讲规名也一并返回，设备才能记下它们
            const teachers = ownedTeachers(draft, existing.signup.tokenHash);
            return { id: clientId, token: clientToken, sessionId: existing.key, repeat: true, teachers, added: teachers };
          }
          fail(409, "提交冲突，请刷新页面后重试");
        }
      }
      if (!admin && !L.upcomingKeys(draft, now).includes(key)) fail(400, "这个场次目前不开放报名");
      const timing = L.sessionTiming(key, draft.sessions[key], draft.settings);
      const status = L.sessionStatus(draft.sessions[key], timing, now);
      const location = draft.sessions[key]?.location || draft.settings.location;
      if (!admin && status !== "open") fail(409, statusMessage(status, location));
      const sess = draft.sessions[key] || (draft.sessions[key] = L.normalizeSession(key, {}, new Set(draft.games.map(g => g.id))));
      const allowed = new Set(admin ? draft.games.map(g => g.id) : L.openGameIds(draft, sess));
      const iso = new Date(now).toISOString();
      const roundCount = L.sessionTiming(key, sess, draft.settings).rounds.length;
      const entry = { id: "", name: "", prefs: [], rounds: [], level: null, teach: false, note: "", createdAt: iso, updatedAt: iso, prefsAt: iso, tokenHash: "", extraTokenHashes: [], pinHash: "", checkedIn: false, by: admin ? "admin" : "self" };
      applySignupFields(entry, body, allowed, admin, roundCount);
      if (entry.level === null && !admin) fail(400, "请选择你的桌游经验");
      if (body.pin && !PIN_RE.test(String(body.pin))) fail(400, "找回码需要是 4 位数字");
      const k = L.nameKey(entry.name);
      if (sess.signups.some(s => L.nameKey(s.name) === k)) fail(409, `「${entry.name}」已经报名过这一场了。要修改请在原来的设备上操作；帮朋友报名请填写朋友的称呼`);
      if (sess.signups.length >= MAX_SIGNUPS_PER_SESSION) fail(409, "本场报名人数已达上限");
      const token = clientToken || crypto.randomBytes(18).toString("base64url");
      entry.id = clientToken ? clientId : `s${crypto.randomBytes(6).toString("hex")}`;
      entry.tokenHash = sha256(token);
      if (body.pin) entry.pinHash = pinHashOf(entry.id, String(body.pin));
      sess.signups.push(entry);
      const added = addTeacherEntries(draft, entry.name, teachGamesFromBody(draft, body, admin, entry.level, room, entry.name), entry.tokenHash, admin ? "admin" : "signup");
      return { id: entry.id, token, sessionId: key, name: entry.name, first: entry.prefs[0], teachers: added, added };
    }, who ? r => (r.repeat ? null : { who, action: "代报名", detail: `${r.sessionId} ${r.name} · ${gameNameOf(r.first)}` }) : null);
    delete result.name;
    delete result.first;
    if (!admin && !result.repeat) hit(okKey, SIGNUP_WINDOW);
    if (!result.repeat) countTeachAdds(req, admin, result.added.length);
    return result;
  } catch (error) {
    if (!admin && error.status && error.status < 500 && error.status !== 429) hit(failKey, SIGNUP_WINDOW);
    throw error;
  }
}

function authorizeSignup(req, signup) {
  if (isAdminRequest(req)) return true;
  const token = String(req.headers["x-edit-token"] || "");
  const h = sha256(token);
  const ok = Boolean(token) && [signup.tokenHash, ...(signup.extraTokenHashes || [])].some(x => x && safeEqual(h, x));
  if (!ok) fail(403, "只能在报名时使用的设备上修改；换了浏览器可以用找回码找回（或联系组织者）");
  return false;
}

async function updateSignup(req, id, body) {
  const who = checkAdmin(req);
  if (!who) rateLimit(req, "edit", 60, SIGNUP_WINDOW);
  let logged = null;
  const room = teachRoom(req, Boolean(who));
  const result = await mutate(draft => {
    const found = findSignup(draft, id);
    if (!found) fail(404, "找不到这条报名，可能已被取消");
    const admin = authorizeSignup(req, found.signup);
    const timing = L.sessionTiming(found.key, found.sess, draft.settings);
    const status = L.sessionStatus(found.sess, timing, nowMs());
    if (!admin && status !== "open") fail(409, `${statusMessage(status, found.sess.location || draft.settings.location)}，如需调整请联系组织者`);
    // 本人修改：可选本场开放的游戏，也可以保留原来已选的（哪怕它后来停用了）；管理员不受限
    const allowed = new Set(admin ? draft.games.map(g => g.id) : [...L.openGameIds(draft, found.sess), ...found.signup.prefs]);
    const prev = found.signup;
    const next = { ...prev };
    applySignupFields(next, body, allowed, admin, timing.rounds.length);
    if (next.level === null && !admin) fail(400, "请选择你的桌游经验");
    if (body.pin) {
      if (!PIN_RE.test(String(body.pin))) fail(400, "找回码需要是 4 位数字");
      next.pinHash = pinHashOf(id, String(body.pin));
    }
    const k = L.nameKey(next.name);
    if (found.sess.signups.some(s => s.id !== id && L.nameKey(s.name) === k)) fail(409, `本场已有人使用「${next.name}」这个称呼`);
    const iso = new Date().toISOString();
    // 志愿有变化就按修改时间重新排队（防止先占早位再换去热门游戏）
    if (JSON.stringify(next.prefs) !== JSON.stringify(prev.prefs)) next.prefsAt = iso;
    next.updatedAt = iso;
    found.sess.signups[found.index] = next;
    // 改了称呼：这条报名自己挂的讲规名跟着改（新称呼在那款游戏已经挂过的就不动）
    const oldK = L.nameKey(prev.name);
    const newK = L.nameKey(next.name);
    if (oldK !== newK) {
      const owned = new Set([prev.tokenHash, ...(prev.extraTokenHashes || [])].filter(Boolean));
      for (const t of draft.teachers || []) {
        if (L.nameKey(t.name) !== oldK || !owned.has(t.tokenHash)) continue;
        if (draft.teachers.some(o => o !== t && o.gameId === t.gameId && L.nameKey(o.name) === newK)) continue;
        t.name = next.name;
      }
    }
    const editToken = String(req.headers["x-edit-token"] || "");
    const ownerHash = admin || !editToken ? prev.tokenHash : sha256(editToken);
    const added = addTeacherEntries(draft, next.name, teachGamesFromBody(draft, body, admin, next.level, room, next.name), ownerHash, admin ? "admin" : "signup");
    const teachers = ownedTeachers(draft, ownerHash);
    const onlyCheckin = Object.keys(body).every(k => k === "checkedIn");
    logged = onlyCheckin ? { action: next.checkedIn ? "签到" : "取消签到", detail: `${found.key} ${next.name}` } : { action: "修改报名", detail: `${found.key} ${prev.name}${prev.name !== next.name ? ` → ${next.name}` : ""} · ${gameNameOf(next.prefs[0])}` };
    return { id, sessionId: found.key, teachers, added };
  }, who ? () => logged && { who, ...logged } : null);
  countTeachAdds(req, Boolean(who), result.added.length);
  return result;
}

async function deleteSignup(req, id) {
  const who = checkAdmin(req);
  if (!who) rateLimit(req, "edit", 60, SIGNUP_WINDOW);
  let detail = "";
  return mutate(draft => {
    const found = findSignup(draft, id);
    if (!found) fail(404, "找不到这条报名，可能已被取消");
    const admin = authorizeSignup(req, found.signup);
    const timing = L.sessionTiming(found.key, found.sess, draft.settings);
    const status = L.sessionStatus(found.sess, timing, nowMs());
    if (!admin && status !== "open") fail(409, `${statusMessage(status, found.sess.location || draft.settings.location)}，如需取消请联系组织者`);
    detail = `${found.key} ${found.signup.name} · ${gameNameOf(found.signup.prefs[0])}`;
    found.sess.signups.splice(found.index, 1);
    return { id, sessionId: found.key };
  }, who ? () => ({ who, action: "删除报名", detail }) : null);
}

async function recoverSignup(req, body) {
  rateLimit(req, "recover", 10, 3600000);
  const key = String(body.sessionId || "");
  const pin = String(body.pin || "");
  if (!L.isDateKey(key)) fail(400, "请选择场次");
  if (!PIN_RE.test(pin)) fail(400, "找回码是 4 位数字");
  const sess = state.sessions[key];
  const k = L.nameKey(body.name);
  if (!k) fail(400, "请填写报名时用的称呼");
  const target = sess && sess.signups.find(x => L.nameKey(x.name) === k);
  // 同一条报名 1 小时内最多猜错 5 次
  const lockKey = `pinfail:${key}:${sha256(k).slice(0, 16)}`;
  if (isLimited(lockKey, 5, 3600000)) fail(429, "找回码错误次数过多，请 1 小时后再试，或联系组织者");
  if (!target || !target.pinHash || !safeEqual(pinHashOf(target.id, pin), target.pinHash)) {
    hit(lockKey, 3600000);
    fail(404, target && !target.pinHash ? "这条报名没有设置找回码，请联系组织者" : "没有找到：请检查场次、称呼和找回码");
  }
  const token = crypto.randomBytes(18).toString("base64url");
  await mutate(draft => {
    const found = findSignup(draft, target.id);
    if (!found) fail(404, "这条报名已被取消");
    found.signup.extraTokenHashes = [...(found.signup.extraTokenHashes || []), sha256(token)].slice(-5);
  });
  const x = state.sessions[key].signups.find(y => y.id === target.id);
  return { id: x.id, token, sessionId: key, name: x.name, prefs: x.prefs, rounds: x.rounds, level: x.level, teach: x.teach, note: x.note };
}

// ---------- 讲规名单（游戏库里自己挂名 / 撤下；管理员可代挂、可删除） ----------
async function createTeacher(req, body) {
  const who = checkAdmin(req);
  const okKey = bucketKey(req, "teach-ok");
  const failKey = bucketKey(req, "teach-fail");
  if (!who && (isLimited(okKey, TEACH_LIMIT, SIGNUP_WINDOW) || isLimited(failKey, 100, SIGNUP_WINDOW))) fail(429, "操作太频繁了，请稍后再试");
  try {
    const gameId = String(body.gameId || "");
    const name = L.cleanLine(body.name, 20);
    if (!name) fail(400, "请填写你的称呼");
    // 设备端生成 id 和凭证：网络中断后重试不会重复挂名，设备上也一定存着撤下用的凭证
    const clientId = L.TEACHER_ID_RE.test(String(body.id || "")) ? body.id : "";
    const clientToken = clientId && CLIENT_TOKEN_RE.test(String(body.token || "")) ? body.token : "";
    const result = await mutate(draft => {
      draft.teachers = draft.teachers || [];
      if (clientId) {
        const existing = draft.teachers.find(t => t.id === clientId);
        if (existing) {
          if (clientToken && existing.tokenHash && safeEqual(sha256(clientToken), existing.tokenHash)) return { id: clientId, token: clientToken, gameId: existing.gameId, name: existing.name, repeat: true };
          fail(409, "提交冲突，请刷新页面后重试");
        }
      }
      const g = draft.games.find(x => x.id === gameId);
      if (!g || (!who && !g.active)) fail(404, "找不到这款游戏，请刷新页面后再试");
      const k = L.nameKey(name);
      if (draft.teachers.some(t => t.gameId === gameId && L.nameKey(t.name) === k)) fail(409, `「${name}」已经在《${g.name}》的讲规名单里了`);
      if (draft.teachers.filter(t => t.gameId === gameId).length >= L.MAX_TEACHERS_PER_GAME) fail(409, "这款游戏的讲规名单已经满了");
      if (draft.teachers.length >= L.MAX_TEACHERS) fail(409, "讲规名单已满，请联系组织者");
      const token = clientToken || crypto.randomBytes(18).toString("base64url");
      const t = { id: clientToken ? clientId : `t${crypto.randomBytes(6).toString("hex")}`, gameId, name, createdAt: new Date().toISOString(), tokenHash: sha256(token), by: who ? "admin" : "self" };
      draft.teachers.push(t);
      return { id: t.id, token, gameId, name, gameName: g.name };
    }, who ? r => (r.repeat ? null : { who, action: "代挂讲规名", detail: `${r.gameName} · ${r.name}` }) : null);
    if (!who && !result.repeat) hit(okKey, SIGNUP_WINDOW);
    delete result.gameName;
    return result;
  } catch (error) {
    if (!who && error.status && error.status < 500 && error.status !== 429) hit(failKey, SIGNUP_WINDOW);
    throw error;
  }
}

async function deleteTeacher(req, id) {
  const who = checkAdmin(req);
  if (!who) rateLimit(req, "edit", 60, SIGNUP_WINDOW);
  let detail = "";
  return mutate(draft => {
    const t = (draft.teachers || []).find(x => x.id === id);
    if (!t) fail(404, "这条挂名已经撤下了");
    if (!who) {
      const token = String(req.headers["x-edit-token"] || "");
      if (!token || !t.tokenHash || !safeEqual(sha256(token), t.tokenHash)) fail(403, "只能在挂名时用的设备上撤下；换了设备请联系组织者");
    }
    detail = `${draft.games.find(g => g.id === t.gameId)?.name || t.gameId} · ${t.name}`;
    draft.teachers = draft.teachers.filter(x => x.id !== id);
    return { id };
  }, who ? () => ({ who, action: "撤下讲规名", detail }) : null);
}

// ---------- 管理：场次 / 设置 / 桌游 ----------
async function updateSession(key, body, who) {
  if (!L.isDateKey(key)) fail(400, "日期格式应为 YYYY-MM-DD");
  return mutate(draft => {
    const gameIds = new Set(draft.games.map(g => g.id));
    const current = draft.sessions[key] || L.normalizeSession(key, { extra: Boolean(body.extra) }, gameIds);
    const merged = { ...current };
    for (const field of ["title", "location", "note", "gameIds", "tableSizes", "copies"]) if (field in body) merged[field] = body[field];
    if ("rounds" in body) {
      if (body.rounds === null || (Array.isArray(body.rounds) && !body.rounds.length)) merged.rounds = null;
      else {
        const r = L.normalizeRounds(body.rounds);
        if (!r) fail(400, "轮次时间格式不正确");
        merged.rounds = r;
      }
    }
    if (body.reallocate) merged.frozen = null;
    if ("status" in body) merged.status = body.status === "cancelled" ? "cancelled" : "";
    if ("extra" in body && !draft.sessions[key]) merged.extra = Boolean(body.extra);
    draft.sessions[key] = L.normalizeSession(key, merged, gameIds);
    return { sessionId: key };
  }, { who, action: body.extra ? "加开场次" : body.status === "cancelled" ? "停办场次" : "修改场次", detail: key });
}

async function deleteSession(key, who) {
  return mutate(draft => {
    const sess = draft.sessions[key];
    if (!sess) fail(404, "没有这个场次的记录");
    if (sess.signups.length) fail(409, "这个场次已有报名记录，不能删除。可以改为“停办”");
    delete draft.sessions[key];
    return { sessionId: key };
  }, { who, action: "删除加场", detail: key });
}

const BILI_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", Referer: "https://www.bilibili.com" };
// 支持：BV 号、bilibili.com/video/BV…、b23.tv 短链、av 号；无法识别时报错，绝不悄悄清空原视频
async function resolveBvid(input) {
  const text = String(input || "").trim();
  if (!text) return "";
  const bv = /BV[0-9A-Za-z]{10}/.exec(text);
  if (bv) return bv[0];
  const short = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[\w-]+/i.exec(text);
  if (short) {
    try {
      const res = await fetch(short[0], { redirect: "manual", signal: AbortSignal.timeout(5000), headers: BILI_HEADERS });
      const m = /BV[0-9A-Za-z]{10}/.exec(res.headers.get("location") || "");
      if (m) return m[0];
    } catch {}
    fail(400, "短链接解析失败，请在 B 站打开视频后复制浏览器地址栏里的完整链接");
  }
  const av = /\bav(\d{1,12})\b/i.exec(text);
  if (av) {
    for (const endpoint of ["x/web-interface/wbi/view", "x/web-interface/view"]) {
      try {
        const json = await (await fetch(`https://api.bilibili.com/${endpoint}?aid=${av[1]}`, { signal: AbortSignal.timeout(5000), headers: BILI_HEADERS })).json();
        if (json.code === 0 && json.data?.bvid) return json.data.bvid;
      } catch {}
    }
    fail(400, `无法把 av${av[1]} 转换成 BV 号，请改贴视频的 BV 号或完整链接`);
  }
  fail(400, "没认出这个视频链接，请贴 B 站视频的完整链接或 BV 号（BV 开头的 12 位）");
}

// 尝试从 B 站公开接口补全视频标题、UP 主、时长和封面；失败也不影响保存
async function enrichVideo(bvid, fallback = {}) {
  const base = { bvid, title: fallback.title || "", uploader: fallback.uploader || "", duration: fallback.duration || 0, cover: fallback.cover || "" };
  // B 站普通接口常被风控（HTTP 412），依次尝试两个接口；只有明确“视频不存在”才判为无效，其他失败一律按原样保存
  const NOT_FOUND = new Set([-404, 62002, 62004, 62012]);
  for (const endpoint of ["x/web-interface/wbi/view", "x/web-interface/view"]) {
    try {
      const res = await fetch(`https://api.bilibili.com/${endpoint}?bvid=${bvid}`, { signal: AbortSignal.timeout(5000), headers: BILI_HEADERS });
      const json = await res.json();
      if (NOT_FOUND.has(json.code)) return { ...base, invalid: true };
      if (json.code !== 0) continue;
      const d = json.data || {};
      return { bvid, title: d.title || base.title, uploader: d.owner?.name || base.uploader, duration: d.duration || base.duration, cover: String(d.pic || "").replace(/^http:/, "https:") };
    } catch {}
  }
  return base;
}

async function prepareGameBody(body, existing) {
  const out = { ...(existing || {}), ...body };
  for (const field of ["video", "videoBackup"]) {
    if (!(field in body)) continue;
    const raw = body[field];
    const bvid = await resolveBvid(typeof raw === "object" && raw ? raw.bvid : raw);
    if (!bvid) {
      out[field] = null;
      continue;
    }
    const prev = existing?.[field];
    if (prev && prev.bvid === bvid && prev.title) {
      out[field] = prev;
      continue;
    }
    const v = await enrichVideo(bvid, typeof raw === "object" && raw ? raw : {});
    if (v.invalid) fail(400, `B 站找不到视频 ${bvid}，请检查链接`);
    out[field] = v;
  }
  return out;
}

async function createGame(body, who) {
  const prepared = await prepareGameBody(body, null);
  return mutate(draft => {
    const taken = new Set(draft.games.map(g => g.id));
    delete prepared.id;
    const game = L.normalizeGame(prepared, draft.games.length, taken);
    draft.games.push(game);
    return { id: game.id, name: game.name };
  }, r => ({ who, action: "新增桌游", detail: r.name }));
}

async function updateGame(id, body, who) {
  const existing = state.games.find(g => g.id === id);
  if (!existing) fail(404, "找不到这款桌游");
  const prepared = await prepareGameBody(body, existing);
  return mutate(draft => {
    const index = draft.games.findIndex(g => g.id === id);
    if (index < 0) fail(404, "找不到这款桌游");
    const taken = new Set(draft.games.filter(g => g.id !== id).map(g => g.id));
    const before = draft.games[index];
    draft.games[index] = L.normalizeGame({ ...prepared, id }, index, taken);
    const after = draft.games[index];
    const what = Object.keys(body).length === 1 && "active" in body ? (after.active ? "启用桌游" : "停用桌游") : "修改桌游";
    return { id, name: after.name, what, before: before.name };
  }, r => ({ who, action: r.what, detail: r.before !== r.name ? `${r.before} → ${r.name}` : r.name }));
}

async function deleteGame(id, who) {
  let name = id;
  return mutate(draft => {
    const index = draft.games.findIndex(g => g.id === id);
    if (index < 0) fail(404, "找不到这款桌游");
    const used = Object.values(draft.sessions).some(s => s.signups.some(p => p.prefs.includes(id)));
    if (used) fail(409, "已有报名记录用到这款游戏，不能删除。可以把它设为“暂不开放”");
    name = draft.games[index].name;
    draft.games.splice(index, 1);
    draft.teachers = (draft.teachers || []).filter(t => t.gameId !== id);
    for (const s of Object.values(draft.sessions)) {
      s.gameIds = s.gameIds.filter(g => g !== id);
      delete s.tableSizes[id];
      delete s.copies[id];
    }
    return { id };
  }, () => ({ who, action: "删除桌游", detail: name }));
}

// ---------- 协作管理员（仅所有者） ----------
async function addAdmin(body, who) {
  const name = L.cleanLine(body?.name, 20);
  if (!name) fail(400, "请填写管理员的名字");
  if (["所有者", "owner", "管理员", "admin"].includes(L.nameKey(name))) fail(400, "这个名字是保留名，请换一个");
  const key = `kz_${crypto.randomBytes(24).toString("base64url")}`;
  const result = await mutate(draft => {
    if ((draft.admins || []).length >= L.MAX_ADMINS) fail(409, `最多 ${L.MAX_ADMINS} 位协作管理员`);
    if ((draft.admins || []).some(a => L.nameKey(a.name) === L.nameKey(name))) fail(409, `已经有叫「${name}」的管理员了`);
    const admin = { id: `a${crypto.randomBytes(4).toString("hex")}`, name, keyHash: sha256(key), createdAt: new Date().toISOString() };
    draft.admins = [...(draft.admins || []), admin];
    return { id: admin.id, name };
  }, { who, action: "添加管理员", detail: name });
  return { ...result, key }; // 密钥只在这里返回一次，服务器只保存哈希
}
async function removeAdmin(id, who) {
  let name = id;
  return mutate(draft => {
    const a = (draft.admins || []).find(x => x.id === id);
    if (!a) fail(404, "找不到这位管理员");
    name = a.name;
    draft.admins = draft.admins.filter(x => x.id !== id);
    return { id };
  }, () => ({ who, action: "撤销管理员", detail: name }));
}

// ---------- 导入 / 导出 / 备份 ----------
function exportPayload(who) {
  const data = who && who.role === "owner" ? state : { ...state, admins: [] };
  return { app: "kaizhuo-boardgame-club", version: 4, exportedAt: new Date().toISOString(), revision, state: data };
}

async function importData(body, who) {
  const data = body?.data;
  if (!data || typeof data !== "object") fail(400, "没有读到备份内容");
  const src = data.state && typeof data.state === "object" ? data.state : data;
  if (Array.isArray(src.events)) {
    return mutate(draft => {
      const { state: merged, imported } = L.migrateLegacy(src, draft);
      merged.admins = draft.admins;
      merged.auditLog = draft.auditLog;
      return { [REPLACE]: merged, result: { mode: "legacy-merge", imported } };
    }, r => ({ who, action: "导入旧版备份", detail: `合并 ${r.imported} 条报名` }));
  }
  if (!Array.isArray(src.games) || typeof src.sessions !== "object") fail(400, "无法识别的备份格式");
  const next = L.normalizeState(src);
  if (!next.games.length) fail(400, "备份里没有任何桌游，已取消导入");
  return mutate(draft => ({ [REPLACE]: { ...next, admins: draft.admins, auditLog: draft.auditLog }, result: { mode: "replace" } }), { who, action: "导入备份", detail: "用备份替换全部数据" });
}

async function restoreBackup(rev, who) {
  const backup = await store.getBackup(rev);
  if (!backup) fail(404, "找不到这个版本的备份");
  return mutate(draft => ({ [REPLACE]: { ...L.normalizeState(backup.state), admins: draft.admins, auditLog: draft.auditLog }, result: { restoredFrom: rev } }), { who, action: "恢复历史版本", detail: `v${rev}` });
}

function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function buildCsv(which) {
  const now = nowMs();
  const keys = which === "all" ? Object.keys(state.sessions).sort() : [which];
  const gameName = id => state.games.find(g => g.id === id)?.name || id || "";
  const maxRounds = Math.max(1, ...keys.filter(L.isDateKey).map(k => L.sessionTiming(k, state.sessions[k], state.settings).rounds.length));
  const header = ["场次日期", "序号", "称呼", "志愿顺序", "参加轮次", "桌游经验", "能讲规"];
  for (let r = 1; r <= maxRounds; r++) header.push(`第${r}轮分配`);
  header.push("签到", "备注", "设了找回码", "报名时间", "最后修改", "来源");
  const rows = [header];
  const tzMs = state.settings.tzOffsetMinutes * 60000;
  const fmt = iso => {
    const d = new Date(Date.parse(iso) + tzMs);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16).replace("T", " ");
  };
  for (const key of keys) {
    if (!L.isDateKey(key)) continue;
    const view = L.sessionView(state, key, now, { admin: true });
    const place = view.alloc.rounds.map(r => {
      const m = new Map();
      for (const [gid, g] of Object.entries(r.games)) for (const t of g.tables) for (const p of t.players) m.set(p.id, `${gameName(gid)} 第${t.no}桌（第${p.rank}志愿）`);
      for (const p of r.unassigned) m.set(p.id, "暂未分到");
      return m;
    });
    view.signups
      .slice()
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
      .forEach((sg, i) => {
        const row = [key, i + 1, sg.name, sg.prefs.map((g, j) => `${j + 1}.${gameName(g)}`).join(" "), sg.rounds.length ? sg.rounds.map(n => `第${n}轮`).join("、") : "全部", sg.level === null ? "" : L.LEVELS[sg.level], sg.teachGames.map(gameName).join("、") || (sg.teach ? "愿意教学" : "")];
        for (let r = 0; r < maxRounds; r++) row.push(place[r] ? place[r].get(sg.id) || (r < view.rounds.length ? "不参加" : "") : "");
        row.push(sg.checkedIn ? "已签到" : "", sg.note, sg.hasPin ? "是" : "", fmt(sg.createdAt), fmt(sg.updatedAt), { self: "本人", admin: "管理员录入", import: "旧系统导入" }[sg.by] || sg.by);
        rows.push(row);
      });
  }
  return "\uFEFF" + rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------- 静态文件（内存缓存 + 预压缩 + 版本号） ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".webp": "image/webp" };
const files = new Map();
let BUILD = "dev";
function loadStatic() {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const list = fs.existsSync(PUBLIC_DIR) ? walk(PUBLIC_DIR) : [];
  const hash = crypto.createHash("sha1");
  for (const f of list.sort()) hash.update(fs.readFileSync(f));
  BUILD = hash.digest("hex").slice(0, 10);
  for (const f of list) {
    const rel = `/${path.relative(PUBLIC_DIR, f).split(path.sep).join("/")}`;
    const ext = path.extname(f).toLowerCase();
    let body = fs.readFileSync(f);
    if ([".html", ".js", ".webmanifest"].includes(ext)) body = Buffer.from(body.toString("utf8").replace(/__V__/g, BUILD));
    const compressible = /^(text\/|application\/(json|manifest)|image\/svg)/.test(TYPES[ext] || "");
    files.set(rel, {
      body,
      type: TYPES[ext] || "application/octet-stream",
      etag: `"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`,
      br: compressible && body.length > 512 ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }) : null,
      gz: compressible && body.length > 512 ? zlib.gzipSync(body, { level: 9 }) : null,
    });
  }
}
const ROUTES = { "/": "/index.html", "/games": "/games.html", "/signup": "/signup.html", "/me": "/me.html", "/admin": "/admin.html" };

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.hdslb.com",
  "frame-src https://player.bilibili.com",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
].join("; ");

function baseHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function serveStatic(req, res, pathname, query) {
  if (process.env.DEV_RELOAD && (ROUTES[pathname] || pathname.endsWith(".html"))) loadStatic();
  const target = ROUTES[pathname] || pathname;
  const file = files.get(target);
  if (!file || target.includes("..")) return false;
  const isHtml = file.type.startsWith("text/html");
  res.setHeader("Content-Type", file.type);
  res.setHeader("ETag", file.etag);
  res.setHeader("Vary", "Accept-Encoding");
  if (target === "/sw.js" || isHtml) res.setHeader("Cache-Control", "no-cache");
  else if (query.get("v") === BUILD) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  else if (query.has("v")) res.setHeader("Cache-Control", "no-cache");
  else res.setHeader("Cache-Control", "public, max-age=3600");
  if (req.headers["if-none-match"] === file.etag) {
    res.writeHead(304);
    res.end();
    return true;
  }
  const accept = String(req.headers["accept-encoding"] || "");
  let body = file.body;
  if (file.br && /\bbr\b/.test(accept)) {
    res.setHeader("Content-Encoding", "br");
    body = file.br;
  } else if (file.gz && /\bgzip\b/.test(accept)) {
    res.setHeader("Content-Encoding", "gzip");
    body = file.gz;
  }
  res.setHeader("Content-Length", body.length);
  res.writeHead(200);
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

// ---------- HTTP ----------
function sendJson(req, res, status, data) {
  let body = Buffer.from(JSON.stringify(data));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
    body = zlib.gzipSync(body);
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
  }
  res.setHeader("Content-Length", body.length);
  res.writeHead(status);
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooBig = () => Object.assign(new HttpError(413, "提交的内容太大了"), { closeConnection: true });
    if (Number(req.headers["content-length"]) > limit) {
      req.resume();
      return reject(tooBig());
    }
    let size = 0;
    let over = false;
    const chunks = [];
    req.on("data", chunk => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return reject(tooBig());
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new HttpError(400, "请求格式不正确"));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, pathname, query) {
  const method = req.method;
  let parts;
  try {
    parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
  } catch {
    fail(400, "请求地址不正确");
  }
  const snap = () => {
    const who = checkAdmin(req);
    return who ? adminSnapshot(who) : publicSnapshot();
  };

  if (parts[1] === "state" && method === "GET") {
    if (storeError || !store) return sendJson(req, res, 503, { error: "数据暂时无法读取，请稍后刷新", readOnly: true });
    return sendJson(req, res, 200, publicSnapshot());
  }

  if (parts[1] === "signups") {
    if (parts.length === 2 && method === "POST") {
      const result = await createSignup(req, await readBody(req, 16 * 1024));
      return sendJson(req, res, 201, { ok: true, signup: result, state: snap() });
    }
    if (parts.length === 3 && parts[2] === "recover" && method === "POST") {
      const result = await recoverSignup(req, await readBody(req, 4 * 1024));
      return sendJson(req, res, 200, { ok: true, signup: result, state: publicSnapshot() });
    }
    if (parts.length === 3 && method === "PATCH") {
      const result = await updateSignup(req, parts[2], await readBody(req, 16 * 1024));
      return sendJson(req, res, 200, { ok: true, signup: result, state: snap() });
    }
    if (parts.length === 3 && method === "DELETE") {
      const result = await deleteSignup(req, parts[2]);
      return sendJson(req, res, 200, { ok: true, signup: result, state: snap() });
    }
  }

  if (parts[1] === "teachers") {
    if (parts.length === 2 && method === "POST") {
      const teacher = await createTeacher(req, await readBody(req, 4 * 1024));
      return sendJson(req, res, 201, { ok: true, teacher, state: snap() });
    }
    if (parts.length === 3 && method === "DELETE") {
      await deleteTeacher(req, parts[2]);
      return sendJson(req, res, 200, { ok: true, state: snap() });
    }
  }

  if (parts[1] === "admin") {
    const who = requireAdmin(req);
    const owner = () => requireAdmin(req, { owner: true });
    const done = (status, extra) => sendJson(req, res, status, { ok: true, ...extra, state: adminSnapshot(who) });
    const route = `${method} ${parts.slice(2, 3).join("/")}`;
    switch (route) {
      case "POST verify":
        return sendJson(req, res, 200, { ok: true, role: who.role, name: who.role === "owner" ? "所有者" : who.name });
      case "GET state":
        return sendJson(req, res, 200, adminSnapshot(who));
      case "GET diag":
        owner();
        return sendJson(req, res, 200, {
          ip: clientIp(req),
          headers: { "x-forwarded-for": req.headers["x-forwarded-for"] || "", "cf-connecting-ip": req.headers["cf-connecting-ip"] || "", "true-client-ip": req.headers["true-client-ip"] || "", "x-real-ip": req.headers["x-real-ip"] || "" },
          storage: store ? store.kind : "none",
          storeError,
          revision,
          build: BUILD,
          node: process.version,
        });
      case "PUT settings": {
        const body = await readBody(req, 16 * 1024);
        await mutate(draft => {
          draft.settings = L.normalizeSettings({ ...draft.settings, ...body });
        }, { who, action: "修改设置", detail: Object.keys(body).join("、") });
        return done(200);
      }
      case "PUT sessions":
        await updateSession(parts[3], await readBody(req, 64 * 1024), who);
        return done(200);
      case "DELETE sessions":
        await deleteSession(parts[3], who);
        return done(200);
      case "POST games":
        return done(201, { game: await createGame(await readBody(req, 64 * 1024), who) });
      case "PUT games":
        return done(200, { game: await updateGame(parts[3], await readBody(req, 64 * 1024), who) });
      case "DELETE games":
        await deleteGame(parts[3], who);
        return done(200);
      case "GET export":
        res.setHeader("Content-Disposition", `attachment; filename="kaizhuo-backup-v${revision}.json"`);
        return sendJson(req, res, 200, exportPayload(who));
      case "GET export.csv": {
        const which = query.get("session") || "all";
        if (which !== "all" && !L.isDateKey(which)) fail(400, "场次日期格式不正确");
        const body = Buffer.from(buildCsv(which));
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Disposition", `attachment; filename="signups-${which}.csv"`);
        res.writeHead(200);
        return res.end(body);
      }
      case "POST import": {
        owner();
        return done(200, { result: await importData(await readBody(req, 8 * 1024 * 1024), who) });
      }
      case "GET backups":
        return sendJson(req, res, 200, { backups: store ? await store.listBackups() : [] });
      case "POST backups": {
        owner();
        const rev = Number(parts[3]);
        if (parts[4] !== "restore" || !Number.isInteger(rev)) break;
        return done(200, { result: await restoreBackup(rev, who) });
      }
      case "POST admins": {
        owner();
        const created = await addAdmin(await readBody(req, 4 * 1024), who);
        return done(201, { admin: created });
      }
      case "DELETE admins":
        owner();
        await removeAdmin(parts[3], who);
        return done(200);
      default:
        break;
    }
  }
  fail(404, "接口不存在");
}

const server = http.createServer(async (req, res) => {
  baseHeaders(res);
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400);
    return res.end();
  }
  const pathname = url.pathname.replace(/\/{2,}/g, "/");
  try {
    if (pathname === "/healthz") {
      res.setHeader("Cache-Control", "no-store");
      const ok = Boolean(store) && !storeError;
      res.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain" });
      return res.end(req.method === "HEAD" ? undefined : ok ? "ok" : "store unavailable");
    }
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname, url.searchParams);
    if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, pathname.replace(/\/$/, "") || "/", url.searchParams)) return;
    if (req.method === "GET" && !path.extname(pathname)) {
      res.writeHead(302, { Location: "/" });
      return res.end();
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    // HttpError 和逻辑层的校验错误（带 4xx status）按原样返回；其余一律 500，不泄露细节
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) console.error(error);
    if (error?.closeConnection) res.setHeader("Connection", "close");
    if (!res.headersSent) sendJson(req, res, status, { error: status === 500 ? "服务器出了点问题，请稍后再试" : error.message });
    else res.end();
  }
});

loadStatic();
boot().then(() => {
  server.listen(PORT, () => console.log(`开桌已启动：http://localhost:${PORT}  (build ${BUILD})`));
});

module.exports = { server };
