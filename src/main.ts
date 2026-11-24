import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
// @ts-ignore - xterm ships css side-effect import
import "@xterm/xterm/css/xterm.css";

type PtyOutput = { id: string; data: string };
type PtyExit = { id: string; code?: number | null };
type ShellInfo = { id: string; name: string; path: string };
type SessionTab = { shell: string; title: string; cwd?: string | null };
type SessionState = { tabs: SessionTab[]; activeIndex: number };
type Config = {
  defaultShell: string; fontSize: number; fontFamily: string; cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean; padding: number; background: string; foreground: string; accent: string; opacity: number; vibrancy: string;
  scrollback: number; restoreSession: boolean; lastSession: SessionState; keybinds: Record<string, string>;
};
type Tab = { id: string; title: string; shellPath: string; term: Terminal; fit: FitAddon; search: SearchAddon; container: HTMLDivElement; disposed: boolean };

const tabs = new Map<string, Tab>();
let activeId: string | null = null;
let config: Config | null = null;
let shells: ShellInfo[] = [];

const root = must<HTMLDivElement>("#terminal-root");
const tabsEl = must<HTMLDivElement>("#tabs");
const statusDot = must<HTMLSpanElement>("#status-dot");
const statusText = must<HTMLSpanElement>("#status-text");
const shellSelect = must<HTMLSelectElement>("#shell-select");
const settingsModal = must<HTMLDivElement>("#settings-modal");
const configPathEl = must<HTMLDivElement>("#config-path");
const paletteModal = must<HTMLDivElement>("#palette-modal");
const paletteInput = must<HTMLInputElement>("#palette-input");
const paletteList = must<HTMLDivElement>("#palette-list");
const findBar = must<HTMLDivElement>("#find-bar");
const findInput = must<HTMLInputElement>("#find-input");

function must<T extends Element>(sel: string): T {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as T;
}

function setStatus(text: string, kind: "ok" | "err" | "busy" = "busy") {
  statusText.textContent = text;
  statusDot.classList.remove("ok", "err");
  if (kind === "ok") statusDot.classList.add("ok");
  if (kind === "err") statusDot.classList.add("err");
}

function shellName(path: string) {
  return shells.find((s) => s.path.toLowerCase() === path.toLowerCase())?.name || path.split(/[\\/]/).pop() || "shell";
}

function normalizeShortcut(e: KeyboardEvent) {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (key === " ") key = "Space";
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return parts.join("+");
  parts.push(key);
  return parts.join("+");
}

function matchesBind(e: KeyboardEvent, bind?: string) {
  if (!bind) return false;
  const want = bind.toLowerCase().replace(/\s+/g, "");
  const got = normalizeShortcut(e).toLowerCase();
  return want === got || (want === "ctrl+tab" && e.ctrlKey && e.key === "Tab" && !e.shiftKey) || (want === "ctrl+shift+tab" && e.ctrlKey && e.shiftKey && e.key === "Tab");
}

function applyConfig(cfg: Config) {
  config = cfg;
  document.documentElement.style.setProperty("--bg", cfg.background);
  document.documentElement.style.setProperty("--accent", cfg.accent);
  document.documentElement.style.setProperty("--app-opacity", String(cfg.opacity ?? 1));
  document.body.style.background = cfg.vibrancy && cfg.vibrancy !== "none" ? "transparent" : "";
  document.documentElement.style.background = cfg.vibrancy && cfg.vibrancy !== "none" ? "transparent" : cfg.background;
  root.style.padding = `${Math.max(0, cfg.padding - 2)}px`;
  invoke("window_set_vibrancy", { effect: cfg.vibrancy || "none", dark: true }).catch(() => {});
  for (const tab of tabs.values()) {
    tab.term.options.fontSize = cfg.fontSize;
    tab.term.options.fontFamily = cfg.fontFamily;
    tab.term.options.cursorBlink = cfg.cursorBlink;
    tab.term.options.cursorStyle = cfg.cursorStyle;
    tab.term.options.scrollback = cfg.scrollback ?? 5000;
    tab.term.options.theme = { ...tab.term.options.theme, background: cfg.vibrancy !== "none" ? "rgba(0,0,0,0)" : cfg.background, foreground: cfg.foreground, cursor: cfg.accent };
    tab.fit.fit();
  }
}

