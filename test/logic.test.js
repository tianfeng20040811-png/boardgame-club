"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lib/logic");
const seed = require("../data/seed.json");

const base = () => L.normalizeState({ games: seed.games, sessions: {} });
const ids = s => new Set(s.games.map(g => g.id));
const at = iso => Date.parse(iso);
const t = m => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();
// p("a", ["splendor","avalon"], 0, {rounds:[1]})
const p = (id, prefs, m, extra = {}) => ({ id, name: id, prefs, rounds: [], level: 1, teach: false, createdAt: t(m), prefsAt: t(m), ...extra });
const confOf = (s, gameIds, stored = {}) => L.gameConf(stored, s.games, gameIds);
const round = (s, players, gameIds, stored = {}, prior = new Map()) => L.allocateRound(players.map(x => L.normalizeSignup(x, ids(s)) && { ...L.normalizeSignup(x, ids(s)), id: x.id }), confOf(s, gameIds, stored), new Set(gameIds), prior);
const names = list => list.map(x => x.id);
const seatedIn = (r, g) => (r.tables[g] || []).flat().map(x => x.id).sort();

test("每周五自动生成场次，最后一轮结束后滚到下一周", () => {
  const s = base();
  assert.deepEqual(L.upcomingKeys(s, at("2026-10-07T04:00:00Z")), ["2026-10-09", "2026-10-16", "2026-10-23"]);
  assert.equal(L.upcomingKeys(s, at("2026-10-09T13:59:00Z"))[0], "2026-10-09");
  assert.equal(L.upcomingKeys(s, at("2026-10-09T14:00:00Z"))[0], "2026-10-16");
});

test("默认两轮：18:30–20:15、20:15–22:00；开局前 open，之后 live / ended", () => {
  const s = base();
  const tm = L.sessionTiming("2026-10-09", null, s.settings);
  assert.deepEqual(tm.rounds.map(r => `${r.start}-${r.end}`), ["18:30-20:15", "20:15-22:00"]);
  assert.equal(L.sessionStatus(null, tm, at("2026-10-09T10:29:59Z")), "open");
  assert.equal(L.sessionStatus(null, tm, at("2026-10-09T10:30:00Z")), "live");
  assert.equal(L.sessionStatus(null, tm, at("2026-10-09T14:00:00Z")), "ended");
});

test("旧设置（只有 time / endTime）自动平分成两轮", () => {
  const st = L.normalizeSettings({ time: "19:00", endTime: "22:00" });
  assert.deepEqual(st.rounds, [{ start: "19:00", end: "20:30" }, { start: "20:30", end: "22:00" }]);
});

test("旧报名（第一 / 第二志愿）自动转成志愿排序", () => {
  const n = L.normalizeSignup({ name: "甲", gameId: "splendor", altGameId: "avalon", createdAt: t(0) }, null);
  assert.deepEqual(n.prefs, ["splendor", "avalon"]);
  assert.deepEqual(n.rounds, []);
  assert.equal(n.prefsAt, n.createdAt);
});

test("按志愿顺序：第一志愿满了自动去下一个", () => {
  const s = base();
  // 璀璨宝石 1 套 4 人；5 个人都最想玩它，第 5 人的第二志愿是拉斯维加斯（2–5 人），但只有他一个 → 被淘汰 → 未分到
  const r = round(s, [...["a", "b", "c", "d", "e"].map((x, i) => p(x, ["splendor", "las-vegas"], i))], ["splendor", "las-vegas"]);
  assert.deepEqual(seatedIn(r, "splendor"), ["a", "b", "c", "d"]);
  // e 一个人去拉斯维加斯凑不齐（最少 2 人），被淘汰后没有别的志愿
  assert.deepEqual(names(r.unassigned), ["e"]);
});

