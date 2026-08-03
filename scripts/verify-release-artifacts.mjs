import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const releaseDir = path.join(root, "src-tauri", "target", "release");

const managerExe = path.join(releaseDir, "mod-manager-v2.exe");
const updaterExe = path.join(releaseDir, "updater.exe");
const msiDir = path.join(releaseDir, "bundle", "msi");

const missing = [];

if (!fs.existsSync(managerExe)) {
  missing.push(`Missing manager EXE: ${managerExe}`);
}

if (!fs.existsSync(updaterExe)) {
  missing.push(`Missing updater EXE: ${updaterExe}`);
}

let msiFiles = [];
if (fs.existsSync(msiDir)) {
  msiFiles = fs.readdirSync(msiDir).filter((name) => name.toLowerCase().endsWith(".msi"));
}

if (msiFiles.length === 0) {
  missing.push(`Missing MSI in: ${msiDir}`);
}

if (missing.length > 0) {
  console.error("Release artifact verification failed:");
  for (const line of missing) {
    console.error(`- ${line}`);
  }
  process.exit(1);
}

console.log("Release artifact verification passed:");
console.log(`- manager: ${managerExe}`);
console.log(`- updater: ${updaterExe}`);
for (const file of msiFiles) {
  console.log(`- msi: ${path.join(msiDir, file)}`);
}