function activeTab() { return activeId ? tabs.get(activeId) : undefined; }

function persistSession() {
  if (!config) return;
  const list = [...tabs.values()].map(t => ({ shell: t.shellPath, title: t.title, cwd: null }));
  const activeIndex = Math.max(0, [...tabs.keys()].indexOf(activeId || ""));
  invoke("session_save", { session: { tabs: list, activeIndex } }).catch(() => {});
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const tab of tabs.values()) {
    const el = document.createElement("div");
    el.className = `tab${tab.id === activeId ? " active" : ""}`;
    el.title = tab.shellPath;
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.disposed ? `${tab.title} • exited` : tab.title;
    el.onclick = () => activateTab(tab.id);
    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
    el.append(label, close);
    tabsEl.appendChild(el);
  }
  persistSession();
}

function activateTab(id: string) {
  const tab = tabs.get(id);
  if (!tab) return;
  activeId = id;
  for (const t of tabs.values()) t.container.style.display = t.id === id ? "block" : "none";
  renderTabs();
  setTimeout(() => { tab.fit.fit(); tab.term.focus(); }, 0);
}

async function closeTab(id: string) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (!tab.disposed) await invoke("pty_kill", { id }).catch(() => {});
  tab.term.dispose();
  tab.container.remove();
  tabs.delete(id);
  if (activeId === id) {
    const ids = [...tabs.keys()];
    const next = ids[ids.length - 1];
    if (next) activateTab(next);
    else { activeId = null; await createTab(); }
  } else renderTabs();
}

async function createTab(shellPath?: string) {
  const cfg = config || await invoke<Config>("config_get");
  const shell = shellPath || shellSelect.value || cfg.defaultShell;
  const termBg = cfg.vibrancy && cfg.vibrancy !== "none" ? "rgba(0,0,0,0)" : cfg.background;
  const term = new Terminal({
    cursorBlink: cfg.cursorBlink, cursorStyle: cfg.cursorStyle, fontFamily: cfg.fontFamily, fontSize: cfg.fontSize,
    lineHeight: 1.25, letterSpacing: 0, allowProposedApi: true, scrollback: cfg.scrollback ?? 5000,
    theme: {
      background: termBg, foreground: cfg.foreground, cursor: cfg.accent, cursorAccent: cfg.background,
      selectionBackground: "rgba(167,139,250,.28)", black: "#1a2230", red: "#fb7185", green: "#86efac", yellow: "#fde68a",
      blue: "#93c5fd", magenta: "#c4b5fd", cyan: "#67e8f9", white: "#d7deea", brightBlack: "#5c708a", brightRed: "#fda4af",
      brightGreen: "#bbf7d0", brightYellow: "#fef08a", brightBlue: "#bfdbfe", brightMagenta: "#ddd6fe", brightCyan: "#a5f3fc", brightWhite: "#f8fbff",
    },
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank")));
  const container = document.createElement("div");
  container.style.height = "100%"; container.style.display = "none";
  root.appendChild(container);
  term.open(container);
  try { const webgl = new WebglAddon(); webgl.onContextLoss(() => webgl.dispose()); term.loadAddon(webgl); } catch {}
  fit.fit();

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const binds = config?.keybinds || {};
    if (matchesBind(e, binds.copy) || matchesBind(e, binds.paste) || matchesBind(e, binds.newTab) || matchesBind(e, binds.closeTab) || matchesBind(e, binds.nextTab) || matchesBind(e, binds.prevTab) || matchesBind(e, binds.settings) || matchesBind(e, binds.commandPalette) || matchesBind(e, binds.clear)) return false;
    return true;
  });
  container.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel) { await navigator.clipboard.writeText(sel).catch(() => {}); term.clearSelection(); }
    else await pasteClipboard();
  });
  container.addEventListener("mousedown", () => term.focus());

  const id = await invoke<string>("pty_create", { cols: term.cols, rows: term.rows, shell, cwd: null });
  const tab: Tab = { id, title: shellName(shell), shellPath: shell, term, fit, search, container, disposed: false };
  tabs.set(id, tab);

  term.onData((data) => { if (!tab.disposed) invoke("pty_write", { id, data }).catch((e) => setStatus(`write failed: ${String(e)}`, "err")); });
  term.onResize(({ cols, rows }) => { if (!tab.disposed) invoke("pty_resize", { id, cols, rows }).catch(() => {}); });

  activateTab(id);
  setStatus("connected", "ok");
}

