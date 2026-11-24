import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
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
type Profile = { name: string; shell: string; cwd: string; args: string; startupCommand: string };
type Config = {
  defaultShell: string; defaultCwd: string; shellArgs: string; fontSize: number; fontFamily: string; cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean; padding: number; background: string; foreground: string; accent: string; opacity: number; vibrancy: string;
  scrollback: number; restoreSession: boolean; alwaysOnTop: boolean; copyOnSelect: boolean; startupCommand: string; backgroundImage: string;
  profiles: Profile[]; lastSession: SessionState; keybinds: Record<string, string>;
};
type Pane = { id: string; term: Terminal; fit: FitAddon; search: SearchAddon; container: HTMLDivElement; disposed: boolean; shellPath: string; title: string; opened: boolean };
type LayoutNode = { type: "leaf"; paneId: string } | { type: "split"; dir: "row" | "col"; ratio: number; a: LayoutNode; b: LayoutNode };
type Tab = { id: string; title: string; container: HTMLDivElement; root: LayoutNode; panes: Map<string, Pane>; activePaneId: string };

const tabs = new Map<string, Tab>();
let activeId: string | null = null;
let config: Config | null = null;
let shells: ShellInfo[] = [];
const closedTabs: { shell: string; title: string }[] = [];

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
  invoke("window_set_always_on_top", { on: !!cfg.alwaysOnTop }).catch(() => {});
  const bgImg = (cfg.backgroundImage || "").trim();
  root.style.backgroundImage = bgImg ? `linear-gradient(rgba(8,11,18,.45), rgba(8,11,18,.65)), url("${bgImg.replace(/"/g, '%22')}")` : "";
  root.style.backgroundSize = bgImg ? "cover" : "";
  root.style.backgroundPosition = bgImg ? "center" : "";
  for (const pane of allPanes()) {
    pane.term.options.fontSize = cfg.fontSize;
    pane.term.options.fontFamily = cfg.fontFamily;
    pane.term.options.cursorBlink = cfg.cursorBlink;
    pane.term.options.cursorStyle = cfg.cursorStyle;
    pane.term.options.scrollback = cfg.scrollback ?? 5000;
    pane.term.options.theme = { ...pane.term.options.theme, background: cfg.vibrancy !== "none" ? "rgba(0,0,0,0)" : cfg.background, foreground: cfg.foreground, cursor: cfg.accent };
    pane.fit.fit();
  }
}

function activeTab() { return activeId ? tabs.get(activeId) : undefined; }
function activePane(tab = activeTab()): Pane | undefined { return tab ? tab.panes.get(tab.activePaneId) : undefined; }
function allPanes(): Pane[] { return [...tabs.values()].flatMap(t => [...t.panes.values()]); }
function findPane(paneId: string): { tab: Tab; pane: Pane } | undefined {
  for (const tab of tabs.values()) { const pane = tab.panes.get(paneId); if (pane) return { tab, pane }; }
}

function layoutLeaves(node: LayoutNode): string[] { return node.type === "leaf" ? [node.paneId] : [...layoutLeaves(node.a), ...layoutLeaves(node.b)]; }
function replaceLeaf(node: LayoutNode, paneId: string, next: LayoutNode): LayoutNode {
  if (node.type === "leaf") return node.paneId === paneId ? next : node;
  return { ...node, a: replaceLeaf(node.a, paneId, next), b: replaceLeaf(node.b, paneId, next) };
}
function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "leaf") return node.paneId === paneId ? null : node;
  const a = removeLeaf(node.a, paneId); const b = removeLeaf(node.b, paneId);
  if (!a && !b) return null; if (!a) return b; if (!b) return a; return { ...node, a, b };
}


function persistSession() {
  if (!config) return;
  const list = [...tabs.values()].map(t => {
    const p = t.panes.get(t.activePaneId) || [...t.panes.values()][0];
    return { shell: p?.shellPath || config?.defaultShell || "", title: t.title, cwd: null };
  });
  const activeIndex = Math.max(0, [...tabs.keys()].indexOf(activeId || ""));
  invoke("session_save", { session: { tabs: list, activeIndex } }).catch(() => {});
}

