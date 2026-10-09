import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError, GitHub, MAX_FILE, normalizeConfig, readLimited } from "../lib/github.mjs";
import { dataEnvelope, envelope, fakeGitHub } from "./fixture.mjs";

const config = () => normalizeConfig({ repository: "owner/repo", folder: "sync", token: "fixture-token" });

test("normalize repository URLs and keep a token only for the same repository", () => {
  const before = config();
  assert.equal(normalizeConfig({ repository: "https://github.com/owner/repo.git", branch: "sync/settings" }, before).token, before.token);
  assert.throws(() => normalizeConfig({ repository: "other/repo" }, before), /token/);
  for (const repository of ["../repo", "owner/..", "owner/repo/else", "owner@evil/repo"]) {
    assert.throws(() => normalizeConfig({ repository, token: "secret" }));
  }
  for (const folder of ["../else", "one//two", "one\\two", "one/./two"]) {
    assert.throws(() => normalizeConfig({ repository: "owner/repo", token: "secret", folder }));
  }
  for (const branch of ["bad..branch", "@", ".hidden", "nested/.hidden", "nested.lock/child"]) {
    assert.throws(() => normalizeConfig({ ...before, branch }));
  }
  assert.throws(() => normalizeConfig({ ...before, token: "bad token" }));
});

test("empty repository initializes only its default branch", async () => {
  const f = fakeGitHub();
  f.empty = true;
  const gh = new GitHub(config(), f.fetch);
  await gh.prepare();
  f.readStatus = 409;
  assert.equal(await gh.content("magpie/magpie.magpie-backup"), null);
  assert.deepEqual(await gh.list("magpie/usage"), []);
  f.readStatus = 0;
  const sha = await gh.commit("magpie/magpie.magpie-backup", envelope);
  assert.ok(sha);
  const request = f.requests.find((r) => r.method === "PUT");
  assert.equal("branch" in JSON.parse(request.body), false);
  await gh.prepare();
  assert.equal(gh.empty, false);
  assert.deepEqual(await gh.bytes(await gh.content("magpie/magpie.magpie-backup")), envelope);
});

test("missing branch and unrelated 409 are failures, never an empty repository", async () => {
  const f = fakeGitHub();
  await assert.rejects(new GitHub({ ...config(), branch: "other" }, f.fetch).prepare(), /404/);
  f.refStatus = 409;
  f.refMessage = "a different conflict";
  await assert.rejects(new GitHub(config(), f.fetch).prepare(), /409/);
  f.empty = true;
  f.refStatus = 0;
  await assert.rejects(new GitHub({ ...config(), branch: "other" }, f.fetch).prepare(), /Empty repository/);
});

test("metadata is read at the selected ref and large files use the pinned blob SHA", async () => {
  const f = fakeGitHub();
  f.branch = "sync/settings";
  f.encoding = "none";
  const c = f.put("sync/magpie/magpie.magpie-backup", envelope);
  const gh = new GitHub({ ...config(), branch: f.branch }, f.fetch);
  await gh.prepare();
  const metadata = await gh.content("magpie/magpie.magpie-backup");
  f.put("sync/magpie/magpie.magpie-backup", Buffer.from("newer bytes"));
  assert.deepEqual(await gh.bytes(metadata), envelope);
  assert.equal(f.requests.at(-1).url.pathname, `/repos/owner/repo/git/blobs/${c.sha}`);
  assert.equal(f.requests.find((r) => r.url.pathname.includes("/contents/")).url.searchParams.get("ref"), f.branch);
  assert.equal(f.requests[0].headers.Authorization, "Bearer fixture-token");
});

test("folder characters are encoded as paths, not query strings or fragments", async () => {
  const f = fakeGitHub();
  const gh = new GitHub({ ...config(), folder: "folder #?%/child" }, f.fetch);
  await gh.prepare();
  await gh.content("magpie/magpie.magpie-backup");
  const url = f.requests.at(-1).url;
  assert.equal(url.hash, "");
  assert.equal(url.searchParams.size, 1);
  assert.ok(url.pathname.includes("folder%20%23%3F%25/child"));
});

test("authentication, rate limiting and redirects are not missing files", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const f = fakeGitHub();
    f.status = status;
    await assert.rejects(new GitHub(config(), f.fetch).prepare(), (error) => {
      assert.equal(error.status, [403, 429, 503].includes(status) ? 429 : 502);
      return true;
    });
  }
  let calls = 0;
  await assert.rejects(new GitHub(config(), async () => {
    calls++;
    return new Response("", { status: 302, headers: { Location: "https://evil.example/" } });
  }).prepare(), /redirected/);
  assert.equal(calls, 1);
});

