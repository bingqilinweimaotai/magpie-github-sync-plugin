import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { BridgeError, GitHub, MAX_FILE, normalizeConfig } from "./github.mjs";
import { profileID, readState, remoteID, saveState } from "./state.mjs";
import { html, css, script } from "./ui.mjs";
import { dailyUsage, UsageBatch } from "./usage.mjs";

const BACKUP = "magpie/magpie.magpie-backup";
const usageFile = /^magpie\/usage\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(magpie-usage|magpie-quotas)$/;
const xml = (s) => String(s).replace(/[<>&"']/g, (ch) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
})[ch]);

function sealed(data, format) {
  try {
    const envelope = JSON.parse(data.toString("utf8"));
    return envelope.format === format && envelope.version === 1 &&
      envelope.kdf === "pbkdf2-sha256" && envelope.iterations === 600000 &&
      ["salt", "nonce", "data"].every((key) => typeof envelope[key] === "string" &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(envelope[key]));
  } catch {
    return false;
  }
}

async function inputBody(req, limit) {
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > limit) throw new BridgeError("Request exceeds the size limit.", 413);
    parts.push(part);
  }
  return Buffer.concat(parts, length);
}

function multiStatus(entries) {
  return '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
    entries.map((e) => `<D:response><D:href>${xml(e.href)}</D:href><D:propstat><D:prop>` +
      `<D:resourcetype>${e.directory ? "<D:collection/>" : ""}</D:resourcetype>` +
      (e.sha ? `<D:getetag>"${e.sha}"</D:getetag><D:getcontentlength>${e.size}</D:getcontentlength>` : "") +
      "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>").join("") +
    "</D:multistatus>";
}