function ensurePaneOpen(pane: Pane) {
  if (pane.opened) return;
  pane.term.open(pane.container);
  try { const webgl = new WebglAddon(); webgl.onContextLoss(() => webgl.dispose()); pane.term.loadAddon(webgl); } catch {}
  pane.opened = true;
}
function fitTab(tab: Tab) {
  for (const p of tab.panes.values()) {
    if (!p.opened || p.container.offsetParent === null) continue;
    try { p.fit.fit(); } catch {}
  }
}
function focusPane(tab: Tab, paneId: string) {
  const pane = tab.panes.get(paneId); if (!pane) return;
  tab.activePaneId = paneId;
  tab.container.querySelectorAll(".pane").forEach(el => el.classList.toggle("active", (el as HTMLElement).dataset.paneId === paneId));
  setTimeout(() => { try { ensurePaneOpen(pane); pane.fit.fit(); pane.term.focus(); } catch {} }, 0);
}

function renderLayout(tab: Tab, node: LayoutNode): HTMLElement {
  if (node.type === "leaf") {
    const pane = tab.panes.get(node.paneId)!;
    pane.container.className = `pane${tab.activePaneId === node.paneId ? " active" : ""}`;
    pane.container.dataset.paneId = node.paneId;
    return pane.container;
  }
  const wrap = document.createElement("div");
  wrap.className = `split split-${node.dir}`;
  const a = renderLayout(tab, node.a); const b = renderLayout(tab, node.b);
  a.style.flex = `${node.ratio} 1 0`; b.style.flex = `${1 - node.ratio} 1 0`;
  const divider = document.createElement("div");
  divider.className = `divider divider-${node.dir}`;
  divider.onmousedown = (e) => {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const ratio = node.dir === "row" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      node.ratio = Math.min(0.85, Math.max(0.15, ratio));
      a.style.flex = `${node.ratio} 1 0`; b.style.flex = `${1 - node.ratio} 1 0`; fitTab(tab);
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  };
  wrap.append(a, divider, b);
  return wrap;
}

function renderTabLayout(tab: Tab) {
  tab.container.innerHTML = "";
  tab.container.className = "tab-root";
  tab.container.appendChild(renderLayout(tab, tab.root));
  for (const p of tab.panes.values()) ensurePaneOpen(p);
  requestAnimationFrame(() => { fitTab(tab); focusPane(tab, tab.activePaneId); });
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const tab of tabs.values()) {
    const el = document.createElement("div");
    el.className = `tab${tab.id === activeId ? " active" : ""}`;
    const active = tab.panes.get(tab.activePaneId);
    el.title = active?.shellPath || tab.title;
    const label = document.createElement("span");
    label.className = "tab-label";
    const anyExited = [...tab.panes.values()].every(p => p.disposed);
    label.textContent = anyExited ? `${tab.title} ? exited` : tab.title;
    label.ondblclick = (e) => { e.stopPropagation(); renameTab(tab.id); };
    el.onclick = () => activateTab(tab.id);
    el.oncontextmenu = (e) => { e.preventDefault(); openTabContextMenu(tab.id, e.clientX, e.clientY); };
    const close = document.createElement("button");
    close.className = "tab-close"; close.type = "button"; close.textContent = "?";
    close.onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
    el.append(label, close);
    tabsEl.appendChild(el);
  }
  persistSession();
}

function activateTab(id: string) {
  const tab = tabs.get(id); if (!tab) return;
  activeId = id;
  for (const t of tabs.values()) t.container.style.display = t.id === id ? "block" : "none";
  renderTabs();
  setTimeout(() => { fitTab(tab); focusPane(tab, tab.activePaneId); }, 0);
}

