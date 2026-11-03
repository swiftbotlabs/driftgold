"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const COLORS = ["var(--c0)", "var(--c1)", "var(--c2)", "var(--c3)"];
  const COVES = ["Amber", "Brine", "Coral", "Dune", "Ember"];
  const LETTERS = "ABCDE";
  const RULES =
    "Everyone starts with 10 oars and no gold. Each round, every captain secretly picks one cove and how many oars to row there; all picks are revealed together. " +
    "Alone at a cove, you take its gold and keep your oars. Where captains meet, the most oars takes the gold and hands the oars it rowed to the captains it beat. " +
    "A tie goes to the captain with less gold. Coves nobody took gain 1-3 gold with the tide; a taken cove restarts at 1. 8 rounds, the last pays double, most gold wins.";

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
  };

  const S = { code: null, token: null, seat: -1, st: null, ver: -1, skew: 0, sel: null, bid: 0, seenRound: -1, players: 4, timer: null, poll: null, log: null, rIdx: 0, busy: false };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  async function api(path, body, token) {
    const opt = { method: body === undefined ? "GET" : "POST", headers: {} };
    if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
    if (token) opt.headers.authorization = "Bearer " + token;
    const r = await fetch(path, opt);
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok) {
      const e = new Error((j && j.error && j.error.message) || "HTTP " + r.status);
      e.code = j && j.error && j.error.code; e.status = r.status; e.body = j;
      throw e;
    }
    return j;
  }

  function show(id) {
    document.body.classList.toggle("at-home", id === "vHome");
    for (const v of ["vHome", "vLobby", "vGame", "vEnd", "vReplay"]) $(v).classList.toggle("hidden", v !== id);
  }
  let toastT = null;
  function toast(nodes, ms = 3800) {
    const t = clear($("toast"));
    t.append(...[nodes].flat());
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), ms);
  }
  const coveName = (i) => `${LETTERS[i]} · ${COVES[i]}`;
  const capName = (caps, seat, short) => {
    const c = caps[seat];
    let n = seat === S.seat ? "You" : (c && c.name) || `Seat ${seat + 1}`;
    if (short) n = n.replace(/ \(bot\)$/, "");
    return h("span", { class: "name", style: `color:${COLORS[seat]}` }, n);
  };
  const myName = () => { const v = ($("nameIn").value || "").trim(); if (v) store.set("dg:name", v); return v || undefined; };

  // ---------- result text (used in game, toast and replay) ----------
  function resultLine(r, caps, moves) {
    const parts = [];
    const nm = (s) => capName(caps, s, true);
    if (!r.captains.length) return null;
    const top = Math.max(...r.oars);
    if (r.captains.length === 1) {
      parts.push(nm(r.captains[0]), ` came alone and took ${r.payout} gold, keeping every oar.`);
    } else if (r.winner === null) {
      const tied = r.captains.filter((s) => moves[s].oars === top);
      parts.push(...joinNames(tied, nm), ` tied with ${top} oar${top === 1 ? "" : "s"}: nobody took it.`);
      const rest = r.captains.filter((s) => !tied.includes(s));
      if (rest.length) parts.push(" (", ...joinNames(rest, nm), " rowed less.)");
    } else {
      const losers = r.captains.filter((s) => s !== r.winner);
      parts.push(nm(r.winner), ` rowed ${moves[r.winner].oars}${r.tie ? " (won the tie: less gold)" : ""} and took ${r.payout} gold. `);
      parts.push(...joinNames(losers, (s) => h("span", null, nm(s), ` (${moves[s].oars})`)));
      if (r.oarsPaid > 0) parts.push(` got ${r.oarsPerCaptain} oar${r.oarsPerCaptain === 1 ? "" : "s"}${losers.length > 1 ? " each" : ""}${r.oarsLost ? `; ${r.oarsLost} sank` : ""}.`);
      else parts.push(" got nothing: the winner rowed 0.");
    }
    return h("div", { class: "res" }, h("span", { class: "cv" }, `${LETTERS[r.cove]} · ${r.payout}`), h("span", { class: "who" }, parts));
  }
  function joinNames(seats, f) {
    const out = [];
    seats.forEach((s, i) => { if (i) out.push(i === seats.length - 1 ? " and " : ", "); out.push(f(s)); });
    return out;
  }

  // ---------- home ----------
  function home(msg) {
    stopPoll();
    S.code = null;
    $("codePill").classList.add("hidden");
    show("vHome");
    $("rulesText").textContent = RULES;
    $("rulesText2").textContent = RULES;
    const nm = store.get("dg:name");
    if (nm && !$("nameIn").value) $("nameIn").value = nm;
    $("homeErr").textContent = msg || "";
  }
  $("playersSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.players = +b.dataset.n;
    for (const x of $("playersSeg").children) x.classList.toggle("on", x === b);
  });
  async function create(start) {
    if (S.busy) return; S.busy = true;
    $("homeErr").textContent = "";
    try {
      const r = await api("/api/match", { players: S.players, name: myName() || "Captain", kind: "human", start });
      store.set("dg:" + r.code, { token: r.token, seat: r.seat });
      go(r.code);
    } catch (e) { $("homeErr").textContent = e.message; }
    finally { S.busy = false; }
  }
  $("quickBtn").onclick = () => create(true);
  $("tableBtn").onclick = () => create(false);
  $("joinBtn").onclick = () => {
    const c = ($("joinIn").value || "").trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(c)) { $("homeErr").textContent = "Codes are 5 letters/digits, like K7QPX."; return; }
    go(c);
  };
  $("joinIn").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });

  function go(code) {
    history.pushState(null, "", "/?m=" + code);
    openMatch(code);
  }

  // ---------- match ----------
  async function openMatch(code) {
    S.code = code;
    const saved = store.get("dg:" + code);
    S.token = saved && saved.token; S.seat = saved ? saved.seat : -1;
    S.ver = -1; S.seenRound = -1; S.sel = null;
    $("codePill").textContent = code; $("codePill").classList.remove("hidden");
    try { await refresh(true); } catch (e) { home(e.status === 404 ? `No match with code ${code}.` : e.message); return; }
    startPoll();
  }
  async function refresh(force) {
    const st = await api(`/api/match/${S.code}`, undefined, S.token);
    S.skew = st.serverTime - Date.now();
    if (st.you) S.seat = st.you.seat; else if (S.token) { S.token = null; S.seat = -1; }
    if (force || st.version !== S.ver || st.phase !== (S.st && S.st.phase)) { S.ver = st.version; S.st = st; render(); }
  }
  function startPoll() {
    stopPoll();
    S.poll = setInterval(() => { if (!document.hidden) refresh(false).catch(() => {}); }, 1500);
    S.timer = setInterval(tickTimer, 250);
  }
  function stopPoll() { clearInterval(S.poll); clearInterval(S.timer); S.poll = S.timer = null; }

  function render() {
    const st = S.st;
    if (st.phase === "lobby") return renderLobby(st);
    if (st.phase === "play") return renderGame(st);
    if (st.phase === "over") return renderEnd(st);
    home("That table expired before it started.");
  }

  // ---------- lobby ----------
  function renderLobby(st) {
    show("vLobby");
    $("lobbyCode").textContent = st.code;
    const link = `${location.origin}/?m=${st.code}`;
    $("lobbyLink").textContent = link;
    $("agentHint").textContent = `POST ${location.origin}/api/match/${st.code}/join`;
    const ul = clear($("seatList"));
    st.captains.forEach((c, i) => ul.append(h("li", null, h("span", { class: "dot", style: `background:${COLORS[i]}` }),
      h("span", { class: "grow" }, c.name ? c.name + (c.you ? " (you)" : "") : h("span", { class: "muted" }, "Empty: a bot sits here on start")),
      h("span", { class: "small muted" }, c.kind === "empty" ? "" : c.kind))));
    const seated = S.seat >= 0;
    $("startBtn").classList.toggle("hidden", !seated);
    $("lobbyJoin").classList.toggle("hidden", seated);
    if (!seated && !$("nameIn2").value) $("nameIn2").value = store.get("dg:name") || "";
  }
  $("copyBtn").onclick = async () => {
    const link = `${location.origin}/?m=${S.code}`;
    try { await navigator.clipboard.writeText(link); toast("Invite link copied.", 1800); } catch { toast(link, 5000); }
  };
  $("startBtn").onclick = async () => {
    try { const r = await api(`/api/match/${S.code}/start`, {}, S.token); S.st = r.state; S.ver = r.state.version; render(); }
    catch (e) { $("lobbyErr").textContent = e.message; }
  };
  $("takeSeatBtn").onclick = async () => {
    try {
      const nm = ($("nameIn2").value || "").trim();
      if (nm) store.set("dg:name", nm);
      const r = await api(`/api/match/${S.code}/join`, { name: nm || "Captain", kind: "human" });
      store.set("dg:" + S.code, { token: r.token, seat: r.seat });
      S.token = r.token; S.seat = r.seat; S.st = r.state; S.ver = r.state.version; render();
    } catch (e) { $("lobbyErr").textContent = e.message; }
  };

  // ---------- game ----------
  function renderCaps(el, caps, gold, st, oars, prev, pulse) {
    clear(el);
    const max = Math.max(1, ...gold);
    const lead = Math.max(...gold);
    const soleLead = gold.filter((x) => x === lead).length === 1;
    caps.forEach((c, i) => {
      const status = st ? (c.moved ? "ready" : "choosing") : c.kind;
      const dG = prev ? prev.goldAfter[i] - prev.goldBefore[i] : 0;
      const dO = prev ? prev.oarsAfter[i] - prev.oarsBefore[i] : 0;
      const oarTxt = `${oars[i]} oar${oars[i] === 1 ? "" : "s"}${dO ? ` (${dO > 0 ? "+" : ""}${dO})` : ""}`;
      el.append(h("div", { class: "cap" + (i === S.seat ? " you" : "") + (pulse && (dG || dO) ? " pulse" : "") },
        h("span", { class: "dot", style: `background:${COLORS[i]}` }),
        h("div", { class: "info grow" },
          h("span", { class: "nm" }, (i === S.seat ? "You" : (c.name || "").replace(/ \(bot\)$/, "")) + (soleLead && gold[i] === lead ? " ★" : "")),
          h("span", { class: "st" }, `${oarTxt} · ${c.kind === "bot" ? "bot" : status}`),
          h("div", { class: "bar" }, h("i", { style: `width:${Math.round((100 * gold[i]) / max)}%;background:${COLORS[i]}` }))),
        h("span", { class: "gd" }, h("span", { class: "coin sm" }), gold[i], dG ? h("sup", { class: "delta" }, `+${dG}`) : null)));
    });
  }

  function renderGame(st) {
    show("vGame");
    const prev = st.previous;
    const fresh = st.round !== S.seenRound;
    if (st.round !== S.seenRound) {
      if (S.seenRound !== -1 && prev) announce(prev, st);
      S.seenRound = st.round;
      S.sel = st.you && st.you.move ? st.you.move.cove : null;
      if (st.you && st.you.move) S.bid = st.you.move.oars;
    }
    $("roundLbl").textContent = `Round ${st.round}/${st.rounds}`;
    $("dblBadge").classList.toggle("hidden", !st.finalRound);
    renderCaps($("caps"), st.captains, st.captains.map((c) => c.gold), st, st.captains.map((c) => c.oars), prev, fresh && S.seenRound !== 1);
    const player = !!st.you;
    const waiting = st.captains.filter((c) => !c.moved).length;
    const p = clear($("prompt"));
    if (!player) p.append("You are watching. ", h("b", null, `${waiting} captain${waiting === 1 ? "" : "s"}`), " still choosing.");
    else if (st.you.moved) p.append("Sent: ", h("b", null, `${st.you.move.oars} oar${st.you.move.oars === 1 ? "" : "s"} to ${coveName(st.you.move.cove)}`), `. Waiting for ${waiting} captain${waiting === 1 ? "" : "s"}; you can change it until the round closes.`);
    else p.append(h("b", null, "Pick a cove and how many oars to row."), ` You have ${st.you.oars} oars and ${st.you.gold} gold.${st.finalRound ? " Final round: every cove pays double, and oars are worth nothing after it." : ""}`);

    const cv = clear($("coves"));
    cv.className = `coves n${st.coves.length}`;
    st.coves.forEach((c) => {
      const pr = prev && prev.results[c.cove];
      let note = "";
      const tide = prev && prev.tide ? prev.tide[c.cove] : null;
      if (pr) note = pr.winner === null ? `${pr.captains.length ? "tied, " : ""}tide +${tide === null ? "?" : tide}` : "taken, restarted";
      const visitors = pr ? pr.captains : [];
      const sel = S.sel === c.cove;
      const won = pr && pr.winner !== null && fresh && S.seenRound !== 1;
      cv.append(h("button", { class: "cove" + (sel ? " sel" : "") + (player ? "" : " disabled") + (won ? " flash" : ""), style: won ? `--wc:${COLORS[pr.winner]}` : null, "aria-pressed": sel ? "true" : "false", onclick: () => pickCove(c.cove) },
        h("div", { class: "lbl" }, coveName(c.cove)),
        h("div", { class: "amt" }, h("span", { class: "coin" }), c.payout, c.payout !== c.gold ? h("span", { class: "x2" }, `(${c.gold} x2)`) : null),
        h("div", { class: "visitors", title: "came here last round" }, visitors.map((s) => h("span", { class: "dot", style: `background:${COLORS[s]}` }))),
        h("div", { class: "note" }, note),
        sel ? h("span", { class: "pick" }, st.you && st.you.moved && st.you.move.cove === c.cove ? "sent" : "your pick") : null));
    });
    $("dock").classList.toggle("hidden", !player);
    if (player) renderDock(st);
    renderLast(prev, st.captains);
    tickTimer();
  }

  function pickCove(i) {
    if (!S.st || !S.st.you) return;
    S.sel = i;
    renderGame(S.st);
  }

  function renderDock(st) {
    const oars = st.you.oars;
    S.bid = Math.max(0, Math.min(S.bid, oars));
    const rng = $("bidRange");
    rng.max = String(oars); rng.value = String(S.bid);
    $("bidVal").textContent = S.bid;
    const chips = clear($("chips"));
    const pay = S.sel !== null ? st.coves[S.sel].payout : null;
    const opts = [["none (0)", 0]];
    if (pay !== null) { const k = Math.min(oars, Math.floor(pay / 2) + 1); opts.push([`just over half the gold (${k})`, k]); }
    opts.push([`all (${oars})`, oars]);
    for (const [lbl, v] of opts) chips.append(h("button", { class: "chip", onclick: () => setBid(v) }, lbl));
    const hint = clear($("hint"));
    if (pay !== null) {
      const b = S.bid;
      hint.append("Alone: ", h("b", null, `+${pay} gold`), ", keep your oars. Most oars where captains meet: ", h("b", null, `+${pay} gold`),
        b > 0 ? `, your ${b} oar${b === 1 ? "" : "s"} go to the captains you beat. ` : ". ", "Outrowed: you collect their oars.");
    } else hint.textContent = "Tap a cove to see what it would pay you.";
    const btn = $("sendBtn");
    const sent = st.you.move;
    const same = sent && sent.cove === S.sel && sent.oars === S.bid;
    btn.disabled = S.sel === null || same;
    btn.textContent = S.sel === null ? "Pick a cove" : same ? "Sent. Waiting for the others" : `${sent ? "Change to" : "Row"} ${S.bid} oar${S.bid === 1 ? "" : "s"} to ${coveName(S.sel)}`;
  }
  function setBid(v) { S.bid = v; if (S.st && S.st.phase === "play") renderDock(S.st); }
  $("bidRange").addEventListener("input", (e) => setBid(+e.target.value));
  $("minus").onclick = () => setBid(Math.max(0, S.bid - 1));
  $("plus").onclick = () => setBid(Math.min(S.st && S.st.you ? S.st.you.oars : 0, S.bid + 1));
  $("sendBtn").onclick = async () => {
    const st = S.st;
    if (!st || !st.you || S.sel === null) return;
    const btn = $("sendBtn");
    btn.disabled = true;
    try {
      const r = await api(`/api/match/${S.code}/move`, { round: st.round, cove: S.sel, oars: S.bid }, S.token);
      S.st = r.state; S.ver = r.state.version; render();
    } catch (e) {
      toast(e.code === "round_over" ? "That round already closed." : e.message, 2500);
      refresh(true).catch(() => {});
    }
  };

  function renderLast(prev, caps, el) {
    const card = clear(el || $("lastCard"));
    if (!prev) { card.append(h("h3", null, "First round"), h("p", { class: "muted small", style: "margin:0" }, "Nobody has moved yet. The richest cove draws a crowd; a quiet cove pays for free. Losing a fight is not wasted: the winner's oars come to you.")); return; }
    card.append(h("h3", null, `Round ${prev.round} results${prev.double ? " (paid x2)" : ""}`));
    let any = false;
    for (const r of prev.results) { const line = resultLine(r, caps, prev.moves); if (line) { card.append(line); any = true; } }
    if (!any) card.append(h("p", { class: "muted" }, "Nobody moved."));
    const autos = prev.moves.filter((m) => m.auto).map((m) => m.seat);
    if (autos.length) card.append(h("p", { class: "small muted" }, "Out of time, played by the house bot: ", ...joinNames(autos, (s) => capName(caps, s)), "."));
  }

  function announce(prev, st) {
    if (S.seat < 0) return;
    const me = S.seat;
    const r = prev.results.find((x) => x.captains.includes(me));
    const mv = prev.moves[me];
    const auto = mv && mv.auto ? " (time ran out: the house bot moved for you)" : "";
    if (!r) return;
    const dOars = prev.oarsAfter[me] - prev.oarsBefore[me];
    let msg;
    if (r.winner === me) msg = r.captains.length === 1 ? `Alone at ${COVES[r.cove]}: +${r.payout} gold.` : `You took ${COVES[r.cove]}: +${r.payout} gold, ${-dOars} oar${dOars === -1 ? "" : "s"} handed over.`;
    else if (r.winner === null) msg = `Tie at ${COVES[r.cove]}: nobody took it.`;
    else msg = h("span", null, capName(st.captains, r.winner, true), ` outrowed you at ${COVES[r.cove]}. You got +${dOars} oar${dOars === 1 ? "" : "s"}.`);
    toast([h("b", null, `Round ${prev.round}: `), msg, auto]);
  }

  function tickTimer() {
    const st = S.st;
    if (!st || st.phase !== "play" || !st.roundEndsAt) return;
    const left = Math.max(0, (st.roundEndsAt - (Date.now() + S.skew)) / 1000);
    $("secs").textContent = `${Math.ceil(left)}s`;
    $("timerFill").style.width = `${Math.min(100, (100 * left) / st.roundSeconds)}%`;
    $("timer").classList.toggle("low", left < 8);
    if (left <= 0) refresh(false).catch(() => {});
  }

  // ---------- end ----------
  async function renderEnd(st) {
    stopPoll();
    show("vEnd");
    if (S.seenRound !== -1 && st.previous && S.seenRound !== "over") announce(st.previous, st);
    S.seenRound = "over";
    if (st.previous) renderLast(st.previous, st.captains, $("endLast"));
    $("endLast").classList.toggle("hidden", !st.previous);
    const gold = st.captains.map((c) => c.gold);
    const w = st.winners || [];
    const title = $("winTitle");
    if (w.length > 1) title.textContent = "Shared win";
    else if (w[0] === S.seat) title.textContent = "You win!";
    else title.textContent = `${st.captains[w[0]].name} wins`;
    $("winSub").textContent = `${Math.max(...gold)} gold after ${st.rounds} rounds`;
    const oarsLeft = st.captains.map((c) => c.oars);
    const order = gold.map((_, i) => i).sort((a, b) => gold[b] - gold[a] || oarsLeft[b] - oarsLeft[a]);
    const box = clear($("standings"));
    order.forEach((s, k) => box.append(h("div", { class: "stand" }, h("span", { class: "pl" }, k + 1), h("span", { class: "dot", style: `background:${COLORS[s]}` }),
      h("span", null, s === S.seat ? "You" : st.captains[s].name), h("span", { class: "small muted" }, `${st.captains[s].oars} oars left`), h("span", { class: "gd" }, gold[s]))));
    try { S.log = await api(`/api/match/${S.code}/log`); drawChart(S.log); } catch { /* chart is optional */ }
  }
  function drawChart(log) {
    const svg = $("chart");
    clear(svg);
    const n = log.captains.length;
    const series = [];
    for (let s = 0; s < n; s++) series.push([0, ...log.rounds.map((r) => r.goldAfter[s])]);
    const max = Math.max(1, ...series.flat());
    const W = Math.max(240, Math.round(svg.getBoundingClientRect().width) || 320), H = 170, pad = 16;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const X = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, log.rounds.length);
    const Y = (v) => H - pad - (v * (H - 2 * pad)) / max;
    const NS = "http://www.w3.org/2000/svg";
    for (let k = 0; k <= 4; k++) {
      const l = document.createElementNS(NS, "line");
      const y = Y((max * k) / 4);
      Object.entries({ x1: pad, x2: W - pad, y1: y, y2: y, stroke: "#1f4b6e", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }).forEach(([a, b]) => l.setAttribute(a, b));
      svg.append(l);
    }
    const txt = (x, y, str, anchor) => {
      const t = document.createElementNS(NS, "text");
      Object.entries({ x, y, fill: "#9fb8cc", "font-size": 11, "text-anchor": anchor || "start" }).forEach(([a, b]) => t.setAttribute(a, b));
      t.textContent = str;
      svg.append(t);
    };
    txt(pad, Y(max) - 3, `${max} gold`);
    txt(W - pad, H - 2, `round ${log.rounds.length}`, "end");
    txt(pad, H - 2, "start");
    series.forEach((pts, s) => {
      const p = document.createElementNS(NS, "polyline");
      p.setAttribute("points", pts.map((v, i) => `${X(i)},${Y(v)}`).join(" "));
      Object.entries({ fill: "none", stroke: ["#43d6c6", "#ff8f66", "#b99bff", "#a6e36a"][s], "stroke-width": s === S.seat ? 3.5 : 2.2, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }).forEach(([a, b]) => p.setAttribute(a, b));
      svg.append(p);
    });
    const lg = clear($("legend"));
    log.captains.forEach((c, s) => lg.append(h("span", { class: "row", style: "gap:6px;margin-right:12px" }, h("span", { class: "dot", style: `background:${COLORS[s]}` }), s === S.seat ? "You" : c.name)));
  }
  $("againBtn").onclick = async () => {
    try {
      const nm = store.get("dg:name") || "Captain";
      const r = await api("/api/match", { players: S.st.players, name: nm, kind: "human", start: true });
      store.set("dg:" + r.code, { token: r.token, seat: r.seat });
      go(r.code);
    } catch (e) { toast(e.message, 2500); }
  };
  $("replayBtn").onclick = () => { history.pushState(null, "", `/?replay=${S.code}`); openReplay(S.code); };

  // ---------- replay ----------
  async function openReplay(code) {
    stopPoll();
    S.code = code;
    const saved = store.get("dg:" + code);
    S.seat = saved ? saved.seat : -1;
    $("codePill").textContent = code; $("codePill").classList.remove("hidden");
    try { S.log = await api(`/api/match/${code}/log`); } catch (e) { home(e.message); return; }
    if (!S.log.rounds.length) { home("No rounds played yet in that match."); return; }
    S.rIdx = 0;
    $("rJson").href = `/api/match/${code}/log`;
    show("vReplay");
    renderReplay();
  }
  function renderReplay() {
    const log = S.log;
    const r = log.rounds[S.rIdx];
    const caps = log.captains;
    $("rLbl").textContent = `Round ${r.round} of ${log.rounds.length}${r.double ? " (x2)" : ""}`;
    $("rPrev").disabled = S.rIdx === 0;
    $("rNext").disabled = S.rIdx === log.rounds.length - 1;
    renderCaps($("rCaps"), caps, r.goldAfter, null, r.oarsAfter, r, false);
    $("rCapsLbl").textContent = `Gold and oars after round ${r.round}. Coves show what they paid; under each: who came and how many oars they rowed.`;
    const cv = clear($("rCoves"));
    cv.className = `coves n${r.coves.length}`;
    r.coves.forEach((c) => {
      const res = r.results[c.cove];
      cv.append(h("div", { class: "cove disabled" },
        h("div", { class: "lbl" }, coveName(c.cove)),
        h("div", { class: "amt" }, h("span", { class: "coin" }), c.payout),
        h("div", { class: "visitors" }, res.captains.map((s) => h("span", { class: "dot", style: `background:${COLORS[s]}` }))),
        h("div", { class: "note" }, res.captains.length ? res.captains.map((s) => `${s === S.seat ? "You" : caps[s].name.replace(" (bot)", "")}: ${r.moves[s].oars}${s === res.winner && res.captains.length > 1 ? " (won)" : ""}`).join(", ") : "nobody")));
    });
    const box = clear($("rRes"));
    for (const res of r.results) { const l = resultLine(res, caps, r.moves); if (l) box.append(l); }
    if (S.rIdx === log.rounds.length - 1 && log.final) {
      const w = log.final.winners;
      box.append(h("p", null, h("b", null, w.length > 1 ? "Shared win: " : "Winner: "), ...joinNames(w, (s) => capName(caps, s)), ` with ${log.final.gold[w[0]]} gold.`));
    }
  }
  let autoT = null;
  function stopAuto() { clearInterval(autoT); autoT = null; $("rPlay").textContent = "Play"; }
  $("rPlay").onclick = () => {
    if (autoT) return stopAuto();
    if (S.rIdx >= S.log.rounds.length - 1) { S.rIdx = 0; renderReplay(); }
    $("rPlay").textContent = "Pause";
    autoT = setInterval(() => { if (S.rIdx < S.log.rounds.length - 1) { S.rIdx++; renderReplay(); } else stopAuto(); }, 1800);
  };
  $("rPrev").onclick = () => { stopAuto(); if (S.rIdx > 0) { S.rIdx--; renderReplay(); } };
  $("rNext").onclick = () => { stopAuto(); if (S.rIdx < S.log.rounds.length - 1) { S.rIdx++; renderReplay(); } };
  $("rBack").onclick = () => { stopAuto(); history.pushState(null, "", `/?m=${S.code}`); openMatch(S.code); };
  $("logBtn").onclick = () => {
    if (!S.st || !S.st.previous) { toast("The log fills in after round 1.", 2000); return; }
    history.pushState(null, "", `/?replay=${S.code}`);
    openReplay(S.code);
  };

  // Desktop shortcuts: 1-5 pick a cove, arrows change the bid, Enter sends.
  document.addEventListener("keydown", (e) => {
    const st = S.st;
    if (!st || st.phase !== "play" || !st.you || $("vGame").classList.contains("hidden")) return;
    if (e.target && e.target.tagName === "INPUT" && e.target.type === "text") return;
    if (/^[1-5]$/.test(e.key) && +e.key <= st.coves.length) { pickCove(+e.key - 1); e.preventDefault(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowRight") { setBid(Math.min(st.you.oars, S.bid + 1)); e.preventDefault(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { setBid(Math.max(0, S.bid - 1)); e.preventDefault(); }
    else if (e.key === "Enter" && !$("sendBtn").disabled) { $("sendBtn").click(); e.preventDefault(); }
  });

  // ---------- boot ----------
  function boot() {
    const q = new URLSearchParams(location.search);
    const m = (q.get("m") || "").toUpperCase();
    const rp = (q.get("replay") || "").toUpperCase();
    if (/^[A-HJ-NP-Z2-9]{5}$/.test(rp)) openReplay(rp);
    else if (/^[A-HJ-NP-Z2-9]{5}$/.test(m)) openMatch(m);
    else home();
  }
  window.addEventListener("popstate", boot);
  boot();
})();