export async function startBridge({ directory, port = 3437, fetcher = globalThis.fetch, batchIdleMs = 15000 }) {
  const initial = readState(directory);
  let batch = new UsageBatch(directory, initial.config, fetcher);
  const csrf = randomBytes(32).toString("hex");
  const errors = {};
  let activity = "idle";
  let lastSuccessAt = null;
  let lastCommitAt = null;
  let readVerifiedAt = null;
  let writeError = null;
  let retryAt = null;
  let retryNotBefore = 0;
  let cooldownUntil = 0;
  let uploadSession;
  let queue = Promise.resolve();
  let timer;
  let closing = false;
  const serialize = (operation) => {
    const pending = queue.then(operation, operation);
    queue = pending.catch(() => {});
    return pending;
  };
  const retryDelay = (err) => {
    const seconds = Number(err.headers?.["Retry-After"]);
    return Number.isFinite(seconds) ? Math.max(60000, Math.min(21600000, seconds * 1000)) : 60000;
  };
  const recordError = (err, scope = "sync") => {
    errors[scope] = { message: err instanceof SyntaxError ? "Invalid JSON. Existing configuration was kept." : err.message,
      code: err.code || (err.status === 412 ? "conflict" : "") };
    if (err.status === 429) {
      const seconds = Number(err.headers?.["Retry-After"]);
      cooldownUntil = Math.max(cooldownUntil, Date.now() + (Number.isFinite(seconds) ? Math.max(1, seconds) : 60) * 1000);
    }
  };
  const success = () => {
    delete errors.sync;
    lastSuccessAt = new Date().toISOString();
  };
  const checkCooldown = () => {
    if (cooldownUntil > Date.now()) {
      throw new BridgeError("GitHub rate limited sync; try again later.", 429,
        { "Retry-After": String(Math.ceil((cooldownUntil - Date.now()) / 1000)) }, "rate-limit");
    }
  };
  const prepare = async (gh) => {
    checkCooldown();
    await gh.prepare();
    readVerifiedAt = new Date().toISOString();
  };
  const flush = async () => {
    if (!batch.pending) return;
    const previousActivity = activity;
    activity = "publishing";
    try {
      checkCooldown();
      await batch.flush();
      lastCommitAt = new Date().toISOString();
      readVerifiedAt = lastCommitAt;
      writeError = null;
      delete errors.pending;
      retryNotBefore = 0;
      success();
    } catch (err) {
      recordError(err, "pending");
      writeError = errors.pending;
      retryNotBefore = Date.now() + retryDelay(err);
      err.pendingFailure = true;
      throw err;
    } finally {
      uploadSession = undefined;
      activity = previousActivity;
    }
  };
  const run = (label, operation) => serialize(async () => {
    activity = label;
    try { return await operation(); } finally { activity = "idle"; }
  });
  const schedule = (after = batchIdleMs) => {
    clearTimeout(timer);
    retryAt = null;
    if (closing || !batch.pending || batch.conflicted) return;
    const delay = Math.max(after, retryNotBefore - Date.now(), cooldownUntil - Date.now());
    retryAt = new Date(Date.now() + delay).toISOString();
    timer = setTimeout(() => run("publishing", flush).catch((err) => {
      schedule(retryDelay(err));
    }).then(() => { if (!batch.pending) retryAt = null; }), delay);
    timer.unref?.();
  };
  if (batch.conflicted) {
    errors.pending = { message: "Usage changed on another computer; pending uploads were kept.", code: "conflict" };
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, body = "", headers = {}) => {
      res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const json = (data) => reply(200, JSON.stringify(data), { "Content-Type": "application/json" });
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== origin.slice(7) ||
          (req.headers.origin && req.headers.origin !== origin)) {
        throw new BridgeError("Only this loopback origin can access the bridge.", 403);
      }
      const url = new URL(req.url, origin);
      if (url.search) throw new BridgeError("Queries are not supported.", 400);
      if (req.method === "GET" && url.pathname === "/_identity") {
        return json({ plugin: "magpie-github-sync-plugin", profile: profileID(directory), version: "0.2.2" });
      }
      if (req.method === "GET" && ["/", "/style.css", "/ui.js"].includes(url.pathname)) {
        return reply(200, url.pathname === "/" ? html(csrf) : url.pathname === "/style.css" ? css : script, {
          "Content-Type": url.pathname === "/" ? "text/html; charset=utf-8" :
            url.pathname === "/style.css" ? "text/css" : "text/javascript",
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        });
      }
      if (url.pathname.startsWith("/api/")) {
        if (req.headers["x-csrf-token"] !== csrf) throw new BridgeError("Reopen the setup page.", 403);
        if (req.method === "GET" && url.pathname === "/api/status") {
          const { secret, config } = readState(directory);
          const error = errors.pending || errors.sync;
          return json({ repository: config?.repository ?? "", branch: config?.branch ?? "",
            folder: config?.folder ?? "", tokenSet: !!config?.token, lastError: error?.message || "",
            lastErrorCode: error?.code || "", activity, lastSuccessAt, lastCommitAt, retryAt,
            pending: batch.status(), diagnostics: { readVerifiedAt,
              write: writeError ? "failed" : lastCommitAt ? "verified" : "unverified",
              writeError: writeError?.message || "" },
            url: config ? `${origin}/dav/${remoteID(config)}` : "", user: "magpie-sync", password: secret });
        }
        if (req.method === "POST" && url.pathname === "/api/config") {
          const body = JSON.parse((await inputBody(req, 64 * 1024)).toString("utf8"));
          await run("checking", async () => {
            if (closing) throw new BridgeError("Bridge is closing; retry sync after it reloads.", 503);
            const state = readState(directory);
            const config = normalizeConfig(body, state.config);
            const gh = new GitHub(config, fetcher);
            checkCooldown();
            await gh.prepare();
            const sameRemote = state.config && remoteID(state.config) === remoteID(config);
            if (!sameRemote) await flush();
            saveState(directory, { ...state, config });
            if (sameRemote) batch.config = config;
            else batch = new UsageBatch(directory, config, fetcher);
            uploadSession = undefined;
            readVerifiedAt = new Date().toISOString();
            if (!sameRemote || state.config.token !== config.token) {
              retryNotBefore = 0;
              lastCommitAt = null;
              writeError = null;
            }
            success();
          });
          schedule();
          return json({ saved: true });
        }
        if (req.method === "POST" && url.pathname === "/api/usage/retry") {
          try { await run("publishing", flush); } finally { schedule(); }
          return json({ published: !batch.pending });
        }
        if (req.method === "POST" && url.pathname === "/api/usage/resolve") {
          const { name, sha } = JSON.parse((await inputBody(req, 64 * 1024)).toString("utf8"));
          await run("recovering", () => {
            batch.useRemote(name, sha);
            uploadSession = undefined;
            if (!batch.conflicted) {
              if (errors.pending?.code === "conflict") delete errors.pending;
              if (errors.sync?.code === "conflict") delete errors.sync;
              if (writeError?.code === "conflict") writeError = null;
            }
            retryNotBefore = 0;
            lastSuccessAt = new Date().toISOString();
          });
          schedule();
          return json({ archived: true });
        }
        if (req.method === "GET" && /^\/api\/usage\/export\/[a-f0-9]{40}$/.test(url.pathname)) {
          return await serialize(() => reply(200, batch.export(url.pathname.split("/").at(-1)),
            { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="encrypted.magpie-usage"' }));
        }
        throw new BridgeError("No such setup operation.", 404);
      }
      const state = readState(directory);
      const expected = "Basic " + Buffer.from("magpie-sync:" + state.secret).toString("base64");
      const actual = Buffer.from(String(req.headers.authorization ?? ""));
      if (actual.length !== Buffer.byteLength(expected) ||
          !timingSafeEqual(actual, Buffer.from(expected))) {
        return reply(401, "Use the local bridge credentials from the setup page.",
          { "WWW-Authenticate": 'Basic realm="Magpie GitHub sync"' });
      }
      let config = state.config;
      if (!config) throw new BridgeError("Configure a GitHub repository on the setup page.", 503);
      if (closing) throw new BridgeError("Bridge is closing; retry sync after it reloads.", 503);
      const base = `/dav/${remoteID(config)}`;
      if (url.pathname !== base && !url.pathname.startsWith(base + "/")) {
        throw new BridgeError("Repository, branch or folder changed. Update the WebDAV address in Magpie.");
      }
      const name = decodeURIComponent(url.pathname.slice(base.length)).replace(/^\/|\/$/g, "");
      const directoryPath = ["", "magpie", "magpie/usage"].includes(name);
      if (!directoryPath && name !== BACKUP && !usageFile.test(name)) {
        throw new BridgeError("This bridge only serves Magpie backup and usage files.", 400);
      }
      const operation = async () => {
        clearTimeout(timer);
        retryAt = null;
        const live = readState(directory).config;
        if (!live || remoteID(live) !== remoteID(config)) {
          throw new BridgeError("Repository, branch or folder changed. Update the WebDAV address in Magpie.");
        }
        config = live;
        if (!batch.config || remoteID(batch.config) !== remoteID(config)) {
          if (batch.pending) throw new BridgeError("Publish pending usage before changing repository, branch or folder.");
          batch = new UsageBatch(directory, config, fetcher);
        } else batch.config = config;
        let gh;
        const dailyRequest = dailyUsage.test(name) && ["PUT", "GET", "HEAD"].includes(req.method);
        if (dailyRequest) {
          if (!uploadSession || uploadSession.remote !== remoteID(config) || uploadSession.token !== config.token ||
              Date.now() - uploadSession.at >= batchIdleMs) {
            gh = new GitHub({ ...config, branch: batch.pending ? batch.branch : config.branch }, fetcher);
            await prepare(gh);
            const files = new Map((await gh.list("magpie/usage", gh.head || true))
              .map((e) => ["magpie/usage/" + e.name, { ...e, encoding: "none" }]));
            uploadSession = { gh, files, at: Date.now(), remote: remoteID(config), token: config.token };
          }
          checkCooldown();
          gh = uploadSession.gh;
        } else {
          uploadSession = undefined;
          gh = new GitHub({ ...config, branch: batch.pending ? batch.branch : config.branch }, fetcher);
          await prepare(gh);
        }
        if (req.method === "OPTIONS") return reply(204, "", { DAV: "1", Allow: "OPTIONS, PROPFIND, MKCOL, GET, HEAD, PUT, DELETE" });
        if (req.method === "MKCOL" && directoryPath) return reply(201);
        if (req.method === "PROPFIND" && directoryPath) {
          const href = base + (name ? "/" + name : "") + "/";
          const entries = [{ href, directory: true }];
          if (req.headers.depth !== "0") {
            if (name === "magpie/usage") {
              await flush();
              for (const c of await gh.list(name)) entries.push({ href: href + encodeURIComponent(c.name), ...c });
            } else entries.push({ href: href + (name ? "usage/" : "magpie/"), directory: true });
          }
          return reply(207, multiStatus(entries), { "Content-Type": "application/xml; charset=utf-8" });
        }
        if (directoryPath) throw new BridgeError("Operation requires a sync file.", 405);
        const c = batch.content(name) ?? (dailyRequest ? uploadSession.files.get(name) ?? null : await gh.content(name));
        if (req.method === "GET" || req.method === "HEAD") {
          if (!c) return reply(404);
          const etag = `"${c.sha}"`;
          if (req.headers["if-none-match"] === etag) return reply(304, "", { ETag: etag });
          const data = req.method === "HEAD" ? undefined : batch.bytes(name) ?? await gh.bytes(c);
          return reply(200, data, { ETag: etag, "Content-Length": String(c.size),
            "Content-Type": "application/octet-stream" });
        }
        if (req.method === "PUT") {
          const match = req.headers["if-match"]?.replace(/^"|"$/g, "");
          if ((match && c?.sha !== match) || (!match && name === BACKUP && c) ||
              (req.headers["if-none-match"] === "*" && c)) {
            throw new BridgeError("File changed on another computer.", 412);
          }
          const data = await inputBody(req, MAX_FILE);
          // Magpie's SealData uses a different envelope from setup backups.
          const format = name === BACKUP ? "magpie-backup" : "magpie-data";
          if (!sealed(data, format)) {
            throw new BridgeError(`Only sealed Magpie ${name === BACKUP ? "backup" : "usage and quota"} files can be uploaded.`, 400);
          }
          let sha;
          if (dailyUsage.test(name) && !gh.empty) sha = await batch.stage(gh, name, data, c);
          else {
            await flush();
            try {
              sha = await gh.commit(name, data, c?.sha);
              lastCommitAt = new Date().toISOString();
              writeError = null;
            } catch (err) {
              writeError = { message: err.message, code: err.code || "" };
              throw err;
            } finally { uploadSession = undefined; }
          }
          return reply(c ? 200 : 201, "", { ETag: `"${sha}"` });
        }
        if (req.method === "DELETE" && usageFile.test(name)) {
          await flush();
          if (c) {
            await gh.commit(name, null, c.sha, true);
            lastCommitAt = new Date().toISOString();
            writeError = null;
          }
          uploadSession = undefined;
          return reply(204);
        }
        throw new BridgeError("Unsupported operation.", 405);
      };
      try {
        await run(req.method === "PUT" ? "uploading" : req.method === "DELETE" ? "removing" : "reading", async () => {
          await operation();
          success();
        });
      } finally { schedule(); }
    } catch (err) {
      if (!err.pendingFailure) recordError(err);
      if (err.status === 429) schedule(retryDelay(err));
      reply(err.status ?? 502, err instanceof SyntaxError ? "Invalid JSON. Existing configuration was kept." : err.message,
        { "Content-Type": "text/plain; charset=utf-8", ...err.headers });
    }
  });
  server.requestTimeout = 120000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const close = server.close.bind(server);
  let closePromise;
  server.close = (callback) => {
    if (!closePromise) {
      closing = true;
      clearTimeout(timer);
      // Drain pending work before releasing the listener to a surviving host.
      closePromise = run("publishing", flush).catch(() => {})
        .then(() => new Promise((resolve) => close(resolve)));
    }
    if (callback) closePromise.then(callback);
    return server;
  };
  schedule(); // Recover an interrupted upload even when Magpie skips its already-sent days.
  return server;
}
