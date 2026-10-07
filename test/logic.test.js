"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lib/logic");
const seed = require("../data/seed.json");

const base = () => L.normalizeState({ games: seed.games, sessions: {} });
// 2026-10-07 是周三；UTC+8 的 12:00 = UTC 04:00
const at = iso => Date.parse(iso);

test("每周五自动生成场次，周五 22:00 后滚到下一周", () => {
  const s = base();
  assert.deepEqual(L.upcomingKeys(s, at("2026-10-07T04:00:00Z")), ["2026-10-09", "2026-10-16", "2026-10-23"]);
  // 周五 18:00（UTC+8）仍是本周
  assert.equal(L.upcomingKeys(s, at("2026-10-09T10:00:00Z"))[0], "2026-10-09");
  // 周五 21:59 进行中，仍显示本周
  assert.equal(L.upcomingKeys(s, at("2026-10-09T13:59:00Z"))[0], "2026-10-09");
  // 周五 22:00 之后滚到下周
  assert.equal(L.upcomingKeys(s, at("2026-10-09T14:00:00Z"))[0], "2026-10-16");
});

test("场次状态：开始前 open，18:30 起 live，22:00 后 ended，停办 cancelled", () => {
  const s = base();
  const t = L.sessionTiming("2026-10-09", null, s.settings);
  assert.equal(new Date(t.startAt).toISOString(), "2026-10-09T10:30:00.000Z");
  assert.equal(L.sessionStatus(null, t, at("2026-10-09T10:29:59Z")), "open");
  assert.equal(L.sessionStatus(null, t, at("2026-10-09T10:30:00Z")), "live");
  assert.equal(L.sessionStatus(null, t, at("2026-10-09T14:00:00Z")), "ended");
  assert.equal(L.sessionStatus({ status: "cancelled" }, t, at("2026-10-08T00:00:00Z")), "cancelled");
});

const mk = (n, gameId, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `${gameId}-${i}`, name: `${gameId}${i}`, gameId, altGameId: "", level: 1, teach: false, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), ...extra }));

test("分桌：璀璨宝石 1 套 4 人一桌，第 5 人进候补；有第二志愿则转过去", () => {
  const s = base();
  const signups = [...mk(5, "splendor"), { id: "x", name: "x", gameId: "splendor", altGameId: "avalon", level: 0, teach: false, createdAt: "2026-10-01T01:00:00.000Z" }];
  const a = L.allocate({ signups }, s.games, ["splendor", "avalon"], false);
  assert.equal(a.games.splendor.count, 4);
  assert.equal(a.games.splendor.waitlist.length, 2 - 1); // 第 5 人候补
  assert.equal(a.games.avalon.count, 1);
  assert.equal(a.games.avalon.tables[0].players[0].via, "alt");
  assert.equal(a.games.avalon.need, 4);
});

test("分桌：2 套时 7 人均衡成 4+3", () => {
  const s = base();
  s.games.find(g => g.id === "splendor").copies = 2;
  const a = L.allocate({ signups: mk(7, "splendor") }, s.games, ["splendor"], false);
  assert.deepEqual(a.games.splendor.tables.map(t => t.players.length), [4, 3]);
  assert.equal(a.games.splendor.seatsLeft, 1);
});

test("分桌：人数不够均衡时先坐满，最后一桌标注差几人", () => {
  const s = base();
  s.games.find(g => g.id === "avalon").copies = 2;
  // 阿瓦隆 5-10 人，11 人 → k=2，base=5 ≥ 5 → 6+5
  let a = L.allocate({ signups: mk(11, "avalon") }, s.games, ["avalon"], false);
  assert.deepEqual(a.games.avalon.tables.map(t => t.players.length), [6, 5]);
  // 阿瓦隆每桌改 6 人上限、13 人 → k=2（套数上限）→ 均衡 base=6 → 6+6，1 人候补
  a = L.allocate({ signups: mk(13, "avalon"), tableSizes: { avalon: 6 } }, s.games, ["avalon"], false);
  assert.deepEqual(a.games.avalon.tables.map(t => t.players.length), [6, 6]);
  assert.equal(a.games.avalon.waitlist.length, 1);
});

test("分桌：会教的人优先分散到不同桌", () => {
  const s = base();
  s.games.find(g => g.id === "splendor").copies = 2;
  const signups = [...mk(6, "splendor"), ...mk(2, "splendor", { level: 2 }).map((p, i) => ({ ...p, id: `t${i}`, name: `t${i}`, createdAt: `2026-10-02T00:0${i}:00.000Z` }))];
  const a = L.allocate({ signups }, s.games, ["splendor"], false);
  for (const t of a.games.splendor.tables) assert.ok(t.players.some(p => p.level === 2), "每桌都有一位会教的");
});

test("截止后（final）凑不齐的游戏按第二志愿转移", () => {
  const s = base();
  const signups = [
    { id: "a", name: "a", gameId: "betrayal", altGameId: "splendor", level: 1, createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "b", name: "b", gameId: "splendor", altGameId: "", level: 1, createdAt: "2026-10-01T00:01:00.000Z" },
  ];
  const open = L.allocate({ signups }, s.games, ["betrayal", "splendor"], false);
  assert.equal(open.games.betrayal.count, 1);
  const fin = L.allocate({ signups }, s.games, ["betrayal", "splendor"], true);
  assert.equal(fin.games.betrayal.count, 0);
  assert.equal(fin.games.splendor.count, 2);
});

test("旧版 v3 备份可以导入", () => {
  const legacy = { games: seed.games, events: [{ id: "e1", title: "周五桌游", date: "2026-09-25", time: "18:30", location: "R312", gameIds: ["splendor"], capacities: { splendor: 4 }, signups: [{ id: "p1", name: "小明", gameId: "splendor" }, { id: "p2", name: "小明", gameId: "splendor" }] }] };
  const { state, imported } = L.migrateLegacy(legacy, base());
  assert.equal(imported, 1);
  assert.equal(state.sessions["2026-09-25"].signups[0].by, "import");
});
