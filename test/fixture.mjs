import { createHash } from "node:crypto";
import { blobSHA } from "../lib/github.mjs";

export const envelope = Buffer.from(JSON.stringify({
  format: "magpie-backup", version: 1, kdf: "pbkdf2-sha256", iterations: 600000,
  salt: "AQEBAQEBAQEBAQEBAQEBAQ==", nonce: "AQEBAQEBAQEBAQEB",
  data: Buffer.from("fixture ciphertext plus authentication tag").toString("base64"),
}));

// Usage days and quota history use backup.SealData, not backup.Seal.
export const dataEnvelope = Buffer.from(JSON.stringify({
  ...JSON.parse(envelope), format: "magpie-data",
}));

export function fakeGitHub() {
  const f = {
    files: new Map(), blobs: new Map(), requests: [], empty: false,
    branch: "main", status: 0, refStatus: 0, refMessage: "", failPut: null,
    encoding: "base64", readStatus: 0, entries: null,
    trees: new Map(), commits: new Map(), published: [], beforeRefUpdate: null, afterRefUpdate: null, refUpdateError: null,
    rejectedTokens: new Set(), treeTruncated: false, treeEntries: null,
  };
  const hash = (text) => createHash("sha1").update(text).digest("hex");
  const treeOf = (files) => {
    const sha = hash(JSON.stringify([...files].map(([name, file]) => [name, file.sha]).sort()));
    f.trees.set(sha, new Map(files));
    return sha;
  };
  const snapshot = (message) => {
    const tree = treeOf(f.files);
    const parents = f.empty || !f.head ? [] : [f.head];
    f.head = hash(JSON.stringify({ tree, parents, message, n: f.published.length }));
    f.commits.set(f.head, { tree, parents, files: new Map(f.files) });
    if (message !== "initial") f.published.push({ sha: f.head, message });
    f.empty = false;
  };
  const metadata = (name, bytes) => {
    const sha = blobSHA(bytes);
    const file = { type: "file", name: name.split("/").at(-1), sha, size: bytes.length,
      encoding: f.encoding, content: bytes.toString("base64"), bytes };
    f.blobs.set(sha, bytes);
    return file;
  };
  const put = (name, bytes, message = "fixture seed") => {
    const file = metadata(name, bytes);
    f.files.set(name, file);
    snapshot(message);
    return file;
  };
  snapshot("initial");
  f.put = put;
  f.fetch = async (url, options) => {
    url = new URL(url);
    if (url.origin !== "https://api.github.com") throw new Error("Token escaped GitHub");
    if (options.redirect !== "manual") throw new Error("Unsafe redirect policy");
    f.requests.push({ url, ...options });
    const reply = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers });
    if (f.rejectedTokens.has(options.headers.Authorization)) return reply(401, { message: "Bad credentials" });
    if (f.status) return reply(f.status, { message: "repository access refused" },
      f.status === 403 ? { "X-RateLimit-Remaining": "0", "Retry-After": "120" } : {});
    const suffix = decodeURIComponent(url.pathname).replace(/^\/repos\/owner\/repo\/?/, "");
    if (!suffix) return reply(200, { default_branch: f.branch });
    if (suffix.startsWith("git/ref/heads/")) {
      if (f.refStatus) return reply(f.refStatus, { message: f.refMessage });
      if (f.empty) return reply(409, { message: "Git Repository is empty." });
      return suffix.slice("git/ref/heads/".length) === f.branch
        ? reply(200, { ref: "refs/heads/" + f.branch, object: { sha: f.head } }) : reply(404, { message: "branch missing" });
    }
    if (suffix === "git/blobs" && options.method === "POST") {
      const body = JSON.parse(options.body);
      const bytes = Buffer.from(body.content, body.encoding);
      const sha = blobSHA(bytes);
      f.blobs.set(sha, bytes);
      return reply(201, { sha });
    }
    if (suffix.startsWith("git/blobs/")) {
      const bytes = f.blobs.get(suffix.slice("git/blobs/".length));
      return bytes ? new Response(bytes) : reply(404, { message: "blob missing" });
    }
    if (suffix.startsWith("git/commits/") && options.method === "GET") {
      const c = f.commits.get(suffix.slice("git/commits/".length));
      return c ? reply(200, { tree: { sha: c.tree } }) : reply(404, { message: "commit missing" });
    }
    if (suffix.startsWith("git/trees/") && options.method === "GET") {
      const files = f.trees.get(suffix.slice("git/trees/".length));
      if (!files) return reply(404, { message: "tree missing" });
      const directories = new Map();
      const entries = [];
      for (const [name, file] of files) {
        const slash = name.indexOf("/");
        if (slash < 0) entries.push({ path: name, mode: "100644", type: "blob", sha: file.sha, size: file.size });
        else {
          const directory = name.slice(0, slash);
          if (!directories.has(directory)) directories.set(directory, new Map());
          directories.get(directory).set(name.slice(slash + 1), file);
        }
      }
      for (const [name, children] of directories) entries.push({ path: name, mode: "040000", type: "tree", sha: treeOf(children) });
      return reply(200, { truncated: f.treeTruncated, tree: f.treeEntries || entries });
    }
    if (suffix === "git/trees" && options.method === "POST") {
      const body = JSON.parse(options.body);
      const files = new Map(f.trees.get(body.base_tree));
      for (const e of body.tree) {
        if (e.sha === null) files.delete(e.path);
        else {
          const bytes = f.blobs.get(e.sha);
          if (!bytes) return reply(422, { message: "blob missing" });
          files.set(e.path, metadata(e.path, bytes));
        }
      }
      return reply(201, { sha: treeOf(files) });
    }
    if (suffix === "git/commits" && options.method === "POST") {
      const body = JSON.parse(options.body);
      const sha = hash(JSON.stringify(body));
      f.commits.set(sha, { ...body, files: new Map(f.trees.get(body.tree)) });
      return reply(201, { sha });
    }
    if (suffix.startsWith("git/refs/heads/") && options.method === "PATCH") {
      const body = JSON.parse(options.body);
      if (body.force !== false) throw new Error("Unsafe history rewrite");
      await f.beforeRefUpdate?.(body);
      if (f.refUpdateError) return reply(f.refUpdateError.status, { message: f.refUpdateError.message });
      const commit = f.commits.get(body.sha);
      if (commit?.parents[0] !== f.head) return reply(422, { message: "Update is not a fast forward" });
      f.head = body.sha;
      f.files.clear();
      for (const [name, file] of commit.files) f.files.set(name, file);
      f.published.push({ sha: f.head, message: commit.message });
      await f.afterRefUpdate?.();
      return reply(200, { object: { sha: f.head } });
    }
    if (!suffix.startsWith("contents/")) return reply(404, { message: "endpoint missing" });
    const name = suffix.slice("contents/".length);
    const c = f.files.get(name);
    if (options.method === "GET") {
      if (f.readStatus) return reply(f.readStatus, { message: "read failed" });
      if (f.entries) return reply(200, f.entries);
      const ref = url.searchParams.get("ref");
      const files = ref && ref !== f.branch ? f.commits.get(ref)?.files : f.files;
      if (!files) return reply(404, { message: "ref missing" });
      if (name.endsWith("/usage")) {
        const entries = [...files].filter(([n]) => n.startsWith(name + "/")).map(([, e]) => {
          const { bytes, ...metadata } = e;
          return metadata;
        });
        return entries.length ? reply(200, entries.slice(0, 1000)) : reply(404, { message: "directory missing" });
      }
      const file = files.get(name);
      if (!file) return reply(404, { message: "file missing" });
      const { bytes, ...metadata } = file;
      return reply(200, metadata);
    }
    const body = JSON.parse(options.body);
    if (f.failPut) return reply(f.failPut.status, { message: f.failPut.message });
    if (f.empty && "branch" in body) return reply(404, { message: "branch not initialized" });
    if (c && c.sha !== body.sha) return reply(409, { message: "stale SHA" });
    if (!c && body.sha) return reply(409, { message: "file was deleted" });
    if (options.method === "DELETE") {
      f.files.delete(name);
      snapshot(body.message);
      return reply(200, { content: null });
    }
    const next = put(name, Buffer.from(body.content, "base64"), body.message);
    return reply(c ? 200 : 201, { content: { sha: next.sha } });
  };
  return f;
}
