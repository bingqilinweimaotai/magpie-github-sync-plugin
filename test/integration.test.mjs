import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startBridge } from "../lib/server.mjs";
import { readState, saveState, remoteID } from "../lib/state.mjs";
import { fakeGitHub } from "./fixture.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error("Integration condition timed out.");
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-github-integration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function host(directory, port) {
  const child = spawn(process.env.BUN_BIN, [process.env.MAGPIE_HOST], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let errors = "";
  const messages = [];
  child.stdout.setEncoding("utf8").on("data", (data) => {
    buffer += data;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) if (line) messages.push(JSON.parse(line));
  });
  child.stderr.on("data", (data) => { errors += data; });
  child.stdin.write(JSON.stringify({ id: 1, method: "init", params: {
    directory, authPath: path.join(directory, "plugin-auth.json"),
    plugins: [{ spec: root, target: root, options: { port } }],
  } }) + "\n");
  return { child, messages, errors: () => errors };
}

test("real Bun plugin host: loading, shared ownership, takeover and disable", {
  skip: !process.env.BUN_BIN || !process.env.MAGPIE_HOST, timeout: 25000,
}, async (t) => {
  const directory = temporary(t);
  const port = await freePort();
  const file = path.join(directory, "plugins.json");
  fs.writeFileSync(file, JSON.stringify({ plugins: [{ spec: root }] }));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null) return;
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }));
  });
  const first = host(directory, port);
  children.push(first.child);
  await waitFor(() => first.messages.some((m) => m.id === 1));
  const init = first.messages.find((m) => m.id === 1);
  assert.equal(init.result.plugins[0].error, undefined, first.errors());
  first.child.stdin.write('{"id":2,"method":"providers"}\n');
  await waitFor(() => first.messages.some((m) => m.id === 2));
  assert.deepEqual(first.messages.find((m) => m.id === 2).result, []);
  const url = `http://127.0.0.1:${port}/_identity`;
  assert.equal((await (await fetch(url)).json()).plugin, "magpie-github-sync-plugin");
  const second = host(directory, port);
  children.push(second.child);
  await waitFor(() => second.messages.some((m) => m.id === 1));
  assert.equal(second.messages.find((m) => m.id === 1).result.plugins[0].error, undefined, second.errors());
  const firstExit = once(first.child, "exit");
  first.child.stdin.end();
  await firstExit;
  await waitFor(async () => { try { return (await fetch(url)).ok; } catch { return false; } });
  fs.writeFileSync(file, JSON.stringify({ plugins: [{ spec: root, off: true }] }));
  await waitFor(async () => { try { await fetch(url); return false; } catch { return true; } });
});

function isolatedEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"),
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    MAGPIE_ADDR: "127.0.0.1:1", MAGPIE_PLUGIN_MARKET: "off", OPENCODE_TEST_HOME: home,
    CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  };
  for (const key of Object.keys(env)) {
    if (/^(QODER|AMP|GEMINI|KILO|COPILOT|MISTRAL|CRUSH|PI|OMP|CURSOR|ZED|MAGPIE_ZED)_/.test(key)) delete env[key];
  }
  return env;
}
function cli(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.MAGPIE_BIN, args, { env: isolatedEnv(home), windowsHide: true });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(output)));
    child.stdin.end();
  });
}

test("native Magpie: encrypted upload, unchanged sync, restore and undo in a fresh profile", {
  skip: !process.env.MAGPIE_BIN, timeout: 60000,
}, async (t) => {
  const base = temporary(t);
  const fake = fakeGitHub();
  fake.empty = true;
  const config = { repository: "owner/repo", branch: "", folder: "backup", token: "fixture-only" };
  const machines = [];
  for (const name of ["first", "second"]) {
    const home = path.join(base, name);
    const directory = path.join(home, ".config", "magpie");
    fs.mkdirSync(directory, { recursive: true });
    saveState(directory, { ...readState(directory), config });
    const server = await startBridge({ directory, port: 0, fetcher: fake.fetch });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    fs.writeFileSync(path.join(directory, "sync.json"), JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}/dav/${remoteID(config)}`,
      user: "magpie-sync", password: readState(directory).secret, passphrase: "integration-passphrase",
      keys: true, agents: false, library: false,
    }));
    machines.push({ home, directory });
  }
  const [first, second] = machines;
  const settingsFile = (machine) => path.join(machine.directory, "settings.json");
  fs.writeFileSync(settingsFile(first), JSON.stringify({ theme: "dark", language: "en" }));
  fs.writeFileSync(settingsFile(second), JSON.stringify({ theme: "light", language: "en" }));
  await cli(first.home, ["webdav", "now"]);
  const backup = fake.files.get("backup/magpie/magpie.magpie-backup");
  assert.ok(backup);
  assert.equal(JSON.parse(backup.bytes).format, "magpie-backup");
  assert.equal(backup.bytes.includes(Buffer.from('"theme"')), false);
  const writes = () => fake.requests.filter((r) => r.method === "PUT").length;
  const count = writes();
  await cli(first.home, ["webdav", "now"]);
  assert.equal(writes(), count, "Unchanged setup should not create another commit.");
  await cli(second.home, ["webdav", "restore"]);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile(second))).theme, "dark");
  await cli(second.home, ["webdav", "undo"]);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile(second))).theme, "light");
});