function cycleTab(dir: 1 | -1) {
  const ids = [...tabs.keys()];
  if (ids.length < 2 || !activeId) return;
  const idx = ids.indexOf(activeId);
  activateTab(ids[(idx + dir + ids.length) % ids.length]);
}

async function copySelection() {
  const tab = activeTab(); if (!tab) return;
  const sel = tab.term.getSelection();
  if (sel) await navigator.clipboard.writeText(sel).catch(() => {});
}

async function pasteClipboard() {
  const tab = activeTab();
  if (!tab || tab.disposed) return;
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text) await invoke("pty_write", { id: tab.id, data: text }).catch(() => {});
}

function clearActive() { activeTab()?.term.clear(); }
function restartActive() { const tab = activeTab(); if (!tab) return; const shell = tab.shellPath; closeTab(tab.id).then(() => createTab(shell)); }
function openFind() { findBar.classList.remove("hidden"); findInput.focus(); findInput.select(); }
function closeFind() { findBar.classList.add("hidden"); activeTab()?.search.clearDecorations(); activeTab()?.term.focus(); }
function findNext(dir: 1 | -1 = 1) {
  const tab = activeTab(); const q = findInput.value; if (!tab || !q) return;
  if (dir === 1) tab.search.findNext(q, { regex: false, caseSensitive: false }); else tab.search.findPrevious(q, { regex: false, caseSensitive: false });
}

type PaletteAction = { name: string; meta: string; run: () => void | Promise<void> };
let paletteIndex = 0;
function paletteActions(): PaletteAction[] {
  const binds = config?.keybinds || {};
  return [
    { name: "New Tab", meta: binds.newTab || "Ctrl+T", run: () => createTab() },
    { name: "Close Tab", meta: binds.closeTab || "Ctrl+W", run: () => activeId && closeTab(activeId) },
    { name: "Next Tab", meta: binds.nextTab || "Ctrl+Tab", run: () => cycleTab(1) },
    { name: "Previous Tab", meta: binds.prevTab || "Ctrl+Shift+Tab", run: () => cycleTab(-1) },
    { name: "Clear Terminal", meta: binds.clear || "Ctrl+K", run: clearActive },
    { name: "Find in Terminal", meta: "Ctrl+F", run: openFind },
    { name: "Restart Session", meta: "action", run: restartActive },
    { name: "Copy Selection", meta: binds.copy || "Ctrl+Shift+C", run: copySelection },
    { name: "Paste Clipboard", meta: binds.paste || "Ctrl+Shift+V", run: pasteClipboard },
    { name: "Open Settings", meta: binds.settings || "Ctrl+,", run: openSettings },
    { name: "Reload Config", meta: "action", run: async () => { config = await invoke<Config>("config_get"); applyConfig(config); setStatus("config reloaded", "ok"); } },
  ];
}
function renderPalette() {
  const q = paletteInput.value.toLowerCase().trim();
  const items = paletteActions().filter(a => !q || a.name.toLowerCase().includes(q) || a.meta.toLowerCase().includes(q));
  paletteIndex = Math.max(0, Math.min(paletteIndex, items.length - 1));
  paletteList.innerHTML = "";
  items.forEach((a, i) => {
    const el = document.createElement("div");
    el.className = `palette-item${i === paletteIndex ? " active" : ""}`;
    el.innerHTML = `<span class="name"></span><span class="meta"></span>`;
    (el.querySelector(".name") as HTMLElement).textContent = a.name;
    (el.querySelector(".meta") as HTMLElement).textContent = a.meta;
    el.onclick = async () => { closePalette(); await a.run(); };
    paletteList.appendChild(el);
  });
  (paletteList as any)._items = items;
}
function openPalette() { paletteModal.classList.remove("hidden"); paletteInput.value = ""; paletteIndex = 0; renderPalette(); setTimeout(() => paletteInput.focus(), 0); }
function closePalette() { paletteModal.classList.add("hidden"); activeTab()?.term.focus(); }

