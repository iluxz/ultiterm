use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

#[derive(Default)]
struct PtyState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

struct ConfigState {
    path: PathBuf,
    _watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
    code: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
struct SessionTab {
    shell: String,
    title: String,
    cwd: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
struct SessionState {
    tabs: Vec<SessionTab>,
    active_index: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct UltitermConfig {
    default_shell: String,
    default_cwd: String,
    shell_args: String,
    font_size: f32,
    font_family: String,
    cursor_style: String,
    cursor_blink: bool,
    padding: u16,
    background: String,
    foreground: String,
    accent: String,
    opacity: f32,
    vibrancy: String,
    scrollback: u32,
    restore_session: bool,
    always_on_top: bool,
    last_session: SessionState,
    keybinds: HashMap<String, String>,
}

impl Default for UltitermConfig {
    fn default() -> Self {
        let mut keybinds = HashMap::new();
        keybinds.insert("newTab".into(), "Ctrl+T".into());
        keybinds.insert("closeTab".into(), "Ctrl+W".into());
        keybinds.insert("nextTab".into(), "Ctrl+Tab".into());
        keybinds.insert("prevTab".into(), "Ctrl+Shift+Tab".into());
        keybinds.insert("copy".into(), "Ctrl+Shift+C".into());
        keybinds.insert("paste".into(), "Ctrl+Shift+V".into());
        keybinds.insert("settings".into(), "Ctrl+,".into());
        keybinds.insert("clear".into(), "Ctrl+K".into());
        keybinds.insert("commandPalette".into(), "Ctrl+Shift+P".into());
        Self {
            default_shell: default_shell(),
            default_cwd: std::env::var("USERPROFILE").unwrap_or_default(),
            shell_args: String::new(),
            font_size: 14.0,
            font_family: "\"Caskaydia Cove Nerd Font\", \"Cascadia Code\", \"JetBrains Mono\", Consolas, monospace".into(),
            cursor_style: "bar".into(),
            cursor_blink: true,
            padding: 10,
            background: "#0b0f17".into(),
            foreground: "#d7deea".into(),
            accent: "#a78bfa".into(),
            opacity: 1.0,
            vibrancy: "none".into(),
            scrollback: 5000,
            restore_session: true,
            always_on_top: false,
            last_session: SessionState::default(),
            keybinds,
        }
    }
}

#[derive(Serialize, Clone)]
struct ShellInfo {
    id: String,
    name: String,
    path: String,
}

fn default_shell() -> String {
    std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
}

#[tauri::command]
fn window_set_vibrancy(window: tauri::Window, effect: String, dark: Option<bool>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_mica};
        let is_dark = dark.unwrap_or(true);
        let _ = clear_acrylic(&window);
        let _ = clear_mica(&window);
        match effect.as_str() {
            "acrylic" => apply_acrylic(&window, Some((10, 10, 20, 125))).map_err(|e| e.to_string())?,
            "mica" => apply_mica(&window, Some(is_dark)).map_err(|e| e.to_string())?,
            _ => {}
        }
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (window, effect, dark); }
    Ok(())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn load_or_create_config(path: &Path) -> UltitermConfig {
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(cfg) = serde_json::from_str::<UltitermConfig>(&raw) {
            return cfg;
        }
    }
    let cfg = UltitermConfig::default();
    let _ = fs::write(path, serde_json::to_string_pretty(&cfg).unwrap_or_else(|_| "{}".into()));
    cfg
}

fn detect_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    let candidates: [(&str, &str, Vec<String>); 5] = [
        ("powershell", "PowerShell", vec![std::env::var("SystemRoot").unwrap_or_default() + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]),
        ("pwsh", "PowerShell 7", vec!["pwsh.exe".into()]),
        ("cmd", "Command Prompt", vec![std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())]),
        ("wsl", "WSL", vec!["wsl.exe".into()]),
        ("gitbash", "Git Bash", vec![
            std::env::var("ProgramFiles").unwrap_or_default() + "\\Git\\bin\\bash.exe",
            std::env::var("ProgramFiles(x86)").unwrap_or_default() + "\\Git\\bin\\bash.exe",
        ]),
    ];

    for (id, name, paths) in candidates {
        for p in paths {
            let path = PathBuf::from(&p);
            let exists = if path.is_absolute() { path.exists() } else { which_like(&p) };
            if exists {
                shells.push(ShellInfo { id: id.into(), name: name.into(), path: p });
                break;
            }
        }
    }
    if shells.is_empty() {
        shells.push(ShellInfo { id: "cmd".into(), name: "Command Prompt".into(), path: default_shell() });
    }
    shells
}