test("凑不齐的游戏被淘汰，选它的人顺延到下一个志愿（按顺序看哪桌先成）", () => {
  const s = base();
  // 山中小屋最少 3 人，只有 2 人最想玩；他们的第二志愿是璀璨宝石（已有 1 人）→ 璀璨宝石成桌 3 人
  const players = [p("a", ["betrayal", "splendor"], 0), p("b", ["betrayal", "splendor"], 1), p("c", ["splendor"], 2)];
  const r = round(s, players, ["betrayal", "splendor"]);
  assert.deepEqual(seatedIn(r, "betrayal"), []);
  assert.deepEqual(seatedIn(r, "splendor"), ["a", "b", "c"]);
  assert.equal(r.unassigned.length, 0);
});

test("淘汰从最弱的开始，能成桌的游戏不会被误杀", () => {
  const s = base();
  // 阿瓦隆 5 人（成桌）；狼人真言只有 1 人 → 淘汰，他顺延到阿瓦隆（还有空位）
  const players = [...["a", "b", "c", "d", "e"].map((x, i) => p(x, ["avalon"], i)), p("w", ["werewords", "avalon"], 9)];
  const r = round(s, players, ["avalon", "werewords"]);
  assert.equal(seatedIn(r, "avalon").length, 6);
  assert.deepEqual(seatedIn(r, "werewords"), []);
});

test("人数够开但会剩一张缺人的桌时，多出来的人顺延", () => {
  const s = base();
  s.games.find(g => g.id === "avalon").copies = 2;
  // 阿瓦隆每桌上限 6、最少 5、2 套：7 人会变成 6+1 → 收紧到 6，第 7 人去他的第二志愿璀璨宝石（与另 1 人凑成 2 人桌）
  const players = [...Array.from({ length: 7 }, (_, i) => p(`a${i}`, ["avalon", "splendor"], i)), p("s", ["splendor"], 20)];
  const r = round(s, players, ["avalon", "splendor"], { tableSizes: { avalon: 6 } });
  assert.equal(seatedIn(r, "avalon").length, 6);
  assert.deepEqual(seatedIn(r, "splendor"), ["a6", "s"]);
});

test("两轮：同一个人第二轮不会再分到第一轮玩过的游戏；只报一轮的人只出现在那一轮", () => {
  const s = base();
  const stored = L.normalizeSession("2026-10-09", {
    signups: [
      ...["a", "b", "c", "d"].map((x, i) => p(x, ["splendor", "las-vegas"], i)),
      p("only1", ["splendor", "las-vegas"], 10, { rounds: [1] }),
      p("only2", ["las-vegas"], 11, { rounds: [2] }),
    ],
  }, ids(s));
  const tm = L.sessionTiming("2026-10-09", stored, s.settings);
  const a = L.allocateSession(stored, s.games, L.allocGameIds(s, stored), L.openGameIds(s, stored), tm.rounds);
  const r1 = a.rounds[0];
  const r2 = a.rounds[1];
  const inR1 = Object.values(r1.games).flatMap(g => g.tables.flatMap(x => x.players.map(y => y.id)));
  const inR2 = Object.values(r2.games).flatMap(g => g.tables.flatMap(x => x.players.map(y => y.id)));
  assert.ok(!inR1.includes("only2") && !inR2.includes("only1"));
  for (const pl of r2.games.splendor?.tables.flatMap(x => x.players) || []) assert.ok(!r1.games.splendor.tables.some(x => x.players.some(y => y.id === pl.id)), `${pl.id} 两轮都是璀璨宝石`);
  assert.equal(a.interest["las-vegas"].any, 6);
  assert.equal(a.interest.splendor.first, 5);
});

