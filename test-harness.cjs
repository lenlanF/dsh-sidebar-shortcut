// Offline harness: simulate DSH's __ModuleLoader__ + client ctx and run apply().
const fs = require("fs");
const vm = require("vm");

const storage = {};
let captured = null;

globalThis.window = {
  __ModuleLoader__: { load: (def) => { captured = def; } },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
  },
};

function createElement(type, props, ...children) {
  return { type, props, children };
}
class ComponentStub {
  constructor(props) { this.props = props; }
  setState() {}
}
const ReactStub = {
  createElement,
  Component: ComponentStub,
  Fragment: "Fragment",
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
};

const src = fs.readFileSync(__dirname + "/lib/client.js", "utf8");
vm.runInThisContext(src, { filename: "client.js" });

if (!captured) throw new Error("FAIL: __ModuleLoader__.load not called");
console.log("PASS loader captured, id =", captured.id);

const mod = captured.factory((name) => {
  if (name === "react") return ReactStub;
  throw new Error("unknown module " + name);
});

console.log("exports keys:", Object.keys(mod));
console.log("name:", mod.name);
console.log("inject:", JSON.stringify(mod.inject));

// ---- fake client context -------------------------------------------------
const state = { slotsInjected: [], registered: [], effects: 0, locale: [], disposed: 0 };

let installedBundles = [
  { name: "dsh-better-sidebar", official: false },
  { name: "@deepseek-ai/dsh-base", official: true },
];
const changedListeners = [];
const fakeRemote = {
  pluginManager: {
    listBundles: () => Promise.resolve({ ok: true, value: installedBundles.slice() }),
  },
  $on: (event, cb) => {
    if (event === "plugin-manager/changed") changedListeners.push(cb);
    return () => {};
  },
};
const fakeReflect = {
  get: (svc) => (svc === "pluginNavigation" ? { openBundle: () => true } : null),
};
let selectPanelCalls = [];
const ctx = {
  effect: (fn, label) => { state.effects++; return () => {}; },
  locale: {
    register: (ns, dict) => state.locale.push(ns),
    bind: (ns) => (key) => key,
  },
  remote: fakeRemote,
  reflect: fakeReflect,
  layout: { selectPanel: (id) => { selectPanelCalls.push(id); } },
  slots: {
    inject: (slotName, factoryFn) => {
      state.slotsInjected.push(slotName);
      const disposers = [];
      state._currentInjectDisposers = disposers;
      factoryFn();
      state._currentInjectDisposers = null;
      // Real app.asar returns a DISPOSE FUNCTION (not an object). Calling it
      // disposes every register() made inside this inject.
      return () => {
        state.disposed++;
        for (const d of disposers.splice(0)) { try { d(); } catch (e) {} }
      };
    },
    register: (opts, comp) => {
      const rec = { slot: opts.name, id: opts.id };
      state.registered.push(rec);
      if (opts.name === "settings.section" && opts.id === "dsh-sidebar-shortcut") {
        state.settingsComp = comp;
      }
      const disposer = () => {
        const i = state.registered.indexOf(rec);
        if (i >= 0) state.registered.splice(i, 1);
      };
      if (state._currentInjectDisposers) state._currentInjectDisposers.push(disposer);
      return disposer;
    },
    subscribe: () => () => {},
    entries: (key) => {
      if (key === "settings.section") {
        return [
          { options: { id: "general" } },
          { options: { id: "dsh-sidebar-shortcut" } },
        ];
      }
      if (key === "sidebar.settings") {
        return [{ store: { create: () => ({ actions: { openSection: () => {} } }) } }];
      }
      return [];
    },
    entriesOf: (key) => [],
    entriesOfSlot: (key) => [],
  },
};

