/* 游戏库：筛选 + 详情 + 教学视频 */
(function () {
  "use strict";
  const B = window.BGC;
  const { $, esc } = B;
  const f = { q: "", players: 0, time: "", diff: 0, group: "" };
  const PLAYERS = [[0, "不限"], [2, "2人"], [3, "3人"], [4, "4人"], [5, "5人"], [6, "6人"], [8, "8人+"]];
  const TIMES = [["", "不限"], ["short", "≤30分钟"], ["mid", "30–60分钟"], ["long", "60分钟+"]];
  const DIFFS = [[0, "不限"], [1, "轻松"], [2, "适中"], [3, "进阶"]];
  let session = null;
  let openedFromHash = false;

  function chips(el, items, key) {
    el.insertAdjacentHTML("beforeend", items.map(([v, label]) => `<button class="fchip" type="button" data-k="${key}" data-v="${esc(v)}" aria-pressed="${String(f[key]) === String(v)}">${esc(label)}</button>`).join(""));
  }
  function match(g) {
    if (!g.active) return false;
    if (f.q) {
      const hay = `${g.name} ${g.en} ${g.category} ${g.group} ${g.intro}`.toLowerCase();
      if (!f.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
    }
    if (f.players === 8 && g.max < 8) return false;
    if (f.players && f.players !== 8 && (g.min > f.players || g.max < f.players)) return false;
    if (f.time === "short" && g.minutes > 30) return false;
    if (f.time === "mid" && (g.minutes <= 30 || g.minutes > 60)) return false;
    if (f.time === "long" && g.minutes <= 60) return false;
    if (f.diff && g.difficulty !== f.diff) return false;
    if (f.group && g.group !== f.group) return false;
    return true;
  }
  function render() {
    const snap = B.snapshot;
    if (!snap) return;
    const order = x => Math.max(0, B.GROUPS.indexOf(x.group));
    const games = snap.games.filter(match).sort((a, b) => order(a) - order(b));
    $("#count").textContent = `共 ${games.length} 款${games.length < snap.games.filter(g => g.active).length ? "（已筛选）" : ""}`;
    $("#list").innerHTML = games.length ? games.map(g => B.cardHtml(g, session)).join("") : `<div class="lib-empty">没有符合条件的游戏，换个条件试试？</div>`;
  }
  function openFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    const g = id && B.gameById(id);
    if (g) B.openGame(g);
  }

  document.addEventListener("DOMContentLoaded", () => {
    chips($("#fPlayers"), PLAYERS, "players");
    chips($("#fTime"), TIMES, "time");
    chips($("#fDiff"), DIFFS, "diff");
    chips($("#fCat"), [["", "不限"], ...B.GROUPS.map(x => [x, x])], "group");
    $(".filters").addEventListener("click", e => {
      const b = e.target.closest(".fchip");
      if (!b) return;
      const key = b.dataset.k;
      const v = ["players", "diff"].includes(key) ? Number(b.dataset.v) : b.dataset.v;
      f[key] = v;
      b.parentElement.querySelectorAll(".fchip").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      render();
    });
    let t;
    $("#q").addEventListener("input", e => {
      clearTimeout(t);
      t = setTimeout(() => {
        f.q = e.target.value.trim();
        render();
      }, 120);
    });
    B.bindCards($("#list"));
    window.addEventListener("hashchange", openFromHash);
    B.onState(snap => {
      session = snap.sessions.find(s => s.status === "open") || null;
      render();
      if (!openedFromHash) {
        openedFromHash = true;
        openFromHash();
      }
    });
    B.boot({ poll: 60000 }).catch(() => {});
  });
})();
