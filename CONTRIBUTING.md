# contributing to ultiterm

yo, thanks for wanting to help. ultiterm’s early, so there’s lots of room to build cool stuff - but we wanna keep it clean, fast, and not cursed in a bad way.

## before you start

- check [issues](https://github.com/iluxz/ultiterm/issues) / PRs so we don’t duplicate work
- for big changes/features, open an issue first so we can align on direction
- keep PRs focused - one thing at a time beats a 4,000-line mystery box

## dev setup

### prerequisites

- windows 10/11
- node.js (lts)
- rust (stable)
- tauri prerequisites: https://v2.tauri.app/start/prerequisites/

### local run

```bash
git clone https://github.com/iluxz/ultiterm.git
cd ultiterm
npm install
npm run tauri dev
```

## project shape

- `src/` - frontend ui, terminal renderer, customization/settings, effects
- `src-tauri/` - rust backend: tauri commands, conpty/pty/session logic, native OS integration
- `src-tauri/src/lib.rs` - tauri command wiring
- `src-tauri/src/main.rs` - desktop entry

## what to work on

good early contributions:

- ui/ux cleanup and terminal layout
- config/settings architecture
- theme system
- keybind handling
- docs, bug reports, repros
- windows conpty/session plumbing (if you know rust/windows)

if you’re unsure, open an issue and ask.

## code guidelines

### general

- keep it **lightweight**. don’t add heavy deps for tiny problems
- prefer simple, readable code over clever nonsense
- don’t break windows-first behavior
- if a feature is customizable, think about config/defaults up front

### frontend (ts)

- typescript strict-friendly code, no lazy `any` unless there’s a real reason
- keep ui state predictable
- separate rendering/ui from terminal/session logic where possible

### rust / tauri

- keep tauri commands small and explicit
- validate inputs at the boundary
- don’t block the ui thread with heavy work
- be careful with process/pty lifecycles - no zombie processes

## commits / prs

- use clear commit messages (ex: `feat: add tab bar`, `fix: handle conpty resize`)
- describe what changed and why
- include screenshots/video for ui changes
- note how you tested it (dev run, build, windows version etc.)

## pr checklist

- [ ] scoped change (no random drive-by refactors)
- [ ] builds/runs locally
- [ ] no unnecessary deps
- [ ] docs updated if needed
- [ ] ui changes have screenshots/video

## behavior

all contributors gotta follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). be respectful, be constructive, don’t be weird.

## license

by contributing, you agree your contributions are licensed under the repo’s [MIT License](LICENSE).