test("每一轮里每个人恰好出现一次，且每桌不超过上限", () => {
  const s = base();
  const all = s.games.map(g => g.id);
  const players = Array.from({ length: 70 }, (_, i) => p(`p${i}`, [all[i % all.length], all[(i * 7 + 3) % all.length], all[(i * 5 + 1) % all.length]], i, { level: i % 3, teach: i % 5 === 0 }));
  const r = round(s, players, all);
  const seen = [...Object.values(r.tables).flatMap(x => x.flat().map(y => y.id)), ...names(r.unassigned)].sort();
  assert.deepEqual(seen, players.map(x => x.id).sort());
  const conf = confOf(s, all);
  for (const [g, list] of Object.entries(r.tables)) for (const tb of list) assert.ok(tb.length <= conf[g].size && tb.length >= conf[g].min, `${g} 桌人数 ${tb.length}`);
});

test("活动开始后锁定分桌：取消的人移除，新加的人只插入有空位的桌，不打乱已有的桌", () => {
  const s = base();
  s.games.find(g => g.id === "avalon").copies = 1;
  const stored = L.normalizeSession("2026-10-09", { rounds: [{ start: "18:30", end: "22:00" }], signups: [...["a", "b", "c", "d", "e"].map((x, i) => p(x, ["avalon"], i))] }, ids(s));
  const tm = L.sessionTiming("2026-10-09", stored, s.settings);
  const fresh = L.allocateSession(stored, s.games, L.allocGameIds(s, stored), L.openGameIds(s, stored), tm.rounds);
  stored.frozen = L.freezeAllocation(fresh, new Date().toISOString());
  stored.signups = stored.signups.filter(x => x.id !== "c");
  stored.signups.push(L.normalizeSignup(p("late", ["splendor", "avalon"], 99), ids(s)));
  stored.signups[stored.signups.length - 1].id = "late";
  const fz = L.applyFrozen(stored, s.games, L.allocGameIds(s, stored), L.openGameIds(s, stored), tm.rounds);
  const av = fz.rounds[0].games.avalon.tables[0].players.map(x => x.id);
  assert.deepEqual(av, ["a", "b", "d", "e", "late"]);
});

test("名字里的零宽字符不能绕过同名检查；日期必须真实存在", () => {
  assert.equal(L.nameKey("小​林"), L.nameKey("小林"));
  assert.equal(L.isDateKey("2026-02-30"), false);
  assert.equal(L.isDateKey("2026-10-09"), true);
});

test("改了活动日后，已有报名的场次不会消失；跨午夜的场次 0 点后仍显示", () => {
  const s = base();
  s.sessions["2026-10-16"] = L.normalizeSession("2026-10-16", { signups: [p("a", ["splendor"], 0)] }, ids(s));
  s.settings.weekday = 4;
  assert.ok(L.upcomingKeys(s, at("2026-10-07T04:00:00Z")).includes("2026-10-16"));
  const s2 = base();
  s2.settings.rounds = [{ start: "18:30", end: "21:00" }, { start: "21:00", end: "01:00" }];
  assert.equal(L.upcomingKeys(s2, at("2026-10-09T16:30:00Z"))[0], "2026-10-09");
});

test("旧版网站备份导入：按名称对应游戏、保留顺序、id 唯一、坏格式报 400", () => {
  const s = base();
  const legacy = {
    games: [{ id: "old-gem", name: "璀璨宝石", min: 2, max: 4 }],
    events: [{ id: "e1", date: "2026-10-16", gameIds: ["old-gem"], signups: Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), name: `n${i + 1}`, gameId: "old-gem" })) }],
  };
  const { state, imported } = L.migrateLegacy(legacy, s);
  assert.equal(imported, 5);
  const sess = state.sessions["2026-10-16"];
  assert.deepEqual(sess.signups.map(x => x.prefs[0]), Array(5).fill("splendor"));
  const v = L.sessionView(state, "2026-10-16", at("2026-10-07T04:00:00Z"));
  assert.deepEqual(v.alloc.rounds[0].games.splendor.tables[0].players.map(x => x.name), ["n1", "n2", "n3", "n4"]);
  assert.throws(() => L.migrateLegacy({ games: {}, events: [] }, s), e => e.status === 400);
});
