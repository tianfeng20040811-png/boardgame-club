"use strict";
// 代码审查发现的问题的回归测试
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lib/logic");
const seed = require("../data/seed.json");

const base = () => L.normalizeState({ games: seed.games, sessions: {} });
const t = m => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();
const p = (id, gameId, m, extra = {}) => ({ id, name: id, gameId, altGameId: "", level: 1, teach: false, createdAt: t(m), altAt: t(m), ...extra });
const every = a => [...Object.values(a.games).flatMap(g => [...g.tables.flatMap(x => x.players), ...g.waitlist]), ...a.orphans].map(x => x.id).sort();

test("第一志愿优先：早报名者后来才填的第二志愿不能挤掉已入座的人", () => {
  const s = base();
  // 璀璨宝石 4 座已满；x 很早报了阿瓦隆，后来把第二志愿设成璀璨宝石
  const signups = [p("x", "avalon", 0, { altGameId: "splendor", altAt: t(50) }), ...["a", "b", "c", "d"].map((id, i) => p(id, "splendor", 10 + i))];
  const r = L.allocate({ signups }, s.games, ["avalon", "splendor"], false);
  assert.deepEqual(r.games.splendor.tables[0].players.map(x => x.id).sort(), ["a", "b", "c", "d"]);
  assert.equal(r.games.avalon.count, 1);
});

test("第二志愿按设定时间排队，候补按报名时间排", () => {
  const s = base();
  const signups = [...["a", "b", "c", "d"].map((id, i) => p(id, "splendor", i)), p("e", "splendor", 5, { altGameId: "werewords", altAt: t(30) }), p("f", "splendor", 6, { altGameId: "werewords", altAt: t(20) }), p("g", "splendor", 7)];
  const r = L.allocate({ signups }, s.games, ["splendor", "werewords"], false);
  assert.deepEqual(r.games.werewords.tables[0].players.map(x => x.id), ["f", "e"]);
  assert.deepEqual(r.games.splendor.waitlist.map(x => x.id), ["g"]);
});

test("截止后调整只会减少缺口：两个落单的人不会被互换", () => {
  const s = base();
  // 审查用例 (b)：betrayal 2 人（缺 1），其中 a 第二志愿阿瓦隆（空）——移动会让缺口变大，不应移动
  const signups = [p("a", "betrayal", 0, { altGameId: "avalon" }), p("b", "betrayal", 1)];
  const r = L.allocate({ signups }, s.games, ["betrayal", "avalon"], true);
  assert.equal(r.games.betrayal.count, 2);
  assert.equal(r.games.avalon.count, 0);
});

test("截止后调整：多余的人转去能凑齐的游戏", () => {
  const s = base();
  s.games.find(g => g.id === "betrayal").copies = 2;
  // 审查用例 (d)：betrayal 每桌 4 人共 2 套，b0-b3 + x（第二志愿璀璨宝石），y 报璀璨宝石
  const signups = [...["b0", "b1", "b2", "b3"].map((id, i) => p(id, "betrayal", i)), p("x", "betrayal", 5, { altGameId: "splendor" }), p("y", "splendor", 6)];
  const r = L.allocate({ signups, tableSizes: { betrayal: 4 } }, s.games, ["betrayal", "splendor"], true);
  assert.equal(r.games.betrayal.count, 4);
  assert.equal(r.games.splendor.count, 2);
  assert.equal(r.games.splendor.tables[0].short, 0);
});

test("每桌人数设得比最少人数还小时，按最少人数处理", () => {
  const s = base();
  const r = L.allocate({ signups: [p("a", "avalon", 0), p("b", "avalon", 1), p("c", "avalon", 2)], tableSizes: { avalon: 3 } }, s.games, ["avalon"], false);
  assert.equal(r.games.avalon.size, 5);
  assert.equal(r.games.avalon.min, 5);
  assert.equal(r.games.avalon.tables[0].short, 2);
});

