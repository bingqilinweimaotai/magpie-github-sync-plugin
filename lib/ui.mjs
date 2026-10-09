export const html = (csrf) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf" content="${csrf}"><title>Magpie / GitHub sync</title><link rel="stylesheet" href="/style.css">
<script src="/ui.js" defer></script></head><body><main>
<header><span class="eyebrow">MAGPIE / COMMUNITY PLUGIN</span><h1>Your setup.<br>Across computers.</h1>
<p>Keep a sealed Magpie backup in your GitHub repository. Magpie handles encryption, merging and recovery.</p>
<div class="flow"><span>Magpie</span><b>&rarr;</b><span>Local bridge</span><b>&rarr;</b><span>GitHub</span></div></header>
<section><h2>01 &mdash; Bind a repository</h2><form id="config">
<label>Repository<input name="repository" placeholder="owner/repo" required autocomplete="off"></label>
<div class="pair"><label>Branch<input name="branch" placeholder="Default branch" autocomplete="off"></label>
<label>Folder<input name="folder" placeholder="Optional" autocomplete="off"></label></div>
<label>GitHub token<input name="token" type="password" autocomplete="new-password" placeholder="Contents: read and write"></label>
<p class="hint">Use an existing repository. The first backup initializes an empty default branch. Other branches must already exist.
Your token stays on this computer. The plugin does not ask for your encryption passphrase.</p>
<button type="submit" id="save">Save repository</button><p id="result" role="status"></p></form></section>
<section id="binding" hidden><h2>02 &mdash; Connect Magpie</h2>
<p>In <strong>Settings &rarr; Sync &rarr; WebDAV</strong>, enter these local bridge details.
Then set the same encryption passphrase on every computer.</p>
<div class="credential"><label>Address<input id="address" readonly></label><button data-copy="address" type="button">Copy</button></div>
<div class="credential"><label>User name<input id="username" readonly></label><button data-copy="username" type="button">Copy</button></div>
<div class="credential"><label>Local password<input id="password" type="password" readonly></label><button data-copy="password" type="button">Copy</button></div>
<p class="hint">The local password is generated for this computer. It is neither your GitHub token nor your encryption passphrase.</p>
<p>Use <strong>Sync now</strong> for ongoing changes, <strong>Restore</strong> to recover setup on a new computer, and <strong>Undo</strong> to recover the setup replaced by a restore.</p>
<p class="hint">On another computer, install this plugin and bind the same repository, branch and folder.
Its local password may differ. Keep Magpie running with the plugin enabled.</p></section>
<footer><span>Only encrypted backup and usage files leave Magpie.</span><span id="health"></span></footer>
</main></body></html>`;

export const css = `
:root{color-scheme:light;--ink:#24332d;--muted:#64736b;--line:#d6ded5;--paper:#fbfcf7;--accent:#9d492c}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 8% 8%,#e5edde 0,transparent 48%),linear-gradient(125deg,#f4f5e9,#f9eee4);color:var(--ink);font:16px/1.6 Georgia,serif}
main{max-width:820px;margin:0 auto;padding:52px 28px}header{padding:0 12px 28px}.eyebrow,button,.hint,input,footer,.flow{font-family:"Cascadia Code","Courier New",monospace}
.eyebrow{font-size:11px;letter-spacing:2px;color:var(--accent)}h1{font-size:clamp(40px,7vw,64px);line-height:1.04;letter-spacing:-2px;font-weight:400;margin:18px 0}header p{max-width:540px;color:var(--muted)}
.flow{display:flex;align-items:center;gap:15px;font-size:12px;margin-top:28px}.flow span{padding:8px 12px;background:#ffffff80;border:1px solid var(--line);border-radius:5px}.flow b{color:var(--accent)}
section{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:28px 32px;margin-bottom:20px;box-shadow:0 8px 32px #24332d07}
h2{font-size:22px;font-weight:400;margin:0 0 18px}label{display:block;font-size:15px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}input{width:100%;font-size:14px;border:1px solid var(--line);padding:11px 12px;margin:5px 0 16px;border-radius:5px;background:white;color:var(--ink)}
input:focus{outline:2px solid #b2c9b1;outline-offset:2px}.hint{font-size:12px;color:var(--muted);line-height:1.65}button{cursor:pointer;border:1px solid var(--line);border-radius:5px;padding:10px 15px;background:#edf1e9;color:var(--ink);font-size:12px}
#save{background:var(--ink);color:white;border-color:var(--ink);margin-top:8px}button:disabled{opacity:.55;cursor:wait}
.credential{display:flex;align-items:center;gap:12px}.credential label{flex:1;min-width:0}.credential input{margin-bottom:10px}.credential button{margin-top:12px}
#result{font:13px/1.5 "Cascadia Code","Courier New",monospace;min-height:20px;color:var(--accent)}footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;font-size:11px;color:var(--muted);padding:8px 12px}
@media(max-width:540px){main{padding:30px 16px}section{padding:22px 18px}.pair{grid-template-columns:1fr;gap:0}.flow{gap:6px}.flow span{padding:6px;font-size:11px}h1{letter-spacing:-1px}}`;

export const script = `
const form = document.querySelector("#config");
const result = document.querySelector("#result");
const csrf = document.querySelector('meta[name="csrf"]').content;
async function api(route, data) {
  const response = await fetch("/api/" + route, {
    method: data ? "POST" : "GET",
    headers: {"X-CSRF-Token": csrf, ...(data ? {"Content-Type": "application/json"} : {})},
    ...(data ? {body: JSON.stringify(data)} : {}),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
async function refresh() {
  const state = await api("status");
  for (const name of ["repository", "branch", "folder"]) form.elements[name].value = state[name];
  form.elements.token.placeholder = state.tokenSet ? "Saved; leave empty to keep it for this repository" : "Contents: read and write";
  form.elements.token.required = !state.tokenSet;
  document.querySelector("#binding").hidden = !state.url;
  document.querySelector("#address").value = state.url;
  document.querySelector("#username").value = state.user;
  document.querySelector("#password").value = state.password;
  document.querySelector("#health").textContent = state.lastError ? "Last sync: " + state.lastError : "Bridge ready";
}
form.onsubmit = async (event) => {
  event.preventDefault();
  const save = document.querySelector("#save");
  save.disabled = true;
  result.textContent = "Checking repository access...";
  try {
    await api("config", Object.fromEntries(new FormData(form)));
    form.elements.token.value = "";
    await refresh();
    result.textContent = "Repository saved. Enter the local bridge details in Magpie.";
  } catch (error) { result.textContent = error.message; }
  finally { save.disabled = false; }
};
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.onclick = async () => {
    const input = document.getElementById(button.dataset.copy);
    try { await navigator.clipboard.writeText(input.value); button.textContent = "Copied"; }
    catch { input.focus(); input.select(); result.textContent = "Press Ctrl+C to copy the selected value."; }
  };
});
refresh().catch((error) => { result.textContent = error.message; });`;
