const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceDist = path.join(root, "node_modules", "electron", "dist");
const devDist = path.join(root, ".dev-electron");
const devExe = path.join(devDist, "Clip Trimmer Dev.exe");
const sourceExe = path.join(sourceDist, "electron.exe");
const rcedit = path.join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
const icon = path.join(root, "build", "icon.ico");
const marker = path.join(devDist, ".clip-trimmer-icon-applied");
const appId = "com.mqt464.cliptrimmer.dev";

function copyDevRuntime() {
  fs.rmSync(devDist, { recursive: true, force: true });
  fs.cpSync(sourceDist, devDist, { recursive: true });
  fs.renameSync(path.join(devDist, "electron.exe"), devExe);
}

function readStamp(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function ensureDevRuntime() {
  const sourceStat = fs.statSync(sourceExe);
  const iconStat = fs.statSync(icon);
  const expectedStamp = JSON.stringify({
    appId,
    electronMtimeMs: sourceStat.mtimeMs,
    iconMtimeMs: iconStat.mtimeMs,
    iconSize: iconStat.size,
  });

  if (!fs.existsSync(devExe) || readStamp(marker) !== expectedStamp) {
    copyDevRuntime();
    spawnSync(
      rcedit,
      [
        devExe,
        "--set-icon",
        icon,
        "--set-version-string",
        "FileDescription",
        "Clip Trimmer Dev",
        "--set-version-string",
        "ProductName",
        "Clip Trimmer",
        "--set-version-string",
        "AppUserModelId",
        appId,
      ],
      { stdio: "inherit" },
    );
    fs.writeFileSync(marker, expectedStamp);
  }
}

ensureDevRuntime();

if (process.argv.includes("--prepare-only")) {
  process.exit(0);
}

const result = spawnSync(devExe, [root], {
  env: {
    ...process.env,
    ELECTRON_FORCE_IS_PACKAGED: "",
  },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
