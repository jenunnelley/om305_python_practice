/* OM 305 Python Practice — runs entirely in the browser. */
"use strict";

// ------------------------------------------------------------------ settings you can change
const CONFIG = {
  LOCK_PARTS: false,       // true = students must finish (or test out of) a part before the next one opens
  JUMP_AHEAD: true,        // locked levels offer a one-shot "Jump ahead" challenge problem
  TEST_OUT_STREAK: 2,      // first-try correct answers in a row needed to test out of a level
  MIN_LEVEL_SIZE: 3,       // levels smaller than this can't be tested out of
  STRUGGLE_FAILS: 3,       // wrong checks on one problem before the level turns off test-out
  STRUGGLE_HINTS: 2,       // hints on one problem before the level turns off test-out
  NO_TEST_OUT_PARTS: [6],  // exam-style practice: do every question
  CALL_TIMEOUT_MS: 25000,
};
const STORE_KEY = "om305-practice-v1";

// ------------------------------------------------------------------ state
let PROBLEMS = [];
let INTRO = {};
let BYID = {};
let PARTS = [];
let pyReady = false;
let state = loadState();
let view = { screen: "welcome", pid: null, revealedHints: 0, feedback: null, output: null, partDone: null };

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.probs) return s;
  } catch (e) { /* storage blocked: start fresh */ }
  return { name: "", probs: {}, levels: {}, current: null };
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}
function ps(id) { return state.probs[id] || (state.probs[id] = { status: null, fails: 0, hints: 0, firstTry: false }); }
function ls(key) { return state.levels[key] || (state.levels[key] = { mastered: false, struggle: false, streak: 0 }); }
const levelKey = (p) => p.part + "|" + p.level;

// ------------------------------------------------------------------ structure helpers
function buildParts() {
  PARTS = [];
  for (const p of PROBLEMS) {
    let part = PARTS.find((x) => x.num === p.part);
    if (!part) { part = { num: p.part, title: p.partTitle, levels: [] }; PARTS.push(part); }
    let lv = part.levels.find((l) => l.key === levelKey(p));
    if (!lv) { lv = { key: levelKey(p), name: p.level, part: p.part, ids: [] }; part.levels.push(lv); }
    lv.ids.push(p.id);
  }
}
const levelOf = (id) => { const p = BYID[id]; return PARTS.find((x) => x.num === p.part).levels.find((l) => l.key === levelKey(p)); };
const partOf = (num) => PARTS.find((x) => x.num === num);
const isDone = (id) => { const s = state.probs[id]; return !!(s && (s.status === "solved" || s.status === "skipped")) || ls(levelOf(id).key).mastered; };
const levelComplete = (lv) => ls(lv.key).mastered || lv.ids.every((id) => isDone(id));
const partComplete = (part) => part.levels.every(levelComplete);
function partUnlocked(part) {
  if (!CONFIG.LOCK_PARTS) return true;
  const i = PARTS.indexOf(part);
  return i === 0 || partComplete(PARTS[i - 1]) || part.levels.some((lv) => lv.ids.some((id) => state.probs[id] && state.probs[id].status));
}
function levelUnlocked(lv) {
  const part = partOf(lv.part);
  if (!partUnlocked(part)) return false;
  const i = part.levels.indexOf(lv);
  return i === 0 || ls(lv.key).unlocked || levelComplete(part.levels[i - 1]) || lv.ids.some((id) => state.probs[id] && state.probs[id].status);
}
// a problem the student can use for a jump-ahead challenge (hardest first), or null
function solvedCount() {
  return Object.values(state.probs).filter((x) => x.status === "solved").length;
}
function jumpCandidate(lv) {
  const lvs = ls(lv.key);
  if (lvs.jumpWaitUntil != null && solvedCount() <= lvs.jumpWaitUntil) return null;
  for (let k = lv.ids.length - 1; k >= 0; k--) {
    const s = state.probs[lv.ids[k]];
    if (!s || (!s.status && !s.jumpFailed && !s.fails && !s.hints)) return lv.ids[k];
  }
  return null;
}
function startJump(lv) {
  const pid = jumpCandidate(lv);
  if (!pid) {
    alert("You've used your jump-ahead tries for this level. Work through the earlier levels to open it.");
    return;
  }
  goto(pid);
  view.jump = { pid, key: lv.key };
  render();
}
function canTestOut(lv) {
  return !CONFIG.NO_TEST_OUT_PARTS.includes(lv.part) && lv.ids.length >= CONFIG.MIN_LEVEL_SIZE;
}
function nextInPart(partNum) {
  const part = partOf(partNum);
  for (const lv of part.levels) {
    if (levelComplete(lv)) continue;
    for (const id of lv.ids) if (!isDone(id)) return id;
  }
  return null;
}
function counts(ids) {
  let solved = 0, tested = 0, skipped = 0;
  for (const id of ids) {
    const s = state.probs[id];
    if (s && s.status === "solved") solved++;
    else if (s && s.status === "skipped") skipped++;
    else if (ls(levelOf(id).key).mastered) tested++;
  }
  return { solved, tested, skipped, total: ids.length };
}

