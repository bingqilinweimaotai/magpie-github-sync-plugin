const translations = {
  en: {
    title: "Magpie / GitHub sync", eyebrow: "MAGPIE / COMMUNITY PLUGIN",
    headline: "Your setup.<br>Across computers.",
    summary: "Keep a sealed Magpie backup in your GitHub repository. Magpie handles encryption, merging and recovery.",
    localBridge: "Local bridge", repositoryHeading: "01 — Bind a repository",
    repository: "Repository", branch: "Branch", folder: "Folder", token: "GitHub token",
    branchPlaceholder: "Default branch", folderPlaceholder: "Optional", tokenPlaceholder: "Contents: read and write",
    tokenSavedPlaceholder: "Saved; leave empty to keep it for this repository",
    repositoryHint: "Use an existing repository. The first backup initializes an empty default branch. Other branches must already exist. Your token stays on this computer. The plugin does not ask for your encryption passphrase.",
    save: "Save repository", connectionHeading: "02 — Connect Magpie",
    connectionIntro: "In <strong>Settings → Sync → WebDAV</strong>, enter these local bridge details. Then set the same encryption passphrase on every computer.",
    address: "Address", username: "User name", password: "Local password", copy: "Copy", copied: "Copied",
    passwordHint: "The local password is generated for this computer. It is neither your GitHub token nor your encryption passphrase.",
    actions: "Use <strong>Sync now</strong> for ongoing changes, <strong>Restore</strong> to recover setup on a new computer, and <strong>Undo</strong> to recover the setup replaced by a restore.",
    otherComputerHint: "On another computer, install this plugin and bind the same repository, branch and folder. Its local password may differ. Keep Magpie running with the plugin enabled.",
    footer: "Only encrypted backup and usage files leave Magpie.", healthReady: "Bridge ready", healthErrorPrefix: "Last sync: ",
    checking: "Checking repository access...", saved: "Repository saved. Enter the local bridge details in Magpie.",
    manualCopy: "Press Ctrl+C to copy the selected value.", errorPrefix: "Error: ",
  },
  zh: {
    title: "Magpie / GitHub 同步", eyebrow: "MAGPIE / 社区插件",
    headline: "配置随行。<br>多端同步。",
    summary: "将加密的 Magpie 备份保存到 GitHub 仓库。加密、合并与恢复由 Magpie 处理。",
    localBridge: "本地桥接", repositoryHeading: "01 — 绑定仓库",
    repository: "仓库", branch: "分支", folder: "文件夹", token: "GitHub 令牌",
    branchPlaceholder: "默认分支", folderPlaceholder: "可选", tokenPlaceholder: "Contents（内容）：读写权限",
    tokenSavedPlaceholder: "已保存；留空可继续使用此仓库的令牌",
    repositoryHint: "请使用已有仓库。首次备份会初始化空仓库的默认分支，其他分支必须已经存在。令牌仅保存在这台电脑上，插件不会要求提供加密口令。",
    save: "保存仓库", connectionHeading: "02 — 连接 Magpie",
    connectionIntro: "在 <strong>设置 → 同步 → WebDAV</strong> 中填写以下本地桥接信息，然后在每台电脑上设置相同的加密口令。",
    address: "地址", username: "用户名", password: "本地密码", copy: "复制", copied: "已复制",
    passwordHint: "本地密码由这台电脑生成，与 GitHub 令牌和加密口令均不同。",
    actions: "使用 <strong>立即同步</strong> 同步日常改动，使用 <strong>恢复</strong> 在新电脑上恢复配置，使用 <strong>撤销</strong> 找回恢复前的本地配置。",
    otherComputerHint: "在另一台电脑上安装此插件，并绑定相同的仓库、分支和文件夹。本地密码可以不同。请保持 Magpie 运行并启用插件。",
    footer: "仅加密的备份和用量文件会传出 Magpie。", healthReady: "桥接服务已就绪", healthErrorPrefix: "最近同步：",
    checking: "正在检查仓库访问权限……", saved: "仓库已保存。请在 Magpie 中填写本地桥接信息。",
    manualCopy: "请按 Ctrl+C 复制已选中的内容。", errorPrefix: "错误：",
  },
};