// Test fixture: two plugins in two groups, one group collapsed.
storage["dsh-sidebar-shortcut:selected"] = JSON.stringify({
  "dsh-better-sidebar": { label: "A", icon: "", group: "gA" },
  "@deepseek-ai/dsh-base": { label: "B", icon: "", group: "gB" },
});
storage["dsh-sidebar-shortcut:groups"] = JSON.stringify({
  enabled: true,
  defs: [
    { id: "gA", name: "组A", collapsed: false },
    { id: "gB", name: "组B", collapsed: true },
  ],
  order: ["gA", "gB"],
});
// Adopt two host entries: one into group A, one flat (ungrouped).
storage["dsh-sidebar-shortcut:external"] = JSON.stringify({
  "dsh-market": { group: "gA", label: "插件市场" },
  "schedules": { group: "__none__", label: "自动化任务" },
});

mod.apply(ctx);

console.log("\n--- results ---");
console.log("effects:", state.effects);
console.log("locale registered:", JSON.stringify(state.locale));
console.log("slots injected:", JSON.stringify(state.slotsInjected));
console.log("entries registered:", JSON.stringify(state.registered.map((r) => r.id)));

// ---- assertions ---------------------------------------------------------
const problems = [];
for (const bad of ["settings", "pluginManager", "pluginNavigation"]) {
  if (mod.inject.includes(bad)) problems.push("blocking inject lists '" + bad + "' (boot-risk)");
}
if (mod.inject.indexOf("remote") < 0) problems.push("inject missing 'remote' (list source)");
if (state.slotsInjected.indexOf("settings.section") < 0) problems.push("settings.section not injected");
if (state.slotsInjected.indexOf("sidebar.panellist") < 0) problems.push("sidebar.panellist not injected");

const ids = state.registered.filter((r) => r.slot === "sidebar.panellist").map((r) => r.id);
// Both group headers must exist.
if (!ids.includes("sidebar-shortcut-folder:gA")) problems.push("group A header missing");
if (!ids.includes("sidebar-shortcut-folder:gB")) problems.push("group B header missing");
// Expanded group A shows its icon; collapsed group B hides its icon.
if (!ids.includes("sidebar-shortcut:dsh-better-sidebar")) problems.push("expanded group icon missing");
if (ids.includes("sidebar-shortcut:@deepseek-ai/dsh-base")) problems.push("collapsed group icon should be hidden");
// Adopted host entries: grouped one mirrored under the expanded group, the
// ungrouped one mirrored flat. Both must be present.
if (!ids.includes("sidebar-shortcut-ext:dsh-market")) problems.push("adopted grouped host mirror missing");
if (!ids.includes("sidebar-shortcut-ext:schedules")) problems.push("adopted flat host mirror missing");
console.log("multi-group panellist ids:", JSON.stringify(ids));

// ---- migration: legacy single-group config -> one default group ----------
delete storage["dsh-sidebar-shortcut:groups"];
delete storage["dsh-sidebar-shortcut:external"];
storage["dsh-sidebar-shortcut:selected"] = JSON.stringify({ "dsh-better-sidebar": true });
storage["dsh-sidebar-shortcut:group"] = JSON.stringify({ enabled: true, label: "旧分组", collapsed: false });
state.registered.length = 0;
state.slotsInjected.length = 0;
mod.apply(ctx);
const migIds = state.registered.filter((r) => r.slot === "sidebar.panellist").map((r) => r.id);
if (!migIds.some((x) => x.indexOf("sidebar-shortcut-folder:") === 0))
  problems.push("migration: default group header missing");
if (!migIds.includes("sidebar-shortcut:dsh-better-sidebar"))
  problems.push("migration: legacy plugin icon missing");
console.log("migrated panellist ids:", JSON.stringify(migIds));

// ---- regression: kill() must handle the FUNCTION-shaped dispose fiber that
// app.asar actually returns (the old `.dispose()` call silently did nothing,
// which is why the group was uncontrollable and rows never got removed). ----
const clientSrc = require("fs").readFileSync(__dirname + "/lib/client.js", "utf8");
if (!/typeof fiber === "function"\) fiber\(\)/.test(clientSrc))
  problems.push("kill() does not call function-shaped dispose fibers");
if (/api\._fibers\[name\]\.dispose\(\)/.test(clientSrc))
  problems.push("leftover `.dispose()` call on a function-shaped fiber");

