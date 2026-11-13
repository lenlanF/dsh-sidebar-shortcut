// dsh-sidebar-shortcut — client half (v3).
//
// WHAT IT DOES
//   1. Adds a Settings card ("侧栏快捷") listing every installed plugin with a
//      checkbox. The selection persists in localStorage.
//   2. On load + on selection change, registers one left-sidebar
//      (sidebar.panellist) icon per checked plugin.
//   3. Clicking that icon opens the plugin's entry inside the host's
//      "Settings › Plugins" panel.
//
// WHY THE PRIOR VERSIONS FAILED (kept here so we never repeat them)
//   v1: listed "settings" in the blocking `inject` array — a service the
//       client context does NOT provide — so this entry stayed "pending" and
//       DSH refused to boot the Web UI at all.
//   v2: used `ctx.inject([deps], cb)` to fetch optional services. The client
//       cordis only supports the DECLARATIVE `inject` array (every built-in
//       plugin confirms this), so the callback never ran and the plugin list
//       stayed in a permanent "读取插件中…" (loading) state.
//
// THE CORRECT APIS (verified against the shipped bundles in app.asar)
//   * Installed-bundle list  -> ctx.remote.pluginManager.listBundles()
//       elements carry { name, official, availability, ... }
//   * Open a plugin's panel  -> ctx.layout.selectPanel("plugins")
//       ("plugins" is the id of the host's Settings › Plugins panel).
//   * Navigation helper      -> ctx.reflect.get("pluginNavigation")?.openBundle(name)
//       provided by dsh-client-ui-plugin-manager via ctx.reflect.provide.
//
// BOOT SAFETY
//   * `inject` lists ONLY services that certainly exist: "slots", "locale",
//     "remote". Nothing here can gate Web boot.
//   * apply() is wrapped in try/catch; any failure disables THIS plugin only.
//
// FEATURE-PAGE SEAM
//   openPlugin(ctx, name) is the single seam: swap the navigation target for a
//   feature-panel id when a host API to list per-plugin panel ids shows up.
window.__ModuleLoader__.load({
  id: "dsh-sidebar-shortcut",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-sidebar-shortcut";
    const STORAGE_KEY = "dsh-sidebar-shortcut:selected";
    const GROUP_KEY = "dsh-sidebar-shortcut:group";      // legacy single-group
    const GROUPS_KEY = "dsh-sidebar-shortcut:groups";    // multi-group config
    const EXTERNAL_KEY = "dsh-sidebar-shortcut:external"; // adopted host entries
    const PANEL_PREFIX = "sidebar-shortcut:";
    const FOLDER_PREFIX = "sidebar-shortcut-folder:";
    const EXT_PREFIX = "sidebar-shortcut-ext:";          // mirror rows for host entries
    const NO_GROUP = "__none__";                         // "ungrouped" bucket
    const PLUGINS_PANEL = "plugins";

    const zh = {
      nav: "侧栏快捷",
      hint: "勾选后，该插件会在左侧栏出现一个图标；点击图标打开它的插件页。改动在重启 DSH 后生效。",
      loading: "读取已装插件中…",
      empty: "没有读到你安装的插件。",
      notReady: "插件服务尚未就绪，正在重试…",
      retry: "重试",
      saved: "已保存。重启 DSH 后左侧栏出现所选入口。",
      openVia: "点击图标打开",
      unavailable: "无法打开插件页：请确认“设置›插件”面板可用。",
    };
    const en = {
      nav: "Sidebar Shortcuts",
      hint: "Each checked plugin gets an icon in the left sidebar; clicking it opens that plugin's page. Changes apply after restarting DSH.",
      loading: "Reading installed plugins…",
      empty: "No installed plugins found.",
      notReady: "Plugin service not ready yet; retrying…",
      retry: "Retry",
      saved: "Saved. Restart DSH to see the chosen entries.",
      openVia: "Open via icon",
      unavailable: "Cannot open the plugin page: ensure the Settings › Plugins panel is available.",
    };

    function loadSelected() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        return {};
      }
    }
    function saveSelected(map) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
      } catch (e) {}
    }
    const DEFAULT_GROUP_NAME = "默认分组";

    function newGroupId() {
      return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // Normalize whatever is in storage into a valid multi-group config:
    //   { enabled, defs: [{id, name, collapsed}], order: [id...] }
    function normalizeGroups(raw) {
      const out = { enabled: true, defs: [], order: [] };
      if (!raw || typeof raw !== "object") return out;
      out.enabled = raw.enabled !== false;
      const defs = Array.isArray(raw.defs) ? raw.defs : [];
      const seen = new Set();
      for (const d of defs) {
        if (!d || typeof d !== "object") continue;
        const id = typeof d.id === "string" && d.id ? d.id : newGroupId();
        if (seen.has(id)) continue;
        seen.add(id);
        out.defs.push({
          id,
          name: typeof d.name === "string" && d.name ? d.name : DEFAULT_GROUP_NAME,
          collapsed: !!d.collapsed,
        });
      }
      const order = Array.isArray(raw.order) ? raw.order : [];
      for (const id of order) if (seen.has(id)) out.order.push(id);
      for (const d of out.defs) if (out.order.indexOf(d.id) < 0) out.order.push(d.id);
      if (!out.defs.length) {
        out.defs.push({ id: "default", name: DEFAULT_GROUP_NAME, collapsed: false });
        out.order.push("default");
      }
      return out;
    }

    // Read the multi-group config. If it doesn't exist yet, migrate the legacy
    // single-group setting into one default group (preserving its name/state).
    function loadGroups() {
      try {
        const raw = window.localStorage.getItem(GROUPS_KEY);
        if (raw) return normalizeGroups(JSON.parse(raw));
      } catch (e) {}
      const g = normalizeGroups({ enabled: true, defs: [] });
      try {
        const legacy = window.localStorage.getItem(GROUP_KEY);
        if (legacy) {
          const lg = JSON.parse(legacy);
          g.enabled = lg.enabled !== false;
          g.defs[0].name = typeof lg.label === "string" && lg.label ? lg.label : DEFAULT_GROUP_NAME;
          g.defs[0].collapsed = !!lg.collapsed;
        }
      } catch (e) {}
      // Assign a group to every selected plugin that has none (legacy data used
      // `true` / `{label,icon}` without a `group` field).
      try {
        const sel = loadSelected();
        let changed = false;
        for (const name of Object.keys(sel)) {
          if (!sel[name]) continue;
          const meta = typeof sel[name] === "object" && sel[name] ? sel[name] : (sel[name] = {});
          if (!meta.group) { meta.group = g.defs[0].id; changed = true; }
        }
        if (changed) saveSelected(sel);
      } catch (e) {}
      return g;
    }

    function saveGroups(cfg) {
      try {
        window.localStorage.setItem(GROUPS_KEY, JSON.stringify(normalizeGroups(cfg)));
      } catch (e) {}
    }

    // Resolve which group a selected plugin belongs to. Unknown/empty group ->
    // the first group (so every icon always lives under some header).
    function groupOf(meta, cfg) {
      const id = meta && meta.group;
      if (id && cfg.defs.some((d) => d.id === id)) return id;
      if (id === NO_GROUP) return NO_GROUP;
      return cfg.defs[0].id;
    }

    // ---- adopted host entries --------------------------------------------
    // `external` maps a host left-sidebar panel id -> its config in our groups:
    //   { [id]: { group: <groupId|__none__>, label: <display name> } }
    // Present in this map == "adopted": the original host row is hidden
    // (moved into the host's More menu via onPinnedChange(id,false)) and a
    // mirror row is rendered under one of our group headers instead.
    function loadExternal() {
      try {
        const raw = window.localStorage.getItem(EXTERNAL_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        return obj && typeof obj === "object" ? obj : {};
      } catch (e) {
        return {};
      }
    }
    function saveExternal(map) {
      try {
        window.localStorage.setItem(EXTERNAL_KEY, JSON.stringify(map));
      } catch (e) {}
    }
    // A host panel id is manageable unless it is one of our OWN rows or the
    // reserved "plugins" row (the host hard-codes both as non-hideable).
    function isManageableId(id) {
      if (!id || typeof id !== "string") return false;
      if (id === PLUGINS_PANEL) return false;
      if (id.indexOf(PANEL_PREFIX) === 0) return false;
      if (id.indexOf(FOLDER_PREFIX) === 0) return false;
      if (id.indexOf(EXT_PREFIX) === 0) return false;
      return true;
    }

    // Remove stale selections whose plugin is no longer installed. Returns the
    // pruned map (and persists it when something was removed). `installed` is
    // a Set of currently-installed bundle names; when null we skip pruning so
    // a not-yet-loaded list never wipes the user's selections.
    function pruneSelected(installed) {
      const sel = loadSelected();
      if (!installed || !(installed instanceof Set)) return sel;
      let changed = false;
      const next = {};
      for (const name of Object.keys(sel)) {
        if (!sel[name]) continue;
        if (installed.has(name)) next[name] = sel[name];
        else { changed = true; console.info("[sc] pruned uninstalled plugin: " + name); }
      }
      if (changed) saveSelected(next);
      return changed ? next : sel;
    }

    // Names reported by listBundles may be scoped (@scope/name) while a saved
    // selection can be the short form (or vice versa). Normalize both sides so
    // the membership check is robust across those shapes.
    function installedMatcher(installed) {
      if (!installed || !(installed instanceof Set)) return null;
      const norm = (s) => String(s).toLowerCase();
      const short = (s) => { const x = String(s); return x.replace(/^@[^/]+\//, "").toLowerCase(); };
      const full = new Set(), shorts = new Set();
      for (const n of installed) { full.add(norm(n)); shorts.add(short(n)); }
      return (name) => {
        const n = String(name);
        return full.has(norm(n)) || full.has(short(n)) || shorts.has(norm(n)) || shorts.has(short(n));
      };
    }

    // ---- section matching -------------------------------------------------
    // Find the settings.section id that belongs to a plugin name. Plugins that
    // ship a feature/settings page register a `settings.section` whose id is
    // usually derived from the package name (e.g. "our-free-model"). We match
    // the package name (full or scope-stripped) against the registered ids.
    function matchSection(name, sections) {
      if (!sections || (typeof sections.size === "number" && sections.size === 0)) return null;
      const norm = (s) => String(s).replace(/[^a-z0-9]/gi, "").toLowerCase();
      const short = name.replace(/^@[^/]+\//, ""); // @scope/foo -> foo
      const nName = norm(name);
      const nShort = norm(short);
      const ids = Array.from(sections);
      for (const id of ids) {
        const n = norm(id);
        if (n === nName || n === nShort) return id;
      }
      for (const id of ids) {
        const n = norm(id);
        if (n && (n.includes(nShort) || nShort.includes(n))) return id;
      }
      return null;
    }

    // Open a plugin. `api` is a plain holder (NOT the ctx proxy) that apply()
    // populates while still inside the inject scope. Preference order:
    //   1) if the plugin registers a settings.section (a feature/settings page),
    //      open the Settings shell directly on that section;
    //   2) otherwise open the plugin's bundle page (openBundle).
    function readSlotEntries(slots, key) {
      // Probe every known slots accessor; return the array of registration
      // entries (each carries `options`) or [].
      const tryers = [
        () => (slots.entries ? slots.entries(key) : null),
        () => (slots.entriesOf ? slots.entriesOf(key) : null),
        () => (slots.entriesOfSlot ? slots.entriesOfSlot(key) : null),
        () => (slots.get ? slots.get(key) : null),
      ];
      for (const tryFn of tryers) {
        try {
          const r = tryFn();
          if (Array.isArray(r)) return r;
          if (r && typeof r === "object") return [r];
        } catch (e) {
          /* try next */
        }
      }
      return [];
    }

    function openPlugin(api, name) {
      // Read LIVE at click time — by now every plugin has registered, so the
      // lists are authoritative (startup-time subscription can race boot).
      const slots = api.slots;
      const sectionEntries = slots ? readSlotEntries(slots, "settings.section") : [];
      const sections = new Set();
      for (const e of sectionEntries) {
        const id = e && e.options && e.options.id;
        if (id) sections.add(id);
      }
      const sectionId = matchSection(name, sections);

      // 1) Feature/settings page: open Settings on that section.
      let shellStore = api.shellStore;
      if (!shellStore && slots) {
        const stEntries = readSlotEntries(slots, "sidebar.settings");
        for (const e of stEntries) {
          const s = (e && e.store) || (e && e.options && e.options.store);
          if (s) { shellStore = s; break; }
        }
        api.shellStore = shellStore || api.shellStore;
      }
      // The slot's `store` is the store HANDLE (it has `.create()`); the live
      // instance carrying `.actions` comes from `.create()`. The host itself
      // does `const inst = handle.create(); inst.actions.open()` — so we must
      // create() first, exactly like the host does.
      let inst = shellStore;
      if (shellStore && typeof shellStore.create === "function") {
        try { inst = shellStore.create(); } catch (e) { /* keep handle */ }
      }
      const probe = (o) => (o && o.actions ? Object.keys(o.actions).join(",") : "none");
      console.info(
        "[sc] click " + name + " | matched=" + sectionId +
        " hasCreate=" + !!(shellStore && shellStore.create) +
        " handleActions=[" + probe(shellStore) + "] instActions=[" + probe(inst) + "]"
      );
      if (sectionId && inst) {
        let opener = null;
        if (inst.actions && typeof inst.actions.openSection === "function") {
          opener = () => inst.actions.openSection(sectionId);
        } else if (typeof inst.openSection === "function") {
          opener = () => inst.openSection(sectionId);
        } else if (inst.actions && typeof inst.actions.open === "function") {
          opener = () => {
            inst.actions.open();
            if (typeof inst.actions.select === "function") inst.actions.select(sectionId);
          };
        }
        if (opener) {
          try {
            opener();
            console.info("[sc] opened settings section: " + sectionId);
            // The settings view is a modal overlay. Restore the right column
            // to whatever the user was looking at before the click, so closing
            // the settings modal returns them to their previous page instead of
            // our placeholder panel.
            try {
              if (api.layout && typeof api.layout.selectPanel === "function") {
                api.layout.selectPanel(api._prevPanel != null ? api._prevPanel : null);
              }
            } catch (e) {
              console.warn("[dsh-sidebar-shortcut] restore previous panel failed:", e);
            }
            return true;
          } catch (e) {
            console.warn("[dsh-sidebar-shortcut] openSection(" + sectionId + ") failed:", e);
          }
        }
      }

      // 2) Plugin bundle page.
      try {
        const nav = api.reflect && api.reflect.get && api.reflect.get("pluginNavigation");
        if (nav && typeof nav.openBundle === "function") {
          nav.openBundle(name);
          console.info("[sc] opened bundle page: " + name);
          return true;
        }
      } catch (e) {
        console.warn("[dsh-sidebar-shortcut] pluginNavigation.openBundle failed:", e);
      }

      // 3) Last resort: host Plugins panel.
      try {
        if (api.layout && typeof api.layout.selectPanel === "function") {
          api.layout.selectPanel(PLUGINS_PANEL);
          return true;
        }
      } catch (e) {
        console.warn("[dsh-sidebar-shortcut] selectPanel('plugins') failed:", e);
      }
      console.warn("[dsh-sidebar-shortcut] cannot open plugin page for " + name);
      return false;
    }

    // ---- shared UI kit for the settings card ------------------------------
    // All styles are inline (no external CSS) and lean on host CSS variables
    // with sensible fallbacks, so the card looks native in both light & dark
    // DSH themes. Everything is a plain function returning h(...) elements.
    const ACCENT = "#6366f1";
    const CSS = {
      page: { padding: "4px 2px 8px", fontFamily: "inherit", color: "var(--dsw-alias-label-primary, inherit)" },
      hero: {
        display: "flex", alignItems: "center", gap: 14, padding: "16px 18px",
        borderRadius: 14, marginBottom: 16,
        background: "linear-gradient(135deg, rgba(99,102,241,0.14), rgba(99,102,241,0.04))",
        border: "1px solid rgba(99,102,241,0.28)",
      },
      heroBadge: {
        width: 42, height: 42, borderRadius: 12, flex: "none",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 22, background: "rgba(99,102,241,0.18)", color: ACCENT,
      },
      heroTitle: { margin: 0, fontSize: 17, fontWeight: 700, letterSpacing: 0.2 },
      heroSub: { margin: "3px 0 0", fontSize: 12, opacity: 0.7, lineHeight: 1.5 },
      statusPill: {
        marginLeft: "auto", flex: "none", fontSize: 11, fontWeight: 600,
        padding: "4px 10px", borderRadius: 999, whiteSpace: "nowrap",
      },
      tabs: {
        display: "flex", gap: 4, padding: 4, marginBottom: 16,
        background: "var(--dsw-alias-fill-tertiary, rgba(128,128,128,0.10))",
        borderRadius: 12,
      },
      tab: (on) => ({
        flex: 1, padding: "8px 6px", border: "none", borderRadius: 9,
        cursor: "pointer", fontSize: 13, fontWeight: on ? 700 : 500,
        background: on ? "var(--dsw-alias-fill-primary, #fff)" : "transparent",
        color: on ? ACCENT : "var(--dsw-alias-label-secondary, inherit)",
        boxShadow: on ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
        transition: "all .15s", display: "flex", alignItems: "center",
        justifyContent: "center", gap: 6,
      }),
      section: {
        border: "1px solid var(--dsw-alias-border, rgba(128,128,128,0.22))",
        borderRadius: 12, padding: "14px 16px", marginBottom: 14,
        background: "var(--dsw-alias-fill-primary, transparent)",
      },
      sectionHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 },
      sectionTitle: { margin: 0, fontSize: 14, fontWeight: 700 },
      sectionDesc: { margin: "0 0 12px", fontSize: 12, opacity: 0.65, lineHeight: 1.55 },
      card: (selected) => ({
        display: "flex", flexDirection: "column", gap: 0,
        padding: "10px 12px", borderRadius: 10, marginBottom: 8,
        border: "1px solid " + (selected ? "rgba(99,102,241,0.55)" : "var(--dsw-alias-border, rgba(128,128,128,0.18))"),
        background: selected ? "rgba(99,102,241,0.06)" : "var(--dsw-alias-fill-secondary, rgba(128,128,128,0.04))",
        transition: "border-color .15s, background .15s",
      }),
      cardHead: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" },
      check: { width: 16, height: 16, accentColor: ACCENT, cursor: "pointer", flex: "none" },
      cardName: { fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      chip: {
        fontSize: 10, padding: "2px 8px", borderRadius: 999, flex: "none",
        background: "rgba(128,128,128,0.14)", opacity: 0.85,
      },
      fields: {
        display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px",
        marginTop: 10, paddingTop: 10, alignItems: "center",
        borderTop: "1px dashed var(--dsw-alias-border, rgba(128,128,128,0.20))",
      },
      fieldLabel: { fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" },
      input: {
        width: "100%", boxSizing: "border-box", padding: "6px 9px", fontSize: 12,
        borderRadius: 8, border: "1px solid var(--dsw-alias-border, rgba(128,128,128,0.30))",
        background: "var(--dsw-alias-fill-primary, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)", outline: "none",
      },
      search: {
        width: "100%", boxSizing: "border-box", padding: "8px 12px", fontSize: 12,
        borderRadius: 9, marginBottom: 10,
        border: "1px solid var(--dsw-alias-border, rgba(128,128,128,0.30))",
        background: "var(--dsw-alias-fill-primary, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)", outline: "none",
      },
      btn: (primary, disabled) => ({
        padding: "7px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600,
        border: primary ? "none" : "1px solid var(--dsw-alias-border, rgba(128,128,128,0.30))",
        background: primary ? ACCENT : "transparent",
        color: primary ? "#fff" : "var(--dsw-alias-label-primary, inherit)",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
        transition: "opacity .15s",
      }),
      rowBtn: {
        padding: "4px 10px", borderRadius: 8, fontSize: 12, cursor: "pointer",
        border: "1px solid var(--dsw-alias-border, rgba(128,128,128,0.30))",
        background: "transparent", color: "var(--dsw-alias-label-primary, inherit)",
      },
      saveBar: {
        display: "flex", alignItems: "center", gap: 10, marginTop: 18,
        padding: "12px 14px", borderRadius: 12, position: "sticky", bottom: 0,
        background: "var(--dsw-alias-fill-primary, #fff)",
        border: "1px solid var(--dsw-alias-border, rgba(128,128,128,0.25))",
        boxShadow: "0 -4px 16px rgba(0,0,0,0.06)", zIndex: 2,
      },
      hint: { fontSize: 12, opacity: 0.6 },
      empty: { fontSize: 12, opacity: 0.6, padding: "18px 4px", textAlign: "center" },
    };

    // Toggle switch (styled checkbox) for section-level booleans.
    function Switch(props) {
      const on = !!props.checked;
      return h(
        "span",
        {
          onClick: (e) => { e.stopPropagation(); props.onChange && props.onChange(!on); },
          style: {
            width: 38, height: 21, borderRadius: 999, flex: "none", cursor: "pointer",
            background: on ? ACCENT : "rgba(128,128,128,0.35)", position: "relative",
            transition: "background .18s",
          },
        },
        h("span", {
          style: {
            position: "absolute", top: 2, left: on ? 19 : 2, width: 17, height: 17,
            borderRadius: "50%", background: "#fff", transition: "left .18s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
          },
        })
      );
    }

    // A labelled field rendered as a [label, control] pair for the CSS grid.
    // Returns a plain ARRAY (not React.Fragment): the plugin's React copy is a
    // different instance from the host's, and Fragment is a Symbol that may not
    // be recognized across copies. Arrays need no shared symbol.
    function Field(props) {
      return [
        h("span", { key: "l", style: CSS.fieldLabel }, props.label),
        h("span", { key: "c", style: { minWidth: 0 } }, props.control),
      ];
    }

    // ---- settings card ----------------------------------------------------
    // NOTE: implemented as a CLASS component (this.state / this.setState /
    // componentDidMount) rather than a hooks function component. The client
    // React instance DSH renders plugin slot content with is a separate copy
    // from the one `require("react")` returns here, so calling React.useState
    // inside a plugin component throws "Invalid hook call", which the settings
    // panel's error boundary swallows and renders as an empty (borderless)
    // content area. Class components do not touch the hooks dispatcher and
    // render reliably. Verified against the shipped plugins settings card,
    // which also uses a class component.
    class SettingsSection extends React.Component {
      constructor(props) {
        super(props);
        // `api` is a plain holder populated by apply() inside the inject scope.
        this.api = props.api;
        const savedSelected = loadSelected();
        const savedGroups = loadGroups();
        const savedExternal = loadExternal();
        // Ensure every selected plugin has a valid group assignment in the
        // SAVED data too (migration may have just added them).
        const fixedSelected = JSON.parse(JSON.stringify(savedSelected));
        for (const name of Object.keys(fixedSelected)) {
          if (!fixedSelected[name]) continue;
          const meta = typeof fixedSelected[name] === "object" && fixedSelected[name] ? fixedSelected[name] : (fixedSelected[name] = {});
          meta.group = groupOf(meta, savedGroups) === NO_GROUP ? NO_GROUP : groupOf(meta, savedGroups);
        }
        this.state = {
          bundles: null,
          // SAVED values (what the sidebar actually uses).
          selected: fixedSelected,
          groups: savedGroups,
          external: savedExternal,
          // EDITABLE drafts. Nothing is persisted until 保存 is pressed.
          draftSelected: JSON.parse(JSON.stringify(fixedSelected)),
          draftGroups: JSON.parse(JSON.stringify(savedGroups)),
          draftExternal: JSON.parse(JSON.stringify(savedExternal)),
          hostEntries: this.api && typeof this.api.listHostEntries === "function" ? this.api.listHostEntries() : [],
          dirty: false,
          notice: "",
          attempt: 0,
          // UI-only state (never persisted)
          activeTab: "plugins", // 'plugins' | 'groups' | 'entries'
          pluginQuery: "",
          entryQuery: "",
        };
        this.timer = null;
        // Refresh discovered host entries whenever the bridge (re)captures.
        if (this.api) {
          this.api.onMoreChanged = () => {
            try {
              const list = this.api.listHostEntries ? this.api.listHostEntries() : [];
              this.setState({ hostEntries: list });
            } catch (e) {}
          };
          // A plugin was installed/uninstalled: refresh the list and drop any
          // now-stale selections from BOTH saved and draft state so the UI and
          // the sidebar agree with what is actually installed.
          this.api.onInstalledChanged = () => {
            try { this.read(); } catch (e) {}
            try {
              const installed = this.api.installedNames;
              const isIn = installedMatcher(installed);
              if (!isIn) return;
              const clean = (m) => {
                const out = {};
                for (const n of Object.keys(m)) { if (m[n] && isIn(n)) out[n] = m[n]; }
                return out;
              };
              const sel = clean(this.state.selected);
              const draft = clean(this.state.draftSelected);
              if (Object.keys(sel).length !== Object.keys(this.state.selected).length ||
                  Object.keys(draft).length !== Object.keys(this.state.draftSelected).length) {
                this.setState({ selected: sel, draftSelected: draft });
              }
            } catch (e) {}
          };
        }
      }

      componentDidMount() {
        console.info("[sc] SettingsSection mounted; hasPm=", !!this.api.pm);
        this.read();
        // Authoritative installed-bundle refresh at mount: prunes zombie
        // selections and rebuilds the sidebar, covering the window where the
        // host's change event fired before this component subscribed.
        if (this.api && typeof this.api.refreshInstalled === "function") {
          try { this.api.refreshInstalled(); } catch (e) {}
        }
        // Discover host left-sidebar entries once the bridge may have mounted.
        if (this.api && typeof this.api.listHostEntries === "function") {
          try { this.setState({ hostEntries: this.api.listHostEntries() }); } catch (e) {}
        }
        // The remote service can arrive a beat after mount; poll briefly.
        this.timer = setInterval(() => {
          this.read();
          if (this.api && typeof this.api.listHostEntries === "function") {
            try { this.setState({ hostEntries: this.api.listHostEntries() }); } catch (e) {}
          }
        }, 800);
      }

      componentWillUnmount() {
        if (this.timer) clearInterval(this.timer);
        if (this.api) {
          this.api.onMoreChanged = null;
          this.api.onInstalledChanged = null;
        }
      }

      read() {
        const pm = this.api && this.api.pm;
        if (!pm || typeof pm.listBundles !== "function") {
          // stay in "loading" until the service exists
          this.setState({ bundles: null });
          return;
        }
        Promise.resolve(pm.listBundles())
          .then((res) => {
            console.info(
              "[sc] listBundles resolved:",
              JSON.stringify(res).slice(0, 300)
            );
            const value = res && res.ok !== false ? res.value || res : res;
            const list = Array.isArray(value) ? value : [];
            const rows = list
              .map((b) => ({ name: b && b.name, official: !!(b && b.official) }))
              .filter((b) => b.name);
            // Keep the left-sidebar's authoritative installed-name set fresh
            // even if the host's change event was missed.
            try {
              const names = new Set(rows.map((b) => b.name));
              if (this.api) this.api.installedNames = names;
            } catch (e) {}
            this.setState({ bundles: rows });
          })
          .catch((err) => {
            console.warn("[dsh-sidebar-shortcut] listBundles failed:", err);
            this.setState({ bundles: [] });
          });
      }

      // All edits below touch ONLY the draft state and mark the form dirty.
      // Nothing is persisted until save() is called.
      clone(v) { return JSON.parse(JSON.stringify(v)); }

      toggle(name) {
        const next = Object.assign({}, this.state.draftSelected);
        if (next[name]) delete next[name];
        else {
          const gid = this.state.draftGroups.defs[0] ? this.state.draftGroups.defs[0].id : "default";
          next[name] = { label: "", icon: "", group: gid };
        }
        this.setState({ draftSelected: next, dirty: true, notice: "" });
      }

      setMeta(name, key, value) {
        const next = Object.assign({}, this.state.draftSelected);
        const cur = typeof next[name] === "object" && next[name] ? next[name] : {};
        next[name] = Object.assign({}, cur, { [key]: value });
        this.setState({ draftSelected: next, dirty: true, notice: "" });
      }

      metaOf(name) {
        const v = this.state.draftSelected[name];
        return typeof v === "object" && v ? v : { label: "", icon: "" };
      }

      // ---- group management (draft only) ---------------------------------
      setGroupsEnabled(v) {
        const g = this.clone(this.state.draftGroups);
        g.enabled = v;
        this.setState({ draftGroups: g, dirty: true, notice: "" });
      }
      addGroup() {
        const g = this.clone(this.state.draftGroups);
        const id = newGroupId();
        g.defs.push({ id, name: "分组 " + (g.defs.length + 1), collapsed: false });
        g.order.push(id);
        this.setState({ draftGroups: g, dirty: true, notice: "" });
      }
      renameGroup(id, name) {
        const g = this.clone(this.state.draftGroups);
        const d = g.defs.find((x) => x.id === id);
        if (d) d.name = name;
        this.setState({ draftGroups: g, dirty: true, notice: "" });
      }
      removeGroup(id) {
        const g = this.clone(this.state.draftGroups);
        if (g.defs.length <= 1) return; // keep at least one group
        g.defs = g.defs.filter((x) => x.id !== id);
        g.order = g.order.filter((x) => x !== id);
        const fallback = g.defs[0].id;
        const sel = Object.assign({}, this.state.draftSelected);
        for (const name of Object.keys(sel)) {
          if (sel[name] && sel[name].group === id) {
            sel[name] = Object.assign({}, sel[name], { group: fallback });
          }
        }
        const ext = this.clone(this.state.draftExternal);
        for (const key of Object.keys(ext)) {
          if (ext[key] && ext[key].group === id) ext[key].group = fallback;
        }
        this.setState({ draftGroups: g, draftSelected: sel, draftExternal: ext, dirty: true, notice: "" });
      }

      // ---- adopted host entries (draft only) ------------------------------
      toggleExternal(id, defaultLabel) {
        const next = this.clone(this.state.draftExternal);
        if (next[id]) delete next[id];
        else {
          const gid = this.state.draftGroups.defs[0] ? this.state.draftGroups.defs[0].id : "default";
          next[id] = { group: gid, label: defaultLabel || id, icon: "" };
        }
        this.setState({ draftExternal: next, dirty: true, notice: "" });
      }
      setExternalMeta(id, key, value) {
        const next = this.clone(this.state.draftExternal);
        if (!next[id]) return;
        next[id][key] = value;
        this.setState({ draftExternal: next, dirty: true, notice: "" });
      }
      externalMetaOf(id, defaultLabel) {
        const v = this.state.draftExternal[id];
        return v && typeof v === "object" ? v : { group: NO_GROUP, label: defaultLabel || id, icon: "" };
      }

      // Persist the draft, then rebuild the sidebar from the saved values.
      save() {
        const { draftSelected, draftGroups, draftExternal } = this.state;
        // `collapsed` is owned by the left-sidebar group headers. Preserve the
        // live fold state for groups that still exist so saving never undoes a
        // fold the user just made in the sidebar.
        const live = loadGroups();
        const liveById = {};
        for (const d of live.defs) liveById[d.id] = d.collapsed;
        const toSave = this.clone(draftGroups);
        for (const d of toSave.defs) if (d.id in liveById) d.collapsed = liveById[d.id];
        saveSelected(draftSelected);
        saveGroups(toSave);
        saveExternal(draftExternal);
        this.setState({
          selected: this.clone(draftSelected),
          groups: this.clone(toSave),
          external: this.clone(draftExternal),
          draftSelected: this.clone(draftSelected),
          draftGroups: this.clone(toSave),
          draftExternal: this.clone(draftExternal),
          dirty: false,
          notice: "已保存，左栏已更新。",
        });
        try {
          // Apply pin changes immediately using whichever source is available.
          if (this.api && typeof this.api.applyPins === "function") this.api.applyPins();
          if (this.api && typeof this.api.rebuildIcons === "function") {
            this.api.rebuildIcons();
          }
        } catch (e) {
          console.warn("[dsh-sidebar-shortcut] rebuildIcons after save failed:", e);
        }
      }

      // Discard the draft and restore the last saved values.
      cancel() {
        this.setState({
          draftSelected: this.clone(this.state.selected),
          draftGroups: this.clone(this.state.groups),
          draftExternal: this.clone(this.state.external),
          dirty: false,
          notice: "已取消修改。",
        });
      }

      render() {
        try {
          const {
            bundles, draftSelected: selected, draftGroups: groups,
            draftExternal: external, hostEntries, dirty, notice, attempt,
            activeTab, pluginQuery, entryQuery,
          } = this.state;
          const moreAvailable = !!(
            this.api && (
              (this.api.sidebar && this.api.sidebar.available) ||
              (this.api.more && this.api.more.available)
            )
          );
          const selectedCount = Object.keys(selected).length;
          const adoptedCount = Object.keys(external).length;

          const textCtrl = (value, onChange, placeholder) =>
            h("input", {
              type: "text", value: value || "", placeholder: placeholder || "",
              onChange: (e) => onChange(e.target.value), style: CSS.input,
            });
          const selectCtrl = (value, onChange, opts, disabled) =>
            h("select", {
              value, disabled: !!disabled,
              onChange: (e) => onChange(e.target.value), style: CSS.input,
            }, opts);

          // ---- Tab: plugin shortcuts ---------------------------------------
          let pluginBody;
          if (bundles === null) {
            pluginBody = h("div", { style: CSS.empty }, "读取已装插件中…");
          } else if (bundles.length === 0) {
            pluginBody = h(
              "div", { style: CSS.empty },
              "没有读到你安装的插件。 ",
              h("button", {
                type: "button", style: CSS.rowBtn,
                onClick: () => this.setState({ attempt: attempt + 1, bundles: null }),
              }, "重试")
            );
          } else {
            const q = (pluginQuery || "").toLowerCase();
            const list = bundles.filter((b) => !q || String(b.name).toLowerCase().indexOf(q) >= 0);
            pluginBody = h(
              "div", null,
              h("input", {
                type: "text", value: pluginQuery || "",
                placeholder: "🔍 搜索插件名称…",
                onChange: (e) => this.setState({ pluginQuery: e.target.value }),
                style: CSS.search,
              }),
              list.length === 0
                ? h("div", { style: CSS.empty }, "没有匹配的插件")
                : list.map((b) => {
                    const meta = this.metaOf(b.name);
                    const isOn = !!selected[b.name];
                    const currentGroup = groupOf(meta, groups);
                    const groupName = currentGroup === NO_GROUP
                      ? "不分组"
                      : ((groups.defs.find((d) => d.id === currentGroup) || {}).name || "默认分组");
                    return h(
                      "div", { key: b.name, style: CSS.card(isOn) },
                      h(
                        "div", { style: CSS.cardHead },
                        h("input", {
                          type: "checkbox", checked: isOn, style: CSS.check,
                          onChange: () => this.toggle(b.name),
                        }),
                        h("span", { style: CSS.cardName, title: b.name }, b.name),
                        b.official ? h("span", { style: CSS.chip }, "官方") : null,
                        isOn
                          ? h("span", {
                              style: Object.assign({}, CSS.chip, {
                                background: "rgba(99,102,241,0.16)", color: ACCENT, opacity: 1,
                              }),
                            }, groupName)
                          : null
                      ),
                      isOn
                        ? h(
                            "div", { style: CSS.fields },
                            Field({ label: "名称", control: textCtrl(meta.label, (v) => this.setMeta(b.name, "label", v), b.name) }),
                            Field({ label: "图标", control: textCtrl(meta.icon, (v) => this.setMeta(b.name, "icon", v), "文字 / emoji / 图片 URL") }),
                            Field({
                              label: "分组",
                              control: selectCtrl(currentGroup, (v) => this.setMeta(b.name, "group", v),
                                groups.defs.map((d) => h("option", { key: d.id, value: d.id }, d.name))
                                  .concat([h("option", { key: NO_GROUP, value: NO_GROUP }, "不分组（平铺）")]),
                                !groups.enabled),
                            })
                          )
                        : null
                    );
                  })
            );
          }

          // ---- Tab: group management --------------------------------------
          const groupBody = h(
            "div", null,
            h(
              "div", {
                style: {
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 12px", borderRadius: 10, marginBottom: 12,
                  background: "var(--dsw-alias-fill-secondary, rgba(128,128,128,0.05))",
                },
              },
              Switch({ checked: groups.enabled, onChange: (v) => this.setGroupsEnabled(v) }),
              h(
                "div", { style: { flex: 1 } },
                h("div", { style: { fontSize: 13, fontWeight: 600 } }, "启用分组收纳"),
                h("div", { style: { fontSize: 11, opacity: 0.6, marginTop: 2 } },
                  "每个分组在左栏独立折叠 / 展开；关闭后所有图标平铺显示")
              )
            ),
            groups.enabled
              ? h(
                  "div", null,
                  groups.defs.map((d) =>
                    h(
                      "div", { key: d.id, style: CSS.card(true) },
                      h(
                        "div", { style: CSS.cardHead },
                        h("span", {
                          style: {
                            width: 8, height: 8, borderRadius: "50%", flex: "none",
                            background: ACCENT,
                          },
                        }),
                        h("input", {
                          type: "text", value: d.name, style: Object.assign({}, CSS.input, { flex: 1 }),
                          onChange: (e) => this.renameGroup(d.id, e.target.value),
                        }),
                        h("button", {
                          type: "button", style: CSS.rowBtn,
                          disabled: groups.defs.length <= 1,
                          onClick: () => this.removeGroup(d.id),
                        }, "删除")
                      )
                    )
                  ),
                  h("button", {
                    type: "button",
                    style: Object.assign({}, CSS.btn(false, false), { marginTop: 6, color: ACCENT, borderColor: "rgba(99,102,241,0.5)" }),
                    onClick: () => this.addGroup(),
                  }, "＋ 新建分组")
                )
              : h("div", { style: CSS.empty }, "分组已关闭，图标将直接平铺在左栏"),
            h("div", { style: { marginTop: 10, ...CSS.hint } },
              "提示：折叠状态由左栏的分组头控制并自动记住，无需在此设置。")
          );

          // ---- Tab: existing host entries ---------------------------------
          const entryList = (hostEntries || []).filter((e) => {
            const q = (entryQuery || "").toLowerCase();
            return !q || String(e.label).toLowerCase().indexOf(q) >= 0 || String(e.id).toLowerCase().indexOf(q) >= 0;
          });
          let entryBody;
          if (!hostEntries || hostEntries.length === 0) {
            entryBody = h("div", { style: CSS.empty }, "未发现可管理的左栏入口（系统「插件」入口不可收纳）");
          } else {
            entryBody = h(
              "div", null,
              h(
                "div", {
                  style: {
                    fontSize: 11, opacity: 0.7, marginBottom: 10, lineHeight: 1.5,
                    padding: "8px 10px", borderRadius: 8,
                    background: moreAvailable ? "rgba(99,102,241,0.08)" : "rgba(128,128,128,0.08)",
                  },
                },
                moreAvailable
                  ? "勾选后，原入口从系统左栏隐藏（移入「更多」菜单），改由我们的分组收纳；点分组头展开可见、点击可打开。"
                  : "可勾选并纳入分组显示（当前版本可能无法隐藏原入口，现有分组不受影响）。"
              ),
              h("input", {
                type: "text", value: entryQuery || "", placeholder: "🔍 搜索左栏入口…",
                onChange: (e) => this.setState({ entryQuery: e.target.value }), style: CSS.search,
              }),
              entryList.length === 0
                ? h("div", { style: CSS.empty }, "没有匹配的入口")
                : entryList.map((e) => {
                    const adopted = !!external[e.id];
                    const meta = this.externalMetaOf(e.id, e.label);
                    return h(
                      "div", { key: e.id, style: CSS.card(adopted) },
                      h(
                        "div", { style: CSS.cardHead },
                        h("input", {
                          type: "checkbox", checked: adopted, style: CSS.check,
                          onChange: () => this.toggleExternal(e.id, e.label),
                        }),
                        h("span", { style: CSS.cardName, title: e.id }, e.label),
                        h("span", { style: CSS.chip }, e.id)
                      ),
                      adopted
                        ? h(
                            "div", { style: CSS.fields },
                            Field({ label: "名称", control: textCtrl(meta.label, (v) => this.setExternalMeta(e.id, "label", v), e.label) }),
                            Field({ label: "图标", control: textCtrl(meta.icon, (v) => this.setExternalMeta(e.id, "icon", v), "文字 / emoji / 图片 URL") }),
                            Field({
                              label: "分组",
                              control: selectCtrl(meta.group, (v) => this.setExternalMeta(e.id, "group", v),
                                groups.defs.map((d) => h("option", { key: d.id, value: d.id }, d.name))
                                  .concat([h("option", { key: NO_GROUP, value: NO_GROUP }, "不分组（平铺）")])),
                            })
                          )
                        : null
                    );
                  })
            );
          }

          const tabs = [
            { id: "plugins", icon: "⭐", label: "插件快捷项", badge: selectedCount },
            { id: "groups", icon: "🗂", label: "分组管理", badge: groups.defs.length },
            { id: "entries", icon: "🧩", label: "已有左栏入口", badge: adoptedCount },
          ];
          const statusText = notice || (dirty ? "● 有未保存的修改" : "✓ 已是最新保存状态");
          const statusColor = dirty ? "#f59e0b" : "#22a06b";

          return h(
            "div", { style: CSS.page },
            // Hero
            h(
              "div", { style: CSS.hero },
              h("div", { style: CSS.heroBadge }, "⚡"),
              h(
                "div", { style: { flex: 1, minWidth: 0 } },
                h("h3", { style: CSS.heroTitle }, "侧栏快捷"),
                h("p", { style: CSS.heroSub },
                  "给插件和左栏入口建立可折叠的快捷分组 · 自定义名称与图标 · 改动点「保存」才生效")
              ),
              h("span", {
                style: Object.assign({}, CSS.statusPill, {
                  color: statusColor, background: "rgba(128,128,128,0.14)",
                }),
              }, statusText)
            ),
            // Tabs
            h(
              "div", { style: CSS.tabs },
              tabs.map((t) =>
                h(
                  "button", {
                    key: t.id, type: "button", style: CSS.tab(activeTab === t.id),
                    onClick: () => this.setState({ activeTab: t.id }),
                  },
                  h("span", null, t.icon),
                  h("span", null, t.label),
                  h("span", {
                    style: {
                      fontSize: 10, minWidth: 18, padding: "1px 6px", borderRadius: 999,
                      background: activeTab === t.id ? "rgba(99,102,241,0.16)" : "rgba(128,128,128,0.18)",
                      color: activeTab === t.id ? ACCENT : "inherit",
                    },
                  }, String(t.badge))
                )
              )
            ),
            // Active panel
            activeTab === "plugins"
              ? h("div", { style: CSS.section },
                  h("div", { style: CSS.sectionHead }, h("h4", { style: CSS.sectionTitle }, "⭐ 插件快捷项")),
                  h("p", { style: CSS.sectionDesc }, "勾选要放进左栏的插件，并自定义显示名称、图标与所属分组。"),
                  pluginBody)
              : null,
            activeTab === "groups"
              ? h("div", { style: CSS.section },
                  h("div", { style: CSS.sectionHead }, h("h4", { style: CSS.sectionTitle }, "🗂 分组管理")),
                  h("p", { style: CSS.sectionDesc }, "创建 / 重命名 / 删除分组；每个分组在左栏独立折叠展开。"),
                  groupBody)
              : null,
            activeTab === "entries"
              ? h("div", { style: CSS.section },
                  h("div", { style: CSS.sectionHead }, h("h4", { style: CSS.sectionTitle }, "🧩 已有左栏入口")),
                  h("p", { style: CSS.sectionDesc }, "把系统或第三方插件的左栏图标也收纳进我们的分组统一管理。"),
                  entryBody)
              : null,
            // Sticky save bar
            h(
              "div", { style: CSS.saveBar },
              h("button", {
                type: "button", style: CSS.btn(true, !dirty), disabled: !dirty,
                onClick: () => this.save(),
              }, "保存"),
              h("button", {
                type: "button", style: CSS.btn(false, !dirty), disabled: !dirty,
                onClick: () => this.cancel(),
              }, "取消"),
              h("span", { style: { flex: 1 } }),
              h("span", { style: CSS.hint },
                notice || (dirty ? "改动尚未应用" : "所有改动均已保存"))
            )
          );
        } catch (e) {
          console.error("[sc] SettingsSection render threw:", e);
          return h(
            "div",
            { style: { padding: "12px 0", color: "#c0392b" } },
            "侧栏快捷：渲染出错 —— ",
            String(e && e.message ? e.message : e)
          );
        }
      }
    }

    // ---- sidebar icon -----------------------------------------------------
    function isImageUrl(s) {
      if (typeof s !== "string") return false;
      const v = s.trim().toLowerCase();
      return v.indexOf("http://") === 0 || v.indexOf("https://") === 0;
    }

    // A collapsible group header shown in the left sidebar — one per group.
    // Implemented as a CLASS component (the client React copy disallows hooks).
    class GroupHeader extends React.Component {
      constructor(props) {
        super(props);
        this.state = { collapsed: !!props.collapsed };
        this.onClick = this.onClick.bind(this);
      }
      onClick(e) {
        e.stopPropagation();
        if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
        const collapsed = !this.state.collapsed;
        // Toggle ONLY this group's collapsed flag in the saved config.
        const cfg = loadGroups();
        const d = cfg.defs.find((x) => x.id === this.props.groupId);
        if (d) { d.collapsed = collapsed; saveGroups(cfg); }
        this.setState({ collapsed });
        // Rebuild outside the current render/event stack (avoids disposing the
        // very registration that is currently being rendered/clicked).
        const api = this.props.api;
        setTimeout(() => {
          if (api && typeof api.rebuildIcons === "function") api.rebuildIcons();
        }, 0);
      }
      render() {
        const collapsed = this.state.collapsed;
        const name = this.props.name || "分组";
        const n = this.props.count || 0;
        const arrow = collapsed ? "▸" : "▾";
        return h(
          "button",
          {
            type: "button",
            title: (collapsed ? "展开 " : "收纳 ") + name,
            "aria-label": name,
            onMouseDown: (e) => {
              e.stopPropagation();
              if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
            },
            onPointerDown: (e) => {
              e.stopPropagation();
              if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
            },
            onClick: this.onClick,
            style: {
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              height: "100%",
              boxSizing: "border-box",
              padding: "0 6px",
              fontSize: 12,
              opacity: 0.8,
            },
          },
          // The host's PanelRow already renders this row's label (from the
          // `panels` store) as `panelTitle`. Rendering the name here too would
          // duplicate it ("我的插件4 我的插件"). Keep only the fold arrow + count.
          h("span", { style: { fontSize: 11, fontWeight: 700 } }, arrow),
          h("span", { style: { opacity: 0.55, fontSize: 11 } }, String(n))
        );
      }
    }

    // The folder row also needs a `main` panel (the host calls selectPanel on
    // any panellist row click). We don't want the right column to get stuck on
    // a placeholder, so this panel simply returns the view to the previous
    // page as soon as it mounts.
    class GroupPanel extends React.Component {
      componentDidMount() {
        const api = this.props.api;
        // The host's PanelRow forces a selectPanel(folderId) on ANY row click
        // (our stopPropagation cannot stop it: the sidebar uses a different
        // React instance). Immediately undo it so the right column returns to
        // the page the user was actually on. Do it synchronously AND once more
        // on the next tick as a guard against a later host re-selection —
        // both calls are idempotent, so expand/collapse stays purely in the
        // left sidebar with no right-column flash.
        const back = () => {
          try {
            if (api && api.layout && typeof api.layout.selectPanel === "function") {
              api.layout.selectPanel(api._prevPanel != null ? api._prevPanel : null);
            }
          } catch (e) {}
        };
        back();
        setTimeout(back, 0);
      }
      render() {
        // Intentionally empty: never show a "folder" page in the right column.
        return null;
      }
    }

    // BRIDGE: registered into `sidebar.panellist.actions` (the host's "More"
    // menu). Verified in a real session that the host passes
    //   entries / onOpen(id) / onPinnedChange(id, pinned)
    // as props. We capture them onto the plain `api` holder so the rest of the
    // plugin (Settings card + mirrored rows) can use them, and re-apply the
    // persisted hidden state on every mount (the host's pin state is in-memory
    // only and resets on restart). Renders nothing.
    class MoreActionsBridge extends React.Component {
      componentDidMount() { this.capture(); }
      componentDidUpdate() { this.capture(); }
      capture() {
        const api = this.props.api;
        if (!api) return;
        const p = this.props;
        const entries = Array.isArray(p.entries)
          ? p.entries
              .filter((x) => x && typeof x.id === "string")
              .map((x) => ({ id: x.id, label: String(x.label != null ? x.label : x.id), pinned: !!x.pinned }))
          : null;
        api.more = {
          entries,
          onOpen: typeof p.onOpen === "function" ? p.onOpen : null,
          onPinnedChange: typeof p.onPinnedChange === "function" ? p.onPinnedChange : null,
          available: typeof p.onPinnedChange === "function" && typeof p.onOpen === "function",
        };
        this.reapply();
        if (api.onMoreChanged) {
          try { api.onMoreChanged(); } catch (e) {}
        }
      }
      reapply() {
        const api = this.props.api;
        if (api && typeof api.applyPins === "function") api.applyPins();
      }
      render() { return null; }
    }

    function ShortcutIcon(props) {
      const api = props.api;
      const name = props.name;
      const icon = props.icon || "";
      const label = props.label || name;
      const glyph = name.replace(/^@[^/]+\//, "").slice(0, 2).toUpperCase();
      const visual = isImageUrl(icon)
        ? h("img", {
            src: icon,
            alt: label,
            style: { width: 22, height: 22, objectFit: "cover", borderRadius: 5, display: "block" },
          })
        : h(
            "span",
            {
              style: {
                fontSize: 14,
                fontWeight: 700,
                lineHeight: 1,
                maxWidth: 26,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            },
            icon || glyph
          );
      return h(
        "button",
        {
          type: "button",
          title: label,
          "aria-label": label,
          onMouseDown: (e) => {
            e.stopPropagation();
            if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
          },
          onPointerDown: (e) => {
            e.stopPropagation();
            if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
          },
          onClick: (e) => {
            e.stopPropagation();
            if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
            openPlugin(api, name);
          },
          style: {
            all: "unset",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            boxSizing: "border-box",
          },
        },
        visual
      );
    }

    // Mirror row for an adopted host left-sidebar entry. Looks like a normal
    // shortcut icon but opens the ORIGINAL host panel instead of a plugin page.
    // `icon` supports the same custom formats as plugin shortcuts: an http(s)
    // image URL, or any short text / emoji. Empty -> first character of label.
    function ExternalIcon(props) {
      const api = props.api;
      const hostId = props.hostId;
      const label = props.label || hostId;
      const icon = props.icon || "";
      const glyph = (label || "").trim().slice(0, 1).toUpperCase() || "•";
      const visual = isImageUrl(icon)
        ? h("img", {
            src: icon,
            alt: label,
            style: { width: 22, height: 22, objectFit: "cover", borderRadius: 5, display: "block" },
          })
        : h(
            "span",
            {
              style: {
                fontSize: 13,
                fontWeight: 700,
                lineHeight: 1,
                maxWidth: 24,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            },
            icon || glyph
          );
      const stop = (e) => {
        e.stopPropagation();
        if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
      };
      return h(
        "button",
        {
          type: "button",
          title: label,
          "aria-label": label,
          onMouseDown: stop,
          onPointerDown: stop,
          onClick: (e) => {
            stop(e);
            if (api && typeof api.openHostEntry === "function") api.openHostEntry(hostId);
          },
          style: {
            all: "unset",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            boxSizing: "border-box",
          },
        },
        visual
      );
    }

    // The host still calls selectPanel(our mirror id) when its row is clicked.
    // Register a main panel for that id; on mount it immediately switches the
    // right column to the ORIGINAL host panel (via onOpen / selectPanel).
    class OpenHostPanel extends React.Component {
      componentDidMount() {
        const { api, hostId } = this.props;
        const go = () => {
          try {
            if (api && typeof api.openHostEntry === "function") api.openHostEntry(hostId);
          } catch (e) {}
        };
        go();
        setTimeout(go, 0);
      }
      render() { return null; }
    }

    // ---- shortcut main panel --------------------------------------------
    // The host opens a left-sidebar panel row by calling
    // ctx.layout.selectPanel(id). If no `main` slot is registered under that
    // id, the host THROWS and the click appears to do nothing. So for every
    // selected plugin we register a `main` panel keyed by the same id. Its
    // only job is to open that plugin's page (via pluginNavigation.openBundle)
    // and show a tiny placeholder while that happens.
    class PluginShortcutPanel extends React.Component {
      componentDidMount() {
        const { api, name } = this.props;
        console.info("[sc] shortcut panel mounted for " + name + "; opening…");
        openPlugin(api, name);
      }
      render() {
        const { name } = this.props;
        return h(
          "div",
          { style: { padding: 16, opacity: 0.7 } },
          "正在打开插件：" + name
        );
      }
    }

    // ---- plugin -----------------------------------------------------------
    // NOTE: `remote.pluginManager` and `layout` must be declared explicitly —
    // the client cordis ctx is a proxy and only the NAMED services you list
    // here become reachable. Declaring just "remote" is not enough to read
    // `ctx.remote.pluginManager`. `reflect` is read inside a try/catch below.
    const inject = ["slots", "locale", "remote", "remote.pluginManager", "layout"];

    function apply(ctx) {
      try {
        console.info("[dsh-sidebar-shortcut] v0.2.5 apply() running");
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        const t = ctx.locale.bind(NS);

        // Build a PLAIN holder of the services we need, while we are still
        // inside the inject scope (so the ctx.remote / ctx.reflect proxies are
        // safe to read). Child slot components receive this holder and must
        // NEVER touch the ctx proxy themselves — doing so throws
        // "cannot get property ... without inject" because the child renders
        // outside our inject context.
        const api = { pm: null, remote: null, reflect: null, layout: null, shellStore: null, installedNames: null };
        try {
          api.remote = ctx.remote;
          api.pm = ctx.remote && ctx.remote.pluginManager;
        } catch (e) {
          console.warn("[dsh-sidebar-shortcut] remote.pluginManager unavailable:", e);
        }
        try {
          api.reflect = ctx.reflect;
        } catch (e) {
          console.warn("[dsh-sidebar-shortcut] ctx.reflect unavailable:", e);
        }
        try {
          api.layout = ctx.layout;
        } catch (e) {
          console.warn("[dsh-sidebar-shortcut] ctx.layout unavailable:", e);
        }
        // Track the last "real" panel the user was on (anything not one of our
        // own placeholder panels) so we can return there after a shortcut opens
        // a settings modal and the user closes it.
        api._prevPanel = null;
        const isOurPanel = (id) => {
          const s = String(id);
          return s.indexOf(PANEL_PREFIX) === 0 || s.indexOf(FOLDER_PREFIX) === 0;
        };
        if (api.layout && typeof api.layout.selectPanel === "function") {
          const origSelect = api.layout.selectPanel.bind(api.layout);
          api.layout.selectPanel = (id) => {
            const target = id === null || id === undefined ? null : id;
            // Never record one of our own placeholder/folder panels as the
            // "previous page" — otherwise returning would loop back to us.
            if (target == null || !isOurPanel(target)) {
              api._prevPanel = target; // null -> conversation
            }
            return origSelect(id);
          };
        }

        // Expose the live slots service so click handlers can read the
        // registration lists at click time (after every plugin has booted),
        // independent of any startup-order race. `slots` is a core cordis
        // service we declared in `inject`, so reading it here (inside the
        // inject scope) yields a stable reference safe to call later.
        api.slots = ctx.slots;

        // Warm caches + keep them fresh via subscription (best-effort; the
        // click handler also reads live, so this is just an early hint).
        const sections = new Set();
        const refreshSections = () => {
          try {
            const entries = ctx.slots.entries("settings.section");
            const list = Array.isArray(entries) ? entries : [];
            sections.clear();
            for (const e of list) {
              const id = e && e.options && e.options.id;
              if (id) sections.add(id);
            }
          } catch (e) {
            console.warn("[dsh-sidebar-shortcut] cannot read settings.section list:", e);
          }
        };
        ctx.slots.subscribe("settings.section", refreshSections);
        refreshSections();
        api.getSections = () => sections;

        const grabShellStore = () => {
          try {
            const entries = ctx.slots.entries("sidebar.settings");
            const list = Array.isArray(entries) ? entries : [];
            for (const e of list) {
              const store = (e && e.store) || (e && e.options && e.options.store);
              if (store) {
                // The slot publishes the store HANDLE; resolve to the live
                // instance (with .actions) the same way the host does.
                let resolved = store;
                if (typeof store.create === "function") {
                  try { resolved = store.create(); } catch (e) { /* keep handle */ }
                }
                api.shellStore = resolved;
                break;
              }
            }
          } catch (e) {
            console.warn("[dsh-sidebar-shortcut] cannot read settings shellStore:", e);
          }
        };
        ctx.slots.subscribe("sidebar.settings", grabShellStore);
        grabShellStore();

        // Read the host sidebar's injected capabilities WITHOUT depending on
        // the "More" menu being open. ui-sidebar registers the `sidebar` root
        // with `inject: injectProps` where injectProps() returns
        //   { selectPanel, setPinned, hooks:{ panels, entryPins, ... } }
        // `panels` is a snapshot store of {id,order,label} for every left
        // sidebar row; `setPinned(id,pinned)` hides/shows a row. This is the
        // same source the More menu uses, but available at boot time.
        api.sidebar = { panels: null, setPinned: null, open: null, available: false };
        const readSidebarEntries = () => {
          try {
            const a = ctx.slots.entries("sidebar");
            if (Array.isArray(a) && a.length) return a;
          } catch (e) {}
          try {
            const b = ctx.slots.entriesOfSlot && ctx.slots.entriesOfSlot("sidebar");
            if (Array.isArray(b) && b.length) return b;
          } catch (e) {}
          return [];
        };
        const extractInjected = (e) => {
          if (!e) return null;
          // `inject` may live on the entry top-level or inside `options`.
          const candidates = [e.inject, e.options && e.options.inject, e.injected];
          for (const inj of candidates) {
            if (!inj) continue;
            let props = inj;
            if (typeof inj === "function") {
              try { props = inj(); } catch (err) { props = null; }
            }
            if (props && typeof props === "object") return props;
          }
          return null;
        };
        const grabSidebarInject = () => {
          try {
            const list = readSidebarEntries();
            console.info(
              "[sc] sidebar entries(" + list.length + ") keys=" +
              JSON.stringify(list.slice(0, 3).map((e) => Object.keys(e || {})))
            );
            for (const e of list) {
              const props = extractInjected(e);
              if (!props) continue;
              const hooks = props.hooks || {};
              const panels = hooks.panels || null;
              const setPinned = props.setPinned || null;
              const selectPanel = props.selectPanel || null;
              console.info(
                "[sc] sidebar inject keys=[" + Object.keys(props).join(",") + "]" +
                " hooks=[" + Object.keys(hooks).join(",") + "]" +
                " hasSetPinned=" + (typeof setPinned === "function") + " hasPanels=" + (!!panels)
              );
              if (typeof setPinned === "function" && panels) {
                api.sidebar = {
                  panels,
                  setPinned,
                  open: (id) => {
                    if (typeof selectPanel === "function") { selectPanel(id); return true; }
                    return false;
                  },
                  available: true,
                };
                console.info("[sc] sidebar inject captured: panels+setPinned available");
                setTimeout(() => {
                  try { if (typeof api.applyPins === "function") api.applyPins(); } catch (e) {}
                  try { if (typeof api.onMoreChanged === "function") api.onMoreChanged(); } catch (e) {}
                }, 0);
                break;
              }
            }
          } catch (e) {
            console.warn("[dsh-sidebar-shortcut] grabSidebarInject failed:", e);
          }
        };
        ctx.slots.subscribe("sidebar", grabSidebarInject);
        grabSidebarInject();

        console.info("[sc] apply done; slots=" + (!!api.slots) + " pm=" + (!!api.pm) + " reflect=" + (!!api.reflect) + " layout=" + (!!api.layout) + " shellStore=" + (!!api.shellStore) + " sidebarInject=" + api.sidebar.available);

        // Settings card.
        console.info("[sc] registering settings.section id=dsh-sidebar-shortcut");
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-sidebar-shortcut",
              order: 90,
              label: () => t("nav"),
              locale: NS,
            },
            () => h(SettingsSection, { api })
          )
        );

        // Bridge into the host's "More" menu region. The registration's second
        // arg IS the component: host renders <Comp {...ownerProps} />, so we
        // MUST forward the received props (entries/onOpen/onPinnedChange).
        api.more = { entries: null, onOpen: null, onPinnedChange: null, available: false };
        api._appliedHidden = new Set();
        ctx.slots.inject("sidebar.panellist.actions", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist.actions",
              id: "dsh-sidebar-shortcut:bridge",
              locale: NS,
            },
            (props) => h(MoreActionsBridge, Object.assign({}, props, { api }))
          )
        );
        // Discover all manageable host left-sidebar entries. Prefer the boot-
        // time `sidebar` inject (`panels` snapshot store, has localized labels,
        // available without opening the More menu). Fall back to the More-menu
        // entries, then to the raw slot registration list (ids only).
        const readPanelsSnapshot = (panels) => {
          try {
            if (!panels) return null;
            const snap = typeof panels.getSnapshot === "function" ? panels.getSnapshot() : null;
            if (Array.isArray(snap)) return snap;
          } catch (e) {}
          return null;
        };
        api.listHostEntries = () => {
          const out = [];
          const snap = readPanelsSnapshot(api.sidebar && api.sidebar.panels);
          if (snap) {
            for (const x of snap) if (x && isManageableId(x.id)) out.push({ id: x.id, label: String(x.label != null ? x.label : x.id) });
            return out;
          }
          const more = api.more && Array.isArray(api.more.entries) ? api.more.entries : null;
          if (more) {
            for (const e of more) if (isManageableId(e.id)) out.push({ id: e.id, label: e.label });
            return out;
          }
          try {
            const raw = ctx.slots.entries("sidebar.panellist");
            const list = Array.isArray(raw) ? raw : [];
            for (const x of list) {
              const id = x && x.options && x.options.id;
              if (isManageableId(id)) out.push({ id, label: id });
            }
          } catch (e) {}
          return out;
        };
        // Open an adopted host entry by its original panel id.
        api.openHostEntry = (id) => {
          try {
            if (api.more && typeof api.more.onOpen === "function") { api.more.onOpen(id); return true; }
            if (api.sidebar && typeof api.sidebar.open === "function" && api.sidebar.open(id)) return true;
            if (api.layout && typeof api.layout.selectPanel === "function") { api.layout.selectPanel(id); return true; }
          } catch (e) {
            console.warn("[dsh-sidebar-shortcut] openHostEntry failed:", e);
          }
          return false;
        };
        // Apply the persisted hide/show state using whichever pin source is
        // available (boot-time sidebar inject is preferred).
        api.applyPins = () => {
          const setPinned = (api.sidebar && typeof api.sidebar.setPinned === "function")
            ? api.sidebar.setPinned
            : (api.more && typeof api.more.onPinnedChange === "function" ? api.more.onPinnedChange : null);
          if (!setPinned) return false;
          if (!api._appliedHidden) api._appliedHidden = new Set();
          const ext = loadExternal();
          const wanted = new Set(Object.keys(ext).filter((id) => isManageableId(id)));
          try {
            for (const id of Array.from(api._appliedHidden)) {
              if (!wanted.has(id)) { setPinned(id, true); api._appliedHidden.delete(id); }
            }
            for (const id of wanted) { setPinned(id, false); api._appliedHidden.add(id); }
          } catch (e) {
            console.warn("[dsh-sidebar-shortcut] applyPins failed:", e);
          }
          return true;
        };

        // Live left-sidebar registrations. `api._fibers` holds a dispose fiber
        // per panellist row (keyed by a unique row key) so we can add/remove
        // rows WITHOUT a restart. With multi-group on, each group contributes
        // one header row plus (when expanded) its own icon rows.
        api._fibers = {};
        api._mainRegistered = {};
        const folderId = (gid) => FOLDER_PREFIX + gid;

        // `ctx.slots.inject(...)` returns a DISPOSE FUNCTION (verified in
        // app.asar), NOT an object with `.dispose()`. Older builds returned an
        // object in some paths, so accept both shapes. Calling `.dispose()` on
        // a function is a no-op TypeError (swallowed) which is exactly why the
        // old rows could never be removed and the group looked "uncontrollable".
        const kill = (fiber) => {
          if (!fiber) return;
          try {
            if (typeof fiber === "function") fiber();
            else if (fiber && typeof fiber.dispose === "function") fiber.dispose();
          } catch (e) {
            console.warn("[dsh-sidebar-shortcut] dispose fiber failed:", e);
          }
        };

        const registerMain = (id, comp) => {
          if (api._mainRegistered[id]) return;
          ctx.slots.inject("main", () =>
            ctx.slots.register(
              { name: "main", key: id, locale: NS },
              () => comp()
            )
          );
          api._mainRegistered[id] = true;
        };

        const rebuildIcons = () => {
          try {
            const cfg = loadGroups();
            const external = loadExternal();
            // Prune selections for plugins that are no longer installed, then
            // only render the survivors. `api.installedNames` is the live set
            // refreshed on boot and on the host's `plugin-manager/changed`
            // event; while it is still loading (null) we don't filter (avoids
            // blanking the sidebar on a slow first read).
            const installed = api.installedNames || null;
            const selected = installed ? pruneSelected(installed) : loadSelected();
            const isInstalled = installedMatcher(installed);
            // Build per-plugin display info + resolved group assignment.
            const items = [];
            for (const name of Object.keys(selected)) {
              if (!selected[name]) continue;
              if (isInstalled && !isInstalled(name)) continue; // uninstalled
              const meta = typeof selected[name] === "object" && selected[name] ? selected[name] : {};
              items.push({
                kind: "plugin",
                name,
                label: meta.label || name,
                icon: meta.icon || "",
                group: cfg.enabled ? groupOf(meta, cfg) : NO_GROUP,
              });
            }
            // Adopted host entries: only those the host still exposes (avoid
            // mirroring entries that no longer exist) and that are manageable.
            const hostIds = api.listHostEntries ? api.listHostEntries().map((e) => e.id) : [];
            for (const hostId of Object.keys(external)) {
              if (!isManageableId(hostId)) continue;
              if (hostIds.length && hostIds.indexOf(hostId) < 0) continue;
              const meta = external[hostId] && typeof external[hostId] === "object" ? external[hostId] : {};
              let group = meta.group;
              if (group !== NO_GROUP && !cfg.defs.some((d) => d.id === group)) group = cfg.defs[0].id;
              items.push({
                kind: "external",
                name: hostId,
                label: meta.label || hostId,
                icon: meta.icon || "",
                group: cfg.enabled ? group : NO_GROUP,
              });
            }

            // Dispose every previously registered row.
            for (const k of Object.keys(api._fibers)) {
              kill(api._fibers[k]);
              delete api._fibers[k];
            }

            let order = 50;
            const addRow = (rowKey, opts, comp) => {
              api._fibers[rowKey] = ctx.slots.inject("sidebar.panellist", () =>
                ctx.slots.register(opts, () => comp())
              );
            };
            const registerItem = (it) => {
              const external = it.kind === "external";
              const id = (external ? EXT_PREFIX : PANEL_PREFIX) + it.name;
              addRow((external ? "ext:" : "icon:") + it.name,
                {
                  name: "sidebar.panellist",
                  id,
                  order: order++,
                  label: () => it.label,
                  locale: NS,
                },
                external
                  ? () => h(ExternalIcon, { api, hostId: it.name, label: it.label, icon: it.icon })
                  : () => h(ShortcutIcon, { api, name: it.name, label: it.label, icon: it.icon })
              );
              registerMain(id, external
                ? () => h(OpenHostPanel, { api, hostId: it.name })
                : () => h(PluginShortcutPanel, { api, name: it.name }));
            };

            if (cfg.enabled) {
              // One header per group, followed by that group's rows when the
              // group is expanded. Both plugin shortcuts and adopted host
              // entries assigned to this group are rendered here.
              for (const gid of cfg.order) {
                const def = cfg.defs.find((d) => d.id === gid);
                if (!def) continue;
                const inGroup = items.filter((it) => it.group === gid);
                const fid = folderId(gid);
                registerMain(fid, () => h(GroupPanel, { api }));
                addRow("folder:" + gid,
                  {
                    name: "sidebar.panellist",
                    id: fid,
                    order: order++,
                    label: () => def.name,
                    locale: NS,
                  },
                  () => h(GroupHeader, {
                    api,
                    groupId: gid,
                    name: def.name,
                    collapsed: def.collapsed,
                    count: inGroup.length,
                  })
                );
                if (!def.collapsed) for (const it of inGroup) registerItem(it);
              }
            }

            // Ungrouped items are always shown flat (also when grouping is off,
            // where every item is treated as ungrouped).
            const flat = items.filter((it) => it.group === NO_GROUP || !cfg.enabled);
            for (const it of flat) registerItem(it);

            console.info(
              "[sc] rebuildIcons: enabled=" + cfg.enabled +
              " groups=" + cfg.defs.length + " items=" + items.length +
              " rows=" + Object.keys(api._fibers).length
            );
          } catch (e) {
            console.warn("[dsh-sidebar-shortcut] rebuildIcons failed:", e);
          }
        };
        api.rebuildIcons = rebuildIcons;
        rebuildIcons();

        // ---- keep in sync with installed/uninstalled plugins ---------------
        // `listBundles()` is the authoritative list of installed bundles. The
        // host emits `plugin-manager/changed` after install/uninstall, so we
        // refresh our cached name set and rebuild the sidebar immediately —
        // no restart needed when a plugin is removed.
        const notifySettings = () => {
          try {
            if (api.onInstalledChanged) api.onInstalledChanged();
          } catch (e) {}
        };
        let refreshSeq = 0;
        api.refreshInstalled = () => {
          const pm = api.pm;
          if (!pm || typeof pm.listBundles !== "function") return Promise.resolve(false);
          const seq = ++refreshSeq;
          return Promise.resolve(pm.listBundles())
            .then((res) => {
              if (seq !== refreshSeq) return false; // ignore stale results
              const value = res && res.ok !== false ? (res.value || res) : res;
              const list = Array.isArray(value) ? value : [];
              const names = new Set();
              for (const b of list) if (b && b.name) names.add(b.name);
              const changed = !api.installedNames ||
                names.size !== api.installedNames.size ||
                Array.from(names).some((n) => !api.installedNames.has(n));
              api.installedNames = names;
              console.info("[sc] installed refresh: " + names.size + " bundles, changed=" + changed);
              if (changed) {
                pruneSelected(names);      // drop zombie localStorage entries
                rebuildIcons();            // remove their sidebar rows
                notifySettings();          // refresh the settings card list
              }
              return changed;
            })
            .catch((e) => {
              console.warn("[dsh-sidebar-shortcut] listBundles refresh failed:", e);
              return false;
            });
        };
        // Subscribe in the inject scope (ctx.remote is a proxy). $on returns
        // a disposer in the host; keep it so cordis can tear us down cleanly.
        try {
          if (api.remote && typeof api.remote.$on === "function") {
            const dispose = api.remote.$on("plugin-manager/changed", () => {
              api.refreshInstalled();
            });
            if (typeof dispose === "function") {
              ctx.effect(() => dispose, "dsh-sidebar-shortcut: plugin-manager listener");
            }
          } else {
            console.info("[sc] remote.$on unavailable; relying on boot refresh only");
          }
        } catch (e) {
          console.warn("[dsh-sidebar-shortcut] plugin-manager subscribe failed:", e);
        }
        // Initial authoritative read (also covers the case where the event
        // fired before we subscribed).
        api.refreshInstalled();
      } catch (e) {
        // Never let this plugin break the Web boot.
        console.error("[dsh-sidebar-shortcut] apply failed (plugin disabled):", e);
      }
    }

    return { name: "dsh-sidebar-shortcut", inject, apply };
  },
});
