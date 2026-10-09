/* 管理后台 */
(function () {
  "use strict";
  const B = window.BGC;
  const { $, $$, esc } = B;
  const KEY = "bgc.adminKey";
  const GROUPS = ["身份类", "桌游", "特色"];
  const ICON_KEYS = ["house", "gem", "flag", "shuriken", "bubble", "moon", "shield", "dice", "crown", "sub", "mask", "mug", "dice2", "letter", "tile", "spade"];
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  let key = "";
  let data = null;
  let tab = "list";
  let sid = null;
  let q = "";
  let filter = "all";
  let tround = 0;
  try {
    key = sessionStorage.getItem(KEY) || "";
  } catch {}

  const call = (path, opts = {}) => B.api(path, { ...opts, admin: key });
  const game = id => data?.games.find(g => g.id === id);
  const gname = id => game(id)?.name || (id ? `（已删除：${id}）` : "");
  const view = () => data?.allSessions.find(s => s.id === sid) || null;
  const fmtTime = iso => {
    const d = new Date(Date.parse(iso) + (data?.settings.tzOffsetMinutes ?? 480) * 60000);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(5, 16).replace("T", " ");
  };
  function apply(res) {
    if (res && res.state) {
      data = res.state;
      render();
    }
  }
  async function guard(fn, okMsg) {
    try {
      const res = await fn();
      apply(res);
      if (okMsg) B.toast(okMsg, "ok");
      return res;
    } catch (error) {
      if (error.status === 401) return logout("登录已失效，请重新输入密钥");
      B.toast(error.message, "error");
      return null;
    }
  }

  // ---------- 登录 ----------
  function showLogin(msg) {
    $("#login").hidden = false;
    $("#app").hidden = true;
    $("#logout").hidden = true;
    $("#loginErr").textContent = msg || "";
    setTimeout(() => $("#key").focus(), 50);
  }
  function logout(msg) {
    key = "";
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
    showLogin(msg);
  }
  async function load() {
    data = await call("/api/admin/state");
    const ids = data.allSessions.map(s => s.id);
    if (!sid || !ids.includes(sid)) sid = data.sessions.find(s => s.status === "open" || s.status === "live")?.id || data.sessions[0]?.id || ids[0] || null;
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#logout").hidden = false;
    const me = $("#whoami");
    if (me && data.me) {
      me.hidden = false;
      me.textContent = data.me.role === "owner" ? "所有者" : `管理员 · ${data.me.name}`;
    }
    render();
  }
  const isOwner = () => data?.me?.role === "owner";

  // ---------- 通用 ----------
  function sessionLabel(s) {
    const st = { open: "报名中", live: "进行中", ended: "已结束", cancelled: "停办" }[s.status];
    return `${B.fmtDate(s.date)} ${s.time} · ${st} · ${s.signups.length} 人${s.extra ? " · 加场" : ""}`;
  }
  function renderPicker() {
    const upcoming = new Set(data.sessions.map(s => s.id));
    const up = data.allSessions.filter(s => upcoming.has(s.id)).sort((a, b) => a.date.localeCompare(b.date));
    const past = data.allSessions.filter(s => !upcoming.has(s.id) && (s.signups.length || s.extra || s.status === "cancelled"));
    $("#sessionPick").innerHTML = `<optgroup label="即将进行">${up.map(s => `<option value="${esc(s.id)}">${esc(sessionLabel(s))}</option>`).join("")}</optgroup>${past.length ? `<optgroup label="历史场次">${past.map(s => `<option value="${esc(s.id)}">${esc(sessionLabel(s))}</option>`).join("")}</optgroup>` : ""}`;
    if (![...$("#sessionPick").options].some(o => o.value === sid)) sid = up[0]?.id || past[0]?.id || null;
    $("#sessionPick").value = sid || "";
    $("#sessionPickRow").hidden = !["list", "tables"].includes(tab);
  }
  // 每条报名在各轮的去向：id → [{ round, kind: seat | none | skip, gid, table, rank, short }]
  function placements(v) {
    const map = new Map();
    const rounds = v.alloc.rounds;
    const put = (id, i, x) => {
      if (!map.has(id)) map.set(id, rounds.map(r => ({ round: r.index, kind: "skip" })));
      map.get(id)[i] = { round: rounds[i].index, ...x };
    };
    rounds.forEach((r, i) => {
      for (const [gid, g] of Object.entries(r.games)) for (const t of g.tables) for (const p of t.players) put(p.id, i, { kind: "seat", gid, table: t.no, rank: p.rank, short: t.short });
      for (const p of r.unassigned) put(p.id, i, { kind: "none" });
    });
    return map;
  }
  const unplaced = list => Boolean(list && list.some(p => p.kind === "none"));
  function placeText(list) {
    if (!list) return `<span class="tag tag-wait">不在任何一轮</span>`;
    const multi = list.length > 1;
    return list
      .map(p => {
        const pre = multi ? `<span class="mono rno">R${p.round}</span>` : "";
        if (p.kind === "skip") return `<div class="pl-line muted">${pre}不参加</div>`;
        if (p.kind === "none") return `<div class="pl-line">${pre}<span class="tag tag-wait">未成桌</span></div>`;
        return `<div class="pl-line">${pre}${esc(gname(p.gid))} · ${p.table}桌${p.short ? ` <span class="tag tag-wait">差${p.short}</span>` : ""}${p.rank > 1 ? ` <span class="tag tag-alt">志愿${p.rank}</span>` : ""}</div>`;
      })
      .join("");
  }
  const prefsText = s => (s.prefs || []).map((g, i) => `${i + 1}.${gname(g)}`).join(" ");
  // 讲规名单（后台用自己的数据）
  const rosterOf = gid => (data?.teacherList || []).filter(t => t.gameId === gid).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const rosterGames = name => {
    const k = B.nameKey(name);
    return k ? [...new Set((data?.teacherList || []).filter(t => B.nameKey(t.name) === k).map(t => t.gameId))] : [];
  };
  const canTeachAny = s => (s.teachGames || []).length > 0 || s.teach;
  const teachOpts = gid => ({ gameName: id => game(id)?.name || "", roster: rosterOf(gid) });
  const roundsText = (s, v) => (v.rounds.length < 2 ? "—" : !s.rounds?.length ? "全部" : s.rounds.map(n => `第${n}轮`).join("、"));
  const roundSpan = r => `${r.start}–${r.end}`;
  const sameRounds = (a, b) => a.length === b.length && a.every((r, i) => r.start === b[i].start && r.end === b[i].end);
  // 轮次编辑器（场次 / 加场 / 基础设置共用）
  function roundRow(r, i) {
    return `<div class="round-row"><span class="mono">第${i + 1}轮</span><input class="input" type="time" name="rs" value="${esc(r.start)}" required aria-label="第${i + 1}轮开始"><span>–</span><input class="input" type="time" name="re" value="${esc(r.end)}" required aria-label="第${i + 1}轮结束"><button class="btn btn-xs btn-ghost" type="button" data-round-del aria-label="删除这一轮">×</button></div>`;
  }
  function roundsEditor(rounds, { label = "轮次时间", reset = false } = {}) {
    return `<div class="field span-all"><span class="label">${label}<small>每轮换一款游戏；一个人不会两轮分到同一款</small></span>
      <div class="rounds-edit">${rounds.map(roundRow).join("")}</div>
      <div class="toolbar"><button class="btn btn-xs" type="button" data-round-add>＋ 加一轮</button>${reset ? `<button class="btn btn-xs btn-ghost" type="button" data-round-reset>恢复默认轮次</button>` : ""}</div></div>`;
  }
  function readRounds(form) {
    const f = new FormData(form);
    const s = f.getAll("rs");
    const e = f.getAll("re");
    return s.map((start, i) => ({ start: String(start), end: String(e[i] || "") }));
  }
  function renumberRounds(box) {
    $$(".round-row", box).forEach((row, i) => {
      row.querySelector(".mono").textContent = `第${i + 1}轮`;
    });
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  // ---------- 名单 ----------
  function renderList() {
    const v = view();
    const box = $("#tab-list");
    if (!v) {
      box.innerHTML = `<div class="empty">还没有场次</div>`;
      return;
    }
    const pl = placements(v);
    const all = [...v.signups].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const ql = q.toLowerCase();
    const rows = all.filter(s => {
      if (ql && !`${s.name} ${s.note} ${prefsText(s)}`.toLowerCase().includes(ql)) return false;
      if (filter === "in") return s.checkedIn;
      if (filter === "notin") return !s.checkedIn;
      if (filter === "wait") return unplaced(pl.get(s.id));
      if (filter === "new") return s.level === 0;
      if (filter === "teach") return canTeachAny(s);
      return true;
    });
    const k = {
      total: all.length,
      inn: all.filter(s => s.checkedIn).length,
      newbie: all.filter(s => s.level === 0).length,
      teach: all.filter(canTeachAny).length,
      wait: all.filter(s => unplaced(pl.get(s.id))).length,
      tables: v.alloc.rounds.reduce((n, r) => n + r.totals.tablesReady, 0),
    };
    const multi = v.rounds.length > 1;
    if (!$("#listToolbar", box)) {
      box.innerHTML = `<div id="listKpis"></div>
      <div class="toolbar" id="listToolbar">
        <input class="input" id="q" type="search" placeholder="搜索称呼、游戏或备注" value="${esc(q)}">
        <select class="select" id="filter">
          ${[["all", "全部"], ["notin", "未签到"], ["in", "已签到"], ["wait", "有轮次未成桌"], ["new", "新手"], ["teach", "能讲规"]].map(([v2, l]) => `<option value="${v2}" ${filter === v2 ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <button class="btn btn-sm btn-primary" type="button" data-act="add">＋ 添加报名</button>
        <button class="btn btn-sm" type="button" data-act="csv">导出本场 CSV</button>
        <button class="btn btn-sm" type="button" data-act="csv-all">导出全部 CSV</button>
      </div>
      <div id="listResults"></div>`;
    }
    $("#listKpis", box).innerHTML = `
      <div class="kpis"><span class="kpi"><b>${k.total}</b>报名</span><span class="kpi"><b>${k.inn}</b>已签到</span><span class="kpi"><b>${k.tables}</b>已成桌${multi ? "（各轮合计）" : ""}</span><span class="kpi"><b>${k.newbie}</b>新手</span><span class="kpi"><b>${k.teach}</b>能讲规</span><span class="kpi"><b>${k.wait}</b>有轮次未成桌</span></div>`;
    $("#listResults", box).innerHTML = `${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>称呼</th><th>志愿顺序</th>${multi ? "<th>参加轮次</th>" : ""}<th>熟悉</th><th>分配结果</th><th>签到</th><th>备注</th><th>报名时间</th><th>操作</th></tr></thead><tbody>
        ${rows
          .map(s => {
            const lv = s.level === null ? "—" : B.LEVELS[s.level];
            const lvTag = s.level === 0 ? "tag-new" : s.level === 2 ? "tag-pro" : "";
            const prefs = s.prefs || [];
            return `<tr>
              <td class="num">${all.indexOf(s) + 1}</td>
              <td><b>${esc(s.name)}</b>${s.by !== "self" ? ` <span class="tag">${s.by === "admin" ? "代报" : "导入"}</span>` : ""}${s.hasPin ? ` <span class="tag" title="设了找回码">🔑</span>` : ""}</td>
              <td class="prefs" title="${esc(prefsText(s))}">${prefs.slice(0, 4).map((g, i) => `<span class="pref"><i>${i + 1}</i>${esc(gname(g))}</span>`).join("")}${prefs.length > 4 ? `<span class="tag">+${prefs.length - 4}</span>` : ""}</td>
              ${multi ? `<td class="time">${esc(roundsText(s, v))}</td>` : ""}
              <td><span class="tag ${lvTag}">${esc(lv)}</span>${(s.teachGames || []).length ? ` <span class="tag tag-pro" title="挂名会讲：${esc(s.teachGames.map(gname).join("、"))}">🎓 ${esc(s.teachGames.slice(0, 2).map(gname).join("、"))}${s.teachGames.length > 2 ? ` +${s.teachGames.length - 2}` : ""}</span>` : s.teach ? ` <span class="tag tag-pro">愿教</span>` : ""}</td>
              <td>${placeText(pl.get(s.id))}</td>
              <td><label class="check"><input type="checkbox" data-checkin="${esc(s.id)}" ${s.checkedIn ? "checked" : ""} aria-label="${esc(s.name)} 签到"></label></td>
              <td class="note">${esc(s.note)}</td>
              <td class="time">${esc(fmtTime(s.createdAt))}</td>
              <td class="acts"><button class="btn btn-xs" type="button" data-edit="${esc(s.id)}">编辑</button> <button class="btn btn-xs btn-danger" type="button" data-del="${esc(s.id)}">删除</button></td>
            </tr>`;
          })
          .join("")}
      </tbody></table></div>` : `<div class="empty">${all.length ? "没有符合筛选条件的报名" : "这一场还没有人报名"}</div>`}`;
  }

  function signupForm(s, v) {
    // 本场开放的在前；也列出其他启用中的游戏和这条报名原有的志愿（管理员不受本场开放范围限制）
    const ids = [...new Set([...v.gameIds, ...(s?.prefs || []), ...v.allGameIds, ...data.games.filter(g => g.active).map(g => g.id)])].filter(id => game(id));
    const multi = v.rounds.length > 1;
    return `<h2 id="modalTitle" class="modal-title">${s ? "编辑报名" : "添加报名"} · ${esc(B.fmtDate(v.date))}</h2>
    <form id="suForm" class="form-grid">
      <div class="field span-2"><label class="label" for="f-name">称呼</label><input class="input" id="f-name" name="name" maxlength="20" required value="${esc(s?.name || "")}"></div>
      <div class="field span-all"><span class="label">志愿顺序 <small>按想玩的程度依次点选，再点一次取消</small></span>
        <div class="pp-order" id="ppOrder" aria-live="polite"></div>
        <div class="pp-opts" role="group" aria-label="想玩的游戏">${ids.map(id => `<button class="pp-opt" type="button" data-pp="${esc(id)}" aria-pressed="false"><b class="pp-rank"></b>${esc(gname(id))}${v.gameIds.includes(id) ? "" : `<small>本场未开放</small>`}</button>`).join("")}</div></div>
      ${multi ? `<div class="field span-all"><span class="label">参加轮次</span><div class="toolbar">${v.rounds.map(r => `<label class="check"><input type="checkbox" name="r" value="${r.index}" ${!s?.rounds?.length || s.rounds.includes(r.index) ? "checked" : ""}>第${r.index}轮 <span class="mono">${esc(roundSpan(r))}</span></label>`).join("")}</div></div>` : ""}
      <div class="field"><label class="label" for="f-level">熟悉程度</label><select class="select" id="f-level" name="level"><option value="">未填</option>${B.LEVELS.map((l, i) => `<option value="${i}" ${s?.level === i ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><span class="label">签到</span><label class="check"><input type="checkbox" name="checkedIn" ${s?.checkedIn ? "checked" : ""}>已签到</label></div>
      <div class="field span-all"><span class="label">能讲规的游戏 <small>勾上的会以这个称呼挂到讲规名单；已挂名的要撤下请到「桌游」页</small></span>
        <div class="pp-opts" id="tpOpts" role="group" aria-label="能讲规的游戏"></div></div>
      <div class="field span-all"><label class="label" for="f-note">备注</label><textarea class="textarea" id="f-note" name="note" maxlength="120">${esc(s?.note || "")}</textarea></div>
      <div class="field"><label class="label" for="f-pin">${s?.hasPin ? "重设找回码" : "找回码"} <small>选填 4 位数字${s?.hasPin ? "，留空不改" : ""}</small></label><input class="input mono" id="f-pin" name="pin" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" autocomplete="off"></div>
      <div class="modal-actions span-all"><button class="btn btn-ghost" type="button" data-close>取消</button><button class="btn btn-primary" type="submit">保存</button></div>
    </form>`;
  }
  function openSignup(id) {
    const v = view();
    const s = id ? v.signups.find(x => x.id === id) : null;
    const m = B.openModal(signupForm(s, v), { wide: true });
    const order = (s?.prefs || []).filter(g => game(g));
    const paint = () => {
      $$(".pp-opt[data-pp]", m).forEach(b => {
        const i = order.indexOf(b.dataset.pp);
        b.setAttribute("aria-pressed", String(i >= 0));
        b.querySelector(".pp-rank").textContent = i >= 0 ? i + 1 : "";
      });
      $("#ppOrder", m).innerHTML = order.length
        ? order.map((g, i) => `<span class="pp-chip"><i>${i + 1}</i>${esc(gname(g))}${i ? `<button type="button" data-pp-up="${i}" aria-label="把 ${esc(gname(g))} 往前移">↑</button>` : ""}</span>`).join("")
        : `<span class="hint">还没选游戏</span>`;
    };
    paint();
    // 能讲规的游戏：已在名单上的（按称呼）显示为已挂名；新勾的提交时添加
    const teachPick = new Set();
    const teachIds = data.games.filter(g => g.active).map(g => g.id);
    const paintTeach = () => {
      const listed = new Set(rosterGames($("#f-name", m).value));
      $("#tpOpts", m).innerHTML = [...new Set([...teachIds, ...listed])]
        .filter(id => game(id))
        .map(id => (listed.has(id) ? `<button class="pp-opt" type="button" aria-pressed="true" disabled title="已挂名">${esc(gname(id))}<small>已挂名</small></button>` : `<button class="pp-opt" type="button" data-tp="${esc(id)}" aria-pressed="${teachPick.has(id)}">${esc(gname(id))}</button>`))
        .join("");
    };
    paintTeach();
    $("#f-name", m).addEventListener("input", paintTeach);
    m.addEventListener("click", e => {
      const opt = e.target.closest("[data-pp]");
      const up = e.target.closest("[data-pp-up]");
      const tp = e.target.closest("[data-tp]");
      if (tp) {
        if (teachPick.has(tp.dataset.tp)) teachPick.delete(tp.dataset.tp);
        else teachPick.add(tp.dataset.tp);
        paintTeach();
      } else if (opt) {
        const i = order.indexOf(opt.dataset.pp);
        if (i >= 0) order.splice(i, 1);
        else order.push(opt.dataset.pp);
        paint();
      } else if (up) {
        const i = Number(up.dataset.ppUp);
        [order[i - 1], order[i]] = [order[i], order[i - 1]];
        paint();
      }
    });
    $("#f-pin", m).addEventListener("input", e => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4)));
    $("#suForm", m).addEventListener("submit", async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (!order.length) return B.toast("至少选一款游戏", "error");
      const pin = String(f.get("pin") || "");
      if (pin && !/^\d{4}$/.test(pin)) return B.toast("找回码需要是 4 位数字", "error");
      const body = { name: f.get("name"), prefs: [...order], level: f.get("level") === "" ? null : Number(f.get("level")), teachGames: [...teachPick], checkedIn: f.get("checkedIn") === "on", note: f.get("note") };
      if (body.level === 0 && teachPick.size) return B.toast("熟悉程度选了「新手」时不会挂讲规名，请改熟悉程度或取消勾选", "error");
      if (v.rounds.length > 1) {
        body.rounds = f.getAll("r").map(Number);
        if (!body.rounds.length) return B.toast("至少参加一轮", "error");
      }
      if (pin) body.pin = pin;
      const res = await guard(() => (s ? call(`/api/signups/${encodeURIComponent(s.id)}`, { method: "PATCH", body }) : call("/api/signups", { method: "POST", body: { ...body, sessionId: v.id } })), s ? "已保存" : "已添加");
      if (res) B.closeModal();
    });
  }

  // ---------- 分桌 / 签到 ----------
  function renderTables() {
    const v = view();
    const box = $("#tab-tables");
    if (!v) {
      box.innerHTML = "";
      return;
    }
    const byId = new Map(v.signups.map(s => [s.id, s]));
    const rounds = v.alloc.rounds;
    if (tround >= rounds.length) tround = 0;
    const r = rounds[tround];
    const multi = rounds.length > 1;
    const player = p => {
      const s = byId.get(p.id);
      const marks = `${p.teach ? " 🎓" : ""}${p.level === 0 ? " 🌱" : ""}`;
      return `<div class="aplayer ${s?.checkedIn ? "in" : ""}"><span>${esc(p.name)}${marks}${p.rank > 1 ? ` <small class="rank">志愿${p.rank}</small>` : ""}</span><label class="check"><input type="checkbox" data-checkin="${esc(p.id)}" ${s?.checkedIn ? "checked" : ""} aria-label="${esc(p.name)} 签到">签到</label></div>`;
    };
    const blocks = r
      ? Object.entries(r.games)
          .map(([id, a]) => ({ g: game(id), a }))
          .filter(x => x.g && x.a.count)
          .sort((x, y) => y.a.count - x.a.count)
          .map(({ g, a }) => `<div class="alloc-game" style="--c:${B.color(g)}"><h3><span class="gi">${B.icon(g, 20)}</span>${esc(g.name)}</h3>
          <p class="sub">每桌 ${a.size} 人 · ${a.copies} 套 · 最少 ${a.min} 人 · 本轮 ${a.count} 人</p>
          ${a.tables.map(t => `<div class="atable"><div class="atable-h"><b>第 ${t.no} 桌</b><span>${t.players.length} 人${t.short ? ` · 差 ${t.short} 人` : ""}</span></div>${t.players.map(player).join("")}${B.teachNoteHtml(r, g.id, t, teachOpts(g.id))}</div>`).join("")}</div>`)
      : [];
    // 没成桌的人：列出前几个志愿，方便现场协调
    const loose = r && r.unassigned.length
      ? `<div class="alloc-game alloc-loose"><h3>本轮未成桌 · ${r.unassigned.length} 人</h3><p class="sub">志愿里的游戏都凑不齐最少人数。可以现场劝他们加入差人的桌，或手动编辑志愿后系统会重排。</p>
          ${r.unassigned.map(p => `${player(p)}<p class="loose-prefs">${esc(prefsText(byId.get(p.id) || { prefs: [] }))}</p>`).join("")}</div>`
      : "";
    const tabs = multi
      ? `<div class="round-tabs" role="tablist" aria-label="轮次">${rounds.map((x, i) => `<button type="button" role="tab" data-tround="${i}" aria-selected="${i === tround}">第${x.index}轮 <span class="mono">${esc(roundSpan(x))}</span> · ${x.totals.seated}人</button>`).join("")}</div>`
      : "";
    const state = v.status === "cancelled"
      ? "本场停办。"
      : v.frozen
        ? "🔒 已锁定：活动开始时的分桌已固定，之后新来的人只会补进有空位的桌，不会打乱已开局的桌。"
        : v.status === "open"
          ? "报名中：分桌实时预估，每次有人报名或修改都会重算；活动开始时自动锁定。"
          : "活动已开始，分桌正在锁定…";
    box.innerHTML = `<div class="toolbar no-print"><span class="hint">${state}</span>${v.frozen ? `<button class="btn btn-sm" type="button" data-act="reallocate">重新自动分桌</button>` : ""}<button class="btn btn-sm" type="button" data-act="print">打印${multi ? "本轮" : ""}分桌表</button></div>
      ${tabs}
      <h2 class="print-only">${esc(B.fmtDate(v.date))} ${multi && r ? `第${r.index}轮 ${esc(roundSpan(r))}` : esc(v.time)} 分桌表</h2>
      ${blocks.length || loose ? `<div class="alloc-grid">${blocks.join("")}${loose}</div>` : `<div class="empty">${v.signups.length ? "这一轮还没有人参加" : "这一场还没有人报名"}</div>`}`;
  }

  // ---------- 场次 ----------
  function sessionCard(s) {
    const active = data.games.filter(g => g.active || s.gameIds.includes(g.id));
    const offered = new Set(s.gameIds);
    return `<form class="ecard" data-session-form="${esc(s.id)}">
      <div class="ecard-h"><h3>${esc(B.fmtDate(s.date))} <span class="mono">${esc(s.rounds.map(roundSpan).join(" / "))}</span> <span class="pill ${s.status === "cancelled" ? "pill-full" : s.status === "open" ? "pill-ok" : "pill-live"}">${esc(B.sessionLabel(s))}</span>${s.extra ? `<span class="tag">加场</span>` : ""}</h3>
        <div>${s.extra && !s.signups.length ? `<button class="btn btn-xs btn-danger" type="button" data-del-session="${esc(s.id)}">删除加场</button>` : ""}</div></div>
      <div class="form-grid">
        <div class="field"><label class="label">标题（可空）</label><input class="input" name="title" maxlength="30" value="${esc(s.title)}" placeholder="如：期中特别场"></div>
        <div class="field"><label class="label">地点</label><input class="input" name="location" maxlength="40" value="${esc(s.location)}"></div>
        <div class="field span-2"><label class="label">备注（公开显示）</label><input class="input" name="note" maxlength="200" value="${esc(s.note)}" placeholder="如：本周改到 R210 / 停办原因"></div>
        <div class="field"><span class="label">状态</span><label class="check"><input type="checkbox" name="cancelled" ${s.status === "cancelled" ? "checked" : ""}>本场停办</label></div>
        ${roundsEditor(s.rounds, { label: `轮次时间${s.customRounds ? "（本场单独设置）" : "（默认）"}`, reset: s.customRounds })}
      </div>
      <details class="section-block"><summary class="label">本场开放的游戏、套数与每桌人数（不改则用桌游默认设置）</summary>
        <div class="game-cfg"><div class="game-cfg-row head"><span>游戏</span><span>套数</span><span>每桌人数</span></div>
        ${active.map(g => `<div class="game-cfg-row"><label class="check"><input type="checkbox" name="g" value="${esc(g.id)}" ${offered.has(g.id) ? "checked" : ""}>${esc(g.name)}${g.active ? "" : "（已停用）"}</label><input class="input" type="number" min="1" max="20" name="copies_${esc(g.id)}" value="${s.copies[g.id] ?? ""}" placeholder="${g.copies}"><input class="input" type="number" min="1" max="40" name="size_${esc(g.id)}" value="${s.tableSizes[g.id] ?? ""}" placeholder="${g.tableSize || g.max}"></div>`).join("")}
        </div></details>
      <div class="modal-actions"><button class="btn btn-sm btn-primary" type="submit">保存本场设置</button></div>
    </form>`;
  }
  function renderSessions() {
    const box = $("#tab-sessions");
    const up = data.allSessions.filter(s => data.sessions.some(x => x.id === s.id)).sort((a, b) => a.date.localeCompare(b.date));
    const st = data.settings;
    box.innerHTML = `<p class="hint">系统每周自动生成「${WEEK[st.weekday]} ${esc(st.rounds.map(roundSpan).join(" / "))} · ${esc(st.location)}」的场次（共 ${st.rounds.length} 轮），并开放未来 ${st.bookAheadWeeks} 周的预约。某一周要停办、换教室、改时间或改轮数，在下面修改即可；默认轮次在「数据与设置」里改。</p>
      <div class="cards-list section-block">${up.map(sessionCard).join("")}</div>
      <form class="ecard section-block" id="extraForm"><div class="ecard-h"><h3>＋ 加开一场</h3></div>
        <div class="form-grid">
          <div class="field"><label class="label">日期</label><input class="input" type="date" name="date" required></div>
          <div class="field"><label class="label">地点</label><input class="input" name="location" value="${esc(st.location)}" required></div>
          <div class="field span-2"><label class="label">标题</label><input class="input" name="title" maxlength="30" placeholder="如：期末解压特别场"></div>
          ${roundsEditor(st.rounds)}
        </div>
        <div class="modal-actions"><button class="btn btn-sm btn-primary" type="submit">创建</button></div>
      </form>`;
  }
  async function saveSession(form) {
    const id = form.dataset.sessionForm;
    const f = new FormData(form);
    const checked = f.getAll("g");
    if (!checked.length) return B.toast("至少要开放一款游戏", "error");
    const activeIds = data.games.filter(g => g.active).map(g => g.id);
    const same = checked.length === activeIds.length && activeIds.every(x => checked.includes(x));
    const copies = {};
    const tableSizes = {};
    for (const g of data.games) {
      const c = f.get(`copies_${g.id}`);
      const t = f.get(`size_${g.id}`);
      if (c) copies[g.id] = Number(c);
      if (t) tableSizes[g.id] = Number(t);
    }
    const st = data.settings;
    const own = (val, def) => (String(val || "").trim() === def ? "" : val);
    const rounds = readRounds(form);
    const body = { title: f.get("title"), rounds: sameRounds(rounds, st.rounds) ? null : rounds, location: own(f.get("location"), st.location), note: f.get("note"), status: f.get("cancelled") ? "cancelled" : "", gameIds: same ? [] : checked, copies, tableSizes };
    await guard(() => call(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: "PUT", body }), "场次已保存");
  }

  // ---------- 桌游 ----------
  function renderGames() {
    const box = $("#tab-games");
    const list = [...data.games].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
    box.innerHTML = `<div class="toolbar"><button class="btn btn-sm btn-primary" type="button" data-act="new-game">＋ 新增桌游</button><span class="hint">停用的游戏不会出现在游戏库和报名页，历史报名不受影响。</span></div>
      <div class="cards-list">${list
        .map(
          g => `<div class="grow ${g.active ? "" : "off"}" style="--c:${B.color(g)}"><span class="gi">${B.icon(g, 22)}</span>
        <div><b>${esc(g.name)}</b> <span class="tag">${esc(g.group)}</span> <span class="tag">${esc(g.category)}</span>${g.active ? "" : ` <span class="tag tag-wait">已停用</span>`}
        <small>${g.min}–${g.max} 人 · ${g.minutes} 分钟 · ${g.copies} 套 · 每桌 ${g.tableSize || g.max} 人 · ${g.video ? `视频 ${esc(g.video.bvid)}` : "无教学视频"}</small>
        <div class="g-teach"><span class="g-teach-h">🎓 讲规名单</span>${rosterOf(g.id).map(t => `<span class="tchip" title="${esc(`${{ self: "本人在游戏库挂名", signup: "报名时挂名", admin: "管理员代挂" }[t.by] || ""} · ${fmtTime(t.createdAt)}`)}">${esc(t.name)}<button type="button" data-adm-teach-del="${esc(t.id)}" data-name="${esc(t.name)}" data-game="${esc(g.name)}" aria-label="删除 ${esc(t.name)} 的讲规挂名">×</button></span>`).join("") || `<span class="hint">暂无</span>`}<button class="btn btn-xs btn-ghost" type="button" data-adm-teach-add="${esc(g.id)}">＋ 代挂名</button></div></div>
        <div class="acts"><button class="btn btn-xs" type="button" data-edit-game="${esc(g.id)}">编辑</button> <button class="btn btn-xs" type="button" data-toggle-game="${esc(g.id)}">${g.active ? "停用" : "启用"}</button> <button class="btn btn-xs btn-danger" type="button" data-del-game="${esc(g.id)}">删除</button></div></div>`,
        )
        .join("")}</div>`;
  }
  function gameForm(g) {
    const v = (x, d = "") => esc(x ?? d);
    return `<h2 id="modalTitle" class="modal-title">${g ? `编辑：${esc(g.name)}` : "新增桌游"}</h2>
    <form id="gForm" class="form-grid">
      <div class="field"><label class="label">名称 *</label><input class="input" name="name" maxlength="32" required value="${v(g?.name)}"></div>
      <div class="field"><label class="label">英文/原名</label><input class="input" name="en" maxlength="60" value="${v(g?.en)}"></div>
      <div class="field"><label class="label">分类</label><select class="select" name="group">${GROUPS.map(x => `<option ${g?.group === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
      <div class="field"><label class="label">类型标签</label><input class="input" name="category" maxlength="16" value="${v(g?.category)}" placeholder="如：阵营推理"></div>
      <div class="field"><label class="label">最少人数</label><input class="input" type="number" name="min" min="1" max="40" value="${v(g?.min, 2)}"></div>
      <div class="field"><label class="label">最多人数</label><input class="input" type="number" name="max" min="1" max="40" value="${v(g?.max, 4)}"></div>
      <div class="field"><label class="label">时长（分钟）</label><input class="input" type="number" name="minutes" min="5" max="600" value="${v(g?.minutes, 30)}"></div>
      <div class="field"><label class="label">难度</label><select class="select" name="difficulty">${[1, 2, 3].map(d => `<option value="${d}" ${g?.difficulty === d ? "selected" : ""}>${B.DIFF[d]}</option>`).join("")}</select></div>
      <div class="field"><label class="label">拥有套数</label><input class="input" type="number" name="copies" min="1" max="20" value="${v(g?.copies, 1)}"></div>
      <div class="field"><label class="label">每桌人数上限（空=最多人数）</label><input class="input" type="number" name="tableSize" min="1" max="40" value="${v(g?.tableSize)}"></div>
      <div class="field span-all"><span class="label">图标</span><div class="icon-pick">${ICON_KEYS.map(k => `<label><input type="radio" name="icon" value="${k}" ${(g?.icon || "dice") === k ? "checked" : ""}><span>${B.icon({ icon: k }, 22)}</span></label>`).join("")}</div></div>
      <div class="field span-all"><label class="label">一句话介绍</label><input class="input" name="intro" maxlength="200" value="${v(g?.intro)}"></div>
      <div class="field span-all"><label class="label">规则速览（每行一条）</label><textarea class="textarea" name="rules" rows="6" maxlength="3000">${v(g?.rules)}</textarea></div>
      <div class="field span-all"><label class="label">醒目提示（可空）</label><input class="input" name="notice" maxlength="120" value="${v(g?.notice)}" placeholder="如：需提前在群里约"></div>
      <div class="field span-2"><label class="label">教学视频（B 站链接或 BV 号）</label><input class="input" name="video" value="${v(g?.video?.bvid)}" placeholder="https://www.bilibili.com/video/BV..."></div>
      <div class="field span-2"><label class="label">备选视频</label><input class="input" name="videoBackup" value="${v(g?.videoBackup?.bvid)}"></div>
      <div class="field"><span class="label">状态</span><label class="check"><input type="checkbox" name="active" ${g?.active === false ? "" : "checked"}>开放</label></div>
      <div class="modal-actions span-all"><button class="btn btn-ghost" type="button" data-close>取消</button><button class="btn btn-primary" type="submit">保存</button></div>
    </form>`;
  }
  function openGame(id) {
    const g = id ? game(id) : null;
    const m = B.openModal(gameForm(g), { wide: true });
    $("#gForm", m).addEventListener("submit", async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = {};
      for (const k of ["name", "en", "group", "category", "intro", "rules", "notice", "icon", "video", "videoBackup"]) body[k] = f.get(k) ?? "";
      for (const k of ["min", "max", "minutes", "difficulty", "copies"]) body[k] = Number(f.get(k));
      body.tableSize = f.get("tableSize") ? Number(f.get("tableSize")) : null;
      body.active = f.get("active") === "on";
      if (body.max < body.min) return B.toast("最多人数不能小于最少人数", "error");
      const res = await guard(() => (g ? call(`/api/admin/games/${encodeURIComponent(g.id)}`, { method: "PUT", body }) : call("/api/admin/games", { method: "POST", body })), "桌游已保存");
      if (res) B.closeModal();
    });
  }

  // ---------- 数据与设置 ----------
  function renderData() {
    const s = data.settings;
    const box = $("#tab-data");
    box.innerHTML = `
      <div class="${data.storage === "postgres" ? "ok-box" : "warn"}">${data.storage === "postgres" ? "✓ 数据保存在 Postgres 数据库，重启、重新部署都不会丢失。每次修改都会自动留存一个历史版本。" : "⚠ 当前使用服务器本地文件存储。Render 免费实例休眠、重启或重新部署时数据可能丢失。请尽快在 Render 环境变量中配置 DATABASE_URL，并定期点下方“导出备份”。"}</div>
      ${data.storeError ? `<div class="warn">数据存储出错：${esc(data.storeError)}（当前为只读模式）</div>` : ""}
      <section class="section-block"><h2>基础设置</h2>
        <form class="ecard" id="settingsForm"><div class="form-grid">
          <div class="field"><label class="label">社团名称</label><input class="input" name="clubName" maxlength="30" value="${esc(s.clubName)}"></div>
          <div class="field"><label class="label">每周活动日</label><select class="select" name="weekday">${WEEK.map((w, i) => `<option value="${i}" ${s.weekday === i ? "selected" : ""}>${w}</option>`).join("")}</select></div>
          <div class="field"><label class="label">默认地点</label><input class="input" name="location" maxlength="40" value="${esc(s.location)}"></div>
          <div class="field"><label class="label">开放预约周数</label><input class="input" type="number" name="bookAheadWeeks" min="1" max="8" value="${s.bookAheadWeeks}"></div>
          <div class="field span-all"><label class="label">首页公告（留空则不显示）</label><input class="input" name="announcement" maxlength="300" value="${esc(s.announcement)}" placeholder="如：本周新到《拉斯维加斯》，欢迎来试玩！"></div>
          ${roundsEditor(s.rounds, { label: "默认轮次时间（每周场次都按这个）" })}
        </div><div class="modal-actions"><button class="btn btn-sm btn-primary" type="submit">保存设置</button></div></form>
      </section>
      <section class="section-block"><h2>备份与导入</h2>
        <div class="ecard">
          <div class="toolbar"><button class="btn btn-sm" type="button" data-act="export-json">导出完整备份（JSON）</button><button class="btn btn-sm" type="button" data-act="csv-all">导出全部报名（CSV / Excel）</button>
          ${isOwner() ? `<label class="btn btn-sm">导入备份…<input type="file" id="importFile" accept="application/json,.json" hidden></label>` : ""}</div>
          <p class="hint">${isOwner() ? "支持导入本系统导出的备份，也支持旧版「开桌」网站导出的备份（会合并进现有数据，同一场次重名的报名会跳过）。" : "导入备份和恢复历史版本只有所有者可以操作。"}</p>
          <h3 class="label section-block">自动历史版本</h3><div class="backup-list" id="backupList"><p class="hint">加载中…</p></div>
        </div>
      </section>
      ${isOwner() ? adminsSection() : ""}
      <section class="section-block"><h2>操作记录</h2>
        <div class="ecard">${auditHtml()}</div>
      </section>`;
    loadBackups();
  }
  function adminsSection() {
    const list = data.admins || [];
    return `<section class="section-block"><h2>协作管理员</h2>
      <div class="ecard">
        <p class="hint">给帮忙管理的朋友单独发一把密钥：他能管名单、签到、场次、桌游和导出；只有你（所有者）能添加 / 撤销管理员、导入备份和恢复历史版本。撤销后对方的密钥立刻失效。</p>
        <div class="cards-list section-block">${
          list.length
            ? list.map(a => `<div class="backup-row"><span><b>${esc(a.name)}</b> <span class="mono">· 添加于 ${esc(fmtTime(a.createdAt))}</span></span><button class="btn btn-xs btn-danger" type="button" data-revoke="${esc(a.id)}" data-name="${esc(a.name)}">撤销</button></div>`).join("")
            : `<p class="hint">还没有协作管理员。</p>`
        }</div>
        <form class="toolbar section-block" id="addAdminForm"><input class="input" name="name" maxlength="20" placeholder="朋友的名字，如：小王" required><button class="btn btn-sm btn-primary" type="submit">＋ 添加管理员</button></form>
      </div></section>`;
  }
  function auditHtml() {
    const log = data.auditLog || [];
    if (!log.length) return `<p class="hint">还没有记录。之后每次管理操作（代报名、删除、签到、改场次、改桌游、导入、恢复、增减管理员）都会记在这里。</p>`;
    return `<div class="backup-list">${log.map(e => `<div class="backup-row"><span><span class="mono">${esc(fmtTime(e.at))}</span> · <b>${esc(e.actor)}</b> · ${esc(e.action)}</span><span class="hint">${esc(e.detail)}</span></div>`).join("")}</div>`;
  }
  function showNewKey(name, key) {
    const m = B.openModal(`<h2 id="modalTitle" class="modal-title">${esc(name)} 的管理员密钥</h2>
      <p class="modal-text">这把密钥<strong>只显示这一次</strong>，关闭后无法再查看（忘了就撤销重新添加）。请复制后<strong>私聊</strong>发给对方，不要发到群里。</p>
      <input class="input mono" id="newKey" readonly value="${esc(key)}" style="margin-top:14px">
      <p class="modal-text">后台地址：${esc(location.origin)}/admin</p>
      <div class="modal-actions"><button class="btn btn-ghost" type="button" data-close>我已保存</button><button class="btn btn-primary" type="button" id="copyKey">复制密钥和后台地址</button></div>`);
    const input = $("#newKey", m);
    input.addEventListener("focus", () => input.select());
    $("#copyKey", m).addEventListener("click", async () => {
      const text = `开桌桌游社管理后台：${location.origin}/admin
你的管理员密钥：${key}`;
      try {
        await navigator.clipboard.writeText(text);
        B.toast("已复制，可以私聊发给对方了", "ok");
      } catch {
        input.focus();
        input.select();
        B.toast("自动复制失败，请长按 / 全选输入框手动复制");
      }
    });
  }
  async function loadBackups() {
    try {
      const res = await call("/api/admin/backups");
      const el = $("#backupList");
      if (!el) return;
      el.innerHTML = res.backups.length
        ? res.backups.map(b => `<div class="backup-row"><span><span class="mono">v${b.revision}</span> · ${esc(fmtTime(b.updatedAt))} · ${b.games} 款游戏 · ${b.signups} 条报名</span>${b.revision === data.revision ? `<span class="tag">当前</span>` : isOwner() ? `<button class="btn btn-xs" type="button" data-restore="${b.revision}">恢复到此版本</button>` : ""}</div>`).join("")
        : `<p class="hint">暂无</p>`;
    } catch (error) {
      const el = $("#backupList");
      if (el) el.innerHTML = `<p class="err">${esc(error.message)}</p>`;
    }
  }

  // ---------- 渲染 & 事件 ----------
  function render() {
    if (!data) return;
    $("#storageWarn").hidden = data.storage === "postgres";
    $("#storageWarn").innerHTML = data.storage === "postgres" ? "" : `⚠ 当前未连接数据库，报名数据可能在服务器重启后丢失。详见「数据与设置」。`;
    $$(".tabs [data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $$(".tab-panel").forEach(p => (p.hidden = p.id !== `tab-${tab}`));
    renderPicker();
    const focusId = document.activeElement?.id;
    ({ list: renderList, tables: renderTables, sessions: renderSessions, games: renderGames, data: renderData })[tab]();
    if (focusId === "q" && $("#q")) {
      const el = $("#q");
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  function bind() {
    $("#loginForm").addEventListener("submit", async e => {
      e.preventDefault();
      const k = $("#key").value.trim();
      if (!k) return;
      try {
        await B.api("/api/admin/verify", { method: "POST", admin: k });
        key = k;
        try {
          sessionStorage.setItem(KEY, k);
        } catch {}
        $("#key").value = "";
        await load();
      } catch (error) {
        $("#loginErr").textContent = error.message;
      }
    });
    $("#logout").addEventListener("click", () => logout());
    $(".tabs").addEventListener("click", e => {
      const b = e.target.closest("[data-tab]");
      if (!b) return;
      tab = b.dataset.tab;
      render();
    });
    $("#sessionPick").addEventListener("change", e => {
      sid = e.target.value;
      render();
    });
    $("#refreshBtn").addEventListener("click", () => guard(load, "已刷新"));
    const main = $("#app");
    main.addEventListener("compositionend", e => {
      if (e.target.id === "q") {
        q = e.target.value;
        render();
      }
    });
    main.addEventListener("input", e => {
      if (e.isComposing) return;
      if (e.target.id === "q") {
        q = e.target.value;
        clearTimeout(main._t);
        main._t = setTimeout(render, 150);
      }
    });
    main.addEventListener("change", async e => {
      const t = e.target;
      if (t.id === "filter") {
        filter = t.value;
        render();
      } else if (t.dataset.checkin) {
        await guard(() => call(`/api/signups/${encodeURIComponent(t.dataset.checkin)}`, { method: "PATCH", body: { checkedIn: t.checked } }));
      } else if (t.id === "importFile" && t.files[0]) {
        const file = t.files[0];
        t.value = "";
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          return B.toast("文件不是有效的 JSON", "error");
        }
        const legacy = Array.isArray((parsed.state || parsed).events);
        const ok = await B.confirmDialog({ title: legacy ? "导入旧版网站备份？" : "用备份覆盖当前数据？", text: legacy ? "会把旧版的游戏和报名合并进当前数据，不会删除现有内容。" : "当前数据会被备份内容替换（导入前的版本仍可在历史版本里恢复）。", ok: "导入", danger: !legacy });
        if (!ok) return;
        const res = await guard(() => call("/api/admin/import", { method: "POST", body: { data: parsed } }));
        if (res) B.toast(legacy ? `导入完成，合并了 ${res.result.imported} 条报名` : "导入完成", "ok");
      }
    });
    main.addEventListener("submit", async e => {
      const form = e.target;
      if (form.dataset.sessionForm) {
        e.preventDefault();
        await saveSession(form);
      } else if (form.id === "extraForm") {
        e.preventDefault();
        const f = new FormData(form);
        const date = f.get("date");
        const exists = data.allSessions.find(s => s.id === date);
        if (exists && !exists.extra) return B.toast("这一天已经有常规场次了，直接在上面修改即可", "error");
        const rounds = readRounds(form);
        await guard(() => call(`/api/admin/sessions/${encodeURIComponent(date)}`, { method: "PUT", body: { extra: true, rounds: sameRounds(rounds, data.settings.rounds) ? null : rounds, location: f.get("location"), title: f.get("title") } }), "已加开场次");
      } else if (form.id === "addAdminForm") {
        e.preventDefault();
        const name = new FormData(form).get("name");
        const res = await guard(() => call("/api/admin/admins", { method: "POST", body: { name } }), "已添加");
        if (res && res.admin) showNewKey(res.admin.name, res.admin.key);
      } else if (form.id === "settingsForm") {
        e.preventDefault();
        const f = new FormData(form);
        const body = {};
        for (const k of ["clubName", "location", "announcement"]) body[k] = f.get(k) ?? "";
        body.weekday = Number(f.get("weekday"));
        body.bookAheadWeeks = Number(f.get("bookAheadWeeks"));
        body.rounds = readRounds(form);
        await guard(() => call("/api/admin/settings", { method: "PUT", body }), "设置已保存");
      }
    });
    main.addEventListener("click", async e => {
      const t = e.target.closest("button");
      if (!t) return;
      const d = t.dataset;
      if ("roundAdd" in d) {
        const box = t.closest(".field").querySelector(".rounds-edit");
        const rows = $$(".round-row", box);
        if (rows.length >= 4) return B.toast("一晚最多 4 轮", "error");
        const last = rows[rows.length - 1];
        const start = last ? last.querySelector("[name=re]").value : data.settings.rounds[0].start;
        const [h, m] = (start || "19:00").split(":").map(Number);
        const end = `${String((h + 1) % 24).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
        box.insertAdjacentHTML("beforeend", roundRow({ start, end }, rows.length));
        return;
      }
      if ("roundDel" in d) {
        const box = t.closest(".rounds-edit");
        if ($$(".round-row", box).length <= 1) return B.toast("至少保留一轮", "error");
        t.closest(".round-row").remove();
        renumberRounds(box);
        return;
      }
      if ("roundReset" in d) {
        t.closest(".field").querySelector(".rounds-edit").innerHTML = data.settings.rounds.map(roundRow).join("");
        B.toast("已填回默认轮次，点「保存本场设置」生效");
        return;
      }
      if (d.tround !== undefined) {
        tround = Number(d.tround);
        render();
        return;
      }
      if (d.act === "add") openSignup(null);
      else if (d.act === "reallocate") {
        if (await B.confirmDialog({ title: "重新自动分桌？", text: "会按所有人的志愿把本场每一轮重新分一遍，已经坐下开局的桌可能被打乱。只在现场人员变化很大时使用。", ok: "重新分桌", danger: true })) await guard(() => call(`/api/admin/sessions/${encodeURIComponent(sid)}`, { method: "PUT", body: { reallocate: true } }), "已重新分桌");
      } else if (d.act === "print") window.print();
      else if (d.act === "csv" || d.act === "csv-all") {
        const which = d.act === "csv" ? sid : "all";
        try {
          const text = await call(`/api/admin/export.csv?session=${encodeURIComponent(which)}`);
          download(`报名-${which}.csv`, text.charCodeAt(0) === 0xfeff ? text : `﻿${text}`, "text/csv;charset=utf-8");
        } catch (error) {
          B.toast(error.message, "error");
        }
      } else if (d.act === "export-json") {
        try {
          const json = await call("/api/admin/export");
          download(`kaizhuo-backup-v${json.revision}.json`, JSON.stringify(json, null, 2), "application/json");
        } catch (error) {
          B.toast(error.message, "error");
        }
      } else if (d.admTeachDel) {
        if (await B.confirmDialog({ title: `删除「${d.name}」的讲规挂名？`, text: `${d.game}。删除后不再出现在讲规名单里（本人可以重新挂名）。`, ok: "删除", danger: true })) await guard(() => call(`/api/teachers/${encodeURIComponent(d.admTeachDel)}`, { method: "DELETE" }), "已删除");
      } else if (d.admTeachAdd) {
        const g = game(d.admTeachAdd);
        const m = B.openModal(`<h2 id="modalTitle" class="modal-title">代挂讲规名 · ${esc(g?.name || "")}</h2>
          <form id="admTeachForm" class="form-grid"><div class="field span-all"><label class="label" for="admTeachName">称呼 <small>请和对方报名用的称呼一致</small></label><input class="input" id="admTeachName" maxlength="20" required></div>
          <div class="modal-actions span-all"><button class="btn btn-ghost" type="button" data-close>取消</button><button class="btn btn-primary" type="submit">挂名</button></div></form>`);
        setTimeout(() => $("#admTeachName", m).focus(), 50);
        $("#admTeachForm", m).addEventListener("submit", async ev => {
          ev.preventDefault();
          const res = await guard(() => call("/api/teachers", { method: "POST", body: { gameId: d.admTeachAdd, name: $("#admTeachName", m).value } }), "已挂名");
          if (res) B.closeModal();
        });
      } else if (d.act === "new-game") openGame(null);
      else if (d.edit) openSignup(d.edit);
      else if (d.del) {
        const s = view().signups.find(x => x.id === d.del);
        if (await B.confirmDialog({ title: "删除这条报名？", text: `${s?.name || ""} · ${s ? prefsText(s) : ""}`, ok: "删除", danger: true })) await guard(() => call(`/api/signups/${encodeURIComponent(d.del)}`, { method: "DELETE" }), "已删除");
      } else if (d.editGame) openGame(d.editGame);
      else if (d.toggleGame) {
        const g = game(d.toggleGame);
        await guard(() => call(`/api/admin/games/${encodeURIComponent(g.id)}`, { method: "PUT", body: { active: !g.active } }), g.active ? "已停用" : "已启用");
      } else if (d.delGame) {
        const g = game(d.delGame);
        if (await B.confirmDialog({ title: `删除「${g.name}」？`, text: "删除后无法恢复（可从历史版本回滚）。只有从未被报名过的游戏才能删除，否则请用“停用”。", ok: "删除", danger: true })) await guard(() => call(`/api/admin/games/${encodeURIComponent(g.id)}`, { method: "DELETE" }), "已删除");
      } else if (d.delSession) {
        if (await B.confirmDialog({ title: "删除这个加场？", text: B.fmtDate(d.delSession), ok: "删除", danger: true })) await guard(() => call(`/api/admin/sessions/${encodeURIComponent(d.delSession)}`, { method: "DELETE" }), "已删除");
      } else if (d.revoke) {
        if (await B.confirmDialog({ title: `撤销「${d.name}」的管理员权限？`, text: "撤销后对方的密钥立刻失效。以后想再给他权限，重新添加会生成一把新密钥。", ok: "撤销", danger: true })) await guard(() => call(`/api/admin/admins/${encodeURIComponent(d.revoke)}`, { method: "DELETE" }), "已撤销");
      } else if (d.restore) {
        if (await B.confirmDialog({ title: `恢复到 v${d.restore}？`, text: "当前数据会被这个历史版本替换（替换前的版本也会保留在历史里，可以再恢复回来）。", ok: "恢复", danger: true })) {
          const res = await guard(() => call(`/api/admin/backups/${d.restore}/restore`, { method: "POST" }), "已恢复");
          if (res) loadBackups();
        }
      }
    });
    // 弹窗里的按钮不在 #app 内，单独代理“签到”等不需要；弹窗表单自己绑定
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bind();
    if (B.inWeChat()) {
      const w = document.createElement("div");
      w.className = "warn";
      w.textContent = "提示：微信内置浏览器无法导出文件和打印。请点右上角「…」→ 在浏览器打开，再使用导出 / 打印功能。";
      $("#main").prepend(w);
    }
    if (!key) return showLogin();
    try {
      await load();
    } catch (error) {
      if (error.status === 401 || error.status === 403) logout(error.message);
      else showLogin(error.message);
    }
    setInterval(() => {
      if (document.visibilityState === "visible" && key && !document.querySelector("#modal") && tab !== "sessions" && tab !== "data")
        load().catch(e => {
          if (e.status === 401 || e.status === 403) logout("密钥已失效或已被撤销，请重新登录");
        });
    }, 30000);
  });
})();
