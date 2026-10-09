import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startBridge } from "../lib/server.mjs";
import { readState, remoteID } from "../lib/state.mjs";
import { envelope, fakeGitHub } from "./fixture.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-github-plugin-test-"));
  const github = fakeGitHub();
  const server = await startBridge({ directory, port: 0, fetcher: github.fetch });
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
  assert.equal((await f.dav(s, name, "PUT", {}, envelope)).status, 201);
  assert.equal((await f.dav(s, name, "PUT", {}, envelope)).status, 200);
  assert.equal((await f.dav(s, quota, "PUT", {}, envelope)).status, 201);
  const listing = await f.dav(s, "magpie/usage/", "PROPFIND", { Depth: "1" });
  assert.equal(listing.status, 207);
  const text = await listing.text();
  assert.ok(text.includes("<D:collection/>"));
  assert.ok(text.includes("computer-2026-10-09.magpie-usage"));
  assert.ok(text.includes("computer.magpie-quotas"));
  assert.deepEqual(Buffer.from(await (await f.dav(s, name)).arrayBuffer()), envelope);
  assert.equal((await f.dav(s, name, "DELETE")).status, 204);
  assert.equal((await f.dav(s, name)).status, 404);
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