// ------------------------------------------------------------------ worker
let worker = null;
let callId = 0;
const pending = new Map();
let workerTimer = null;

function startWorker() {
  pyReady = false;
  worker = new Worker("worker.js");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "bank") onBank(m);
    else if (m.type === "status") setPyStatus(m.text, false);
    else if (m.type === "ready") { pyReady = true; setPyStatus("Python is ready", true); render(); }
    else if (m.type === "result") {
      const cb = pending.get(m.id);
      if (cb) { pending.delete(m.id); clearTimeout(cb.timer); cb.resolve(m.data); }
    }
  };
  worker.onerror = (e) => setPyStatus("Python couldn't start. Try reloading the page. (" + (e.message || "error") + ")", false);
  worker.postMessage({ type: "init" });
}
function call(type, payload) {
  return new Promise((resolve) => {
    const id = ++callId;
    const timer = setTimeout(() => {
      // runaway code: restart Python
      pending.delete(id);
      worker.terminate();
      for (const [, cb] of pending) cb.resolve({ crash: "restarted" });
      pending.clear();
      startWorkerQuiet();
      resolve({ timeout: true });
    }, CONFIG.CALL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    worker.postMessage(Object.assign({ type, id }, payload));
  });
}
function startWorkerQuiet() {
  setPyStatus("Restarting Python…", false);
  const keepBank = PROBLEMS.length > 0;
  pyReady = false;
  worker = new Worker("worker.js");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "bank" && !keepBank) onBank(m);
    else if (m.type === "status") setPyStatus(m.text, false);
    else if (m.type === "ready") { pyReady = true; setPyStatus("Python is ready", true); render(); }
    else if (m.type === "result") {
      const cb = pending.get(m.id);
      if (cb) { pending.delete(m.id); clearTimeout(cb.timer); cb.resolve(m.data); }
    }
  };
  worker.postMessage({ type: "init" });
  render();
}

function setPyStatus(text, ready) {
  const el = document.getElementById("pyStatus");
  document.getElementById("pyStatusText").textContent = text;
  el.classList.toggle("ready", ready);
  el.classList.remove("hidden");
  if (ready) setTimeout(() => el.classList.add("hidden"), 2500);
}

function onBank(m) {
  PROBLEMS = m.problems;
  INTRO = m.intro || {};
  BYID = {};
  for (const p of PROBLEMS) BYID[p.id] = p;
  buildParts();
  if (state.current && BYID[state.current]) { view.screen = "problem"; view.pid = state.current; }
  render();
}

