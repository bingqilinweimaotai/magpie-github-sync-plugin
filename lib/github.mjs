import { createHash } from "node:crypto";

export const MAX_FILE = 64 * 1024 * 1024;
const validSHA = (sha) => /^[a-f0-9]{40}$/i.test(sha ?? "");
export const blobSHA = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export class BridgeError extends Error {
  constructor(message, status = 502, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function normalizeConfig(input, previous = {}) {
  const repository = String(input.repository ?? "").trim()
    .replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository.split("/").some((p) => p === "." || p === "..")) {
    throw new BridgeError("Repository must be owner/repo.", 400);
  }
  const branch = String(input.branch ?? "").trim();
  const folder = String(input.folder ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (/\s|[~^:?*[\]\\]|\.\.|@\{|\/\/|^\/|\/$|\.$/.test(branch) || branch === "@" ||
      branch.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock"))) {
    throw new BridgeError("Branch contains invalid characters.", 400);
  }
  if (folder && folder.split("/").some((p) => !p || p === "." || p === ".." || /[\\\x00-\x1f]/.test(p))) {
    throw new BridgeError("Folder must be a relative path without empty, . or .. components.", 400);
  }
  const same = repository.toLowerCase() === String(previous.repository ?? "").toLowerCase();
  const token = String(input.token ?? "").trim() || (same ? previous.token : "");
  if (!token || /\s/.test(token)) throw new BridgeError("Enter a GitHub token for this repository.", 400);
  return { repository, branch, folder, token };
}

export async function readLimited(body, limit) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new BridgeError("GitHub returned an oversized response.");
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts, length);
}

export class GitHub {
  constructor(config, fetcher = globalThis.fetch) {
    this.config = config;
    this.fetcher = fetcher;
    this.branch = config.branch;
    this.empty = false;
  }

  async request(method, suffix = "", payload, ref = false, raw = false, object = false) {
    const url = new URL("https://api.github.com");
    url.pathname = `/repos/${this.config.repository}` +
      (suffix ? "/" + suffix.split("/").map(encodeURIComponent).join("/") : "");
    if (ref) url.searchParams.set("ref", ref === true ? this.branch : ref);
    const headers = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: raw ? "application/vnd.github.raw+json" :
        object ? "application/vnd.github.object+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "magpie-github-sync-plugin",
    };
    if (payload) headers["Content-Type"] = "application/json";
    const res = await this.fetcher(url, {
      method, headers, body: payload ? JSON.stringify(payload) : undefined,
      redirect: "manual", signal: AbortSignal.timeout(60000),
    });
    const body = await readLimited(res.body, raw ? MAX_FILE : 90 * 1024 * 1024);
    if (res.status >= 300 && res.status < 400) {
      throw new BridgeError("GitHub redirected the request. Check the current repository name.");
    }
    if (raw && res.ok) return { status: res.status, body, headers: res.headers };
    let data;
    try {
      data = JSON.parse(body.toString("utf8"));
    } catch {
      throw new BridgeError("GitHub returned an unreadable response.");
    }
    return { status: res.status, data, headers: res.headers };
  }

  fail(res) {
    const message = String(res.data?.message ?? "request failed");
    if (res.status === 429 || res.status === 503 ||
        (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")))) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const delay = res.headers.get("retry-after") ||
        (reset ? String(Math.max(1, Math.ceil(reset - Date.now() / 1000))) : "60");
      throw new BridgeError("GitHub rate limited sync; try again later.", 429, { "Retry-After": delay });
    }
    throw new BridgeError(`GitHub HTTP ${res.status}: ${message}`);
  }

  async prepare() {
    const repo = await this.request("GET");
    if (repo.status !== 200) this.fail(repo);
    this.branch = this.config.branch || repo.data.default_branch;
    if (!this.branch) throw new BridgeError("Repository has no default branch.");
    const ref = await this.request("GET", `git/ref/heads/${this.branch}`);
    if (ref.status === 409 && ref.data.message === "Git Repository is empty.") {
      if (this.branch !== repo.data.default_branch) {
        throw new BridgeError("Empty repository: leave Branch empty or select its default branch.");
      }
      this.empty = true;
    } else if (ref.status !== 200) this.fail(ref);
    else this.empty = false;
  }

  at(name) {
    return [this.config.folder, name].filter(Boolean).join("/");
  }

  async content(name) {
    if (this.empty) return null;
    const res = await this.request("GET", `contents/${this.at(name)}`, undefined, true, false, true);
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res);
    const c = res.data;
    if (c.type !== "file" || !/^[a-f0-9]{40,64}$/i.test(c.sha ?? "") ||
        !Number.isSafeInteger(c.size) || c.size < 0 || c.size > MAX_FILE) {
      throw new BridgeError("GitHub sync requires a regular file no larger than 64 MiB.");
    }
    return c;
  }

  async bytes(c) {
    let data;
    if (c.encoding === "base64") {
      const encoded = String(c.content ?? "").replace(/\n/g, "");
      data = Buffer.from(encoded, "base64");
      if (data.toString("base64") !== encoded) {
        throw new BridgeError("GitHub returned invalid base64.");
      }
    } else if (c.encoding === "none") {
      const res = await this.request("GET", `git/blobs/${c.sha}`, undefined, false, true);
      if (res.status !== 200) this.fail(res);
      data = res.body;
    } else throw new BridgeError("GitHub returned an unsupported file encoding.");
    if (data.length !== c.size) throw new BridgeError("GitHub returned an incomplete file.");
    return data;
  }

  async commit(name, bytes, sha, remove = false) {
    if (bytes && bytes.length > MAX_FILE) throw new BridgeError("Sync file exceeds 64 MiB.", 413);
    const payload = { message: `magpie: ${remove ? "remove" : "sync"} ${name}` };
    if (!this.empty) payload.branch = this.branch;
    if (sha) payload.sha = sha;
    if (!remove) payload.content = bytes.toString("base64");
    const res = await this.request(remove ? "DELETE" : "PUT", `contents/${this.at(name)}`, payload);
    if (res.status === 409 || (res.status === 422 && /"sha" wasn't supplied/.test(res.data?.message ?? ""))) {
      throw new BridgeError("Backup changed on another computer; sync again.", 412);
    }
    if (res.status !== 200 && res.status !== 201) this.fail(res);
    if (remove) return "";
    const next = res.data.content?.sha;
    if (!/^[a-f0-9]{40,64}$/i.test(next ?? "")) throw new BridgeError("GitHub returned no committed file version.");
    this.empty = false;
    return next;
  }

  async blob(bytes) {
    if (bytes.length > MAX_FILE) throw new BridgeError("Sync file exceeds 64 MiB.", 413);
    const res = await this.request("POST", "git/blobs", { encoding: "base64", content: bytes.toString("base64") });
    if (res.status !== 201) this.fail(res);
    if (res.data.sha !== blobSHA(bytes)) throw new BridgeError("GitHub returned an invalid uploaded blob version.");
    return res.data.sha;
  }

  // Publish uploaded usage blobs together, preserving the latest tree and history.
  async commitUsage(entries) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await this.request("GET", `git/ref/heads/${this.branch}`);
      if (ref.status !== 200) this.fail(ref);
      const head = ref.data.object?.sha;
      if (!validSHA(head)) throw new BridgeError("GitHub returned an invalid branch version.");
      const parent = await this.request("GET", `git/commits/${head}`);
      if (parent.status !== 200) this.fail(parent);
      const base = parent.data.tree?.sha;
      if (!validSHA(base)) throw new BridgeError("GitHub returned an invalid commit tree.");
      const current = new Map((await this.list("magpie/usage", head)).map((e) => ["magpie/usage/" + e.name, e.sha]));
      const changes = [];
      for (const [name, e] of entries) {
        const have = current.get(name) ?? null;
        if (have === e.sha) continue; // A previous update may have landed before its response was lost.
        if (have !== e.before) throw new BridgeError("Usage changed on another computer; pending uploads were kept.", 412);
        changes.push({ path: this.at(name), mode: "100644", type: "blob", sha: e.sha });
      }
      if (!changes.length) return;
      const tree = await this.request("POST", "git/trees", { base_tree: base, tree: changes });
      if (tree.status !== 201) this.fail(tree);
      if (!validSHA(tree.data.sha)) throw new BridgeError("GitHub returned an invalid new tree.");
      const commit = await this.request("POST", "git/commits", {
        message: `magpie: sync usage (${changes.length} files)`, tree: tree.data.sha, parents: [head],
      });
      if (commit.status !== 201) this.fail(commit);
      if (!validSHA(commit.data.sha)) throw new BridgeError("GitHub returned an invalid new commit.");
      const update = await this.request("PATCH", `git/refs/heads/${this.branch}`, { sha: commit.data.sha, force: false });
      if (update.status === 200) {
        if (update.data.object?.sha !== commit.data.sha) throw new BridgeError("GitHub did not confirm the new branch version.");
        return;
      }
      if (update.status === 409 || update.status === 422) {
        const latest = await this.request("GET", `git/ref/heads/${this.branch}`);
        if (latest.status !== 200) this.fail(latest);
        if (latest.data.object?.sha !== head) continue;
      }
      this.fail(update);
    }
    throw new BridgeError("GitHub branch kept changing; pending usage uploads were kept.", 412);
  }

  async list(name, ref = true) {
    if (this.empty) return [];
    const res = await this.request("GET", `contents/${this.at(name)}`, undefined, ref);
    if (res.status === 404) return [];
    if (res.status !== 200) this.fail(res);
    if (!Array.isArray(res.data) || res.data.length >= 1000) {
      throw new BridgeError("Usage listing is invalid or reached GitHub's 1,000-entry limit.");
    }
    return res.data.filter((e) => e.type === "file" && /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(magpie-usage|magpie-quotas)$/.test(e.name))
      .map((e) => {
        if (!/^[a-f0-9]{40,64}$/i.test(e.sha ?? "") || !Number.isSafeInteger(e.size) || e.size < 0 || e.size > MAX_FILE) {
          throw new BridgeError("GitHub returned invalid usage metadata.");
        }
        return e;
      });
  }
}
