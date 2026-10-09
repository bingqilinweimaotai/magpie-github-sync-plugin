import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { BridgeError, GitHub, MAX_FILE, normalizeConfig } from "./github.mjs";
import { profileID, readState, remoteID, saveState } from "./state.mjs";
import { html, css, script } from "./ui.mjs";

const BACKUP = "magpie/magpie.magpie-backup";
const usageFile = /^magpie\/usage\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(magpie-usage|magpie-quotas)$/;
const xml = (s) => String(s).replace(/[<>&"']/g, (ch) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
})[ch]);

function sealed(data) {
  try {
    const envelope = JSON.parse(data.toString("utf8"));
    return envelope.format === "magpie-backup" && envelope.version === 1 &&
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

export async function startBridge({ directory, port = 3437, fetcher = globalThis.fetch }) {
  readState(directory);
  const csrf = randomBytes(32).toString("hex");
  let lastError = "";
  let queue = Promise.resolve();
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
        return json({ plugin: "magpie-github-sync-plugin", profile: profileID(directory), version: "0.1.0" });
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
          return json({ repository: config?.repository ?? "", branch: config?.branch ?? "",
            folder: config?.folder ?? "", tokenSet: !!config?.token, lastError,
            url: config ? `${origin}/dav/${remoteID(config)}` : "", user: "magpie-sync", password: secret });
        }
        if (req.method === "POST" && url.pathname === "/api/config") {
          const body = JSON.parse((await inputBody(req, 64 * 1024)).toString("utf8"));
          const state = readState(directory);
          const config = normalizeConfig(body, state.config);
          await new GitHub(config, fetcher).prepare();
          saveState(directory, { ...state, config });
          lastError = "";
          return json({ saved: true });
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
      const config = state.config;
      if (!config) throw new BridgeError("Configure a GitHub repository on the setup page.", 503);
      const base = `/dav/${remoteID(config)}`;
      if (url.pathname !== base && !url.pathname.startsWith(base + "/")) {
        throw new BridgeError("Repository, branch or folder changed. Update the WebDAV address in Magpie.");
      }
      const name = decodeURIComponent(url.pathname.slice(base.length)).replace(/^\/|\/$/g, "");
      const directoryPath = ["", "magpie", "magpie/usage"].includes(name);
      if (!directoryPath && name !== BACKUP && !usageFile.test(name)) {
        throw new BridgeError("This bridge only serves Magpie backup and usage files.", 400);
      }
      const gh = new GitHub(config, fetcher);
      const operation = async () => {
        await gh.prepare();
        if (req.method === "OPTIONS") return reply(204, "", { DAV: "1", Allow: "OPTIONS, PROPFIND, MKCOL, GET, HEAD, PUT, DELETE" });
        if (req.method === "MKCOL" && directoryPath) return reply(201);
        if (req.method === "PROPFIND" && directoryPath) {
          const href = base + (name ? "/" + name : "") + "/";
          const entries = [{ href, directory: true }];
          if (req.headers.depth !== "0") {
            if (name === "magpie/usage") {
              for (const c of await gh.list(name)) entries.push({ href: href + encodeURIComponent(c.name), ...c });
            } else entries.push({ href: href + (name ? "usage/" : "magpie/"), directory: true });
          }
          return reply(207, multiStatus(entries), { "Content-Type": "application/xml; charset=utf-8" });
        }
        if (directoryPath) throw new BridgeError("Operation requires a sync file.", 405);
        const c = await gh.content(name);
        if (req.method === "GET" || req.method === "HEAD") {
          if (!c) return reply(404);
          const etag = `"${c.sha}"`;
          if (req.headers["if-none-match"] === etag) return reply(304, "", { ETag: etag });
          const data = req.method === "HEAD" ? undefined : await gh.bytes(c);
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
          if (!sealed(data)) throw new BridgeError("Only sealed Magpie backup files can be uploaded.", 400);
          const sha = await gh.commit(name, data, c?.sha);
          return reply(c ? 200 : 201, "", { ETag: `"${sha}"` });
        }
        if (req.method === "DELETE" && usageFile.test(name)) {
          if (c) await gh.commit(name, null, c.sha, true);
          return reply(204);
        }
        throw new BridgeError("Unsupported operation.", 405);
      };
      if (req.method === "PUT" || req.method === "DELETE") {
        const pending = queue.then(operation, operation);
        queue = pending.catch(() => {});
        await pending;
      } else await operation();
    } catch (err) {
      lastError = err instanceof SyntaxError ? "Invalid JSON. Existing configuration was kept." : err.message;
      reply(err.status ?? 502, lastError, { "Content-Type": "text/plain; charset=utf-8", ...err.headers });
    }
  });
  server.requestTimeout = 120000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
