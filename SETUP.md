# Setup guide

This project looks like it needs a lot of tools. It only needs **two things installed**, and everything else comes along automatically.

## What each tool is

| Tool | What it is | Do I install it? |
| --- | --- | --- |
| **Node.js** | Runs the web part of the app (the screens you see). | **Yes** |
| **npm** | Downloads the libraries the web part needs. It is **installed together with Node.js**. | No (comes with Node) |
| **Yarn** | A different downloader that does the same job as npm. The project used to mix npm and Yarn, which caused most of the confusion. **It now uses npm only.** | **No** |
| **Rust** | The language the desktop part (file access, saving, windows) is written in. | **Yes** |
| **Cargo** | Rust's own downloader and builder. It is **installed together with Rust**, and the app calls it for you. | No (comes with Rust) |
| **Tauri** | The framework that wraps the web screens in a real desktop window. Its command line tool is installed by `npm install`, so you do **not** need `cargo install tauri-cli`. | No |

In one sentence: **Node + npm** run the interface, **Rust + Cargo** build the desktop shell around it, and **Tauri** joins the two.

## Install (one time)

### Windows
1. Install **Node.js 22 LTS**: https://nodejs.org (accept the defaults).
2. Install **Rust**: https://rustup.rs (download and run `rustup-init.exe`, choose the default).
3. Install **Microsoft C++ Build Tools**: https://visualstudio.microsoft.com/visual-cpp-build-tools/ then tick **"Desktop development with C++"**.
4. WebView2 is already included in Windows 11. On Windows 10 install it from https://developer.microsoft.com/microsoft-edge/webview2/
5. **Close and reopen VS Code** so it can find the new tools.

### macOS
1. `xcode-select --install`
2. Install **Node.js 22 LTS** from https://nodejs.org
3. Install **Rust** from https://rustup.rs
4. Close and reopen VS Code.

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev
```
Then install **Node.js 22 LTS** (https://nodejs.org) and **Rust** (https://rustup.rs), and reopen your terminal.

## Run it

Open the project folder in VS Code, open the terminal (**Ctrl + `**), then:

```bash
npm install     # first time only
npm run app     # starts the desktop app
```

The **first** `npm run app` compiles all the Rust parts and can take 5 to 15 minutes. Later starts take seconds.

Shortcuts: double-click `run-windows.bat` (Windows), run `./run-mac-linux.sh` (macOS/Linux), or use **Terminal > Run Task** in VS Code.

## Check your setup

```bash
npm run doctor
```

It lists anything missing and tells you how to fix it. `npm run app` runs this check automatically before starting.

## Build an installer

```bash
npm run app:build
```

The installer appears in `src-tauri/target/release/bundle/`.

## Troubleshooting

| You see | What it means | Fix |
| --- | --- | --- |
| `cargo` or `rustc` "not found" | Rust is not installed, or VS Code was open when you installed it. | Install from https://rustup.rs, then **close and reopen VS Code**. |
| `link.exe not found` or `linker 'link.exe'` (Windows) | The C++ Build Tools are missing. | Install them (Windows step 3 above). |
| `Port 3000 is in use` | Another program (often an old run of this app) is using the port. | Close the other terminal or app, then try again. |
| `yarn: command not found` | You are running an old copy of the project that still uses Yarn. | Use this version: it runs on npm only. |
| `npm ci` complains the lock file is out of sync | An old `package-lock.json`. | Use the `package-lock.json` in this version, or run `npm install`. |
| First run seems stuck on "Compiling ..." | Normal: Rust is building everything once. | Wait. It is fast afterwards. |
| `npm test` fails with an unknown flag | Node is older than 22.6. | Install Node 22 LTS. The app itself still runs on Node 20.9+. |

## For existing contributors: what changed

- The project now uses **npm only**. `yarn.lock` was removed and `package-lock.json` was regenerated from it, so every dependency keeps exactly the same version.
- `src-tauri/tauri.conf.json` and the GitHub release workflow now call `npm` instead of `yarn`.
- Added `npm run app`, `npm run app:build` and `npm run doctor`.
