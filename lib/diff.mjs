// What a sync would change, at the granularity magpie itself uses. hashes()
// in internal/davsync/davsync.go splits the setup into five parts, and each
// part is more than one file: the providers part also carries the routing
// groups, their order, the search APIs, provider icons and the installed
// plugins. Comparing only the providers list, as this once did, hid a group's
// strategy change and every plugin added or removed.
//
// The names here are the ones magpie's own sync page shows (app.js's parts()
// and i18n.js): 供应商, 设置, Profile, agent 的模型, 资源库.

export const PARTS = ["providers", "settings", "profiles", "agents", "library"];

// PART_NAMES is what magpie calls each part on its sync page. A reader who
// knows magpie's Settings → Sync recognises these, where "library" alone
// would say nothing.
export const PART_NAMES = {
  providers: { en: "Providers", zh: "供应商" },
  settings: { en: "Settings", zh: "设置" },
  profiles: { en: "Profiles", zh: "Profile" },
  agents: { en: "Agents' models", zh: "agent 的模型" },
  library: { en: "Library", zh: "资源库" },
};

// Things the providers part carries, named as the page a reader changes them
// on. magpie folds all of these into the one providers hash; shown as one
// row, a plugin or a routing strategy change would be lost inside it.
export const MEMBERS = {
  providers: { en: "Providers", zh: "供应商" },
  groups: { en: "Routing groups", zh: "路由组" },
  order: { en: "Provider order", zh: "供应商顺序" },
  groupOrder: { en: "Routing group order", zh: "路由组顺序" },
  searches: { en: "Web search APIs", zh: "网页搜索 API" },
  icons: { en: "Provider icons", zh: "供应商图标" },
  plugins: { en: "Plugins", zh: "插件" },
  gatewayKeys: { en: "Gateway keys", zh: "网关密钥" },
};

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