async function closePane(paneId: string) {
  const found = findPane(paneId); if (!found) return;
  const { tab, pane } = found;
  closedTabs.push({ shell: pane.shellPath, title: pane.title }); if (closedTabs.length > 20) closedTabs.shift();
  if (!pane.disposed) await invoke("pty_kill", { id: paneId }).catch(() => {});
  try { pane.term.dispose(); } catch {} pane.container.remove(); tab.panes.delete(paneId);
  const nextRoot = removeLeaf(tab.root, paneId);
  if (!nextRoot) { await closeTab(tab.id, true); return; }
  tab.root = nextRoot;
  if (tab.activePaneId === paneId) tab.activePaneId = layoutLeaves(tab.root)[0];
  renderTabLayout(tab); renderTabs(); fitTab(tab); focusPane(tab, tab.activePaneId);
}

async function closeTab(id: string, skipKill = false) {
  const tab = tabs.get(id); if (!tab) return;
  if (!skipKill) for (const p of tab.panes.values()) { if (!p.disposed) await invoke("pty_kill", { id: p.id }).catch(() => {}); }
  for (const p of tab.panes.values()) { try { p.term.dispose(); } catch {} }
  tab.container.remove(); tabs.delete(id);
  if (activeId === id) {
    const ids = [...tabs.keys()]; const next = ids[ids.length - 1];
    if (next) activateTab(next); else { activeId = null; await createTab(); }
  } else renderTabs();
}

async function spawnPane(tab: Tab, shellPath?: string, opts?: { cwd?: string | null; args?: string[]; startup?: string; title?: string }) {
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
  term.loadAddon(fit); term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank")));
  const container = document.createElement("div");
  container.className = "pane";

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const binds = config?.keybinds || {};
    const block = [binds.copy, binds.paste, binds.newTab, binds.closeTab, binds.nextTab, binds.prevTab, binds.settings, binds.commandPalette, binds.clear, binds.reopenTab, binds.zoomIn, binds.zoomOut, binds.zoomReset, "Ctrl+F", "Ctrl+Shift+T", "Ctrl+=", "Ctrl+-", "Ctrl+0", "Ctrl+Shift+D", "Ctrl+Shift+E"];
    if (block.some(b => matchesBind(e, b))) return false;
    return true;
  });
  container.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel) { await navigator.clipboard.writeText(sel).catch(() => {}); term.clearSelection(); }
    else await pasteClipboard();
  });
  container.addEventListener("mousedown", () => { tab.activePaneId = pane.id; tab.container.querySelectorAll(".pane").forEach(el => el.classList.toggle("active", (el as HTMLElement).dataset.paneId === pane.id)); term.focus(); });

  const args = opts?.args ?? ((cfg.shellArgs || "").trim() ? (cfg.shellArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(s => s.replace(/^"|"$/g, "")) : []);
  const cwd = opts?.cwd ?? ((cfg.defaultCwd || "").trim() || null);
  const id = await invoke<string>("pty_create", { cols: term.cols, rows: term.rows, shell, cwd, args });
  const pane: Pane = { id, title: opts?.title || shellName(shell), shellPath: shell, term, fit, search, container, disposed: false, opened: false };
  tab.panes.set(id, pane);

  term.onData((data) => { if (!pane.disposed) invoke("pty_write", { id, data }).catch((e) => setStatus(`write failed: ${String(e)}`, "err")); });
  term.onResize(({ cols, rows }) => { if (!pane.disposed) invoke("pty_resize", { id, cols, rows }).catch(() => {}); });
  term.onSelectionChange(() => { if (config?.copyOnSelect) { const s = term.getSelection(); if (s) navigator.clipboard.writeText(s).catch(() => {}); } });
  term.onTitleChange((title) => { if (title?.trim()) { pane.title = title.trim().slice(0, 40); if (tab.panes.size===1) tab.title=pane.title; renderTabs(); } });
  new ResizeObserver(() => { if (pane.opened && pane.container.offsetParent !== null) try { pane.fit.fit(); } catch {} }).observe(container);

  const startup = opts?.startup ?? cfg.startupCommand;
  if (startup && startup.trim()) setTimeout(() => { if (!pane.disposed) invoke("pty_write", { id, data: startup + "\r" }).catch(() => {}); }, 250);
  return pane;
}