test("stale writes and racing creates become precondition failures", async () => {
  const f = fakeGitHub();
  f.put("sync/magpie/magpie.magpie-backup", envelope);
  const gh = new GitHub(config(), f.fetch);
  await gh.prepare();
  await assert.rejects(gh.commit("magpie/magpie.magpie-backup", envelope, "0".repeat(40)),
    (error) => error instanceof BridgeError && error.status === 412);
  f.failPut = { status: 422, message: '"sha" wasn\'t supplied.' };
  await assert.rejects(gh.commit("magpie/magpie.magpie-backup", envelope), (e) => e.status === 412);
  f.failPut.message = "branch protection prevents this operation";
  await assert.rejects(gh.commit("magpie/magpie.magpie-backup", envelope), (e) => e.status === 502);
});

test("malformed metadata, base64, sizes and failed body reads fail closed", async () => {
  const f = fakeGitHub();
  const c = f.put("sync/magpie/magpie.magpie-backup", envelope);
  const gh = new GitHub(config(), f.fetch);
  await gh.prepare();
  c.sha = "";
  await assert.rejects(gh.content("magpie/magpie.magpie-backup"), /regular file/);
  await assert.rejects(gh.bytes({ encoding: "base64", content: "bad!!!", size: 1 }), /base64/);
  await assert.rejects(gh.bytes({ encoding: "base64", content: "YQ==", size: 2 }), /incomplete/);
  await assert.rejects(gh.bytes({ encoding: "unknown", size: 1 }), /unsupported/);
  c.sha = "a".repeat(40);
  c.size = MAX_FILE + 1;
  await assert.rejects(gh.content("magpie/magpie.magpie-backup"), /regular file/);
  await assert.rejects(readLimited(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2)); },
  }), 1), /oversized/);
  await assert.rejects(readLimited(new ReadableStream({
    start(controller) { controller.error(new Error("broken read")); },
  }), 10), /broken read/);
});

test("usage listing never silently truncates or accepts malformed versions", async () => {
  const f = fakeGitHub();
  f.put("sync/magpie/usage/computer-2026-10-09.magpie-usage", dataEnvelope);
  const gh = new GitHub(config(), f.fetch);
  await gh.prepare();
  assert.equal((await gh.list("magpie/usage")).length, 1);
  f.entries = Array(1000).fill({});
  await assert.rejects(gh.list("magpie/usage"), /1,000/);
  f.entries = [{ type: "file", name: "computer.magpie-quotas", sha: "", size: 1 }];
  await assert.rejects(gh.list("magpie/usage"), /invalid usage/);
});

test("batch commits keep unrelated concurrent edits and publish only one usage commit", async () => {
  const f = fakeGitHub();
  f.branch = "sync/settings";
  f.put("unrelated.txt", Buffer.from("keep me"));
  const gh = new GitHub({ ...config(), branch: f.branch }, f.fetch);
  await gh.prepare();
  const sha = await gh.blob(dataEnvelope);
  const count = f.published.length;
  f.beforeRefUpdate = () => {
    f.beforeRefUpdate = null;
    f.put("sync/magpie/usage/another.magpie-usage", dataEnvelope);
  };
  await gh.commitUsage(new Map([
    ["magpie/usage/computer-1.magpie-usage", { sha, before: null }],
    ["magpie/usage/computer-2.magpie-usage", { sha, before: null }],
  ]));
  assert.equal(f.published.length, count + 2); // The concurrent edit plus one published batch.
  assert.equal(f.published.filter((c) => c.message.startsWith("magpie: sync usage")).length, 1);
  assert.equal(f.files.get("unrelated.txt").bytes.toString(), "keep me");
  assert.ok(f.files.has("sync/magpie/usage/another.magpie-usage"));
  assert.ok(f.files.has("sync/magpie/usage/computer-1.magpie-usage"));
  assert.ok(f.files.has("sync/magpie/usage/computer-2.magpie-usage"));
});

test("a concurrent edit to the same usage file is not overwritten", async () => {
  const f = fakeGitHub();
  const name = "magpie/usage/computer.magpie-usage";
  const before = f.put("sync/" + name, Buffer.from("old encrypted version")).sha;
  const gh = new GitHub(config(), f.fetch);
  await gh.prepare();
  const sha = await gh.blob(dataEnvelope);
  f.beforeRefUpdate = () => {
    f.beforeRefUpdate = null;
    f.put("sync/" + name, Buffer.from("another encrypted version"));
  };
  await assert.rejects(gh.commitUsage(new Map([[name, { sha, before }]])), (err) => err.status === 412);
  assert.equal(f.files.get("sync/" + name).bytes.toString(), "another encrypted version");
});
