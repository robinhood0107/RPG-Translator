import { copyFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const releaseDir = join(repoRoot, "target", "release");
const artifactsDir = join(releaseDir, "artifacts", "windows");

if (process.platform !== "win32") {
  console.log("Skipping Windows artifact copy on non-Windows host.");
  process.exit(0);
}

const portableSource = join(releaseDir, "rpg-translator-desktop.exe");
const setupSource = newestNsisSetup(join(releaseDir, "bundle", "nsis"));

if (!existsSync(portableSource)) {
  throw new Error(`Portable desktop exe not found at ${portableSource}`);
}
if (!setupSource) {
  throw new Error("NSIS setup exe not found under target/release/bundle/nsis");
}

mkdirSync(artifactsDir, { recursive: true });
await copyWithRetry(portableSource, join(artifactsDir, "RPG-Translator-Portable-x64.exe"));
await copyWithRetry(setupSource, join(artifactsDir, "RPG-Translator-Setup-x64.exe"));
writeFileSync(
  join(artifactsDir, "README-Windows-Artifacts.txt"),
  [
    "RPG-Translator Windows release artifacts",
    "",
    "- RPG-Translator-Setup-x64.exe is the recommended installer and includes WebView2 runtime handling.",
    "- RPG-Translator-Portable-x64.exe is a convenience executable only. It requires WebView2 Runtime.",
    "- Unsigned Windows artifacts may trigger SmartScreen warnings until code signing is approved.",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Prepared Windows artifacts in ${artifactsDir}`);

function newestNsisSetup(nsisDir) {
  if (!existsSync(nsisDir)) return null;
  return readdirSync(nsisDir)
    .filter((name) => name.toLowerCase().endsWith(".exe"))
    .map((name) => join(nsisDir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    .at(0) ?? null;
}

async function copyWithRetry(source, destination) {
  const attempts = 20;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await copyFile(source, destination);
      return;
    } catch (error) {
      if (!isTransientWindowsFileLock(error) || attempt === attempts) {
        throw error;
      }
      await sleep(attempt * 150);
    }
  }
}

function isTransientWindowsFileLock(error) {
  return error && ["EBUSY", "EPERM", "EACCES"].includes(error.code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
