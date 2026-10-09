import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export function stateFile(directory) {
  return path.join(directory, "github-sync-plugin", "state.json");
}

export function readState(directory) {
  const file = stateFile(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, JSON.stringify({ secret: randomBytes(32).toString("hex") }) + "\n",
        { flag: "wx", mode: 0o600 });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(state.secret ?? "")) {
    throw new Error("Plugin state is unreadable. Restore it before configuring sync.");
  }
  return state;
}

export function saveState(directory, state) {
  const file = stateFile(directory);
  const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function remoteID(config) {
  return createHash("sha256").update(JSON.stringify([
    config.repository.toLowerCase(), config.branch, config.folder,
  ])).digest("hex").slice(0, 24);
}

export function profileID(directory) {
  return createHash("sha256").update(path.resolve(directory)).digest("hex");
}