// scrub strips the credential-ish fields out of a value before it is shown,
// and masks the rest. A path is passed down so a nested key is judged by its
// own name, not only its parent's.
export function scrub(value, depth = 0) {
  if (depth > 6) return "[deep]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (!isPlain(value)) {
    if (typeof value === "string" && value.length > 24 && !/\s/.test(value)) return lastShown(value);
    return value;
  }
  const out = {};
  for (const [name, v] of Object.entries(value)) {
    if (SECRET.test(name) && !NOT_SECRET.has(name.toLowerCase())) out[name] = lastShown(v);
    else if (isPlain(v) || Array.isArray(v)) out[name] = scrub(v, depth + 1);
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

// A group's strategy is left out when it is the default, so "smart" and a
// missing field are the same thing to magpie. Comparing them raw would report
// a change whenever magpie rewrote the file.
const groupRouting = (g) => g?.routing ?? "smart";

// changes lists the leaf differences between two values, by dotted path.
function changes(before, after, path, out, depth = 0) {
  if (depth > 4) {
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

// order diffs two lists whose order is the content, as with the provider and
// routing group arrangement. magpie keeps them whole, so a move is a change
// even when both lists hold the same ids.
function order(local, remote) {
  const left = Array.isArray(local) ? local : [];
  const right = Array.isArray(remote) ? remote : [];
  if (same(left, right)) return { added: [], removed: [], changed: [] };
  const fields = {};
  for (const id of new Set([...left, ...right])) {
    const a = right.indexOf(id), b = left.indexOf(id);
    if (a !== b) fields[id] = { path: id, before: a < 0 ? "—" : String(a + 1), after: b < 0 ? "—" : String(b + 1) };
  }
  return { added: [], removed: [], changed: [{ key: "order", name: "", fields: Object.values(fields) }] };
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
  const list = (entries) => entries.map((e) => ({ ...e, fields: e.fields?.map(field) }));
  return { level: kind, added: list(data.added), removed: list(data.removed), changed: list(data.changed) };
}

const empty = () => ({ added: [], removed: [], changed: [] });

// diffBundle compares this computer's setup with the bundle on the server.
// carried is whether the bundle carries credentials; partOnly are the parts
// that can only be told apart as a whole.
export function diffBundle({ local, remote, carried = true, partOnly = {} }) {
  const parts = [];
  const changedIn = (p) => p.added.length + p.removed.length + p.changed.length;

  // The providers part: every member hashes() folds into it, each compared on
  // its own so a plugin or a routing strategy is not lost inside one number.
  const members = [];
  const providersLocal = carried ? local.providers : (local.providers ?? []).map(withoutKeys);
  const providersRemote = carried ? remote.providers : (remote.providers ?? []).map(withoutKeys);
  members.push({ id: "providers", ...describe("entity",
    entities(providersLocal, providersRemote, (p) => p.id, (p) => p.name || p.id)) });
  // A group's strategy and its members in order: the strategy is normalised
  // so "smart" and no field at all read the same, and the members are kept in
  // the order they are tried in. An absent members list is an empty one.
  const groups = entities(local.groups, remote.groups, (g) => g.id, (g) => g.name || g.id);
  for (const c of groups.changed) {
    const a = (remote.groups ?? []).find((g) => g.id === c.key) ?? {};
    const b = (local.groups ?? []).find((g) => g.id === c.key) ?? {};
    c.fields = [
      ...changes(groupRouting(a), groupRouting(b), "routing", []),
      ...changes(a.members ?? [], b.members ?? [], "members", []),
    ].filter((f) => !same(f.before, f.after));
  }
  groups.changed = groups.changed.filter((c) => c.fields.length > 0);
  members.push({ id: "groups", ...describe("entity", groups) });
  members.push({ id: "order", ...describe("field", order(local.order, remote.order)) });
  members.push({ id: "groupOrder", ...describe("field", order(local.groupOrder, remote.groupOrder)) });
  members.push({ id: "searches", ...describe("entity",
    entities(local.searches, remote.searches, (s) => s.id, (s) => s.name || s.id)) });
  // Icons are kept by file name, and their content is bytes: only the names
  // are compared, since a picture's bytes are not something to show.
  members.push({ id: "icons", ...describe("entity",
    entities(Object.keys(local.icons ?? {}).map((name) => ({ id: name })),
      Object.keys(remote.icons ?? {}).map((name) => ({ id: name })), (i) => i.id, (i) => i.id)) });
  members.push({ id: "plugins", ...describe("entity",
    entities(local.plugins, remote.plugins, (p) => p.spec, (p) => p.spec)) });
  parts.push({ part: "providers", ...describe("members", empty()), members });

  const settings = { part: "settings", ...describe("fields",
    keyed(settingsPart(remote.settings), settingsPart(local.settings))) };
  // Gateway keys ride the settings part in magpie's hash. They are empty on a
  // setup with none, and never shown by value.
  settings.gatewayKeys = describe("entity",
    entities(local.gatewayKeys, remote.gatewayKeys, (k) => k.id ?? k.name, (k) => k.name || k.id));
  parts.push(settings);

  parts.push({ part: "profiles", ...describe("entity",
    keyed(remote.profiles, local.profiles)) });
  // A field magpie has written here is compared with the server's snapshot.
  // Fields the agent owns itself are left out of the server's side: they are
  // in the snapshot but were never magpie's to sync.
  const localAgents = agentEntries(local.agents);
  const remoteAgents = knownAgents(localAgents, agentEntries(remote.agents));
  parts.push({ part: "agents", ...describe("entity",
    entities(localAgents, remoteAgents, (a) => a.id, (a) => a.id)) });
  for (const part of ["library"]) {
    parts.push({ part, level: "part", changed: partOnly[part] === true });
  }
  for (const part of ["agents"]) {
    const built = parts.find((p) => p.part === part);
    if (built.added.length + built.removed.length + built.changed.length === 0) {
      // Nothing to show field by field, but magpie's own hashes may still
      // differ: say so rather than claim there is nothing.
      built.fallback = partOnly[part] === true;
    }
  }
  const changed = parts.some((p) => p.level === "part" ? p.changed
    : changedIn(p) > 0
      || (p.members ?? []).some((m) => changedIn(m) > 0)
      || (p.gatewayKeys ? changedIn(p.gatewayKeys) > 0 : false));
  return { changed, parts };
}

// agentEntries turns either side's agents into a list of {id, value} so the
// same comparison serves both: the bundle keeps "agent.field" → value, and
// this computer's applied.json keeps agent → fields.
//
// A field magpie set back to its agent's default is deleted from applied.json
// (agent/applied.go's record), while the bundle's snapshot keeps it as "". The
// two mean the same thing, so empty values are dropped from both sides: an
// unset field is not a change.
function agentEntries(agents) {
  if (!agents) return [];
  const out = [];
  for (const [key, value] of Object.entries(agents)) {
    if (isPlain(value)) {
      for (const [field, v] of Object.entries(value)) {
        if (v === "" || v === null || v === undefined) continue;
        out.push({ id: `${key}.${field}`, value: v });
      }
    } else if (value !== "" && value !== null && value !== undefined) {
      out.push({ id: key, value });
    }
  }
  return out;
}

// knownAgents keeps only the fields magpie itself has written on this
// computer, as applied.json records them. A field the agent set for itself
// (dsh's own reasoning effort) is not in applied.json, and the bundle is a
// snapshot of the live value: comparing the two would report the field as
// removed on every computer that never set it through magpie. What only the
// server has is likewise left out, so a difference shown is one this computer
// can account for. A field both sides have is always compared, so changed
// models still show.
function knownAgents(localEntries, remoteEntries) {
  const known = new Set(localEntries.map((e) => e.id));
  return remoteEntries.filter((e) => known.has(e.id));
}

// keyed diffs two maps of named objects, such as profiles or settings. The
// first argument is what the server holds, so a change reads "server → here".
function keyed(remote, local) {
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
