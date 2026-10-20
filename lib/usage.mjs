import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { blobSHA, BridgeError, GitHub, MAX_FILE, normalizeConfig } from "./github.mjs";
import { remoteID } from "./state.mjs";

export const dailyUsage = /^magpie\/usage\/[A-Za-z0-9][A-Za-z0-9_.-]*\.magpie-usage$/;

// Blobs a batch uploads at once. A first sync stages 90 days, and one blob
// per day one after another is what made it look hung.
const UPLOAD_CONCURRENCY = 6;

// mapLimit runs fn over items with at most limit in flight, stopping the
// rest at the first failure so a broken batch is not 90 failures logged.
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  let failure;
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (!failure) {
      const next = queue.shift();
      if (next === undefined) return;
      try { await fn(next); } catch (err) { failure = err; }
    }
  }));
  if (failure) throw failure;
}

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
    this.archives = [];
    // Uploads already started by stage, by blob SHA, so flush waits for them
    // instead of sending the same blob twice.
    this.uploads = new Map();
    // Blob SHAs GitHub has confirmed, for the progress the setup page shows.
    this.arrived = new Set();
    // Uploads in flight, and those waiting for one to finish.
    this.inflight = 0;
    this.drainers = [];
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
    } catch {
      throw new BridgeError("Pending usage uploads are unreadable or belong to another repository. Restore their configuration before syncing.");
    }
  }

  get pending() { return this.entries.size > 0; }
  get conflicted() { return [...this.entries.values()].some((e) => e.conflict); }

  status() {
    return { count: this.entries.size, bytes: [...this.entries.values()].reduce((sum, e) => sum + e.size, 0),
      // How many staged blobs GitHub has already accepted, so a long first
      // upload shows movement instead of an unchanging pending count.
      uploaded: [...this.entries.values()].filter((e) => this.arrived.has(e.sha)).length,
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
    if (!this.pending) this.branch = "";
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
    // Git names a blob by its content, so the SHA GitHub will confirm is known
    // before the upload starts. Answering Magpie now lets its 90 day upload
    // run at disk speed instead of one GitHub round trip per day; flush waits
    // for these before it commits.
    this.upload(gh, sha, bytes);
    return sha;
  }

  upload(gh, sha, bytes) {
    let started = this.uploads.get(sha);
    if (!started) {
      // Queued, not fired at once: a first sync stages 90 days, and 90
      // concurrent blob uploads trip GitHub's secondary rate limit.
      started = this.slot(async () => {
        const landed = await gh.blob(bytes);
        this.arrived.add(sha);
        return landed;
      });
      this.uploads.set(sha, started);
      // A failure is not fatal here: the journal keeps the entry, and flush
      // uploads it again from the spool. Keep the rejected promise handled so
      // a bytes already gone never surfaces as an unhandled rejection.
      started.catch(() => {});
    }
    return started;
  }

  // slot runs fn once fewer than UPLOAD_CONCURRENCY uploads are in flight.
  // A first sync stages 90 days; sending them one at a time is what made it
  // look hung, and sending all 90 at once trips GitHub's secondary limit.
  async slot(fn) {
    while (this.inflight >= UPLOAD_CONCURRENCY) await this.drained();
    this.inflight++;
    try { return await fn(); } finally {
      this.inflight--;
      const waiting = this.drainers;
      this.drainers = [];
      for (const resolve of waiting) resolve();
    }
  }

  drained() {
    return new Promise((resolve) => this.drainers.push(resolve));
  }

  async flush() {
    if (!this.pending) return;
    const gh = new GitHub({ ...this.config, branch: this.branch }, this.fetcher);
    await gh.prepare();
    // Every staged blob, including one whose first upload failed or was
    // never started (a batch recovered from the journal after a restart).
    await mapLimit([...this.entries.values()], UPLOAD_CONCURRENCY, async (e) => {
      const started = this.uploads.get(e.sha);
      if (started) {
        try { await started; return; } catch { /* sent again below */ }
      }
      this.uploads.delete(e.sha);
      await this.upload(gh, e.sha, this.readBlob(e));
    });
    let published;
    try {
      published = await gh.commitUsage(this.entries);
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
    this.uploads.clear();
    this.arrived.clear();
    this.branch = "";
    for (const sha of blobs) this.cleanup(sha);
    return published;
  }
}
