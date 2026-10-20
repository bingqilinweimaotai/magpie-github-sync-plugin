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
    // Which repository, branch and folder the cached file is of, so a diff
    // never shows one server's contents against another's setup.
    url: sync.url,
    branch: sync.branch ?? "",
  };
}

// localParts is this computer's setup as the bundle stores it: providers.json's
// providers, settings.json, profiles.json. Each is read as it is; a file that
// is there but unreadable is an error, since treating it as empty would report
// every entry as removed.
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
  return {
    providers: Array.isArray(providers?.providers) ? providers.providers : [],
    settings: settings ?? {},
    profiles: profiles ?? {},
    carried,
  };
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
  const local = (() => {
    try { return localParts(directory, setup.carried); }
    catch (err) {
      if (err instanceof SealedError) return err;
      throw err;
    }
  })();
  if (local instanceof SealedError) {
    return { available: false, reason: "local", message: local.message };
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
