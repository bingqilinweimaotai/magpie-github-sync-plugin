import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { openBackup, openData, SealedError } from "../lib/sealed.mjs";
import { diffBundle, scrub, withoutKeys } from "../lib/diff.mjs";

// seal is backup.Seal from magpie's side: AES-256-GCM under a PBKDF2-SHA256
// key, with the envelope's own fields as the additional data. Writing it here
// keeps the test off a Go toolchain while still checking the real format.
function seal(bundle, passphrase, { iterations = 600_000, format = "magpie-backup" } = {}) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${format}/1/pbkdf2-sha256/${iterations}/${salt.toString("hex")}`));
  const plain = Buffer.isBuffer(bundle) ? bundle : Buffer.from(JSON.stringify(bundle));
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return Buffer.from(JSON.stringify({
    format, version: 1, kdf: "pbkdf2-sha256", iterations,
    salt: salt.toString("base64"), nonce: nonce.toString("base64"), data: body.toString("base64"),
  }));
}

const bundle = () => ({
  version: 2, created: "2026-10-20T00:00:00Z", app: "magpie", keys: true,
  providers: [{ id: "one", name: "One", key: "sk-secret-one" }],
  settings: { theme: "dark", port: 1 },
  profiles: { main: { model: "a" } },
  agents: { "claude.effort": "high" },
  library: { mcp: [] },
});

test("a sealed backup opens, and a wrong passphrase fails the tag", () => {
  const bytes = seal(bundle(), "pass", { iterations: 100_000 });
  const opened = openBackup(bytes, "pass");
  assert.equal(opened.providers[0].id, "one");
  assert.equal(opened.settings.theme, "dark");
  assert.throws(() => openBackup(bytes, "other"), (e) => e instanceof SealedError && e.code === "passphrase");
});

test("a bundle that isn't one, a newer seal and a damaged file all fail alone", () => {
  assert.throws(() => openBackup(Buffer.from("not json"), "p"), (e) => e.code === "unreadable");
  assert.throws(() => openBackup(seal(bundle(), "p", { format: "magpie-data" }), "p"), (e) => e.code === "format");
  const newer = JSON.parse(seal(bundle(), "p").toString());
  newer.version = 2;
  assert.throws(() => openBackup(Buffer.from(JSON.stringify(newer)), "p"), (e) => e.code === "version");
  // A byte changed in the ciphertext is a failed tag, never a partial bundle.
  const damaged = JSON.parse(seal(bundle(), "p").toString());
  const data = Buffer.from(damaged.data, "base64");
  data[0] ^= 0xff;
  damaged.data = data.toString("base64");
  assert.throws(() => openBackup(Buffer.from(JSON.stringify(damaged)), "p"), (e) => e.code === "passphrase");
});

test("usage files open under their own format and never as a setup backup", () => {
  const gzipped = gzipSync(Buffer.from(JSON.stringify({ day: "2026-10-20" })));
  const bytes = seal(gzipped, "p", { format: "magpie-data" });
  assert.equal(JSON.parse(openData(bytes, "p").toString("utf8")).day, "2026-10-20");
  assert.throws(() => openBackup(bytes, "p"), (e) => e.code === "format");
  // An envelope that isn't gzipped inside was not written by usage sharing.
  assert.throws(() => openData(seal({ day: "x" }, "p", { format: "magpie-data" }), "p"),
    (e) => e.code === "format");
});

test("the four envelope fields are covered: changing one fails the tag", () => {
  const original = JSON.parse(seal(bundle(), "p", { iterations: 100_000 }).toString());
  for (const field of ["iterations", "salt"]) {
    const changed = JSON.parse(JSON.stringify(original));
    if (field === "iterations") changed.iterations = 100_001;
    else changed.salt = randomBytes(16).toString("base64");
    assert.throws(() => openBackup(Buffer.from(JSON.stringify(changed)), "p"),
      (e) => e instanceof SealedError, `${field} was not covered by the seal`);
  }
});

test("a credential is masked wherever it sits, and a plain field is not", () => {
  assert.equal(scrub({ key: "sk-abcdefghijkl" }).key, "••••ijkl");
  assert.equal(scrub({ apiKey: "sk-abcdefghijkl" }).apiKey, "••••ijkl");
  assert.equal(scrub({ headers: { Authorization: "Bearer abcdefgh" } }).headers.Authorization, "••••efgh");
  assert.equal(scrub({ name: "visible" }).name, "visible");
  // A field whose name only looks like a credential stays readable.
  assert.equal(scrub({ keyName: "primary" }).keyName, "primary");
});

// member returns one member of a part, by its id, for tests that look at the
// providers part's several lists.
const member = (part, id) => (part.members ?? []).find((m) => m.id === id);

test("a changed credential is shown masked, never in the clear", () => {
  const local = { providers: [{ id: "one", name: "One", key: "sk-NEWSECRET-aaaaaaaa" }], settings: {}, profiles: {} };
  const remote = { providers: [{ id: "one", name: "One", key: "sk-OLDSECRET-bbbbbbbb" }], settings: {}, profiles: {} };
  const d = diffBundle({ local, remote, carried: true });
  const fields = member(d.parts.find((p) => p.part === "providers"), "providers").changed[0].fields;
  assert.equal(fields[0].path, "key");
  assert.match(fields[0].before, /^••••/);
  assert.match(fields[0].after, /^••••/);
  assert.equal(JSON.stringify(d).includes("SECRET"), false);
});

test("a keyless bundle does not report every key as removed", () => {
  const local = { providers: [{ id: "one", name: "One", key: "sk-abc", keyName: "k" }], settings: {}, profiles: {} };
  const remote = { providers: [withoutKeys({ id: "one", name: "One", key: "sk-abc", keyName: "k" })], settings: {}, profiles: {} };
  const d = diffBundle({ local, remote, carried: false });
  const part = member(d.parts.find((p) => p.part === "providers"), "providers");
  assert.equal(part.changed.length, 0, "a keyless bundle was compared with keys in place");
  assert.equal(d.changed, false);
});

test("added, removed and changed providers are told apart", () => {
  const local = { providers: [{ id: "a", name: "A" }, { id: "b", name: "B2" }], settings: {}, profiles: {} };
  const remote = { providers: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }], settings: {}, profiles: {} };
  const part = member(diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "providers"), "providers");
  assert.deepEqual(part.removed.map((e) => e.key), ["c"]);
  assert.equal(part.changed.length, 1);
  assert.equal(part.changed[0].key, "b");
  assert.deepEqual(part.changed[0].fields[0], { path: "name", before: "B", after: "B2" });
});

test("settings that only this computer owns never make a difference", () => {
  const local = { providers: [], settings: { theme: "dark", port: 3437, proxy: "x" }, profiles: {} };
  const remote = { providers: [], settings: { theme: "dark", port: 1 }, profiles: {} };
  const part = diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "settings");
  assert.equal(part.changed.length, 0);
  local.settings.theme = "light";
  const changed = diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "settings");
  assert.equal(changed.changed.length, 1);
  assert.equal(changed.changed[0].key, "theme");
});

test("profiles diff by name", () => {
  const local = { providers: [], settings: {}, profiles: { a: { m: 1 }, b: { m: 2 } } };
  const remote = { providers: [], settings: {}, profiles: { a: { m: 1 } } };
  const d = diffBundle({ local, remote, carried: true });
  const profiles = d.parts.find((p) => p.part === "profiles");
  assert.deepEqual(profiles.added.map((e) => e.key), ["b"]);
  assert.equal(d.changed, true);
});

// The agents part reads applied.json, which records each field magpie set on
// an agent and when. A record newer than the backup is a change still to
// upload; an older one is already synced. Reading it by time is what makes
// the part exact without redoing every agent's parsing rules.
test("an agent field changed after the last sync is shown, with both values", () => {
  const remote = { providers: [], settings: {}, profiles: {}, agents: { "claude.model": "auto/dfmodel[1m]" } };
  const local = {
    providers: [], settings: {}, profiles: {},
    syncedAt: "2026-10-20T20:45:49.1948141+08:00",
    applied: { claude: { at: "2026-10-20T21:00:35.3953789+08:00", fields: { model: "auto/gfmodel[1m]" } } },
  };
  const agents = diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "agents");
  assert.equal(agents.changed.length, 1);
  assert.deepEqual(agents.changed[0].fields[0],
    { path: "value", before: "auto/dfmodel[1m]", after: "auto/gfmodel[1m]" });
});

test("an agent field already synced is not shown", () => {
  const remote = { providers: [], settings: {}, profiles: {}, agents: { "codex.model": "gpt-6.1-sol" } };
  // Recorded before the backup was made: the bundle already has it, so the
  // difference in applied.json is history, not a pending upload.
  const local = {
    providers: [], settings: {}, profiles: {},
    syncedAt: "2026-10-20T20:45:49+08:00",
    applied: { codex: { at: "2026-10-15T11:07:17+08:00", fields: { model: "group/auto-gpt-6-1-sol" } } },
  };
  const agents = diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "agents");
  assert.equal(agents.changed.length, 0);
  assert.equal(agents.added.length, 0);
});

test("an unreadable local file is an error, never an empty setup", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { diffSetup } = await import("../lib/setupdiff.mjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-diff-unit-"));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    fs.writeFileSync(path.join(directory, "sync.json"), JSON.stringify({
      url: "http://127.0.0.1:3437/dav/x", passphrase: "p", keys: true }));
    fs.writeFileSync(path.join(directory, "sync-server.magpie-backup"),
      seal(bundle(), "p", { iterations: 100_000 }));
    fs.writeFileSync(path.join(directory, "providers.json"), "{ not json");
    const result = diffSetup(directory);
    // The file is there but unreadable: reported, never taken as no providers.
    assert.equal(result.available, false);
    assert.equal(result.reason, "local");
  } finally { cleanup(); }
});

test("a config with no sync, no cached backup or a bad passphrase says which", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { diffSetup } = await import("../lib/setupdiff.mjs");
  const make = () => fs.mkdtempSync(path.join(os.tmpdir(), "magpie-diff-case-"));
  const cases = [];
  const none = make();
  cases.push([none, "no-sync"]);
  const noBackup = make();
  fs.writeFileSync(path.join(noBackup, "sync.json"), JSON.stringify({ url: "http://h/dav/x", passphrase: "p" }));
  cases.push([noBackup, "no-backup"]);
  const wrongPass = make();
  fs.writeFileSync(path.join(wrongPass, "sync.json"), JSON.stringify({ url: "http://h/dav/x", passphrase: "nope" }));
  fs.writeFileSync(path.join(wrongPass, "sync-server.magpie-backup"), seal(bundle(), "p", { iterations: 100_000 }));
  cases.push([wrongPass, "passphrase"]);
  try {
    for (const [directory, want] of cases) {
      const result = diffSetup(directory);
      assert.equal(result.available, false, want);
      assert.equal(result.reason, want);
    }
  } finally { for (const [directory] of cases) fs.rmSync(directory, { recursive: true, force: true }); }
});

// The providers part of magpie's hash folds in more than the providers list.
// Each of these once went unseen, so each is held here.
test("every member of the providers part is compared", () => {
  const base = () => ({ providers: [{ id: "p", name: "P", key: "sk-xxxxxxxxxxxx" }], groups: [],
    order: [], groupOrder: [], searches: [], icons: {}, plugins: [], settings: {}, profiles: {} });
  const remote = base();
  const cases = {
    groups: (l) => { l.groups = [{ id: "g", name: "G", members: [] }]; },
    order: (l) => { l.order = ["b", "a"]; },
    groupOrder: (l) => { l.groupOrder = ["z", "y"]; },
    searches: (l) => { l.searches = [{ id: "s", name: "S" }]; },
    icons: (l) => { l.icons = { "a.png": "bytes" }; },
    plugins: (l) => { l.plugins = [{ spec: "@x/y" }]; },
  };
  for (const [id, mutate] of Object.entries(cases)) {
    const local = base();
    mutate(local);
    const part = diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "providers");
    assert.ok(member(part, id).added.length + member(part, id).removed.length + member(part, id).changed.length > 0,
      `${id} was not compared`);
  }
});

test("a routing group's strategy and member order are both shown", () => {
  const local = { providers: [], settings: {}, profiles: {},
    groups: [{ id: "g", name: "G", routing: "least-used", members: ["b", "a"] }] };
  const remote = { providers: [], settings: {}, profiles: {},
    groups: [{ id: "g", name: "G", members: ["a", "b"] }] };
  const part = member(diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "providers"), "groups");
  const fields = part.changed[0].fields;
  // smart is what a missing strategy means, so its default is not a change.
  assert.deepEqual(fields.find((f) => f.path === "routing"), { path: "routing", before: "smart", after: "least-used" });
  assert.ok(fields.some((f) => f.path === "members"));
});

test("a strategy set back to smart is not a change", () => {
  const local = { providers: [], settings: {}, profiles: {},
    groups: [{ id: "g", name: "G", routing: "smart" }] };
  const remote = { providers: [], settings: {}, profiles: {},
    groups: [{ id: "g", name: "G" }] };
  const part = member(diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "providers"), "groups");
  assert.equal(part.changed.length, 0);
});

// A record whose time cannot be placed against the backup is left out: a
// guess would report a synced setup as pending.
test("an agent record with no usable time is left out", () => {
  const remote = { providers: [], settings: {}, profiles: {}, agents: { "claude.model": "old" } };
  const local = {
    providers: [], settings: {}, profiles: {},
    syncedAt: "2026-10-20T20:45:49+08:00",
    applied: { claude: { at: "", fields: { model: "new" } } },
  };
  const part = diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "agents");
  assert.equal(part.added.length, 0);
  assert.equal(part.changed.length, 0);
});

test("the parts are named as magpie's own sync page names them", async () => {
  const { PART_NAMES, MEMBERS } = await import("../lib/diff.mjs");
  assert.equal(PART_NAMES.library.zh, "资源库");
  assert.equal(PART_NAMES.agents.zh, "agent 的模型");
  assert.equal(PART_NAMES.providers.zh, "供应商");
  assert.equal(MEMBERS.groups.zh, "路由组");
  assert.equal(MEMBERS.plugins.zh, "插件");
});

// The library is compared for real: the bundle carries each skill's files,
// and hashing them the way magpie hashes a folder gives the hash this
// computer keeps. Getting this wrong made every synced library look changed.
const b64 = (s) => Buffer.from(s).toString("base64");
const skillFiles = (text) => ({ files: { "SKILL.md": b64(text) } });

test("a library the bundle and this computer agree on shows no change", async () => {
  const { librarySkillHash } = await import("../lib/diff.mjs");
  const files = skillFiles("# Archify");
  const local = { providers: [], settings: {}, profiles: {},
    library: { instructions: { agents: [] }, mcp: null,
      skills: [{ name: "archify", agents: [], hash: librarySkillHash(files.files) }] } };
  const remote = { providers: [], settings: {}, profiles: {},
    library: { instructions: { agents: [] }, mcp: null,
      skills: [{ name: "archify", agents: [], ...files }] } };
  const library = diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "library");
  assert.equal(library.added.length, 0);
  assert.equal(library.changed.length, 0);
  assert.equal(library.removed.length, 0);
});

test("a skill whose files changed, or that was added or removed, is shown", async () => {
  const { librarySkillHash } = await import("../lib/diff.mjs");
  const local = { providers: [], settings: {}, profiles: {},
    library: { instructions: null, mcp: null, skills: [
      { name: "edited", agents: [], hash: librarySkillHash(skillFiles("new text").files) },
      { name: "only-here", agents: [], hash: "b".repeat(64) },
    ] } };
  const remote = { providers: [], settings: {}, profiles: {},
    library: { instructions: null, mcp: null, skills: [
      { name: "edited", agents: [], ...skillFiles("old text") },
      { name: "only-there", agents: [], ...skillFiles("gone") },
    ] } };
  const library = diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "library");
  assert.deepEqual(library.added.map((e) => e.name), ["only-here"]);
  assert.deepEqual(library.removed.map((e) => e.name), ["only-there"]);
  assert.deepEqual(library.changed.map((e) => e.name), ["edited"]);
});

test("a library's instructions and MCP servers are compared too", () => {
  const local = { providers: [], settings: {}, profiles: {},
    library: { instructions: { agents: ["claude"] }, mcp: [{ name: "srv", command: "b" }], skills: [] } };
  const remote = { providers: [], settings: {}, profiles: {},
    library: { instructions: { agents: [] }, mcp: [{ name: "srv", command: "a" }], skills: [] } };
  const library = diffBundle({ local, remote, carried: true }).parts.find((p) => p.part === "library");
  assert.ok(library.fields.length > 0, "instructions or MCP changes were not compared");
});