const errorsZh = {
  "Repository must be owner/repo.": "仓库格式应为 owner/repo（所有者/仓库名）。",
  "Branch contains invalid characters.": "分支名称包含无效字符。",
  "Folder must be a relative path without empty, . or .. components.": "文件夹应为相对路径，不能包含空目录、. 或 ..。",
  "Enter a GitHub token for this repository.": "请输入此仓库的 GitHub 令牌。",
  "Reopen the setup page.": "请重新打开配置页面。",
  "Invalid JSON. Existing configuration was kept.": "JSON 格式无效，原有配置已保留。",
  "Repository has no default branch.": "仓库没有默认分支。",
  "Empty repository: leave Branch empty or select its default branch.": "仓库为空：请将分支留空，或选择其默认分支。",
  "GitHub redirected the request. Check the current repository name.": "GitHub 重定向了请求，请检查仓库当前的名称。",
  "GitHub rate limited sync; try again later.": "GitHub 限制了同步请求，请稍后重试。",
  "File changed on another computer.": "文件已被另一台电脑修改。",
  "Backup changed on another computer; sync again.": "备份已被另一台电脑修改，请重新同步。",
  "Usage changed on another computer; pending uploads were kept.": "用量文件已被另一台电脑修改，待上传记录已保留。",
  "GitHub branch kept changing; pending usage uploads were kept.": "GitHub 分支持续发生变化，待上传的用量记录已保留。",
  "Pending usage uploads are unreadable or belong to another repository. Restore their configuration before syncing.": "待上传的用量记录无法读取，或属于其他仓库，请恢复对应配置后再同步。",
  "A pending encrypted usage file is unreadable. Its upload record was kept.": "待上传的加密用量文件无法读取，上传记录已保留。",
  "Failed to fetch": "无法连接本地桥接服务，请确认 Magpie 正在运行且插件已启用。",
};

