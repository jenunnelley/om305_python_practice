/* Runs Python (Pyodide) in the background so a runaway loop can never freeze the page. */
const VERSION = new URL(self.location.href).searchParams.get("v") || "1";
importScripts("py/pyodide.js");

let py = null;
let engine = null;
let bank = null;
const byId = {};

function decode(text) {
  const key = "om305-roll-tide";
  const bin = atob(text.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key.charCodeAt(i % key.length);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function init() {
  // 1. problem bank first, so the page can show a problem while Python loads
  const raw = await (await fetch("bank.dat?v=" + VERSION, { cache: "no-cache" })).text();
  bank = decode(raw);
  for (const p of bank.problems) byId[p.id] = p;
  const pub = bank.problems.map((p) => ({
    id: p.id, label: p.label, n: p.n, part: p.part, partTitle: p.partTitle, level: p.level,
    prompt: p.prompt, starter: p.starter, hints: p.hints, loaded: p.loaded || [],
    usesInput: !!p.usesInput, exampleInputs: p.exampleInputs || [], strict: !!p.strict,
  }));
  postMessage({ type: "bank", problems: pub, intro: bank.intro });

  // 2. Python + NumPy + pandas
  postMessage({ type: "status", text: "Starting Python…" });
  py = await loadPyodide({ indexURL: "py/" });
  postMessage({ type: "status", text: "Loading NumPy and pandas…" });
  await py.loadPackage(["numpy", "pandas"]);
  const csv = await (await fetch("CoffeeCart.csv?v=" + VERSION, { cache: "no-cache" })).text();
  py.FS.writeFile("CoffeeCart.csv", csv);
  const src = await (await fetch("engine.py?v=" + VERSION, { cache: "no-cache" })).text();
  py.FS.writeFile("engine.py", src);
  py.runPython("import sys; sys.path.insert(0, '.')\nimport engine");
  engine = py.pyimport("engine");
  postMessage({ type: "ready" });
}

function toPy(obj) {
  return py.toPy(obj);
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      await init();
      return;
    }
    const p = byId[m.pid];
    if (!p) throw new Error("Unknown problem " + m.pid);
    const pp = toPy(p);
    let out;
    if (m.type === "run") {
      out = engine.ui_run(pp, m.code, toPy(m.inputs || []));
    } else if (m.type === "check") {
      out = engine.ui_check(pp, m.code);
      const res = JSON.parse(out);
      if (res.status === "pass") res.solution = p.solution;
      out = JSON.stringify(res);
    } else if (m.type === "peek") {
      out = engine.ui_peek(pp, m.name);
    }
    pp.destroy();
    postMessage({ type: "result", id: m.id, data: JSON.parse(out) });
  } catch (err) {
    postMessage({ type: "result", id: m.id, data: { crash: String(err && err.message ? err.message : err) } });
  }
};