// ------------------------------------------------------------------ tiny markdown
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => "<code>" + esc(c) + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function md(text) {
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
  return blocks.map((b) => {
    const lines = b.split("\n");
    if (lines.every((l) => l.trim().startsWith("|"))) {
      const rows = lines.filter((l) => !/^\s*\|[\s|:-]+\|\s*$/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      const [head, ...body] = rows;
      return "<table><thead><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>" +
        body.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
    }
    if (lines.every((l) => l.trim().startsWith(">"))) {
      return "<blockquote>" + lines.map((l) => inline(l.trim().replace(/^>\s?/, ""))).join("<br>") + "</blockquote>";
    }
    if (/^\s*</.test(b) && /<\/(div|ol|ul|table)>\s*$/.test(b)) return b;
    return "<p>" + lines.map((l) => inline(l.replace(/\s+$/, ""))).join("<br>") + "</p>";
  }).join("");
}

function introFor(p) {
  let t = INTRO[levelKey(p)];
  if (!t) return "";
  t = t.replace(/<div style="color:#C00000">[\s\S]*?<\/div>/, "**`CoffeeCart.csv` is already loaded in this tool.** Read it in with `pd.read_csv(\"CoffeeCart.csv\")`. You can also [download CoffeeCart.csv](CoffeeCart.csv) to look at it in Excel or use it in Jupyter.");
  t = t.replace("Run the cell below to build the DataFrame.", "The `race_data` DataFrame is already built for you. Click its name below to see it.");
  t = t.replace("The `weekly_sales` array from Level 2", "The `weekly_sales` array");
  return t;
}

// ------------------------------------------------------------------ rendering
function render() {
  renderTop();
  renderSidebar();
  const main = document.getElementById("main");
  if (!PROBLEMS.length) return;
  if (view.screen === "problem" && view.pid) renderProblem(main);
  else if (view.screen === "partDone") renderPartDone(main);
  else renderWelcome(main);
}

function renderTop() {
  const el = document.getElementById("topProgress");
  if (!PROBLEMS.length) { el.innerHTML = ""; return; }
  const c = counts(PROBLEMS.map((p) => p.id));
  const done = c.solved + c.tested + c.skipped;
  const pct = Math.round((100 * done) / c.total);
  el.innerHTML = '<span class="bar"><span style="width:' + pct + '%"></span></span><span>' + pct + '%</span><span class="label">' +
    c.solved + " solved" + (c.tested ? " · " + c.tested + " tested out" : "") + "</span>";
}

function renderSidebar() {
  const sb = document.getElementById("sidebar");
  sb.innerHTML = "";
  const curPart = view.pid ? BYID[view.pid].part : null;
  for (const part of PARTS) {
    const unlocked = partUnlocked(part);
    const done = partComplete(part);
    const c = counts(part.levels.flatMap((l) => l.ids));
    const wrap = document.createElement("div");
    wrap.className = "part" + (done ? " done" : "") + (unlocked ? "" : " locked") + (curPart === part.num || (!curPart && part.num === 1) ? "" : " collapsed");
    const head = document.createElement("button");
    head.className = "part-head";
    head.innerHTML = '<span class="num">' + (done ? "✓" : part.num) + "</span><span>" + esc(part.title) + '</span><span class="meta">' +
      (unlocked ? c.solved + c.tested + c.skipped + "/" + c.total : "🔒") + "</span>";
    head.onclick = () => wrap.classList.toggle("collapsed");
    wrap.appendChild(head);
    const lvWrap = document.createElement("div");
    lvWrap.className = "levels";
    for (const lv of part.levels) {
      const b = document.createElement("button");
      const lvs = ls(lv.key);
      const open = levelUnlocked(lv);
      b.className = "level" + (view.pid && levelOf(view.pid) === lv ? " current" : "");
      const partOpen = partUnlocked(part);
      const jumpable = !open && partOpen && CONFIG.JUMP_AHEAD && jumpCandidate(lv);
      b.disabled = !open && !jumpable;
      if (jumpable) b.title = "Locked. Click to try a jump-ahead challenge.";
      const lc = counts(lv.ids);
      let badge = "";
      if (lvs.mastered) badge = '<span class="badge mastered">tested out</span>';
      else if (levelComplete(lv)) badge = '<span class="badge done">done</span>';
      else if (jumpable) badge = '<span class="badge jump">🔒 jump ahead</span>';
      else if (!open) badge = '<span class="badge">🔒</span>';
      else badge = '<span class="badge">' + (lc.solved + lc.skipped) + "/" + lc.total + "</span>";
      b.innerHTML = '<span class="lname">' + esc(lv.name.replace(/^Level (\d+): /, "$1. ")) + badge + '</span><span class="dots"></span>';
      const dots = b.querySelector(".dots");
      for (const id of lv.ids) {
        const d = document.createElement("i");
        const s = state.probs[id];
        if (s && s.status === "solved") d.className = "solved";
        else if (s && s.status === "skipped") d.className = "skipped";
        else if (lvs.mastered) d.className = "testedout";
        if (id === view.pid) d.classList.add("cur");
        d.title = id + (s && s.status ? " (" + s.status + ")" : "");
        d.onclick = (ev) => { ev.stopPropagation(); if (open) goto(id); };
        dots.appendChild(d);
      }
      b.onclick = () => {
        if (!open) { if (jumpable) startJump(lv); return; }
        const first = lv.ids.find((id) => !isDone(id)) || lv.ids[0];
        goto(first);
      };
      lvWrap.appendChild(b);
    }
    wrap.appendChild(lvWrap);
    sb.appendChild(wrap);
  }
}

function goto(id) {
  view = { screen: "problem", pid: id, revealedHints: (state.probs[id] && state.probs[id].hints) || 0, feedback: null, output: null };
  state.current = id;
  saveState();
  document.getElementById("sidebar").classList.remove("open");
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderWelcome(main) {
  const started = Object.values(state.probs).some((s) => s.status);
  const cont = state.current && BYID[state.current];
  main.innerHTML =
    '<section class="hero"><h1>Python Practice</h1>' +
    "<p>Practice everything from OM 305: if statements, loops, NumPy, and pandas. You write real Python right here in your browser. There's nothing to install.</p>" +
    '<div class="notice good"><span class="icon">✅</span><div><b>This is just for practice.</b> Nothing you do here is graded, and it won\'t count toward or against your grade. ' +
    "Mistakes are how you learn, so try things, get things wrong, and try again.</div></div>" +
    "<ul>" +
    "<li><b>It starts easy and gets harder.</b> Each level adds one new idea.</li>" +
    "<li><b>Get the first two in a level right on your first try</b>, without hints, and you test out. You can skip ahead to the next level.</li>" +
    "<li><b>Already know it?</b> Click a locked level and take the <b>jump-ahead challenge</b>. Get that one problem right on your first try and you skip straight there.</li>" +
    "<li><b>Stuck?</b> Hints point you in the right direction without giving away the code.</li>" +
    "<li><b>Your progress saves in this browser,</b> so you can come back later on the same computer.</li>" +
    "</ul>" +
    '<div class="toolbar">' +
    (cont ? '<button class="btn" id="contBtn">Continue where you left off →</button>' : '<button class="btn" id="startBtn">Start with Part 1 →</button>') +
    "</div></section>" +
    (CONFIG.JUMP_AHEAD ?
    '<section class="howto"><h2>🚀 Already know some of this? Jump ahead.</h2>' +
    "<p>You don't have to start at the beginning of every part. Levels inside a part are locked until you finish the ones before them, but you can test your way past them.</p>" +
    "<ol>" +
    "<li>In the list on the left, open a part and click any level marked <b>🔒 jump ahead</b>.</li>" +
    "<li>You'll get <b>one challenge problem</b> from that level. Hints are off, but you can click <b>Run</b> as many times as you want to test your code.</li>" +
    "<li>When you're ready, click <b>Check my answer</b>. <b>You only get one check</b>, so make sure your code works first.</li>" +
    "<li><b>Got it right?</b> That level opens, and the easier levels before it count as mastered. Keep going from there.</li>" +
    "<li><b>Missed it?</b> No problem. The level stays locked and you'll go back to the earlier levels. After you solve another problem, you can try jumping again with a different one.</li>" +
    "</ol>" +
    '<p class="small-note">Changed your mind? Click <b>Cancel challenge</b> before you check, and it won\'t count against you.</p></section>' : "") +
    '<div class="part-grid" id="partGrid"></div>';
  const grid = main.querySelector("#partGrid");
  for (const part of PARTS) {
    const c = counts(part.levels.flatMap((l) => l.ids));
    const b = document.createElement("button");
    b.className = "part-card";
    b.disabled = !partUnlocked(part);
    b.innerHTML = '<span class="t">' + part.num + ". " + esc(part.title) + '</span><span class="s">' +
      (b.disabled ? "🔒 Finish Part " + (part.num - 1) + " first" : (partComplete(part) ? "✓ Complete" : part.levels.length + (part.levels.length === 1 ? " level · " : " levels · ") + c.total + " problems")) + "</span>";
    b.onclick = () => goto(nextInPart(part.num) || part.levels[0].ids[0]);
    grid.appendChild(b);
  }
  const s = main.querySelector("#startBtn");
  if (s) s.onclick = () => goto(nextInPart(1) || PROBLEMS[0].id);
  const cb = main.querySelector("#contBtn");
  if (cb) cb.onclick = () => goto(state.current);
}

function renderPartDone(main) {
  const part = partOf(view.partDone);
  const next = PARTS[PARTS.indexOf(part) + 1];
  const c = counts(part.levels.flatMap((l) => l.ids));
  main.innerHTML = '<section class="hero"><h1>🎉 Part ' + part.num + " complete!</h1><p>You finished <b>" + esc(part.title) + "</b>: " +
    c.solved + " solved" + (c.tested ? ", " + c.tested + " tested out" : "") + (c.skipped ? ", " + c.skipped + " skipped" : "") + ".</p>" +
    '<div class="toolbar">' + (next ? '<button class="btn" id="nextPart">Start Part ' + next.num + ": " + esc(next.title) + " →</button>" :
    "<p>You've finished the whole workbook. Nice work! Open <b>My progress</b> to copy your report.</p>") +
    "</div></section>";
  const b = main.querySelector("#nextPart");
  if (b) b.onclick = () => goto(nextInPart(next.num) || next.levels[0].ids[0]);
}

function needsNpNote(p) {
  return p.part === 4 || p.part === 6 || /Random/.test(p.level);
}

function renderProblem(main) {
  const p = BYID[view.pid];
  const s = ps(p.id);
  const lv = levelOf(p.id);
  const lvs = ls(lv.key);
  const optional = lvs.mastered && s.status !== "solved";
  const idx = lv.ids.indexOf(p.id) + 1;
  const jumping = view.jump && view.jump.pid === p.id;

  let html = '<div class="crumbs"><span class="pill' + (optional ? " optional" : "") + '">' + esc(p.id) + "</span><span>Part " + p.part + ": " +
    esc(p.partTitle) + "</span><span>·</span><span>" + esc(p.level) + "</span><span>·</span><span>" + idx + " of " + lv.ids.length + "</span>" +
    (optional ? '<span class="pill optional">Optional: you tested out</span>' : "") +
    (s.status === "solved" ? '<span class="pill" style="background:var(--good-soft);color:var(--good)">✓ Solved</span>' : "") + "</div>";

  if (jumping) {
    html += '<div class="notice info"><span class="icon">🚀</span><div><b>Jump-ahead challenge: ' + esc(p.level) + "</b><br>" +
      "Get this one right on your <b>first check</b> to unlock this level. The earlier levels in this part will count as mastered. " +
      "Hints are off. You can run your code as many times as you want before you check.</div></div>";
  } else if (!levelUnlocked(lv)) {
    html += '<div class="notice warn"><span class="icon">🔒</span><div>This level is still locked. Work through the earlier levels to open it.' +
      '<div class="actions"><button class="btn ghost small" id="backToOpen">Go to my next problem</button></div></div></div>';
  }

  const intro = introFor(p);
  if (intro && (idx === 1 || /Level 5: A Bigger Dataset|Level 4: Adding Things Up|Level 10/.test(p.level))) html += '<div class="intro">' + md(intro) + "</div>";

  // gentle support when struggling
  const part = partOf(p.part);
  const li = part.levels.indexOf(lv);
  if (lvs.struggle && !levelComplete(lv) && li > 0 && ls(part.levels[li - 1].key).mastered) {
    const prev = part.levels[li - 1];
    html += '<div class="notice warn"><span class="icon">💡</span><div>This level is a little tricky. You tested out of <b>' + esc(prev.name) +
      "</b>, so a quick refresher there might help.<div class=\"actions\"><button class=\"btn ghost small\" id=\"refresher\">Practice " +
      esc(prev.name.replace(/:.*/, "")) + "</button></div></div></div>";
  }

  html += '<div class="prompt">' + md(p.prompt) + "</div>";
  const notes = [];
  if (needsNpNote(p)) notes.push("NumPy is already imported as <code>np</code>.");
  if (p.part === 5 && p.n > 1) notes.push("pandas is already imported as <code>pd</code>.");
  if (notes.length) html += '<div class="loaded">' + notes.join(" ") + "</div>";
  if (p.loaded.length) {
    html += '<div class="loaded">Already loaded for you (click to see it): ' + p.loaded.map((n) => '<button class="chip" data-peek="' + esc(n) + '">' + esc(n) + "</button>").join("") + "</div>";
  }

  html += '<div class="editor-wrap"><div class="editor-head"><span>Your code</span><button class="btn ghost small" id="resetCode">Reset code</button></div>' +
    '<div class="editor"><div class="gutter" id="gutter">1</div><textarea class="code" id="code" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Your Python code"></textarea></div>';
  if (p.usesInput) {
    html += '<div class="inputs-box"><label for="inputs">Typed-in values, one per line. Each time your code calls <code>input()</code>, it uses the next one. When you check your answer, other values get tested too.</label>' +
      '<textarea id="inputs" spellcheck="false"></textarea></div>';
  }
  html += "</div>";

  const hintsLeft = p.hints.length - view.revealedHints;
  html += '<div class="toolbar">' +
    '<button class="btn ghost" id="runBtn"' + (pyReady ? "" : " disabled") + ">▶ Run</button>" +
    '<button class="btn" id="checkBtn"' + (pyReady ? "" : " disabled") + ">Check my answer</button>" +
    (jumping ? "" : '<button class="btn ghost" id="hintBtn"' + (hintsLeft > 0 ? "" : " disabled") + ">💡 Hint" + (hintsLeft > 0 ? " (" + hintsLeft + " left)" : "") + "</button>") +
    '<span class="spacer"></span>' +
    (pyReady ? '<span class="kbd">Ctrl + Enter runs your code</span>' : '<span class="kbd">Python is loading…</span>') +
    '<button class="btn ghost small" id="skipBtn">' + (jumping ? "Cancel challenge" : (s.status === "solved" || optional ? "Next →" : "Skip for now →")) + "</button>" +
    "</div>";

  html += '<div id="outputArea"></div><div id="feedbackArea"></div><div class="hints" id="hintsArea"></div>';
  main.innerHTML = html;

  // editor
  const ta = main.querySelector("#code");
  ta.value = s.code != null ? s.code : p.starter;
  setupEditor(ta);
  const inp = main.querySelector("#inputs");
  if (inp) {
    inp.value = s.inputs != null ? s.inputs : p.exampleInputs.join("\n");
    inp.oninput = () => { s.inputs = inp.value; saveState(); };
  }
  main.querySelector("#resetCode").onclick = () => { ta.value = p.starter; s.code = p.starter; saveState(); syncGutter(ta); };
  main.querySelector("#runBtn").onclick = () => doRun();
  main.querySelector("#checkBtn").onclick = () => doCheck();
  const hbtn = main.querySelector("#hintBtn");
  if (hbtn) hbtn.onclick = () => doHint();
  main.querySelector("#skipBtn").onclick = () => (jumping ? cancelJump() : doSkip());
  const bto = main.querySelector("#backToOpen");
  if (bto) bto.onclick = () => goto(nextInPart(p.part) || PROBLEMS[0].id);
  const rf = main.querySelector("#refresher");
  if (rf) rf.onclick = () => { const prev = part.levels[li - 1]; goto(prev.ids.find((id) => !(state.probs[id] && state.probs[id].status)) || prev.ids[0]); };
  main.querySelectorAll("[data-peek]").forEach((b) => (b.onclick = () => doPeek(b.dataset.peek)));

  renderHints();
  if (view.output) showOutput(view.output);
  if (view.feedback) showFeedback(view.feedback);
}

// ------------------------------------------------------------------ editor behavior
function setupEditor(ta) {
  const p = BYID[view.pid];
  const s = ps(p.id);
  let t = null;
  ta.addEventListener("input", () => {
    syncGutter(ta);
    if (view.feedback && !view.feedback.pass) {
      view.feedback = null;
      const fa = document.getElementById("feedbackArea");
      if (fa) fa.innerHTML = "";
    }
    s.code = ta.value;
    clearTimeout(t);
    t = setTimeout(saveState, 250);
  });
  ta.addEventListener("scroll", () => { document.getElementById("gutter").scrollTop = ta.scrollTop; });
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); s.code = ta.value; doRun(); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value: v } = ta;
      const ls0 = v.lastIndexOf("\n", a - 1) + 1;
      if (a !== b && v.slice(a, b).includes("\n")) {
        const block = v.slice(ls0, b);
        const changed = e.shiftKey ? block.replace(/^ {1,4}/gm, "") : block.replace(/^/gm, "    ");
        ta.setRangeText(changed, ls0, b, "select");
      } else if (e.shiftKey) {
        const m = v.slice(ls0).match(/^ {1,4}/);
        if (m) ta.setRangeText("", ls0, ls0 + m[0].length, "end");
      } else {
        ta.setRangeText("    ", a, b, "end");
      }
      ta.dispatchEvent(new Event("input"));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value: v } = ta;
      const ls0 = v.lastIndexOf("\n", a - 1) + 1;
      const line = v.slice(ls0, a);
      let indent = line.match(/^ */)[0];
      if (/:\s*(#.*)?$/.test(line)) indent += "    ";
      ta.setRangeText("\n" + indent, a, b, "end");
      ta.dispatchEvent(new Event("input"));
      return;
    }
    if (e.key === "Backspace") {
      const { selectionStart: a, selectionEnd: b, value: v } = ta;
      if (a === b) {
        const ls0 = v.lastIndexOf("\n", a - 1) + 1;
        const before = v.slice(ls0, a);
        if (before.length >= 4 && /^ +$/.test(before) && before.length % 4 === 0) {
          e.preventDefault();
          ta.setRangeText("", a - 4, a, "end");
          ta.dispatchEvent(new Event("input"));
        }
      }
    }
  });
  syncGutter(ta);
}
function syncGutter(ta) {
  const n = ta.value.split("\n").length;
  const g = document.getElementById("gutter");
  if (g) g.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
  ta.style.height = "auto";
  ta.style.height = Math.max(220, Math.min(ta.scrollHeight + 4, 640)) + "px";
}

