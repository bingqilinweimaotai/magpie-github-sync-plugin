// What a sync would change, from the setup files beside magpie's and the
// bundle a sealed backup carries. The bundle's parts are the same shapes the
// files have (verified against a real backup): providers.json's providers,
// settings.json, profiles.json. Agents and the library are assembled by
// magpie from each agent's own files and the library folder, which this
// cannot redo, so they are reported as a part that differs, not field by field.

export const PARTS = ["providers", "settings", "profiles", "agents", "library"];

// A field whose name says it holds a credential is never shown, whatever it
// is worth. The allowlist keeps the ones that only look like one.
const SECRET = /(^|[^a-z])(key|keys|token|secret|passphrase|password|authorization|cookie|credential|apikey)/i;
const NOT_SECRET = new Set(["keyname", "keyprotocol", "keyweight", "keyscount", "keyslength"]);

// KeepOwn in settings.go: fields that are this computer's alone, never
// synced. magpie zeroes them on both sides before it hashes a settings part,
// so a diff does the same or every computer would look changed.
export const KEEP_OWN = ["gatewayConversations", "uiFont", "codeFont", "window", "proxy", "port",
  "dock", "dockWindow", "lightweight", "windowMaximised", "keepAwake", "keepAwakeDisplay",
  "trayUsages", "trayUsage", "trayUsageEvery", "trayNoLogos", "trayNoBird", "trayPace", "trayNoCost",
  "gatewayMode", "noWSLAgents", "quotaReads", "noAccountDiscovery", "lan", "allowIPs",
  "fetchPrivate", "sessionTerminal"];

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// lastShown is what a masked value shows: enough to tell two apart, never
// enough to be the value.
function lastShown(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  if (text.length < 8) return "••••";
  return "••••" + text.slice(-4);
}

// clean strips the credential-ish fields out of a value before it is shown,
// and masks the rest. A path is passed down so a nested key is judged by its
// own name, not only its parent's.
export function scrub(value, depth = 0) {
  if (depth > 6) return "[deep]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (!isPlain(value)) return value;
  const out = {};
  for (const [name, v] of Object.entries(value)) {
    if (SECRET.test(name) && !NOT_SECRET.has(name.toLowerCase())) {
      out[name] = lastShown(v);
    } else if (isPlain(v) || Array.isArray(v)) out[name] = scrub(v, depth + 1);
    else out[name] = v;
  }
  return out;
}

// withoutKeys is backup.withoutKeys: what a sync that doesn't carry keys puts
// in the bundle. Comparing a keyless bundle with the local file as it is would
// otherwise report every provider's key as removed.
export function withoutKeys(provider) {
  const p = { ...provider };
  p.key = ""; p.keyName = ""; p.keys = []; p.keyProtocol = ""; p.keyWeight = 0;
  p.balanceToken = ""; p.accessKeyID = ""; p.secretAccessKey = "";
  p.balanceToken = "";
  if (isPlain(p.headers)) {
    const headers = {};
    for (const [k, v] of Object.entries(p.headers)) if (!SECRET.test(k)) headers[k] = v;
    p.headers = headers;
  }
  return p;
}

// settingsPart normalizes the settings side of a diff: the fields KeepOwn
// owns are dropped from both, as magpie zeroes them before hashing.
function settingsPart(settings) {
  if (!isPlain(settings)) return {};
  const out = { ...settings };
  for (const name of KEEP_OWN) delete out[name];
  return out;
}

// changes lists the leaf differences between two values, by dotted path.
function changes(before, after, path, out, depth = 0) {
  if (depth > 3) {
    if (!same(before, after)) out.push({ path, before, after });
    return out;
  }
  if (isPlain(before) && isPlain(after)) {
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      changes(before[name], after[name], path ? `${path}.${name}` : name, out, depth + 1);
    }
    return out;
  }
  if (!same(before, after)) out.push({ path, before, after });
  return out;
}

// entities diffs two lists by a key, telling what only this computer has
// (a sync would upload it), what only the remote has (a sync would put it
// here), and what both have differently.
function entities(local, remote, keyOf, nameOf) {
  const left = new Map((Array.isArray(local) ? local : []).map((e) => [keyOf(e), e]));
  const right = new Map((Array.isArray(remote) ? remote : []).map((e) => [keyOf(e), e]));
  const out = { added: [], removed: [], changed: [] };
  for (const [key, e] of left) {
    if (!right.has(key)) out.added.push({ key, name: nameOf(e) });
    else {
      const fields = changes(right.get(key), e, "", []);
      if (fields.length) out.changed.push({ key, name: nameOf(e), fields });
    }
  }
  for (const [key, e] of right) if (!left.has(key)) out.removed.push({ key, name: nameOf(e) });
  return out;
}

// keyed diffs two maps of named objects, such as profiles.
function keyed(local, remote) {
  const left = isPlain(local) ? local : {};
  const right = isPlain(remote) ? remote : {};
  const out = { added: [], removed: [], changed: [] };
  for (const [name, v] of Object.entries(left)) {
    if (!(name in right)) out.added.push({ key: name, name });
    else {
      const fields = changes(right[name], v, "", []);
      if (fields.length) out.changed.push({ key: name, name, fields });
    }
  }
  for (const name of Object.keys(right)) if (!(name in left)) out.removed.push({ key: name, name });
  return out;
}

// describe makes one part's answer. Every value is scrubbed by its own field
// name: a credential is masked whether it sits in an entity or is the whole
// before/after of a changed field, which scrub() alone would let through as
// a plain string.
function describe(kind, data) {
  const field = (f) => {
    const name = f.path.split(".").at(-1);
    if (SECRET.test(name) && !NOT_SECRET.has(name.toLowerCase())) {
      return { path: f.path, before: lastShown(f.before), after: lastShown(f.after) };
    }
    return { path: f.path, before: scrub(f.before), after: scrub(f.after) };
  };
  const list = (entries) => entries.map((e) => ({
    ...e,
    fields: e.fields?.map(field),
  }));
  return { level: kind, added: list(data.added), removed: list(data.removed), changed: list(data.changed) };
}

// diffBundle compares this computer's setup with the bundle on the server.
// carried is whether the bundle carries credentials; partOnly are the parts
// that can only be told apart as a whole.
export function diffBundle({ local, remote, carried = true, partOnly = {} }) {
  const parts = [];
  const providersLocal = carried ? local.providers : (local.providers ?? []).map(withoutKeys);
  const providersRemote = carried ? remote.providers : (remote.providers ?? []).map(withoutKeys);
  parts.push({ part: "providers",
    ...describe("entity", entities(providersLocal, providersRemote, (p) => p.id, (p) => p.name || p.id)) });
  parts.push({ part: "settings",
    ...describe("field", keyed(
      mapFields(settingsPart(local.settings)),
      mapFields(settingsPart(remote.settings)))) });
  parts.push({ part: "profiles",
    ...describe("entity", keyed(local.profiles, remote.profiles)) });
  for (const part of ["agents", "library"]) {
    parts.push({ part, level: "part", changed: partOnly[part] === true });
  }
  const changed = parts.some((p) => p.level === "part" ? p.changed
    : p.added.length + p.removed.length + p.changed.length > 0);
  return { changed, parts };
}

// mapFields lets keyed() diff a flat object field by field: each top-level
// name becomes an entity whose value is the field itself.
function mapFields(settings) {
  const out = {};
  for (const [name, v] of Object.entries(settings)) out[name] = { value: v };
  return out;
}