function openSettings() {
  if (!config) return;
  (must<HTMLSelectElement>("#cfg-shell")).innerHTML = shells.map(s => `<option value="${s.path}">${s.name}</option>`).join("");
  (must<HTMLSelectElement>("#cfg-shell")).value = config.defaultShell;
  (must<HTMLInputElement>("#cfg-font-size")).value = String(config.fontSize);
  (must<HTMLInputElement>("#cfg-font-family")).value = config.fontFamily;
  (must<HTMLSelectElement>("#cfg-cursor")).value = config.cursorStyle;
  (must<HTMLSelectElement>("#cfg-blink")).value = String(config.cursorBlink);
  (must<HTMLInputElement>("#cfg-padding")).value = String(config.padding);
  (must<HTMLInputElement>("#cfg-accent")).value = config.accent;
  (must<HTMLInputElement>("#cfg-bg")).value = config.background;
  (must<HTMLInputElement>("#cfg-fg")).value = config.foreground;
  (must<HTMLInputElement>("#cfg-opacity")).value = String(config.opacity ?? 1);
  (must<HTMLSelectElement>("#cfg-vibrancy")).value = config.vibrancy || "none";
  (must<HTMLInputElement>("#cfg-scrollback")).value = String(config.scrollback ?? 5000);
  (must<HTMLSelectElement>("#cfg-restore")).value = String(config.restoreSession ?? true);
  settingsModal.classList.remove("hidden");
}
function closeSettings() { settingsModal.classList.add("hidden"); activeTab()?.term.focus(); }
async function saveSettings() {
  if (!config) return;
  const next: Config = {
    ...config,
    defaultShell: (must<HTMLSelectElement>("#cfg-shell")).value,
    fontSize: Number((must<HTMLInputElement>("#cfg-font-size")).value) || 14,
    fontFamily: (must<HTMLInputElement>("#cfg-font-family")).value || config.fontFamily,
    cursorStyle: (must<HTMLSelectElement>("#cfg-cursor")).value as Config["cursorStyle"],
    cursorBlink: (must<HTMLSelectElement>("#cfg-blink")).value === "true",
    padding: Number((must<HTMLInputElement>("#cfg-padding")).value) || 0,
    accent: (must<HTMLInputElement>("#cfg-accent")).value,
    background: (must<HTMLInputElement>("#cfg-bg")).value,
    foreground: (must<HTMLInputElement>("#cfg-fg")).value,
    opacity: Math.min(1, Math.max(0.2, Number((must<HTMLInputElement>("#cfg-opacity")).value) || 1)),
    vibrancy: (must<HTMLSelectElement>("#cfg-vibrancy")).value || "none",
    scrollback: Math.min(50000, Math.max(500, Number((must<HTMLInputElement>("#cfg-scrollback")).value) || 5000)),
    restoreSession: (must<HTMLSelectElement>("#cfg-restore")).value === "true",
  };
  await invoke("config_save", { config: next });
  applyConfig(next);
  setStatus("config saved", "ok");
  closeSettings();
}