async function createTab(shellPath?: string, opts?: { cwd?: string | null; args?: string[]; startup?: string; title?: string }) {
  const tabId = crypto.randomUUID();
  const container = document.createElement("div");
  container.className = "tab-root"; container.style.height = "100%"; container.style.display = "none";
  root.appendChild(container);
  const tab: Tab = { id: tabId, title: opts?.title || shellName(shellPath || config?.defaultShell || "shell"), container, root: { type: "leaf", paneId: "" }, panes: new Map(), activePaneId: "" };
  const pane = await spawnPane(tab, shellPath, opts);
  tab.root = { type: "leaf", paneId: pane.id }; tab.activePaneId = pane.id; tab.title = opts?.title || pane.title;
  tabs.set(tabId, tab);
  renderTabLayout(tab); activateTab(tabId); fitTab(tab); focusPane(tab, pane.id);
  setStatus("connected", "ok");
  return tab;
}

async function splitPane(dir: "row" | "col") {
  const tab = activeTab(); const pane = activePane(tab); if (!tab || !pane) return;
  const newPane = await spawnPane(tab, pane.shellPath);
  tab.root = replaceLeaf(tab.root, pane.id, { type: "split", dir, ratio: 0.5, a: { type: "leaf", paneId: pane.id }, b: { type: "leaf", paneId: newPane.id } });
  tab.activePaneId = newPane.id;
  renderTabLayout(tab); renderTabs(); fitTab(tab); focusPane(tab, newPane.id);
}

function cycleTab(dir: 1 | -1) {
  const ids = [...tabs.keys()];
  if (ids.length < 2 || !activeId) return;
  const idx = ids.indexOf(activeId);
  activateTab(ids[(idx + dir + ids.length) % ids.length]);
}

async function copySelection() {
  const pane = activePane(); if (!pane) return;
  const sel = pane.term.getSelection();
  if (sel) await navigator.clipboard.writeText(sel).catch(() => {});
}

async function pasteClipboard() {
  const pane = activePane();
  if (!pane || pane.disposed) return;
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text) await invoke("pty_write", { id: pane.id, data: text }).catch(() => {});
}

function clearActive() { activePane()?.term.clear(); }
async function restartActive() {
  const p = activePane(); const tab = activeTab(); if (!p || !tab) return;
  const shell = p.shellPath; const oldId = p.id;
  const np = await spawnPane(tab, shell);
  tab.root = replaceLeaf(tab.root, oldId, { type: "leaf", paneId: np.id });
  if (tab.activePaneId === oldId) tab.activePaneId = np.id;
  if (!p.disposed) await invoke("pty_kill", { id: oldId }).catch(() => {});
  try { p.term.dispose(); } catch {} p.container.remove(); tab.panes.delete(oldId);
  renderTabLayout(tab); renderTabs(); fitTab(tab); focusPane(tab, np.id);
}
function renameTab(id: string) {
  const tab = tabs.get(id); if (!tab) return;
  const name = prompt("Rename tab", tab.title);
  if (name && name.trim()) { tab.title = name.trim().slice(0, 40); renderTabs(); }
}
function duplicateTab() { const p = activePane(); if (p) createTab(p.shellPath); }
function reopenClosedTab() { const last = closedTabs.pop(); if (last) createTab(last.shell); }
function zoom(delta: number) {
  if (!config) return;
  config.fontSize = Math.min(32, Math.max(10, (config.fontSize || 14) + delta));
  applyConfig(config); invoke("config_save", { config }).catch(() => {});
}
async function openConfigFile() { const p = await invoke<string>("config_path_get").catch(() => ""); if (p) openPath(p).catch(() => {}); }
function openFind() { findBar.classList.remove("hidden"); findInput.focus(); findInput.select(); }
function closeFind() { findBar.classList.add("hidden"); activePane()?.search.clearDecorations(); activePane()?.term.focus(); }
function findNext(dir: 1 | -1 = 1) {
  const pane = activePane(); const q = findInput.value; if (!pane || !q) return;
  if (dir === 1) pane.search.findNext(q, { regex: false, caseSensitive: false }); else pane.search.findPrevious(q, { regex: false, caseSensitive: false });
}

