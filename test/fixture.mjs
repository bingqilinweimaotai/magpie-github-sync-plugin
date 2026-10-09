import { createHash } from "node:crypto";

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
  };
  const put = (name, bytes) => {
    const sha = createHash("sha1").update(bytes).digest("hex");
    const file = { type: "file", name: name.split("/").at(-1), sha, size: bytes.length,
      encoding: f.encoding, content: bytes.toString("base64"), bytes };
    f.files.set(name, file);
    f.blobs.set(sha, bytes);
    return file;
  };
  f.put = put;
  f.fetch = async (url, options) => {
    url = new URL(url);
    if (url.origin !== "https://api.github.com") throw new Error("Token escaped GitHub");
    if (options.redirect !== "manual") throw new Error("Unsafe redirect policy");
    f.requests.push({ url, ...options });
    const reply = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers });
    if (f.status) return reply(f.status, { message: "repository access refused" },
      f.status === 403 ? { "X-RateLimit-Remaining": "0", "Retry-After": "120" } : {});
    const suffix = decodeURIComponent(url.pathname).replace(/^\/repos\/owner\/repo\/?/, "");
    if (!suffix) return reply(200, { default_branch: f.branch });
    if (suffix.startsWith("git/ref/heads/")) {
      if (f.refStatus) return reply(f.refStatus, { message: f.refMessage });
      if (f.empty) return reply(409, { message: "Git Repository is empty." });
      return suffix.slice("git/ref/heads/".length) === f.branch
        ? reply(200, { ref: "refs/heads/" + f.branch }) : reply(404, { message: "branch missing" });
    }
    if (suffix.startsWith("git/blobs/")) {
      const bytes = f.blobs.get(suffix.slice("git/blobs/".length));
      return bytes ? new Response(bytes) : reply(404, { message: "blob missing" });
    }
    if (!suffix.startsWith("contents/")) return reply(404, { message: "endpoint missing" });
    const name = suffix.slice("contents/".length);
    const c = f.files.get(name);
    if (options.method === "GET") {
      if (f.readStatus) return reply(f.readStatus, { message: "read failed" });
      if (f.entries) return reply(200, f.entries);
      if (name.endsWith("/usage")) {
        const entries = [...f.files].filter(([n]) => n.startsWith(name + "/")).map(([, e]) => {
          const { bytes, ...metadata } = e;
          return metadata;
        });
        return entries.length ? reply(200, entries) : reply(404, { message: "directory missing" });
      }
      if (!c) return reply(404, { message: "file missing" });
      const { bytes, ...metadata } = c;
      return reply(200, metadata);
    }
    const body = JSON.parse(options.body);
    if (f.failPut) return reply(f.failPut.status, { message: f.failPut.message });
    if (f.empty && "branch" in body) return reply(404, { message: "branch not initialized" });
    if (c && c.sha !== body.sha) return reply(409, { message: "stale SHA" });
    if (!c && body.sha) return reply(409, { message: "file was deleted" });
    if (options.method === "DELETE") {
      f.files.delete(name);
      return reply(200, { content: null });
    }
    const next = put(name, Buffer.from(body.content, "base64"));
    f.empty = false;
    return reply(c ? 200 : 201, { content: { sha: next.sha } });
  };
  return f;
}
