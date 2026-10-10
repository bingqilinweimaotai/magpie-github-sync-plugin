import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startBridge } from "../lib/server.mjs";
import { readState, remoteID } from "../lib/state.mjs";
import { dataEnvelope, envelope, fakeGitHub } from "./fixture.mjs";

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-github-plugin-test-"));
  const github = fakeGitHub();
  const server = await startBridge({ directory, port: 0, fetcher: github.fetch, ...options });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(origin)).text();
  const csrf = /name="csrf" content="([^"]+)"/.exec(page)[1];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const api = (name, body) => fetch(origin + "/api/" + name, {
    headers: { "X-CSRF-Token": csrf, ...(body ? { "Content-Type": "application/json" } : {}) },
    method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const bind = async (config = {}) => {
    const res = await api("config", { repository: "owner/repo", folder: "sync", token: "fixture-token", ...config });
    assert.equal(res.status, 200, await res.text());
    return (await api("status")).json();
  };
  const dav = (status, name, method = "GET", headers = {}, body) => fetch(
    status.url + "/" + name, { method,
      headers: { Authorization: "Basic " + Buffer.from(status.user + ":" + status.password).toString("base64"), ...headers },
      ...(body ? { body } : {}),
    });
  return { directory, github, server, origin, api, bind, dav };
}

test("setup uses CSRF and loopback Host/Origin checks; secrets are not returned", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + "/api/status")).status, 403);
  assert.equal((await fetch(f.origin + "/api/status", { headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await fetch(f.origin, { headers: { Origin: "https://evil.example" } })).status, 403);
  const status = await f.bind();
  assert.equal(status.tokenSet, true);
  assert.equal("token" in status, false);
  assert.notEqual(status.password, "fixture-token");
  assert.equal((await fetch(status.url + "/magpie/magpie.magpie-backup")).status, 401);
  assert.equal(f.github.requests.filter((r) => r.method === "PUT").length, 0);
});

test("encrypted backup read, conditional read, HEAD, update and conflict", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  const name = "magpie/magpie.magpie-backup";
  assert.equal((await f.dav(s, name)).status, 404);
  const first = await f.dav(s, name, "PUT", {}, envelope);
  assert.equal(first.status, 201, await first.text());
  const etag = first.headers.get("etag");
  const read = await f.dav(s, name);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), envelope);
  assert.equal(read.headers.get("etag"), etag);
  assert.equal((await f.dav(s, name, "GET", { "If-None-Match": etag })).status, 304);
  const head = await f.dav(s, name, "HEAD");
  assert.equal(head.headers.get("content-length"), String(envelope.length));
  assert.equal((await f.dav(s, name, "PUT", { "If-Match": '"stale"' }, envelope)).status, 412);
  assert.equal((await f.dav(s, name, "PUT", {}, envelope)).status, 412);
  assert.equal((await f.dav(s, name, "PUT", { "If-Match": etag }, envelope)).status, 200);
  assert.equal((await f.dav(s, name, "DELETE")).status, 405);
});

test("empty repository supports MKCOL then backup creation", async (t) => {
  const f = await fixture(t);
  f.github.empty = true;
  const s = await f.bind();
  assert.equal((await f.dav(s, "magpie/", "MKCOL")).status, 201);
  assert.equal((await f.dav(s, "magpie/magpie.magpie-backup", "PUT", {}, envelope)).status, 201);
  assert.equal("branch" in JSON.parse(f.github.requests.find((r) => r.method === "PUT").body), false);
});

test("usage and quota files support overwrite, DAV listing, read and removal", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  const name = "magpie/usage/computer-2026-10-09.magpie-usage";
  const quota = "magpie/usage/computer.magpie-quotas";
  assert.equal((await f.dav(s, name, "PUT", {}, dataEnvelope)).status, 201);
  assert.equal((await f.dav(s, name, "PUT", {}, dataEnvelope)).status, 200);
  assert.equal((await f.dav(s, quota, "PUT", {}, dataEnvelope)).status, 201);
  const listing = await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" });
  assert.equal(listing.status, 207);
  const text = await listing.text();
  assert.ok(text.includes("<D:collection/>"));
  assert.ok(text.includes("computer-2026-10-09.magpie-usage"));
  assert.ok(text.includes("computer.magpie-quotas"));
  assert.deepEqual(Buffer.from(await (await f.dav(s, name)).arrayBuffer()), dataEnvelope);
  assert.equal((await f.dav(s, name, "DELETE")).status, 204);
  assert.equal((await f.dav(s, name)).status, 404);
});