type PaletteAction = { name: string; meta: string; run: () => void | Promise<void> };
let paletteIndex = 0;
function paletteActions(): PaletteAction[] {
  const binds = config?.keybinds || {};
  return [
    { name: "New Tab", meta: binds.newTab || "Ctrl+T", run: () => createTab() },
    { name: "Close Tab", meta: binds.closeTab || "Ctrl+W", run: () => activeId && closeTab(activeId) },
    { name: "Reopen Closed Tab", meta: binds.reopenTab || "Ctrl+Shift+T", run: reopenClosedTab },
    { name: "Duplicate Tab", meta: "action", run: duplicateTab },
    { name: "Split Right", meta: "Ctrl+Shift+D", run: () => splitPane("row") },
    { name: "Split Down", meta: "Ctrl+Shift+E", run: () => splitPane("col") },
    { name: "Close Pane", meta: "action", run: () => { const p=activePane(); if(p){ const t=activeTab(); if(t&&t.panes.size>1) closePane(p.id); else if(activeId) closeTab(activeId);} } },
    { name: "Rename Tab", meta: "dblclick tab", run: () => activeId && renameTab(activeId) },
    { name: "Next Tab", meta: binds.nextTab || "Ctrl+Tab", run: () => cycleTab(1) },
    { name: "Previous Tab", meta: binds.prevTab || "Ctrl+Shift+Tab", run: () => cycleTab(-1) },
    { name: "Clear Terminal", meta: binds.clear || "Ctrl+K", run: clearActive },
    { name: "Find in Terminal", meta: "Ctrl+F", run: openFind },
    { name: "Restart Session", meta: "action", run: restartActive },
    { name: "Zoom In", meta: binds.zoomIn || "Ctrl+=", run: () => zoom(1) },
    { name: "Zoom Out", meta: binds.zoomOut || "Ctrl+-", run: () => zoom(-1) },
    { name: "Reset Zoom", meta: binds.zoomReset || "Ctrl+0", run: () => { if(config){config.fontSize=14; applyConfig(config); invoke("config_save",{config}).catch(()=>{});} } },
    { name: "Copy Selection", meta: binds.copy || "Ctrl+Shift+C", run: copySelection },
    { name: "Paste Clipboard", meta: binds.paste || "Ctrl+Shift+V", run: pasteClipboard },
    { name: "Open Settings", meta: binds.settings || "Ctrl+,", run: openSettings },
    { name: "Open Config File", meta: "action", run: openConfigFile },
    { name: "Toggle Quake Mode", meta: "Ctrl+Shift+`", run: () => invoke("quake_toggle").catch(() => {}) },
    ...(config?.profiles || []).map(p => ({ name: `Profile: ${p.name}`, meta: p.shell.split(/[\\/]/).pop() || "shell", run: () => createTab(p.shell, { cwd: p.cwd || null, args: p.args ? (p.args.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(s=>s.replace(/^"|"$/g,"")) : [], startup: p.startupCommand || "", title: p.name }) })),
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
function closePalette() { paletteModal.classList.add("hidden"); activePane()?.term.focus(); }

let ctxMenu: HTMLDivElement | null = null;
function closeContextMenu() { ctxMenu?.remove(); ctxMenu = null; }
function openTabContextMenu(tabId: string, x: number, y: number) {
  closeContextMenu();
  const tab = tabs.get(tabId); if (!tab) return;
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`; menu.style.top = `${y}px`;
  const pane = tab.panes.get(tab.activePaneId) || [...tab.panes.values()][0];
  const items: { label: string; run: () => void | Promise<void> }[] = [
    { label: "Rename Tab", run: () => renameTab(tabId) },
    { label: "Duplicate Tab", run: () => createTab(pane?.shellPath) },
    { label: "Split Right", run: () => { activateTab(tabId); splitPane("row"); } },
    { label: "Split Down", run: () => { activateTab(tabId); splitPane("col"); } },
    { label: "Close Pane", run: () => { if (pane && tab.panes.size > 1) closePane(pane.id); else closeTab(tabId); } },
    { label: "Restart Pane", run: () => { activateTab(tabId); if (pane) { tab.activePaneId = pane.id; restartActive(); } } },
    { label: "Close Tab", run: () => closeTab(tabId) },
  ];
  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = "ctx-item"; btn.type = "button"; btn.textContent = item.label;
    btn.onclick = async () => { closeContextMenu(); await item.run(); };
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  ctxMenu = menu;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
}

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
  (must<HTMLInputElement>("#cfg-cwd")).value = config.defaultCwd || "";
  (must<HTMLInputElement>("#cfg-args")).value = config.shellArgs || "";
  (must<HTMLSelectElement>("#cfg-aot")).value = String(config.alwaysOnTop ?? false);
  (must<HTMLSelectElement>("#cfg-copy-select")).value = String(config.copyOnSelect ?? false);
  (must<HTMLInputElement>("#cfg-startup")).value = config.startupCommand || "";
  (must<HTMLInputElement>("#cfg-bgimg")).value = config.backgroundImage || "";
  (must<HTMLTextAreaElement>("#cfg-profiles")).value = JSON.stringify(config.profiles || [], null, 2);
  settingsModal.classList.remove("hidden");
}
function closeSettings() { settingsModal.classList.add("hidden"); activePane()?.term.focus(); }
async function saveSettings() {
  if (!config) return;
  let profiles = config.profiles || [];
  try {
    const raw = (must<HTMLTextAreaElement>("#cfg-profiles")).value.trim();
    profiles = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(profiles)) throw new Error("profiles must be an array");
  } catch (e) { setStatus(`profiles json invalid: ${String(e)}`, "err"); return; }
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
    defaultCwd: (must<HTMLInputElement>("#cfg-cwd")).value.trim(),
    shellArgs: (must<HTMLInputElement>("#cfg-args")).value.trim(),
    alwaysOnTop: (must<HTMLSelectElement>("#cfg-aot")).value === "true",
    copyOnSelect: (must<HTMLSelectElement>("#cfg-copy-select")).value === "true",
    startupCommand: (must<HTMLInputElement>("#cfg-startup")).value.trim(),
    backgroundImage: (must<HTMLInputElement>("#cfg-bgimg")).value.trim(),
    profiles,
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
    if (matchesBind(e, binds.reopenTab || "Ctrl+Shift+T")) { e.preventDefault(); reopenClosedTab(); return; }
    if (matchesBind(e, binds.zoomIn || "Ctrl+=") || (e.ctrlKey && e.key === "+")) { e.preventDefault(); zoom(1); return; }
    if (matchesBind(e, binds.zoomOut || "Ctrl+-")) { e.preventDefault(); zoom(-1); return; }
    if (matchesBind(e, binds.zoomReset || "Ctrl+0")) { e.preventDefault(); zoom(14 - (config?.fontSize || 14)); return; }
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

  await listen<PtyOutput>("pty-output", (e) => { const f = findPane(e.payload.id); if (f && !f.pane.disposed) f.pane.term.write(e.payload.data); });
  await listen<PtyExit>("pty-exit", (e) => {
    const f = findPane(e.payload.id); if (!f) return;
    f.pane.disposed = true;
    f.pane.term.writeln(`\r\n\x1b[90m[process exited${e.payload.code != null ? `: ${e.payload.code}` : ""}]\x1b[0m`);
    if (activeId === f.tab.id) setStatus("session exited", "err");
    renderTabs();
  });
  await listen<Config>("config-changed", (e) => { applyConfig(e.payload); setStatus("config reloaded", "ok"); });

  configPathEl.textContent = await invoke<string>("config_path_get").catch(() => "");
  window.addEventListener("resize", () => { const t=activeTab(); if(t) fitTab(t); });
  window.addEventListener("click", () => closeContextMenu());
  window.addEventListener("blur", () => closeContextMenu());
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
