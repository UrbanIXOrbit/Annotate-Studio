#!/usr/bin/env node
// Friendly pre-flight check: tells you exactly what is missing before the long build starts.
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const os = platform();
let failed = false;

const ok = (msg) => console.log(`  \u2713 ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (msg, fix) => {
  failed = true;
  console.log(`  \u2717 ${msg}`);
  if (fix) console.log(`      -> ${fix}`);
};

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim();
}

console.log('\nChecking your computer for Annotate Studio...\n');

// Node.js
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 9)) {
  fail(`Node.js ${process.versions.node} is too old`, 'Install Node.js 22 LTS from https://nodejs.org');
} else if (major < 22 || (major === 22 && minor < 6)) {
  ok(`Node.js ${process.versions.node}`);
  warn('Node 22.6 or newer is needed for "npm test" (the app itself runs fine).');
} else {
  ok(`Node.js ${process.versions.node}`);
}

// Rust toolchain
const cargo = run('cargo', ['--version']);
const rustc = run('rustc', ['--version']);
if (cargo && rustc) {
  ok(cargo);
} else {
  fail('Rust (cargo) is not installed, or VS Code was not restarted after installing it', 'Install from https://rustup.rs, then close and reopen VS Code.');
}

// Platform build tools (Tauri needs a native toolchain + web view)
if (os === 'linux') {
  const pkgConfig = run('pkg-config', ['--version']);
  if (!pkgConfig) {
    fail('pkg-config is missing', 'Ubuntu/Debian: sudo apt install pkg-config build-essential');
  } else if (spawnSync('pkg-config', ['--exists', 'webkit2gtk-4.1']).status !== 0) {
    fail('WebKitGTK 4.1 development files are missing', 'Ubuntu/Debian: sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev');
  } else {
    ok('WebKitGTK and build tools');
  }
} else if (os === 'darwin') {
  if (run('xcode-select', ['-p'])) ok('Xcode command line tools');
  else fail('Xcode command line tools are missing', 'Run: xcode-select --install');
} else if (os === 'win32') {
  warn('Windows also needs "Microsoft C++ Build Tools" (Desktop development with C++).');
  warn('If the first build stops with "link.exe not found", install them from https://visualstudio.microsoft.com/visual-cpp-build-tools/');
}

console.log('');
if (failed) {
  console.log('Fix the items marked \u2717 above, then run the same command again.\n');
  console.log('Full guide: SETUP.md\n');
  process.exit(1);
}
console.log('All good.\n');
