// What a sync would change, at the granularity magpie itself uses. hashes()
// in internal/davsync/davsync.go splits the setup into five parts, and each
// part is more than one file: the providers part also carries the routing
// groups, their order, the search APIs, provider icons and the installed
// plugins. Comparing only the providers list, as this once did, hid a group's
// strategy change and every plugin added or removed.
//
// The names here are the ones magpie's own sync page shows (app.js's parts()
// and i18n.js): 供应商, 设置, Profile, agent 的模型, 资源库.

import { createHash } from "node:crypto";

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

// linkHash is the hash magpie keeps for a skill's files
// (library/skillcheck.go's hashWalk): the folders walked in order, each file
// named with its size and then its bytes, .git and the marker left out. The
// bundle carries the files themselves, so the same hash can be worked out
// from it and held against the one this computer keeps.
const MARKER = ".magpie-library";
export function librarySkillHash(files) {
  const names = Object.keys(files ?? {})
    .filter((name) => name !== MARKER && !name.split("/").includes(".git"))
    .sort();
  const h = createHash("sha256");
  for (const name of names) {
    // A skill's files come from JSON in the bundle (base64) and from a test
    // as text: both are bytes to the hash.
    const raw = files[name];
    const bytes = Buffer.isBuffer(raw) ? raw
      : typeof raw === "string" ? Buffer.from(raw, "base64") : Buffer.from(raw?.data ?? raw ?? []);
    h.update(`file ${name} ${bytes.length}\n`);
    h.update(bytes);
  }
  return h.digest("hex");
}

// librarySkills normalizes both sides' skills to what can be compared: the
// bundle keeps each skill's files, this computer keeps the hash of its own
// folder, so the files are hashed the way magpie hashes a folder.
function librarySkills(library) {
  const decode = (v) => (typeof v === "string"
    ? Buffer.from(v, "base64")
    : Buffer.from(v?.data ?? v ?? []));
  return (library?.skills ?? []).map((s) => {
    const files = {};
    for (const [name, value] of Object.entries(s.files ?? {})) files[name] = decode(value);
    return {
      id: s.name,
      name: s.name,
      source: s.source ?? null,
      agents: [...(s.agents ?? [])].sort(),
      // A skill this computer holds keeps its hash; one from the bundle is
      // hashed here, so both sides compare the same thing.
      hash: s.hash ?? (s.files ? librarySkillHash(s.files) : ""),
    };
  });
}

// diffLibrary compares the library part: its instructions, the MCP servers,
// and the skills by name. Its hash is of the files either side carries, which
// differ in form (a hash here, the files there) but not in meaning.
function diffLibrary(localLibrary, remoteLibrary) {
  const fields = changes(
    { instructions: remoteLibrary?.instructions ?? null, mcp: sortBy(remoteLibrary?.mcp, "name"),
      texts: remoteLibrary?.texts ?? {}, extra: remoteLibrary?.extra ?? {} },
    { instructions: localLibrary?.instructions ?? null, mcp: sortBy(localLibrary?.mcp, "name"),
      texts: localLibrary?.texts ?? {}, extra: localLibrary?.extra ?? {} },
    "", []);
  const skills = entities(librarySkills(localLibrary), librarySkills(remoteLibrary),
    (s) => s.id, (s) => s.name);
  // A skill's own fields are compared, but its files are its hash: showing
  // every path of a changed folder would bury the difference.
  for (const s of [skills.added, skills.removed]) for (const e of s) delete e.hash;
  return { fields, skills };
}

const sortBy = (list, key) => [...(Array.isArray(list) ? list : [])]
  .sort((a, b) => String(a?.[key] ?? "").localeCompare(String(b?.[key] ?? "")));
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
  // The agents part: applied.json records each field magpie set on an agent,
  // with when. An entry newer than the backup is this computer's change not
  // yet synced; an older one is already in the backup. So a field is compared
  // only where applied.json says magpie set it after the backup was made,
  // which is exactly what the next sync would upload.
  parts.push({ part: "agents", ...describe("entity",
    pendingAgents(local.applied, remote, local.syncedAt)) });
  // The library is compared for real: the bundle carries each skill's files,
  // and hashing them the way magpie hashes a folder gives the hash this
  // computer keeps, so a skill added, removed or edited is visible.
  const library = diffLibrary(local.library, remote.library);
  parts.push({ part: "library", level: "library", ...library,
    added: library.skills.added, removed: library.skills.removed,
    changed: library.skills.changed, fields: library.fields });
  const changed = parts.some((p) => p.level === "part" ? p.changed
    : changedIn(p) > 0
      || (p.members ?? []).some((m) => changedIn(m) > 0)
      || (p.gatewayKeys ? changedIn(p.gatewayKeys) > 0 : false));
  return { changed, parts };
}

// pendingAgents lists the agent fields this computer has changed since the
// backup was made, as changes against what the backup holds: the fields the
// next sync would upload.
//
// applied.json is magpie's record of what it set on each agent, and when
// (agent/applied.go). A record newer than the backup's creation is a change
// made after that sync, so the server does not have it yet; one older is
// already in the backup. Reading it by time is what makes the part exact:
// the live value sits in each agent's own config file, which this cannot
// parse without redoing every agent's rules, and the bundle only knows what
// the last sync saw.
//
// A field put back to its agent's default is deleted from applied.json
// (record()), so an absent field is no change rather than a removal.
function pendingAgents(applied, remote, syncedAt) {
  const out = { added: [], removed: [], changed: [] };
  if (!isPlain(applied)) return out;
  const since = Date.parse(syncedAt);
  if (!Number.isFinite(since)) return out;
  for (const [agent, entry] of Object.entries(applied)) {
    if (!isPlain(entry)) continue;
    const at = Date.parse(entry.at ?? "");
    // Without a usable time it cannot be placed against the backup, and
    // guessing would report a synced setup as pending: leave it out.
    if (!Number.isFinite(at) || at <= since) continue;
    for (const [field, value] of Object.entries(isPlain(entry.fields) ? entry.fields : {})) {
      if (value === "" || value === null || value === undefined) continue;
      const id = `${agent}.${field}`;
      const there = remote?.agents?.[id];
      // The server's own copy as the backup holds it, so a change that
      // already matches is not reported.
      if (same(there, value)) continue;
      if (there === undefined) {
        out.added.push({ id, name: id, value });
        continue;
      }
      out.changed.push({ id, name: id, fields: [{ path: "value", before: there, after: value }] });
    }
  }
  return out;
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
