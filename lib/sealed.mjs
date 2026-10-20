import { createDecipheriv, pbkdf2Sync, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// backup.Seal in magpie (internal/backup/backup.go) writes a JSON envelope
// whose data is AES-256-GCM under a PBKDF2-SHA256 key, with the envelope's
// own fields as the additional data. Opening one here is what lets the setup
// page show what a sync would change, without asking magpie to do it.
const FORMAT = "magpie-backup";
const DATA_FORMAT = "magpie-data";
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

export class SealedError extends Error {
  constructor(message, code = "") {
    super(message);
    this.code = code;
  }
}

// keys are derived once per passphrase and salt: PBKDF2 at 600,000 rounds is
// slow on purpose, and a diff reads one backup but a page may ask twice.
const keys = new Map();
function keyFor(passphrase, salt, iterations) {
  const id = createHash("sha256")
    .update(passphrase).update("\0").update(salt).update("\0").update(String(iterations))
    .digest("hex");
  let key = keys.get(id);
  if (!key) {
    key = pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
    keys.set(id, key);
  }
  return key;
}

// header is what the seal covers besides the bundle: magpie writes it as
// "%s/%d/%s/%d/%x" of the envelope's format, version, kdf, iterations and salt.
const header = (e, salt) =>
  Buffer.from(`${e.format}/${e.version}/${e.kdf}/${e.iterations}/${salt.toString("hex")}`);

function openEnvelope(bytes, passphrase, format) {
  let e;
  try {
    e = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SealedError("This file is not sealed JSON.", "unreadable");
  }
  if (e?.format !== format) {
    throw new SealedError(format === FORMAT
      ? "This file is not a Magpie setup backup."
      : "This file is not a Magpie usage file.", "format");
  }
  if (e.version !== 1 || e.kdf !== "pbkdf2-sha256") {
    throw new SealedError("This file was sealed by a newer Magpie.", "version");
  }
  const iterations = e.iterations;
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new SealedError("This file is not sealed the way Magpie seals one.", "format");
  }
  const salt = Buffer.from(String(e.salt ?? ""), "base64");
  const nonce = Buffer.from(String(e.nonce ?? ""), "base64");
  const data = Buffer.from(String(e.data ?? ""), "base64");
  if (salt.length < 16 || nonce.length !== 12 || data.length <= 16) {
    throw new SealedError("This file is not sealed the way Magpie seals one.", "format");
  }
  const key = keyFor(passphrase, salt, iterations);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(header(e, salt));
  // Go's GCM appends the 16-byte tag to the ciphertext.
  decipher.setAuthTag(data.subarray(data.length - 16));
  try {
    const plain = Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]);
    return plain;
  } catch {
    // A wrong passphrase and a changed byte fail the same way: the tag.
    throw new SealedError("The passphrase does not open this backup, or the file was changed.", "passphrase");
  }
}

// openBackup returns the bundle a sealed setup backup carries.
export function openBackup(bytes, passphrase) {
  const plain = openEnvelope(bytes, passphrase, FORMAT);
  try {
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw new SealedError("The backup opened but is not readable as one.", "unreadable");
  }
}

// openData returns what a sealed usage or quota file carries, already
// gunzipped: magpie seals gzipped JSON there, not a bundle. The JSON is not
// parsed here, because what a usage file holds is magpie's to decide.
export function openData(bytes, passphrase) {
  const plain = openEnvelope(bytes, passphrase, DATA_FORMAT);
  try {
    return gunzipSync(plain);
  } catch {
    // A seal that isn't gzipped was not written by magpie's usage sharing.
    throw new SealedError("This usage file is not the shape magpie shares.", "format");
  }
}

// forgetKeys drops what was derived, so a passphrase the user retyped is the
// one used next: the cache is keyed by passphrase, never by a stored one.
export function forgetKeys() { keys.clear(); }
