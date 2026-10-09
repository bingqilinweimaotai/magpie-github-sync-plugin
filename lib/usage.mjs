import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { blobSHA, BridgeError, GitHub, MAX_FILE, normalizeConfig } from "./github.mjs";
import { remoteID } from "./state.mjs";

export const dailyUsage = /^magpie\/usage\/[A-Za-z0-9][A-Za-z0-9_.-]*\.magpie-usage$/;

function atomicWrite(file, bytes) {
  const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

// A PUT stores an encrypted Git blob and journals its name before acknowledging it.
// Magpie's PROPFIND after uploading days publishes the entire group in one commit.
export class UsageBatch {
  constructor(directory, config, fetcher) {
    this.file = path.join(directory, "github-sync-plugin", "usage-pending.json");
    this.spool = path.join(directory, "github-sync-plugin", "usage-blobs");
    this.config = config;
    this.fetcher = fetcher;
    this.entries = new Map();
    this.branch = "";
    this.recovered = false;
    if (!fs.existsSync(this.file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!config || saved.version !== 1 || saved.remote !== remoteID(config) || !saved.branch ||
          !Array.isArray(saved.entries)) throw new Error();
      this.branch = normalizeConfig({ ...config, branch: saved.branch }).branch;
      for (const [name, e] of saved.entries) {
        if (!dailyUsage.test(name) || !/^[a-f0-9]{40}$/.test(e.sha) ||
            (e.before !== null && !/^[a-f0-9]{40}$/.test(e.before)) ||
            !Number.isSafeInteger(e.size) || e.size < 0 || e.size > MAX_FILE) throw new Error();
        this.entries.set(name, e);
      }
      this.recovered = true;
    } catch {
      throw new BridgeError("Pending usage uploads are unreadable or belong to another repository. Restore their configuration before syncing.");
    }
  }

  get pending() { return this.entries.size > 0; }

  content(name) {
    const e = this.entries.get(name);
    return e ? { type: "file", name: path.posix.basename(name), sha: e.sha, size: e.size, encoding: "none" } : undefined;
  }

  bytes(name) {
    const e = this.entries.get(name);
    if (!e) return undefined;
    try {
      const file = path.join(this.spool, e.sha);
      if (fs.statSync(file).size !== e.size) throw new Error();
      const bytes = fs.readFileSync(file);
      if (blobSHA(bytes) !== e.sha) throw new Error();
      return bytes;
    } catch {
      throw new BridgeError("A pending encrypted usage file is unreadable. Its upload record was kept.");
    }
  }

  async stage(gh, name, bytes, current) {
    const sha = blobSHA(bytes);
    if (current?.sha === sha) return sha;
    await gh.blob(bytes);
    // Unreferenced remote blobs may disappear; keep the ciphertext for recovery.
    fs.mkdirSync(this.spool, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(this.spool, sha), bytes);
    const entries = new Map(this.entries);
    const previous = this.entries.get(name);
    entries.set(name, { sha, size: bytes.length, before: previous ? previous.before : current?.sha ?? null });
    const branch = this.branch || gh.branch;
    atomicWrite(this.file, JSON.stringify({ version: 1, remote: remoteID(this.config), branch, entries: [...entries] }) + "\n");
    this.entries = entries;
    this.branch = branch;
    if (previous && previous.sha !== sha && ![...entries.values()].some((e) => e.sha === previous.sha)) {
      try { fs.rmSync(path.join(this.spool, previous.sha), { force: true }); } catch { /* Keep a spare ciphertext copy if cleanup fails. */ }
    }
    return sha;
  }

  async flush() {
    if (!this.pending) return;
    const gh = new GitHub({ ...this.config, branch: this.branch }, this.fetcher);
    await gh.prepare();
    if (this.recovered) {
      for (const [name] of this.entries) await gh.blob(this.bytes(name));
    }
    await gh.commitUsage(this.entries);
    fs.unlinkSync(this.file);
    const blobs = new Set([...this.entries.values()].map((e) => e.sha));
    this.entries.clear();
    this.branch = "";
    this.recovered = false;
    for (const sha of blobs) {
      try { fs.rmSync(path.join(this.spool, sha), { force: true }); } catch { /* Published copies are safe to leave for cleanup. */ }
    }
  }
}