function wireKeyboard() {
  window.addEventListener("keydown", async (e) => {
    if (matchesBind(e, "Ctrl+F")) { e.preventDefault(); findBar.classList.contains("hidden") ? openFind() : closeFind(); return; }
    if (!findBar.classList.contains("hidden") && e.key === "Escape") { e.preventDefault(); closeFind(); return; }
    if (!paletteModal.classList.contains("hidden")) {
      if (e.key === "Escape") { e.preventDefault(); closePalette(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); paletteIndex++; renderPalette(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); renderPalette(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const items = (paletteList as any)._items as PaletteAction[] || [];
        const item = items[paletteIndex]; if (item) { closePalette(); await item.run(); }
        return;
      }
    }
    if (matchesBind(e, config?.keybinds?.commandPalette || "Ctrl+Shift+P")) { e.preventDefault(); paletteModal.classList.contains("hidden") ? openPalette() : closePalette(); return; }
    if (matchesBind(e, config?.keybinds?.settings || "Ctrl+,")) { e.preventDefault(); settingsModal.classList.contains("hidden") ? openSettings() : closeSettings(); return; }
    if (e.key === "Escape" && !settingsModal.classList.contains("hidden")) { e.preventDefault(); closeSettings(); return; }
    const binds = config?.keybinds || {};
    if (matchesBind(e, binds.newTab)) { e.preventDefault(); await createTab().catch((err) => setStatus(String(err), "err")); return; }
    if (matchesBind(e, binds.closeTab)) { e.preventDefault(); if (activeId) await closeTab(activeId); return; }
    if (matchesBind(e, binds.nextTab)) { e.preventDefault(); cycleTab(1); return; }
    if (matchesBind(e, binds.prevTab)) { e.preventDefault(); cycleTab(-1); return; }
    if (matchesBind(e, binds.copy)) { e.preventDefault(); await copySelection(); return; }
    if (matchesBind(e, binds.paste)) { e.preventDefault(); await pasteClipboard(); return; }
    if (matchesBind(e, binds.clear)) { e.preventDefault(); clearActive(); return; }
  }, { capture: true });
}

async function boot() {
  setStatus("booting", "busy");
  config = await invoke<Config>("config_get").catch(() => null);
  shells = await invoke<ShellInfo[]>("shells_list").catch(() => []);
  if (!config) throw new Error("failed to load config");
  shellSelect.innerHTML = "";
  for (const s of shells) {
    const opt = document.createElement("option");
    opt.value = s.path; opt.textContent = s.name;
    if (s.path.toLowerCase() === config.defaultShell.toLowerCase()) opt.selected = true;
    shellSelect.appendChild(opt);
  }
  applyConfig(config);

  await listen<PtyOutput>("pty-output", (e) => { const tab = tabs.get(e.payload.id); if (tab && !tab.disposed) tab.term.write(e.payload.data); });
  await listen<PtyExit>("pty-exit", (e) => {
    const tab = tabs.get(e.payload.id); if (!tab) return;
    tab.disposed = true;
    tab.term.writeln(`\r\n\x1b[90m[process exited${e.payload.code != null ? `: ${e.payload.code}` : ""}]\x1b[0m`);
    if (activeId === tab.id) setStatus("session exited", "err");
    renderTabs();
  });
  await listen<Config>("config-changed", (e) => { applyConfig(e.payload); setStatus("config reloaded", "ok"); });

  configPathEl.textContent = await invoke<string>("config_path_get").catch(() => "");
  window.addEventListener("resize", () => activeTab()?.fit.fit());
  must<HTMLButtonElement>("#new-tab").addEventListener("click", () => createTab().catch((e) => setStatus(String(e), "err")));
  must<HTMLButtonElement>("#settings-btn").addEventListener("click", openSettings);
  must<HTMLButtonElement>("#settings-close").addEventListener("click", closeSettings);
  must<HTMLButtonElement>("#settings-save").addEventListener("click", () => saveSettings().catch(e => setStatus(String(e), "err")));
  must<HTMLButtonElement>("#settings-reload").addEventListener("click", async () => { config = await invoke<Config>("config_get"); applyConfig(config); openSettings(); setStatus("config reloaded", "ok"); });
  settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) closeSettings(); });
  must<HTMLButtonElement>("#palette-close").addEventListener("click", closePalette);
  paletteModal.addEventListener("click", (e) => { if (e.target === paletteModal) closePalette(); });
  paletteInput.addEventListener("input", () => { paletteIndex = 0; renderPalette(); });
  must<HTMLButtonElement>("#find-close").addEventListener("click", closeFind);
  must<HTMLButtonElement>("#find-next").addEventListener("click", () => findNext(1));
  must<HTMLButtonElement>("#find-prev").addEventListener("click", () => findNext(-1));
  findInput.addEventListener("input", () => findNext(1));
  findInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); } });
  wireKeyboard();

  try {
    const restore = config.restoreSession && config.lastSession?.tabs?.length;
    if (restore) {
      for (const t of config.lastSession.tabs) await createTab(t.shell || config.defaultShell);
      const ids = [...tabs.keys()];
      const target = ids[Math.min(config.lastSession.activeIndex || 0, ids.length - 1)];
      if (target) activateTab(target);
    } else {
      await createTab();
    }
  }
  catch (e) {
    setStatus(String(e), "err");
    root.innerHTML = `<div style="padding:18px;color:#fda4af;font-family:Consolas,monospace;white-space:pre-wrap">failed to start pty\n${String(e)}</div>`;
  }
}

boot().catch((e) => { setStatus(String(e), "err"); console.error(e); });