test("sealed formats must match backup, usage and quota paths", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  const backup = "magpie/magpie.magpie-backup";
  const usage = "magpie/usage/computer-2026-10-09.magpie-usage";
  const quota = "magpie/usage/computer.magpie-quotas";
  const newer = Buffer.from(JSON.stringify({ ...JSON.parse(dataEnvelope), version: 2 }));
  for (const [name, body] of [[backup, dataEnvelope], [usage, envelope], [quota, envelope],
    [usage, Buffer.from("{}")], [quota, Buffer.from("{}")], [usage, newer]]) {
    assert.equal((await f.dav(s, name, "PUT", {}, body)).status, 400);
  }
  assert.equal(f.github.requests.filter((r) => r.method === "PUT").length, 0);
});

test("wrong token, missing branch and failed reads never look like a missing backup", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  f.github.status = 401;
  assert.equal((await f.dav(s, "magpie/magpie.magpie-backup")).status, 502);
  f.github.status = 404;
  assert.equal((await f.dav(s, "magpie/magpie.magpie-backup")).status, 502);
  f.github.status = 403;
  const limited = await f.dav(s, "magpie/magpie.magpie-backup");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "120");
  const status = await (await f.api("status")).json();
  assert.match(status.lastError, /rate limited/);
});

test("saving config and retrying pending uploads respect the rate-limit cooldown", async (t) => {
  const f = await fixture(t, { batchIdleMs: 60000 });
  const s = await f.bind();
  const name = "magpie/usage/computer-2026-10-09.magpie-usage";
  assert.equal((await f.dav(s, name, "PUT", {}, dataEnvelope)).status, 201);
  f.github.status = 403;
  const limited = await f.api("usage/retry", {});
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "120");
  const requests = f.github.requests.length;
  f.github.status = 0;
  const config = { repository: "owner/repo", folder: "sync", token: "" };
  for (const token of ["", "fixture-token", "replacement-token"]) {
    const save = await f.api("config", { ...config, token });
    assert.equal(save.status, 429);
    assert.ok(Number(save.headers.get("retry-after")) > 0);
  }
  assert.equal((await f.api("usage/retry", {})).status, 429);
  assert.equal(f.github.requests.length, requests);
  assert.equal(readState(f.directory).config.token, "fixture-token");
  assert.equal((await (await f.api("status")).json()).pending.count, 1);
  const afterCooldown = Date.now() + 121000;
  t.mock.method(Date, "now", () => afterCooldown);
  assert.equal((await f.api("config", config)).status, 200);
  assert.equal((await f.api("usage/retry", {})).status, 200);
  assert.deepEqual(f.github.files.get("sync/" + name).bytes, dataEnvelope);
});

test("a pending upload does not block replacing an expired token", async (t) => {
  const f = await fixture(t, { batchIdleMs: 60000 });
  const old = await f.bind({ token: "old-fixture" });
  const name = "magpie/usage/computer-2026-10-09.magpie-usage";
  assert.equal((await f.dav(old, name, "PUT", {}, dataEnvelope)).status, 201);
  f.github.rejectedTokens.add("Bearer old-fixture");
  assert.equal((await f.api("usage/retry", {})).status, 502);
  const replacement = await f.api("config", { repository: "owner/repo", folder: "sync", token: "new-fixture" });
  assert.equal(replacement.status, 200, await replacement.text());
  assert.equal(readState(f.directory).config.token, "new-fixture");
  assert.equal((await f.dav(old, "magpie/usage/", "PROPFIND", { Depth: "1" })).status, 207);
  assert.equal(f.github.published.length, 1);
});

