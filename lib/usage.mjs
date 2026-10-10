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
    this.archiveFile = path.join(directory, "github-sync-plugin", "usage-archive.json");
    this.config = config;
    this.fetcher = fetcher;
    this.entries = new Map();
    this.branch = "";
    this.recovered = false;
    this.archives = [];
    if (fs.existsSync(this.archiveFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.archiveFile, "utf8"));
        if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error();
        for (const e of saved.entries) {
          if (!dailyUsage.test(e.name) || !/^[a-f0-9]{40}$/.test(e.sha) ||
              !Number.isSafeInteger(e.size) || e.size < 0 || e.size > MAX_FILE ||
              typeof e.at !== "string" || !e.remote || typeof e.remote.repository !== "string" ||
              typeof e.remote.branch !== "string" || typeof e.remote.folder !== "string") throw new Error();
        }
        this.archives = saved.entries;
      } catch {
        throw new BridgeError("Archived encrypted usage records are unreadable. Restore their local index before syncing.");
      }
    }
    if (!fs.existsSync(this.file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!config || saved.version !== 1 || saved.remote !== remoteID(config) || !saved.branch ||
          !Array.isArray(saved.entries)) throw new Error();
      this.branch = normalizeConfig({ ...config, branch: saved.branch }).branch;
      for (const [name, e] of saved.entries) {
        if (!dailyUsage.test(name) || !/^[a-f0-9]{40}$/.test(e.sha) ||
            (e.before !== null && !/^[a-f0-9]{40}$/.test(e.before)) ||
            !Number.isSafeInteger(e.size) || e.size < 0 || e.size > MAX_FILE ||
            (e.conflict !== undefined && typeof e.conflict !== "boolean")) throw new Error();
        this.entries.set(name, e);
      }
      this.recovered = true;
    } catch {
      throw new BridgeError("Pending usage uploads are unreadable or belong to another repository. Restore their configuration before syncing.");
    }
  }

  get pending() { return this.entries.size > 0; }
  get conflicted() { return [...this.entries.values()].some((e) => e.conflict); }

  status() {
    return { count: this.entries.size, bytes: [...this.entries.values()].reduce((sum, e) => sum + e.size, 0),
      files: [...this.entries].map(([name, e]) => ({ name, sha: e.sha, size: e.size, conflict: !!e.conflict })),
      archives: this.archives };
  }

  writeJournal(entries = this.entries, branch = this.branch) {
    if (!entries.size) { fs.rmSync(this.file, { force: true }); return; }
    atomicWrite(this.file, JSON.stringify({ version: 1, remote: remoteID(this.config), branch, entries: [...entries] }) + "\n");
  }

  content(name) {
    const e = this.entries.get(name);
    return e && !e.conflict ? { type: "file", name: path.posix.basename(name), sha: e.sha, size: e.size, encoding: "none" } : undefined;
  }

  bytes(name) {
    const e = this.entries.get(name);
    if (!e || e.conflict) return undefined;
    return this.readBlob(e);
  }

  readBlob(e) {
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

  export(sha) {
    const e = [...this.entries.values(), ...this.archives].find((entry) => entry.sha === sha);
    if (!e) throw new BridgeError("No such local encrypted usage file.", 404);
    return this.readBlob(e);
  }

  useRemote(name, sha) {
    const e = this.entries.get(name);
    if (!e?.conflict || e.sha !== sha) {
      throw new BridgeError("Pending usage changed. Refresh the setup page before resolving it.", 409);
    }
    this.readBlob(e);
    const archives = [...this.archives, { name, sha: e.sha, size: e.size, at: new Date().toISOString(),
      remote: { repository: this.config.repository, branch: this.branch, folder: this.config.folder } }];
    // Save the archive first so an interrupted resolution always retains the ciphertext.
    atomicWrite(this.archiveFile, JSON.stringify({ version: 1, entries: archives }) + "\n");
    this.archives = archives;
    const entries = new Map(this.entries);
    entries.delete(name);
    this.writeJournal(entries);
    this.entries = entries;
    if (!this.pending) { this.branch = ""; this.recovered = false; }
  }

  cleanup(sha) {
    if ([...this.entries.values(), ...this.archives].some((e) => e.sha === sha)) return;
    try { fs.rmSync(path.join(this.spool, sha), { force: true }); } catch { /* Keep ciphertext if cleanup fails. */ }
  }

  async stage(gh, name, bytes, current) {
    const previous = this.entries.get(name);
    if (previous?.conflict) {
      throw new BridgeError("Resolve pending usage conflicts on the setup page before uploading this file.", 412, {}, "conflict");
    }
    const sha = blobSHA(bytes);
    if (current?.sha === sha) return sha;
    await gh.blob(bytes);
    // Unreferenced remote blobs may disappear; keep the ciphertext for recovery.
    fs.mkdirSync(this.spool, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(this.spool, sha), bytes);
    const entries = new Map(this.entries);
    const before = previous ? previous.before : current?.sha ?? null;
    entries.set(name, { sha, size: bytes.length, before });
    const branch = this.branch || gh.branch;
    this.writeJournal(entries, branch);
    this.entries = entries;
    this.branch = branch;
    if (previous && previous.sha !== sha) this.cleanup(previous.sha);
    return sha;
  }

  async flush() {
    if (!this.pending) return;
    const gh = new GitHub({ ...this.config, branch: this.branch }, this.fetcher);
    await gh.prepare();
    if (this.recovered) {
      for (const e of this.entries.values()) await gh.blob(this.readBlob(e));
    }
    try {
      await gh.commitUsage(this.entries);
    } catch (err) {
      if (err.conflicts) {
        const entries = new Map([...this.entries].map(([name, e]) => [name, { ...e, conflict: err.conflicts.has(name) }]));
        this.writeJournal(entries);
        this.entries = entries;
      }
      throw err;
    }
    fs.unlinkSync(this.file);
    const blobs = new Set([...this.entries.values()].map((e) => e.sha));
    this.entries.clear();
    this.branch = "";
    this.recovered = false;
    for (const sha of blobs) this.cleanup(sha);
  }
}
