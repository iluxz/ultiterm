# Ultiterm

> a lightweight, insanely customizable, windows-first terminal. no bloat, all control.

**ultiterm** is a terminal app built for people who want their terminal to look sick, feel fast, and obey them - not the other way around.

it’s **windows-first** (ConPTY is the first-class target), but the goal is to keep the core clean so other OSes can come later without a rewrite nightmare.

## why ultiterm

most terminals make you pick: pretty but heavy, fast but boring, or customizable if you’re willing to write a novel in config. ultiterm’s trying to hit all three:

- **lightweight** - tauri + system webview2, no bundled chromium brick
- **insane customization** - themes, layout, effects, fonts, keybinds, behavior. if it can be a setting, it should be
- **real control** - windows-first, built around how windows terminal actually works
- **looks go hard** - webgl/canvas effects when you want them, plain fast rendering when you don’t

## stack

| layer | tech | why |
|---|---|---|
| app shell | [tauri v2](https://v2.tauri.app/) | tiny footprint, rust backend, native feel |
| frontend | typescript + vite | fast dev, easy ui/effects iteration |
| renderer | webview2 / webgl | custom visuals without electron tax |
| terminal backend | windows conpty (planned) | real windows terminal behavior |

## project status

🚧 **super early / scaffolding**. repo just got spun up - core terminal engine, pty wiring, tabs/panes, config system, and customization are all on deck.

## planned features

- [ ] conpty-backed terminal sessions (powershell/cmd/wsl/etc.)
- [ ] tabs + panes/splits
- [ ] gpu-accelerated text rendering path
- [ ] webgl background/shader/effect layer
- [ ] theme system (colors, opacity, blur, fonts, cursor, padding)
- [ ] keybind system (fully remappable)
- [ ] config file (hot-reload)
- [ ] profiles (per-shell/per-project settings)
- [ ] plugin/extension hooks (later)

## getting started

### prerequisites

- **windows 10/11** (webview2 installed - usually already there)
- [node.js](https://nodejs.org/) (lts recommended)
- [rust toolchain](https://rustup.rs/)
- tauri v2 prerequisites: https://v2.tauri.app/start/prerequisites/

### run dev

```bash
git clone https://github.com/iluxz/ultiterm.git
cd ultiterm
npm install
npm run tauri dev
```

### build

```bash
npm run tauri build
```

## repo layout

```text
.
├── src/                 # frontend (ui, renderer, customization)
├── src-tauri/           # rust backend (tauri commands, pty/system, app shell)
├── index.html
├── package.json
└── vite.config.ts
```

## contributing

want to help make the sickest terminal on windows? hell yeah.

read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## code of conduct

be cool. read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## security

if you find a security issue, **don’t open a public issue**. see [SECURITY.md](SECURITY.md).

## license

[MIT](LICENSE) © lux

