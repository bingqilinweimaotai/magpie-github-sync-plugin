import fs from "node:fs";
import path from "node:path";
import { openBackup, SealedError } from "./sealed.mjs";
import { diffBundle } from "./diff.mjs";

// The files beside magpie's that a diff reads. They are settings.Dir()'s:
// the same folder the plugin host hands this plugin as `directory`.
const SYNC = "sync.json";
const STATE = "sync-state.json";
const CACHED = "sync-server.magpie-backup";

const readJSON = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
};

// setup reads what a diff needs. A Magpie with sync off has no sync.json, and
// one that never synced has no cached server file: both are answered as "not
// available", never as an empty setup that would look like a whole config
// the user is about to lose.
export function readSetup(directory) {
  const sync = readJSON(path.join(directory, SYNC));
  if (!sync || typeof sync.url !== "string" || !sync.url) {
    return { available: false, reason: "no-sync" };
  }
  const state = readJSON(path.join(directory, STATE)) ?? {};
  const cached = path.join(directory, CACHED);
  return {
    available: true,
    sync,
    state,
    cacheFile: fs.existsSync(cached) ? cached : "",
    // The token and the local bridge password stay here: a diff needs the
    // passphrase alone, and only to open the backup's own envelope.
    passphrase: typeof sync.passphrase === "string" ? sync.passphrase : "",
    carried: sync.keys !== false,
    partOnly: {
      agents: state.local?.agents !== state.remote?.agents,
      library: state.local?.library !== state.remote?.library,
    },
    url: sync.url,
    branch: sync.branch ?? "",
  };
}

// localParts is this computer's setup as the bundle stores it. Each member of
// magpie's providers part comes from providers.json or plugins.json, and
// applied.json holds what magpie last wrote into each agent, which is what the
// bundle's agents part is a snapshot of.
function localParts(directory, carried) {
  const need = (name) => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return undefined;
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { throw new SealedError(`Cannot read ${name}.`, "local"); }
    try { return JSON.parse(text); } catch { throw new SealedError(`${name} is not readable JSON.`, "local"); }
  };
  const providers = need("providers.json");
  const settings = need("settings.json");
  const profiles = need("profiles.json");
  const plugins = need("plugins.json");
  const library = need("library.json");
  return {
    providers: Array.isArray(providers?.providers) ? providers.providers : [],
    // The rest of magpie's providers hash: routing groups, the orders, the
    // search APIs and the plugins.
    groups: Array.isArray(providers?.groups) ? providers.groups : [],
    order: Array.isArray(providers?.order) ? providers.order : [],
    groupOrder: Array.isArray(providers?.groupOrder) ? providers.groupOrder : [],
    searches: Array.isArray(providers?.searches) ? providers.searches : [],
    icons: {},
    plugins: entriesOf(plugins),
    settings: settings ?? {},
    profiles: profiles ?? {},
    // library.json's skills keep the hash of their folder, which the bundle's
    // files hash to: the two sides compare the same thing.
    library: library ?? {},
    carried,
  };
}

// entriesOf reads plugins.json's list: magpie keeps an entry's spec, and the
// bundle carries those it installed.
function entriesOf(plugins) {
  if (!Array.isArray(plugins?.plugins)) return [];
  return plugins.plugins.filter((e) => e && typeof e.spec === "string" && !e.off);
}

// diffSetup compares this computer with the backup already cached from the
// last sync. It reads no network: what the last sync saw is what the user is
// shown, which is also what would be reconciled on the next one.
export function diffSetup(directory) {
  const setup = readSetup(directory);
  if (!setup.available) return { available: false, reason: setup.reason };
  if (!setup.passphrase) return { available: false, reason: "no-passphrase" };
  if (!setup.cacheFile) return { available: false, reason: "no-backup" };
  let remote;
  try {
    remote = openBackup(fs.readFileSync(setup.cacheFile), setup.passphrase);
  } catch (err) {
    if (err instanceof SealedError) return { available: false, reason: err.code || "sealed", message: err.message };
    throw err;
  }
  let local;
  try {
    local = localParts(directory, setup.carried);
  } catch (err) {
    if (err instanceof SealedError) return { available: false, reason: "local", message: err.message };
    throw err;
  }
  const result = diffBundle({ local, remote, carried: setup.carried, partOnly: setup.partOnly });
  return {
    available: true,
    url: setup.url,
    branch: setup.branch,
    carried: setup.carried,
    // The cached file is the server's as of the last sync; the state says when.
    syncedAt: setup.state?.last ?? "",
    ...result,
  };
}