fn which_like(cmd: &str) -> bool {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let full = dir.join(cmd);
            if full.exists() { return true; }
        }
    }
    false
}

#[tauri::command]
fn config_get(state: State<'_, ConfigState>) -> Result<UltitermConfig, String> {
    Ok(load_or_create_config(&state.path))
}

#[tauri::command]
fn config_path_get(state: State<'_, ConfigState>) -> String {
    state.path.to_string_lossy().to_string()
}

#[tauri::command]
fn config_save(state: State<'_, ConfigState>, config: UltitermConfig) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&state.path, raw).map_err(|e| e.to_string())
}

#[tauri::command]
fn window_set_always_on_top(window: tauri::Window, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_save(state: State<'_, ConfigState>, session: SessionState) -> Result<(), String> {
    let mut cfg = load_or_create_config(&state.path);
    cfg.last_session = session;
    let raw = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(&state.path, raw).map_err(|e| e.to_string())
}

#[tauri::command]
fn shells_list() -> Vec<ShellInfo> {
    detect_shells()
}

#[tauri::command]
fn pty_create(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
    args: Option<Vec<String>>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = shell.filter(|s| !s.trim().is_empty()).unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(dir) = cwd.filter(|s| !s.trim().is_empty()) {
        cmd.cwd(dir);
    }
    if shell.to_lowercase().contains("powershell") {
        cmd.arg("-NoLogo");
    }
    if let Some(extra) = args {
        for a in extra.into_iter().filter(|s| !s.trim().is_empty()) {
            cmd.arg(a);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();

    let session = PtySession { writer, master: pair.master, child };
    state.sessions.lock().map_err(|_| "pty state lock poisoned".to_string())?.insert(id.clone(), session);

    let read_id = id.clone();
    let read_app = app.clone();
    let read_sessions = state.sessions.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = read_app.emit("pty-output", PtyOutput { id: read_id.clone(), data });
                }
                Err(_) => break,
            }
        }
        let code = read_sessions.lock().ok()
            .and_then(|mut sessions| sessions.remove(&read_id))
            .and_then(|mut s| s.child.wait().ok())
            .map(|status| status.exit_code());
        let _ = read_app.emit("pty-exit", PtyExit { id: read_id, code });
    });

    Ok(id)
}

#[tauri::command]
fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "pty state lock poisoned".to_string())?;
    let session = sessions.get_mut(&id).ok_or("pty session not found")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "pty state lock poisoned".to_string())?;
    let session = sessions.get(&id).ok_or("pty session not found")?;
    session.master.resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "pty state lock poisoned".to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

fn start_config_watcher(app: AppHandle, path: PathBuf) -> Option<RecommendedWatcher> {
    let watch_path = path.clone();
    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            if event.kind.is_modify() || event.kind.is_create() {
                let cfg = load_or_create_config(&watch_path);
                let _ = app_handle.emit("config-changed", cfg);
            }
        }
    }).ok()?;
    let _ = watcher.watch(&path, RecursiveMode::NonRecursive);
    // also watch parent dir for editors that replace file
    if let Some(parent) = path.parent() {
        let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
    }
    Some(watcher)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = config_path(&app.handle())?;
            let _ = load_or_create_config(&path);
            let watcher = start_config_watcher(app.handle().clone(), path.clone());
            app.manage(ConfigState { path, _watcher: Mutex::new(watcher) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_create, pty_write, pty_resize, pty_kill,
            config_get, config_save, config_path_get, shells_list, window_set_vibrancy, session_save, window_set_always_on_top
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