const text = (key) => `<span data-i18n="${key}">${translations.en[key]}</span>`;
export const html = (csrf) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf" content="${csrf}"><title>Magpie / GitHub sync</title><link rel="stylesheet" href="/style.css">
<script src="/ui.js" defer></script></head><body><main>
<header><div class="topbar"><span class="eyebrow" data-i18n="eyebrow">${translations.en.eyebrow}</span>
<nav class="language-switch" aria-label="Language / 语言">
<button type="button" data-language="zh" lang="zh-CN" aria-pressed="false">中文</button>
<button type="button" data-language="en" lang="en" aria-pressed="true">English</button></nav></div>
<h1 data-i18n-html="headline">${translations.en.headline}</h1>
<p data-i18n="summary">${translations.en.summary}</p>
<div class="flow"><span>Magpie</span><b>&rarr;</b><span data-i18n="localBridge">${translations.en.localBridge}</span><b>&rarr;</b><span>GitHub</span></div></header>
<section><h2 data-i18n="repositoryHeading">${translations.en.repositoryHeading}</h2><form id="config">
<label>${text("repository")}<input name="repository" placeholder="owner/repo" required autocomplete="off"></label>
<div class="pair"><label>${text("branch")}<input name="branch" data-i18n-placeholder="branchPlaceholder" placeholder="${translations.en.branchPlaceholder}" autocomplete="off"></label>
<label>${text("folder")}<input name="folder" data-i18n-placeholder="folderPlaceholder" placeholder="${translations.en.folderPlaceholder}" autocomplete="off"></label></div>
<label>${text("token")}<input name="token" type="password" autocomplete="new-password" placeholder="${translations.en.tokenPlaceholder}"></label>
<p class="hint" data-i18n="repositoryHint">${translations.en.repositoryHint}</p>
<button type="submit" id="save" data-i18n="save">${translations.en.save}</button><p id="result" role="status" aria-live="polite"></p></form></section>
<section id="binding" hidden><h2 data-i18n="connectionHeading">${translations.en.connectionHeading}</h2>
<p data-i18n-html="connectionIntro">${translations.en.connectionIntro}</p>
<div class="credential"><label>${text("address")}<input id="address" readonly></label><button data-copy="address" data-i18n="copy" type="button">${translations.en.copy}</button></div>
<div class="credential"><label>${text("username")}<input id="username" readonly></label><button data-copy="username" data-i18n="copy" type="button">${translations.en.copy}</button></div>
<div class="credential"><label>${text("password")}<input id="password" type="password" readonly></label><button data-copy="password" data-i18n="copy" type="button">${translations.en.copy}</button></div>
<p class="hint" data-i18n="passwordHint">${translations.en.passwordHint}</p>
<p data-i18n-html="actions">${translations.en.actions}</p>
<p class="hint" data-i18n="otherComputerHint">${translations.en.otherComputerHint}</p></section>
<footer><span data-i18n="footer">${translations.en.footer}</span><span id="health" role="status"></span></footer>
</main></body></html>`;

export const css = `
:root{color-scheme:light;--ink:#24332d;--muted:#64736b;--line:#d6ded5;--paper:#fbfcf7;--accent:#9d492c}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 8% 8%,#e5edde 0,transparent 48%),linear-gradient(125deg,#f4f5e9,#f9eee4);color:var(--ink);font:16px/1.6 Georgia,serif}
main{max-width:820px;margin:0 auto;padding:52px 28px}header{padding:0 12px 28px}.eyebrow,button,.hint,input,footer,.flow{font-family:"Cascadia Code","Microsoft YaHei","Courier New",monospace}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.language-switch{display:flex;gap:4px;padding:3px;border:1px solid var(--line);border-radius:7px;background:#ffffff80}.language-switch button{border:0;background:transparent;padding:6px 11px;min-height:34px}.language-switch button[aria-pressed="true"]{background:var(--ink);color:white}button:focus-visible{outline:2px solid #9d492c;outline-offset:3px}html[lang="zh-CN"] .eyebrow{letter-spacing:1px}
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
const translations = ${JSON.stringify(translations)};
const errorsZh = ${JSON.stringify(errorsZh)};
const form = document.querySelector("#config");
const result = document.querySelector("#result");
const csrf = document.querySelector('meta[name="csrf"]').content;
const languageKey = "magpie-github-sync.language";
let language = /^zh/i.test(navigator.languages?.[0] || navigator.language || "en") ? "zh" : "en";
try {
  const saved = localStorage.getItem(languageKey);
  if (saved === "zh" || saved === "en") language = saved;
} catch { /* Language switching also works when browser storage is unavailable. */ }
let state;
let message = {};
const t = (key) => translations[language][key];
function errorText(raw) { return language === "zh" ? errorsZh[raw] || raw : raw; }
function renderStatus() {
  form.elements.token.placeholder = t(state?.tokenSet ? "tokenSavedPlaceholder" : "tokenPlaceholder");
  document.querySelector("#health").textContent = state ? (state.lastError ? t("healthErrorPrefix") + errorText(state.lastError) : t("healthReady")) : "";
  result.textContent = message.error ? t("errorPrefix") + errorText(message.error) : message.key ? t(message.key) : "";
}
function setMessage(key) { message = { key }; renderStatus(); }
function setError(error) { message = { error: error.message }; renderStatus(); }
function applyLanguage() {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = t("title");
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.copied === "true" ? "copied" : element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((element) => {
    // Only the fixed translation strings contain markup; API errors use textContent.
    element.innerHTML = t(element.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-language]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.language === language));
  });
  renderStatus();
}
document.querySelectorAll("[data-language]").forEach((button) => {
  button.onclick = () => {
    language = button.dataset.language;
    try { localStorage.setItem(languageKey, language); } catch { /* Keep the selection for this page. */ }
    applyLanguage();
  };
});
applyLanguage();
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
  state = await api("status");
  for (const name of ["repository", "branch", "folder"]) form.elements[name].value = state[name];
  form.elements.token.required = !state.tokenSet;
  document.querySelector("#binding").hidden = !state.url;
  document.querySelector("#address").value = state.url;
  document.querySelector("#username").value = state.user;
  document.querySelector("#password").value = state.password;
  renderStatus();
}
form.onsubmit = async (event) => {
  event.preventDefault();
  const save = document.querySelector("#save");
  save.disabled = true;
  setMessage("checking");
  try {
    await api("config", Object.fromEntries(new FormData(form)));
    form.elements.token.value = "";
    await refresh();
    setMessage("saved");
  } catch (error) { setError(error); }
  finally { save.disabled = false; }
};
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.onclick = async () => {
    const input = document.getElementById(button.dataset.copy);
    try { await navigator.clipboard.writeText(input.value); button.dataset.copied = "true"; button.textContent = t("copied"); }
    catch { input.focus(); input.select(); setMessage("manualCopy"); }
  };
});
refresh().catch(setError);`;
