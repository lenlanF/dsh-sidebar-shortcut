# dsh-sidebar-shortcut

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) client plugin that turns
any installed plugin — or any existing left-sidebar entry — into a tidy,
collapsible shortcut group.

## Features

- **Pick plugins**: a Settings card lists every installed plugin; check the ones
  you want in the left sidebar.
- **Custom name & icon**: each shortcut can override its display name and icon
  (short text / emoji / an `http(s)` image URL).
- **Smart open target**: plugins that ship a `settings.section` open their
  settings page directly; the rest open their bundle/plugin page. Closing the
  settings view returns you to the page you were on.
- **Multiple custom groups**: create/rename/delete groups, assign each shortcut
  to a group (or leave it ungrouped/flat). Each group folds/unfolds
  independently in the left sidebar, with its state remembered.
- **Adopt existing sidebar entries**: pull host / third-party left-sidebar icons
  (e.g. 插件市场, 自动化任务, 任务看板, 智能体, 技能中心) into your groups.
  The original row is hidden (moved into the host's "More" menu) and a mirror
  row is shown under the chosen group; clicking it opens the original panel.
  Adopted entries support their own name/icon too. The `plugins` row is
  reserved by the host and cannot be adopted.
- **Explicit Save / Cancel**: all edits are a local draft until you press
  **保存 (Save)**; **取消 (Cancel)** discards them. Nothing is written on every
  keystroke.

## Install (local, for testing)

This plugin is installed into a DSH **desktop profile** by declaring it in the
profile's `package.json` and running a full app restart:

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-sidebar-shortcut": "file:./vendor/dsh-sidebar-shortcut-<version>.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-sidebar-shortcut"]
    }
  }
}
```

Build a tarball with `pnpm pack`, copy it to `<profile>/vendor/`, then run
`pnpm install --no-frozen-lockfile` with the DSH-bundled Node/pnpm. A **full DSH
restart** is required to load the new client bundle.

## Repository layout

| Path | Purpose |
| --- | --- |
| `lib/client.js` | Client half (the whole feature: Settings card, sidebar rows, group logic) |
| `lib/index.js` | Host half — minimal cordis plugin (`apply` is a no-op) |
| `lib/index.d.ts` | Type declaration for the host half |
| `cordis.patch.yml` | Registers the client plugin into the client cordis composition |
| `test-harness.cjs` | Offline harness that runs `apply()` against a fake client context |

## Compatibility notes

- Client cordis uses a **declarative `inject` array** only; `ctx` is a proxy, so
  `remote.pluginManager` and `layout` must be named explicitly.
- Slot registrations' second argument **is the React component**: the host
  renders `<Comp {...props} />`, so host-provided props (e.g. `entries`,
  `onOpen`, `onPinnedChange`) must be forwarded.
- `ctx.slots.inject(...)` returns a **dispose function** (call it, not
  `.dispose()`).
- The host's panel-pin state is in-memory only; this plugin re-applies the
  persisted hide/show state on every start.
- The panel "adoption" capability is obtained through a standard slot injection
  and degrades gracefully when unavailable (mirror rows still work, original
  rows simply remain).

## License

MIT — see [LICENSE](./LICENSE).