// ---- robustness: a ctx that explodes must not throw --------------------
let threw = false;
try {
  mod.apply({
    effect: () => { throw new Error("boom"); },
    locale: { register: () => {}, bind: () => () => "" },
    remote: {},
    reflect: { get: () => null },
    layout: { selectPanel: () => {} },
    slots: {
      inject: () => ({ dispose: () => {} }),
      register: () => () => {},
      subscribe: () => () => {},
      entries: () => [],
      entriesOf: () => [],
      entriesOfSlot: () => [],
    },
  });
} catch (e) {
  threw = true;
}
if (threw) problems.push("apply() threw on a broken ctx (should be swallowed)");

// ---- UI render smoke test: the redesigned settings card must render all
// three tabs without throwing (client React copy forbids hooks, class comp). ---
function treeText(node) {
  if (node == null || node === false) return "";
  if (Array.isArray(node)) return node.map(treeText).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object" && node.children) return treeText(node.children);
  return "";
}
if (!state.settingsComp) {
  problems.push("settings.section component factory not captured");
} else {
  for (const tab of ["plugins", "groups", "entries"]) {
    try {
      const el = state.settingsComp(); // () => h(SettingsSection, { api })
      const Inst = el.type;
      const inst = new Inst(el.props);
      inst.state = Object.assign({}, inst.state, { activeTab: tab, bundles: [
        { name: "dsh-better-sidebar", official: false },
      ] });
      const out = inst.render();
      const txt = treeText(out);
      if (!txt.includes("侧栏快捷")) problems.push("render(" + tab + "): hero title missing");
      if (!txt.includes("保存")) problems.push("render(" + tab + "): save bar missing");
      console.log("render tab '" + tab + "' ok, text length=" + txt.length);
    } catch (e) {
      problems.push("render(" + tab + ") threw: " + (e && e.message));
    }
  }
}

// ---- uninstall regression: a plugin removed from listBundles must lose its
// sidebar row and its saved selection, WITHOUT a restart. ----
storage["dsh-sidebar-shortcut:selected"] = JSON.stringify({
  "dsh-better-sidebar": { label: "A", icon: "", group: "gA" },
  "ghost-plugin": { label: "G", icon: "", group: "gA" },
});
storage["dsh-sidebar-shortcut:groups"] = JSON.stringify({
  enabled: false, defs: [{ id: "gA", name: "A", collapsed: false }], order: ["gA"],
});
delete storage["dsh-sidebar-shortcut:external"];
installedBundles = [
  { name: "dsh-better-sidebar", official: false },
  { name: "@deepseek-ai/dsh-base", official: true },
]; // ghost-plugin is "uninstalled"
state.registered.length = 0;
state.slotsInjected.length = 0;
mod.apply(ctx);
const pending = [];
for (const cb of changedListeners) {
  try { const r = cb(); if (r && typeof r.then === "function") pending.push(r); } catch (e) {}
}
Promise.all(pending).then(() => {
  const ids = state.registered.filter((r) => r.slot === "sidebar.panellist").map((r) => r.id);
  if (ids.includes("sidebar-shortcut:ghost-plugin"))
    problems.push("uninstalled plugin still has a sidebar row");
  if (!ids.includes("sidebar-shortcut:dsh-better-sidebar"))
    problems.push("installed plugin lost its sidebar row after prune");
  let persisted;
  try { persisted = JSON.parse(storage["dsh-sidebar-shortcut:selected"] || "{}"); } catch (e) { persisted = {}; }
  if (persisted["ghost-plugin"])
    problems.push("uninstalled plugin still persisted in localStorage");
  if (!persisted["dsh-better-sidebar"])
    problems.push("installed plugin was wrongly pruned from localStorage");
  console.log("uninstall regression ids:", JSON.stringify(ids));
  finish();
}).catch((e) => { problems.push("uninstall test error: " + e); finish(); });

function finish() {
  console.log("\n--- verdict ---");
  if (problems.length) {
    problems.forEach((p) => console.log("FAIL:", p));
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED");
}