// ------------------------------------------------------------------ actions
function currentCode() {
  const ta = document.getElementById("code");
  const s = ps(view.pid);
  s.code = ta.value;
  saveState();
  return ta.value;
}
function currentInputs() {
  const el = document.getElementById("inputs");
  if (!el) return [];
  return el.value.split("\n").map((x) => x.trim()).filter((x) => x.length);
}
function busy(on, which) {
  for (const id of ["runBtn", "checkBtn"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = on || !pyReady;
  }
  const b = document.getElementById(which);
  if (b && on) b.dataset.label = b.textContent, (b.textContent = "Working…");
  else for (const id of ["runBtn", "checkBtn"]) { const x = document.getElementById(id); if (x && x.dataset.label) { x.textContent = x.dataset.label; delete x.dataset.label; } }
}

async function doRun() {
  if (!pyReady) return;
  const code = currentCode();
  busy(true, "runBtn");
  const r = await call("run", { pid: view.pid, code, inputs: currentInputs() });
  busy(false);
  if (r.timeout) view.output = { error: { friendly: "Your code ran for too long, so we stopped it. This usually means a loop never ends. Check that the loop's condition eventually becomes False.", raw: "" }, lines: [], value: null };
  else if (r.crash) view.output = { error: { friendly: "Something went wrong running your code. Try again.", raw: r.crash }, lines: [], value: null };
  else view.output = r;
  showOutput(view.output);
}

async function doPeek(name) {
  if (!pyReady) return;
  const r = await call("peek", { pid: view.pid, name });
  view.output = Object.assign({ title: name }, r);
  showOutput(view.output);
}

function showOutput(r) {
  const area = document.getElementById("outputArea");
  if (!area) return;
  let body = "";
  if (r.lines && r.lines.length) body += "<pre>" + r.lines.map((l) => (l.t === "echo" ? '<span class="echo">' + esc(l.s) + "</span>" : esc(l.s))).join("\n") + "</pre>";
  if (r.value) {
    body += r.value.type === "html" ? '<div class="value">' + r.value.data + "</div>" : '<div class="value text"><pre>' + esc(r.value.data) + "</pre></div>";
  }
  if (r.error) {
    body += '<div class="err"><b>' + (r.error.line ? "Problem on line " + r.error.line + ". " : "Your code hit an error. ") + "</b>" +
      esc(r.error.friendly || "") + (r.error.raw ? '<div class="raw">' + esc(r.error.raw) + "</div>" : "") + "</div>";
  }
  if (!body) body = '<div class="empty">Your code ran, but nothing was printed or shown.</div>';
  area.innerHTML = '<div class="output"><div class="output-head">' + (r.title ? "Preview of " + esc(r.title) : "Output") + '</div><div class="output-body">' + body + "</div></div>";
}

async function doCheck() {
  if (!pyReady) return;
  const p = BYID[view.pid];
  const s = ps(p.id);
  const lv = levelOf(p.id);
  const lvs = ls(lv.key);
  const code = currentCode();
  busy(true, "checkBtn");
  const r = await call("check", { pid: p.id, code });
  busy(false);
  if (r.timeout) {
    view.feedback = { pass: false, msgs: ["Your code ran for too long, so we stopped it. This usually means a loop never ends."] };
  } else if (r.crash) {
    view.feedback = { pass: false, msgs: ["Something went wrong checking your code. Try running it first to see what happens."] };
  } else if (view.jump && view.jump.pid === p.id && (r.status === "pass" || r.status === "fail")) {
    const part = partOf(p.part);
    const li = part.levels.indexOf(lv);
    view.jump = null;
    if (r.status === "pass") {
      s.status = "solved";
      s.firstTry = true;
      lvs.unlocked = true;
      lvs.streak = 1;
      let skipped = 0;
      for (let k = 0; k < li; k++) {
        const prev = part.levels[k];
        if (!levelComplete(prev)) { ls(prev.key).mastered = true; skipped++; }
      }
      saveState();
      view.feedback = { pass: true, msgs: r.messages || [], solution: r.solution, jumped: true, jumpedOver: skipped };
    } else {
      s.fails++;
      s.jumpFailed = true;
      lvs.jumpWaitUntil = solvedCount();
      saveState();
      view.feedback = { pass: false, jumpFailed: true, msgs: r.messages && r.messages.length ? r.messages : ["Not quite yet."] };
    }
    renderSidebar();
    renderTop();
    render();
    return;
  } else if (r.status === "pass") {
    const firstTry = s.fails === 0 && s.hints === 0 && s.status !== "solved";
    const wasSolved = s.status === "solved";
    s.status = "solved";
    s.firstTry = s.firstTry || firstTry;
    let testedOut = false;
    if (!wasSolved) {
      if (firstTry) lvs.streak = (lvs.streak || 0) + 1;
      else lvs.streak = 0;
      if (s.fails >= CONFIG.STRUGGLE_FAILS || s.hints >= CONFIG.STRUGGLE_HINTS) lvs.struggle = true;
      const remaining = lv.ids.some((id) => !(state.probs[id] && state.probs[id].status));
      if (!lvs.mastered && canTestOut(lv) && !lvs.struggle && lvs.streak >= CONFIG.TEST_OUT_STREAK && remaining) {
        lvs.mastered = true;
        testedOut = true;
      }
    }
    saveState();
    view.feedback = { pass: true, msgs: r.messages || [], solution: r.solution, testedOut, firstTry };
    renderSidebar();
    renderTop();
  } else {
    s.fails++;
    if (s.fails >= CONFIG.STRUGGLE_FAILS) lvs.struggle = true;
    lvs.streak = 0;
    saveState();
    view.feedback = { pass: false, msgs: r.messages && r.messages.length ? r.messages : ["Not quite yet."], error: r.first_error };
  }
  showFeedback(view.feedback);
}

function showFeedback(f) {
  const area = document.getElementById("feedbackArea");
  if (!area) return;
  if (f.pass) {
    const p = BYID[view.pid];
    const cheers = ["Nice work!", "You got it!", "Correct!", "Nailed it!", "Great job!"];
    let h = '<div class="feedback pass"><h3>✅ ' + cheers[p.n % cheers.length] + "</h3>";
    if (f.jumped) h += "<p><b>🚀 You jumped ahead!</b> " + esc(p.level.replace(/:.*/, "")) + " is now open" +
      (f.jumpedOver ? ", and the earlier levels count as mastered" : "") + ". Keep going from here.</p>";
    if (f.testedOut) h += "<p><b>🚀 You tested out of this level!</b> You got " + CONFIG.TEST_OUT_STREAK + " in a row on your first try, so the rest of " + esc(p.level.replace(/:.*/, "")) + " is optional.</p>";
    if (f.msgs && f.msgs.length) h += "<p>" + f.msgs.map(esc).join("<br>") + "</p>";
    h += '<div class="actions"><button class="btn good" id="nextBtn">Next problem →</button>' +
      (f.solution ? '<button class="btn ghost" id="solBtn">See another way to write it</button>' : "") + "</div>" +
      '<div id="solBox"></div></div>';
    area.innerHTML = h;
    document.getElementById("nextBtn").onclick = () => advance();
    const sb = document.getElementById("solBtn");
    if (sb) sb.onclick = () => {
      document.getElementById("solBox").innerHTML = '<div class="small-note" style="margin-top:10px">One way to solve it. Yours can look different and still be right.</div><div class="solution">' + esc(f.solution) + "</div>";
      sb.remove();
    };
  } else {
    let h = '<div class="feedback fail"><h3>' + (f.jumpFailed ? "Not this time" : "Not quite yet") + '</h3><ul>' + f.msgs.map((m) => "<li>" + inline(esc(m)) + "</li>").join("") + "</ul>";
    if (f.jumpFailed) {
      h += "<p>No problem! This level stays locked for now. Work up through the earlier levels. After you solve another problem, you can try jumping ahead again with a different one.</p>" +
        '<div class="actions"><button class="btn" id="jumpBack">Go to the earlier levels →</button></div></div>';
      area.innerHTML = h;
      document.getElementById("jumpBack").onclick = () => goto(nextInPart(BYID[view.pid].part) || PROBLEMS[0].id);
      return;
    }
    const p = BYID[view.pid];
    const s = ps(p.id);
    if (s.fails >= 2 && view.revealedHints < p.hints.length) h += '<div class="actions"><button class="btn ghost small" id="hint2">💡 Want a hint?</button></div>';
    h += "</div>";
    area.innerHTML = h;
    const hb = document.getElementById("hint2");
    if (hb) hb.onclick = () => doHint();
  }
}

function doHint() {
  const p = BYID[view.pid];
  const s = ps(p.id);
  if (view.revealedHints >= p.hints.length) return;
  view.revealedHints++;
  if (s.status !== "solved") {
    s.hints = Math.max(s.hints, view.revealedHints);
    const lvs = ls(levelOf(p.id).key);
    lvs.streak = 0;
    if (s.hints >= CONFIG.STRUGGLE_HINTS) lvs.struggle = true;
    saveState();
  }
  renderHints();
  const hb = document.getElementById("hintBtn");
  const left = p.hints.length - view.revealedHints;
  if (hb) { hb.textContent = "💡 Hint" + (left > 0 ? " (" + left + " left)" : ""); hb.disabled = left <= 0; }
}
function renderHints() {
  const p = BYID[view.pid];
  const area = document.getElementById("hintsArea");
  if (!area) return;
  area.innerHTML = p.hints.slice(0, view.revealedHints).map((h, i) => '<div class="hint"><b>Hint ' + (i + 1) + ":</b> " + inline(esc(h)) + "</div>").join("");
}

function cancelJump() {
  const p = BYID[view.pid];
  view.jump = null;
  goto(nextInPart(p.part) || PROBLEMS[0].id);
}

function doSkip() {
  const p = BYID[view.pid];
  const s = ps(p.id);
  const lvs = ls(levelOf(p.id).key);
  if (!s.status && !lvs.mastered) {
    s.status = "skipped";
    lvs.streak = 0;
    saveState();
  }
  advance();
}

function advance() {
  const p = BYID[view.pid];
  const part = partOf(p.part);
  // next not-done problem after this one in the same level, then the rest of the part
  const lv = levelOf(p.id);
  const after = lv.ids.slice(lv.ids.indexOf(p.id) + 1).find((id) => !isDone(id));
  const nxt = (!ls(lv.key).mastered && after) || nextInPart(p.part);
  if (nxt) { goto(nxt); return; }
  if (partComplete(part)) {
    view = { screen: "partDone", partDone: part.num, pid: null };
    state.current = null;
    saveState();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

// ------------------------------------------------------------------ progress report
function reportText() {
  const lines = ["OM 305 Python Practice: progress report", "Name: " + (state.name || "(not entered)"), "Date: " + new Date().toLocaleString(), ""];
  let tot = { solved: 0, tested: 0, skipped: 0, total: 0 };
  for (const part of PARTS) {
    const c = counts(part.levels.flatMap((l) => l.ids));
    for (const k in tot) tot[k] += c[k];
    lines.push("Part " + part.num + " (" + part.title + "): " + c.solved + " solved, " + c.tested + " tested out, " + c.skipped + " skipped, of " + c.total + (partComplete(part) ? "  [COMPLETE]" : ""));
  }
  lines.push("", "Total: " + tot.solved + " solved, " + tot.tested + " tested out, " + tot.skipped + " skipped, of " + tot.total);
  return lines.join("\n");
}
function openReport() {
  const d = document.getElementById("reportDialog");
  const nameEl = document.getElementById("studentName");
  nameEl.value = state.name || "";
  nameEl.oninput = () => { state.name = nameEl.value; saveState(); };
  let rows = "";
  for (const part of PARTS) {
    const c = counts(part.levels.flatMap((l) => l.ids));
    rows += "<tr><td>" + part.num + ". " + esc(part.title) + (partComplete(part) ? " ✓" : "") + '</td><td class="n">' + c.solved + '</td><td class="n">' + c.tested + '</td><td class="n">' + c.skipped + '</td><td class="n">' + c.total + "</td></tr>";
  }
  document.getElementById("reportBody").innerHTML =
    '<table class="report-table"><thead><tr><th>Part</th><th>Solved</th><th>Tested out</th><th>Skipped</th><th>Total</th></tr></thead><tbody>' + rows + "</tbody></table>" +
    '<p class="small-note">Progress is saved in this browser only. If you switch computers or clear your browser data, it starts over.</p>';
  d.showModal();
}

// ------------------------------------------------------------------ boot
document.getElementById("reportBtn").onclick = openReport;
document.getElementById("copyReportBtn").onclick = async (e) => {
  const t = reportText();
  try { await navigator.clipboard.writeText(t); e.target.textContent = "Copied!"; }
  catch (err) { prompt("Copy your report:", t); }
  setTimeout(() => (e.target.textContent = "Copy report"), 1800);
};
document.getElementById("resetBtn").onclick = () => {
  if (confirm("Erase all of your progress and start over? This can't be undone.")) {
    state = { name: state.name, probs: {}, levels: {}, current: null };
    saveState();
    document.getElementById("reportDialog").close();
    view = { screen: "welcome", pid: null };
    render();
  }
};
document.getElementById("menuBtn").onclick = () => document.getElementById("sidebar").classList.toggle("open");
document.querySelector(".brand").style.cursor = "pointer";
document.querySelector(".brand").onclick = () => { view = { screen: "welcome", pid: null }; render(); };
window.addEventListener("beforeunload", saveState);
startWorker();