test("usage conflicts are visible, readable from remote, and can be resolved", async (t) => {
  const f = await fixture(t, { batchIdleMs: 60000 });
  const s = await f.bind();
  const name = "magpie/usage/computer-2026-10-09.magpie-usage";
  const remote = Buffer.from(JSON.stringify({ ...JSON.parse(dataEnvelope), data: Buffer.from("remote").toString("base64") }));
  f.github.put("sync/" + name, remote);
  assert.equal((await f.dav(s, name, "PUT", {}, dataEnvelope)).status, 200);
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(dataEnvelope), data: Buffer.from("other").toString("base64") }));
  f.github.put("sync/" + name, changed);
  assert.equal((await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" })).status, 412);
  let status = await (await f.api("status")).json();
  assert.equal(status.lastErrorCode, "conflict");
  assert.equal(status.pending.files[0].conflict, true);
  const pending = status.pending.files[0];
  const journal = path.join(f.directory, "github-sync-plugin", "usage-pending.json");
  const saved = await fs.readFile(journal, "utf8");
  const read = await f.dav(s, name);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), changed);
  const blobs = f.github.requests.filter((r) => r.method === "POST" && r.url.pathname.endsWith("/git/blobs")).length;
  for (const bytes of [dataEnvelope, remote, changed]) {
    assert.equal((await f.dav(s, name, "PUT", {}, bytes)).status, 412);
  }
  assert.deepEqual((await (await f.api("status")).json()).pending.files[0], pending);
  assert.equal(await fs.readFile(journal, "utf8"), saved);
  assert.equal(f.github.requests.filter((r) => r.method === "POST" && r.url.pathname.endsWith("/git/blobs")).length, blobs);
  assert.deepEqual(f.github.files.get("sync/" + name).bytes, changed);
  const exported = await f.api("usage/export/" + pending.sha);
  assert.equal(exported.status, 200);
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()), dataEnvelope);
  const resolve = await f.api("usage/resolve", { name, sha: pending.sha });
  assert.equal(resolve.status, 200, await resolve.text());
  status = await (await f.api("status")).json();
  assert.equal(status.pending.count, 0);
  assert.equal(status.pending.archives.length, 1);
  assert.equal(status.lastError, "");
  assert.equal(status.diagnostics.write, "unverified");
  assert.equal(status.diagnostics.writeError, "");
  assert.equal((await f.dav(s, name)).status, 200);
  assert.equal((await f.dav(s, name, "PUT", {}, dataEnvelope)).status, 200);
  assert.equal((await f.api("usage/retry", {})).status, 200);
  assert.deepEqual(f.github.files.get("sync/" + name).bytes, dataEnvelope);
  assert.deepEqual(Buffer.from(await (await f.api("usage/export/" + pending.sha)).arrayBuffer()), dataEnvelope);
});

for (const operation of ["read", "publish"]) {
  test(`resolving a conflict preserves a later ${operation} authentication failure`, async (t) => {
    const f = await fixture(t, { batchIdleMs: 60000 });
    const s = await f.bind();
    const name = "magpie/usage/computer-2026-10-09.magpie-usage";
    assert.equal((await f.dav(s, name, "PUT", {}, dataEnvelope)).status, 201);
    f.github.put("sync/" + name, Buffer.from(JSON.stringify({ ...JSON.parse(dataEnvelope), data: "b3RoZXI=" })));
    assert.equal((await f.api("usage/retry", {})).status, 412);
    const status = await (await f.api("status")).json();
    f.github.status = 401;
    const failure = operation === "read" ? await f.dav(s, name) : await f.api("usage/retry", {});
    assert.equal(failure.status, 502);
    assert.equal((await f.api("usage/resolve", { name, sha: status.pending.files[0].sha })).status, 200);
    const resolved = await (await f.api("status")).json();
    assert.equal(resolved.pending.count, 0);
    assert.equal(resolved.lastErrorCode, "authentication");
    assert.equal(resolved.diagnostics.write, operation === "read" ? "unverified" : "failed");
    assert.match(resolved.diagnostics.writeError, operation === "read" ? /^$/ : /401/);
  });
}