test("游戏停用后：已报名的人保留座位，但不再接受新报名", () => {
  const s = base();
  s.sessions["2026-10-09"] = L.normalizeSession("2026-10-09", { signups: [p("a", "splendor", 0)] }, new Set(s.games.map(g => g.id)));
  s.games.find(g => g.id === "splendor").active = false;
  const v = L.sessionView(s, "2026-10-09", Date.parse("2026-10-07T04:00:00Z"));
  assert.ok(!v.gameIds.includes("splendor"));
  assert.ok(v.allGameIds.includes("splendor"));
  assert.equal(v.alloc.games.splendor.count, 1);
  assert.equal(v.alloc.orphans.length, 0);
});

test("自定义清单里的停用游戏也不能再报名", () => {
  const s = base();
  s.games.find(g => g.id === "avalon").active = false;
  assert.deepEqual(L.openGameIds(s, { gameIds: ["splendor", "avalon"] }), ["splendor"]);
});

test("每个报名都恰好出现一次（入座 / 候补 / 无处安放）", () => {
  const s = base();
  const ids = s.games.map(g => g.id);
  const signups = Array.from({ length: 60 }, (_, i) => p(`p${i}`, ids[i % ids.length], i, { altGameId: ids[(i * 7 + 3) % ids.length], level: i % 3, teach: i % 5 === 0 }));
  for (const final of [false, true]) {
    const r = L.allocate({ signups }, s.games, ids, final);
    assert.deepEqual(every(r), signups.map(x => x.id).sort());
    for (const g of Object.values(r.games)) for (const tb of g.tables) assert.ok(tb.players.length <= g.size);
  }
});

test("跨午夜的场次在 0 点后仍显示", () => {
  const s = base();
  s.settings.endTime = "01:00";
  // 周五 18:30 开始，周六 01:00 结束；周六 00:30（UTC+8）应仍包含周五场
  assert.equal(L.upcomingKeys(s, Date.parse("2026-10-09T16:30:00Z"))[0], "2026-10-09");
});

test("改了活动日后，已有报名的场次不会消失", () => {
  const s = base();
  s.sessions["2026-10-16"] = L.normalizeSession("2026-10-16", { signups: [p("a", "splendor", 0)] }, new Set(s.games.map(g => g.id)));
  s.settings.weekday = 4;
  assert.ok(L.upcomingKeys(s, Date.parse("2026-10-07T04:00:00Z")).includes("2026-10-16"));
});

test("零宽字符不能绕过同名检查；日期必须真实存在", () => {
  assert.equal(L.nameKey("小​林"), L.nameKey("小林"));
  assert.equal(L.nameKey("‮小林"), L.nameKey("小林"));
  assert.equal(L.isDateKey("2026-02-30"), false);
  assert.equal(L.isDateKey("9999-12-31"), false);
  assert.equal(L.isDateKey("2026-10-09"), true);
});

test("旧版导入：按名称对应游戏、保留顺序、不收窄现有场次、坏格式报 400", () => {
  const s = base();
  s.sessions["2026-10-16"] = L.normalizeSession("2026-10-16", { signups: [p("keep", "avalon", 0)] }, new Set(s.games.map(g => g.id)));
  const legacy = {
    games: [{ id: "old-gem", name: "璀璨宝石", min: 2, max: 4 }],
    events: [
      { id: "e1", date: "2026-10-16", gameIds: ["old-gem"], signups: Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), name: `n${i + 1}`, gameId: "old-gem" })) },
      { id: "e2", date: "2026-10-23", gameIds: ["old-gem"], signups: [{ id: "1", name: "z", gameId: "old-gem" }] },
    ],
  };
  const { state, imported } = L.migrateLegacy(legacy, s);
  assert.equal(imported, 7);
  const sess = state.sessions["2026-10-16"];
  assert.deepEqual(sess.gameIds, []);
  const a = L.allocate(sess, state.games, L.allocGameIds(state, sess), false);
  assert.deepEqual(a.games.splendor.tables[0].players.map(x => x.name), ["n1", "n2", "n3", "n4"]);
  const allIds = Object.values(state.sessions).flatMap(x => x.signups.map(y => y.id));
  assert.equal(new Set(allIds).size, allIds.length);
  assert.throws(() => L.migrateLegacy({ games: {}, events: [] }, s), e => e.status === 400);
});
