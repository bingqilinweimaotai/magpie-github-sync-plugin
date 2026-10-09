import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { startBridge } from "./lib/server.mjs";
import { profileID } from "./lib/state.mjs";

function identity(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/_identity", timeout: 1500 }, (res) => {
      let data = "";
      res.on("data", (part) => { data += part; if (data.length > 2048) req.destroy(); });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("Port is used by another application.")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Bridge did not respond.")));
    req.on("error", reject);
  });
}

// The host may overlap with a CLI host or an old host draining requests.
// Recheck ownership so the surviving host takes over when that host exits.
export default async function GitHubSyncPlugin({ directory, client }, options = {}) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("Magpie must provide its configuration directory.");
  const port = options.port ?? 3437;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535.");
  const ownDirectory = path.dirname(fileURLToPath(import.meta.url));
  let server;
  let checking = false;
  let stopped = false;
  let timer;
  const enabled = () => {
    const file = path.join(directory, "plugins.json");
    if (!fs.existsSync(file)) return true;
    const entries = JSON.parse(fs.readFileSync(file, "utf8")).plugins ?? [];
    return entries.some((e) => !e.off && (
      path.resolve(e.spec) === ownDirectory ||
      /(?:^|\/|:)magpie-github-sync-plugin(?:\.git)?(?:#.*|@[^/]*)?$/.test(e.spec)
    ));
  };
  const ensure = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      if (!enabled()) {
        stopped = true;
        clearInterval(timer);
        server?.close();
        return;
      }
      if (server?.listening) return;
      try {
        server = await startBridge({ directory, port });
      } catch (err) {
        if (err.code !== "EADDRINUSE") throw err;
        const other = await identity(port);
        if (other.plugin !== "magpie-github-sync-plugin" || other.profile !== profileID(directory)) {
          throw new Error("Bridge port belongs to another application or Magpie profile. Choose another port.");
        }
      }
    } finally { checking = false; }
  };
  await ensure();
  timer = setInterval(() => ensure().catch((err) => client.app.log({
    body: { service: "github-sync", level: "error", message: err.message },
  })), 2000);
  timer.unref?.();
  await client.app.log({ body: { service: "github-sync", level: "info",
    message: `GitHub sync setup: http://127.0.0.1:${port}/` } });
  return {};
}
