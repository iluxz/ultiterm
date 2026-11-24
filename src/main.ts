import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
// @ts-ignore - xterm ships css side-effect import\nimport "@xterm/xterm/css/xterm.css";

type PtyOutput = { id: string; data: string };
type PtyExit = { id: string; code?: number | null };

type Tab = {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  disposed: boolean;
};

const tabs = new Map<string, Tab>();
let activeId: string | null = null;

const root = must<HTMLDivElement>("#terminal-root");
const tabsEl = must<HTMLDivElement>("#tabs");
const statusDot = must<HTMLSpanElement>("#status-dot");
const statusText = must<HTMLSpanElement>("#status-text");
const tabTitle = must<HTMLDivElement>("#tab-title");
const termMeta = must<HTMLDivElement>("#term-meta");

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

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const tab of tabs.values()) {
    const btn = document.createElement("button");
    btn.className = `tab${tab.id === activeId ? " active" : ""}`;
    btn.innerHTML = `<span>${tab.title}</span><small>${tab.disposed ? "exited" : "conpty"}</small>`;
    btn.onclick = () => activateTab(tab.id);
    tabsEl.appendChild(btn);
  }
}

function activateTab(id: string) {
  const tab = tabs.get(id);
  if (!tab) return;
  activeId = id;
  for (const t of tabs.values()) t.container.style.display = t.id === id ? "block" : "none";
  tabTitle.textContent = tab.title;
  termMeta.textContent = `${tab.term.cols}x${tab.term.rows}`;
  renderTabs();
  setTimeout(() => {
    tab.fit.fit();
    tab.term.focus();
  }, 0);
}

async function createTab() {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Cascadia Mono, Consolas, "SF Mono", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    theme: {
      background: "#090d12",
      foreground: "#dce8f3",
      cursor: "#7df9c7",
      black: "#10161d",
      red: "#ff7d9a",
      green: "#7df9c7",
      yellow: "#ffd479",
      blue: "#79a8ff",
      magenta: "#c8a1ff",
      cyan: "#7de2ff",
      white: "#dce8f3",
      brightBlack: "#516273",
      brightRed: "#ff99b0",
      brightGreen: "#98ffd6",
      brightYellow: "#ffe29b",
      brightBlue: "#9ec0ff",
      brightMagenta: "#d9beff",
      brightCyan: "#a9ecff",
      brightWhite: "#f4f9ff",
    },
    allowProposedApi: true,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);

  const container = document.createElement("div");
  container.style.height = "100%";
  container.style.display = "none";
  root.appendChild(container);
  term.open(container);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // canvas fallback is fine
  }
  fit.fit();

  const id = await invoke<string>("pty_create", {
    cols: term.cols,
    rows: term.rows,
    shell: null,
    cwd: null,
  });

  const tab: Tab = {
    id,
    title: `session ${tabs.size + 1}`,
    term,
    fit,
    container,
    disposed: false,
  };
  tabs.set(id, tab);

  term.onData((data) => {
    if (tab.disposed) return;
    invoke("pty_write", { id, data }).catch((e) => {
      setStatus(`write failed: ${String(e)}`, "err");
    });
  });

  term.onResize(({ cols, rows }) => {
    if (tab.disposed) return;
    termMeta.textContent = `${cols}x${rows}`;
    invoke("pty_resize", { id, cols, rows }).catch(() => {});
  });

  activateTab(id);
  setStatus("connected", "ok");
}

async function boot() {
  setStatus("booting", "busy");
  await listen<PtyOutput>("pty-output", (e) => {
    const tab = tabs.get(e.payload.id);
    if (!tab || tab.disposed) return;
    tab.term.write(e.payload.data);
  });
  await listen<PtyExit>("pty-exit", (e) => {
    const tab = tabs.get(e.payload.id);
    if (!tab) return;
    tab.disposed = true;
    tab.term.writeln(`\r\n\x1b[90m[process exited${e.payload.code != null ? `: ${e.payload.code}` : ""}]\x1b[0m`);
    if (activeId === tab.id) setStatus("session exited", "err");
    renderTabs();
  });

  window.addEventListener("resize", () => {
    const tab = activeId ? tabs.get(activeId) : null;
    if (tab) tab.fit.fit();
  });

  must<HTMLButtonElement>("#new-tab").addEventListener("click", () => {
    createTab().catch((e) => setStatus(String(e), "err"));
  });

  try {
    await createTab();
  } catch (e) {
    setStatus(String(e), "err");
    root.innerHTML = `<div style="padding:18px;color:#ff99b0;font-family:Consolas,monospace;white-space:pre-wrap">failed to start pty\n${String(e)}</div>`;
  }
}

boot();