test("repository identity includes branch and folder; credentials cannot cross repositories", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  assert.equal((await f.api("config", { repository: "other/repo" })).status, 400);
  assert.equal(readState(f.directory).config.repository, "owner/repo");
  const changed = await f.bind({ folder: "other", token: "" });
  assert.notEqual(changed.url, s.url);
  assert.equal(changed.password, s.password);
  assert.equal((await f.dav(s, "magpie/magpie.magpie-backup")).status, 502);
  assert.notEqual(remoteID({ repository: "owner/repo", branch: "", folder: "" }),
    remoteID({ repository: "owner/repo", branch: "main", folder: "" }));
});

test("plaintext and arbitrary files are rejected before any GitHub write", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  assert.equal((await f.dav(s, "magpie/magpie.magpie-backup", "PUT", {}, Buffer.from("{}"))).status, 400);
  assert.equal((await f.dav(s, "magpie/secrets.txt", "PUT", {}, envelope)).status, 400);
  assert.equal((await f.dav(s, "magpie/usage/%2e%2e%2fsecrets.txt")).status, 400);
  assert.equal(f.github.requests.filter((r) => r.method === "PUT").length, 0);
});

test("saved state survives restart without replacing the local password", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  assert.ok(readState(f.directory).config.token);
  const again = readState(f.directory);
  assert.equal(again.secret, s.password);
  const file = path.join(f.directory, "github-sync-plugin", "state.json");
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("90 sequential daily uploads publish as one commit with readable staged files", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  const requestsAfterBind = f.github.requests.length;
  const names = Array.from({ length: 90 }, (_, i) => `magpie/usage/computer-day-${i}.magpie-usage`);
  let etag;
  for (const name of names) {
    const res = await f.dav(s, name, "PUT", {}, dataEnvelope);
    assert.equal(res.status, 201, await res.text());
    etag = res.headers.get("etag");
    const head = await f.dav(s, name, "HEAD");
    assert.equal(head.headers.get("etag"), etag);
    assert.equal(head.headers.get("content-length"), String(dataEnvelope.length));
  }
  assert.equal(f.github.published.length, 0);
  assert.ok(f.github.requests.length - requestsAfterBind < 150, "daily uploads should reuse the remote usage snapshot");
  assert.deepEqual(Buffer.from(await (await f.dav(s, names[0])).arrayBuffer()), dataEnvelope);
  assert.equal((await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" })).status, 207);
  assert.equal(f.github.published.length, 1);
  assert.equal(f.github.files.size, 90);
  assert.match(f.github.published[0].message, /90 files/);
  assert.equal((await f.dav(s, names[0], "HEAD")).headers.get("etag"), etag);
  assert.equal((await f.dav(s, names[0], "PUT", {}, dataEnvelope)).status, 200);
  await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" });
  assert.equal(f.github.published.length, 1);
});

test("daily reads and unchanged uploads reuse a snapshot until listing or expiry", async (t) => {
  const f = await fixture(t, { batchIdleMs: 60000 });
  const s = await f.bind();
  const names = Array.from({ length: 90 }, (_, i) => `magpie/usage/device-${i}.magpie-usage`);
  for (const name of names) f.github.put("sync/" + name, dataEnvelope);
  const published = f.github.published.length;
  const requests = f.github.requests.length;
  for (const name of names) {
    assert.equal((await f.dav(s, name, "HEAD")).status, 200);
    assert.deepEqual(Buffer.from(await (await f.dav(s, name)).arrayBuffer()), dataEnvelope);
    assert.equal((await f.dav(s, name, "PUT", {}, dataEnvelope)).status, 200);
  }
  assert.equal(f.github.requests.length - requests, 93);
  assert.equal(f.github.published.length, published);
  assert.equal((await (await f.api("status")).json()).pending.count, 0);

  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(dataEnvelope), data: "bmV3" }));
  f.github.put("sync/" + names[0], changed);
  const added = "magpie/usage/later.magpie-usage";
  f.github.put("sync/" + added, dataEnvelope);
  assert.equal((await f.dav(s, added, "HEAD")).status, 404);
  assert.equal((await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" })).status, 207);
  assert.equal((await f.dav(s, added, "HEAD")).status, 200);
  assert.deepEqual(Buffer.from(await (await f.dav(s, names[0])).arrayBuffer()), changed);

  f.github.put("sync/" + names[0], dataEnvelope);
  const afterExpiry = Date.now() + 60001;
  t.mock.method(Date, "now", () => afterExpiry);
  assert.deepEqual(Buffer.from(await (await f.dav(s, names[0])).arrayBuffer()), dataEnvelope);
});

test("failed publication keeps a journal, blocks config changes and recovers after restart", async (t) => {
  const f = await fixture(t, { batchIdleMs: 60000 });
  const s = await f.bind();
  const name = "magpie/usage/computer-2026-10-09.magpie-usage";
  assert.equal((await f.dav(s, name, "PUT", {}, dataEnvelope)).status, 201);
  f.github.refUpdateError = { status: 403, message: "branch protection prevents this operation" };
  assert.equal((await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" })).status, 502);
  const journal = path.join(f.directory, "github-sync-plugin", "usage-pending.json");
  const saved = JSON.parse(await fs.readFile(journal, "utf8"));
  assert.equal(saved.entries.length, 1);
  assert.equal("token" in saved, false);
  assert.equal((await f.api("config", { repository: "owner/repo", folder: "other", token: "fixture-token" })).status, 502);
  assert.equal(readState(f.directory).config.folder, "sync");
  await new Promise((resolve) => f.server.close(resolve));
  f.github.blobs.clear(); // Recover even if unreferenced remote blobs were lost.
  f.github.refUpdateError = null;
  const restarted = await startBridge({ directory: f.directory, port: 0, fetcher: f.github.fetch });
  t.after(() => new Promise((resolve) => restarted.close(resolve)));
  const restored = { ...s, url: `http://127.0.0.1:${restarted.address().port}/dav/${remoteID(readState(f.directory).config)}` };
  assert.deepEqual(Buffer.from(await (await f.dav(restored, name)).arrayBuffer()), dataEnvelope);
  assert.equal((await f.dav(restored, "magpie/usage/", "PROPFIND", { Depth: "1" })).status, 207);
  assert.equal(f.github.published.length, 1);
  await assert.rejects(fs.access(journal), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.join(f.directory, "github-sync-plugin", "usage-blobs")), []);
});

test("repeated staged updates to new and existing days retain the original remote base", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  const created = "magpie/usage/computer-new.magpie-usage";
  const existing = "magpie/usage/computer-existing.magpie-usage";
  f.github.put("sync/" + existing, dataEnvelope);
  const count = f.github.published.length;
  const data = (text) => Buffer.from(JSON.stringify({ ...JSON.parse(dataEnvelope), data: Buffer.from(text).toString("base64") }));
  for (const name of [created, existing]) {
    assert.ok((await f.dav(s, name, "PUT", {}, data("first ciphertext plus tag"))).ok);
    assert.equal((await f.dav(s, name, "PUT", {}, data("last ciphertext plus tag"))).status, 200);
  }
  assert.equal((await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" })).status, 207);
  assert.equal(f.github.published.length, count + 1);
  for (const name of [created, existing]) assert.deepEqual(f.github.files.get("sync/" + name).bytes, data("last ciphertext plus tag"));
  assert.deepEqual(await fs.readdir(path.join(f.directory, "github-sync-plugin", "usage-blobs")), []);
});

test("a lost publication response retries without another commit", async (t) => {
  const f = await fixture(t);
  const s = await f.bind();
  await f.dav(s, "magpie/usage/computer-2026-10-09.magpie-usage", "PUT", {}, dataEnvelope);
  f.github.afterRefUpdate = () => {
    f.github.afterRefUpdate = null;
    throw new Error("connection lost after publication");
  };
  assert.equal((await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" })).status, 502);
  assert.equal(f.github.published.length, 1);
  assert.equal((await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" })).status, 207);
  assert.equal(f.github.published.length, 1);
});

test("interrupted uploads flush after idle and graceful close", async (t) => {
  const f = await fixture(t, { batchIdleMs: 40 });
  const s = await f.bind();
  await f.dav(s, "magpie/usage/computer-first.magpie-usage", "PUT", {}, dataEnvelope);
  for (let i = 0; i < 100 && !f.github.published.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.github.published.length, 1);
  await f.dav(s, "magpie/usage/computer-second.magpie-usage", "PUT", {}, dataEnvelope);
  await new Promise((resolve) => f.server.close(resolve));
  assert.equal(f.github.published.length, 2);
});
