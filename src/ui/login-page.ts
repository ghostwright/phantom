// WHY: the login page is the highest-taste surface in the deployed UI after
// the landing page. It uses the phantom-* design tokens, Instrument Serif
// for the welcome display, and a quiet warm-cream / warm-deep-dark theme
// pair that matches public/_base.html. The agent name is threaded in via a
// module-level setter wired from src/index.ts at startup so this file stays
// callable from src/ui/serve.ts with no signature change.

import { escapeHtml } from "./html.ts";
import { agentNameInitial, capitalizeAgentName } from "./name.ts";

let configuredAgentName = "Phantom";

export function setLoginPageAgentName(name: string): void {
	configuredAgentName = name;
}

export function loginPageHtml(): string {
	const displayName = capitalizeAgentName(configuredAgentName);
	const safeName = escapeHtml(displayName);
	const safeInitial = escapeHtml(agentNameInitial(displayName));
	return `<!DOCTYPE html>
<html lang="en" data-theme="phantom-light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in - ${safeName}</title>
<link rel="icon" href="data:,">
<script>
(function(){var s=localStorage.getItem('phantom-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.setAttribute('data-theme',s||(d?'phantom-dark':'phantom-light'));})();
<\/script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
:root {
  --space-2:8px; --space-3:12px; --space-4:16px; --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px;
  --radius-sm:8px; --radius-md:10px; --radius-lg:14px; --radius-pill:9999px;
  --motion-fast:100ms; --motion-base:150ms; --ease-out:cubic-bezier(0.25,0.46,0.45,0.94);
}
[data-theme="phantom-light"] { --color-base-100:#faf9f5; --color-base-200:#ffffff; --color-base-300:#ece9df; --color-base-content:#1c1917; --color-primary:#4850c4; --color-primary-content:#ffffff; --color-success:#16a34a; --color-error:#dc2626; color-scheme:light; }
[data-theme="phantom-dark"] { --color-base-100:#0b0a09; --color-base-200:#161412; --color-base-300:#26211d; --color-base-content:#f7f6f1; --color-primary:#7078e0; --color-primary-content:#0b0a09; --color-success:#4ade80; --color-error:#f87171; color-scheme:dark; }
html { transition: background-color 150ms ease, color 150ms ease; }
body { background:var(--color-base-100); color:var(--color-base-content); font-family:Inter,system-ui,sans-serif; margin:0; min-height:100vh; display:flex; flex-direction:column; -webkit-font-smoothing:antialiased; font-variant-numeric:tabular-nums; }
@keyframes fadeUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
@keyframes spin { to { transform:rotate(360deg); } }

.top-bar { display:flex; align-items:center; justify-content:space-between; padding:var(--space-5) var(--space-8); }
.brand { display:inline-flex; align-items:center; gap:var(--space-2); font-family:'Instrument Serif',Georgia,serif; font-size:20px; font-weight:400; color:var(--color-base-content); text-decoration:none; }
.brand-logo { width:24px; height:24px; border-radius:6px; background:var(--color-primary); display:inline-flex; align-items:center; justify-content:center; color:var(--color-primary-content); font-family:'Instrument Serif',serif; font-size:14px; }
.top-action { display:inline-flex; align-items:center; gap:8px; padding:9px 16px; border:1px solid var(--color-base-300); border-radius:var(--radius-pill); font-size:13px; font-weight:500; color:var(--color-base-content); background:transparent; cursor:pointer; transition:background-color 150ms, border-color 150ms; }
.top-action:hover { background:color-mix(in oklab, var(--color-base-content) 5%, transparent); }

.login-main { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:var(--space-10) var(--space-6); }
.login-shell { width:100%; max-width:420px; animation: fadeUp 0.4s var(--ease-out); }
.login-display { font-family:'Instrument Serif',Georgia,serif; font-size:48px; font-weight:400; line-height:1.08; text-align:center; letter-spacing:-0.01em; color:var(--color-base-content); margin:0 0 12px; }
.login-display em { font-style:italic; }
.login-subtitle { text-align:center; font-size:15px; line-height:1.55; color:color-mix(in oklab, var(--color-base-content) 68%, transparent); margin:0 auto var(--space-8); max-width:340px; }

.form-row { margin-bottom:18px; }
.field-label { display:block; font-size:12px; font-weight:500; color:color-mix(in oklab, var(--color-base-content) 72%, transparent); margin-bottom:6px; }
.field-input { width:100%; box-sizing:border-box; font-family:Inter,sans-serif; font-size:14px; line-height:1.4; background:var(--color-base-200); color:var(--color-base-content); border:1px solid var(--color-base-300); border-radius:var(--radius-md); padding:12px 14px; transition:border-color 150ms, box-shadow 150ms; }
.field-input::placeholder { color:color-mix(in oklab, var(--color-base-content) 38%, transparent); }
.field-input:focus { outline:none; border-color:var(--color-primary); box-shadow:0 0 0 3px color-mix(in oklab, var(--color-primary) 18%, transparent); }

.primary-button { display:inline-flex; width:100%; align-items:center; justify-content:center; gap:8px; font-family:Inter,sans-serif; font-size:14px; font-weight:500; line-height:1; padding:13px 18px; border-radius:var(--radius-pill); border:1px solid transparent; background:var(--color-base-content); color:var(--color-base-100); cursor:pointer; text-decoration:none; transition:opacity 100ms, transform 100ms; }
.primary-button:hover { opacity:0.88; }
.primary-button:active { transform:translateY(1px); }
.primary-button:disabled { opacity:0.5; cursor:not-allowed; }
.btn-spinner { display:inline-block; width:14px; height:14px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:spin 0.6s linear infinite; }

.divider { display:flex; align-items:center; gap:12px; margin:24px 0; }
.divider-line { flex:1; height:1px; background:var(--color-base-300); }
.divider-text { font-size:11px; font-weight:500; letter-spacing:0.08em; text-transform:uppercase; color:color-mix(in oklab, var(--color-base-content) 45%, transparent); }

.helper { text-align:center; font-size:13px; line-height:1.55; color:color-mix(in oklab, var(--color-base-content) 58%, transparent); max-width:340px; margin:0 auto; }

.alert-error { margin-top:16px; display:none; align-items:flex-start; gap:10px; padding:10px 12px; border:1px solid color-mix(in oklab, var(--color-error) 40%, var(--color-base-300)); border-radius:var(--radius-md); background:color-mix(in oklab, var(--color-error) 6%, transparent); font-size:12px; color:var(--color-error); }
.alert-error.visible { display:flex; }

.alert-success { margin-top:16px; display:none; align-items:flex-start; gap:10px; padding:10px 12px; border:1px solid color-mix(in oklab, var(--color-success) 40%, var(--color-base-300)); border-radius:var(--radius-md); background:color-mix(in oklab, var(--color-success) 6%, transparent); font-size:12px; color:var(--color-success); }
.alert-success.visible { display:flex; }

.footer-strip { padding:var(--space-6) var(--space-8); border-top:1px solid var(--color-base-300); display:flex; align-items:center; justify-content:space-between; font-size:11px; color:color-mix(in oklab, var(--color-base-content) 50%, transparent); font-family:'JetBrains Mono',monospace; }
</style>
</head>
<body>

<div class="top-bar">
  <a href="/ui/" class="brand">
    <span class="brand-logo">${safeInitial}</span>
    <span>${safeName}</span>
  </a>
  <button id="theme-toggle" class="top-action" aria-label="Toggle theme">
    <svg id="icon-moon" style="width:14px;height:14px;" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/></svg>
    <svg id="icon-sun" style="width:14px;height:14px;display:none;" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/></svg>
    <span>Theme</span>
  </button>
</div>

<main class="login-main">
  <div class="login-shell">

    <h1 class="login-display">Welcome <em>back</em>.</h1>
    <p class="login-subtitle">Sign in with the access token ${safeName} sent you, or paste a magic link.</p>

    <form id="login-form" autocomplete="off">

      <div class="form-row">
        <label class="field-label" for="token">Access token</label>
        <input class="field-input" id="token" name="token" type="text" placeholder="Paste your token here" autocomplete="off" spellcheck="false">
      </div>

      <button type="submit" id="submit-btn" class="primary-button">Continue</button>

      <div id="error-msg" class="alert-error">
        <svg style="width:14px;height:14px;flex-shrink:0;margin-top:1px;" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"/></svg>
        <span id="error-text">Invalid token. Please try again.</span>
      </div>

      <div id="success-msg" class="alert-success">
        <svg style="width:14px;height:14px;flex-shrink:0;margin-top:1px;" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
        <span>Authenticated. Redirecting...</span>
      </div>

    </form>

    <div class="divider">
      <div class="divider-line"></div>
      <span class="divider-text">Or</span>
      <div class="divider-line"></div>
    </div>

    <form id="email-form" autocomplete="off">
      <div class="form-row">
        <label class="field-label" for="email">Email me a login link</label>
        <input class="field-input" id="email" name="email" type="email" placeholder="Your email address" autocomplete="email" spellcheck="false">
      </div>
      <button type="submit" id="email-btn" class="primary-button" style="background:transparent;color:var(--color-base-content);border:1px solid var(--color-base-300);">Send link</button>
      <div id="email-success" class="alert-success">
        <svg style="width:14px;height:14px;flex-shrink:0;margin-top:1px;" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
        <span>If that email matches, a login link is on its way.</span>
      </div>
    </form>

    <p class="helper" style="margin-top:24px;">Ask ${safeName} in Slack for a magic link, or use the email form above.<br>Links are valid for 10 minutes. Sessions last 7 days.</p>

  </div>
</main>

<div class="footer-strip">
  <span>${safeName} - AI that works alongside you</span>
  <span>cookie auth</span>
</div>

<script>
(function(){
  var toggle=document.getElementById('theme-toggle');
  var sun=document.getElementById('icon-sun'); var moon=document.getElementById('icon-moon');
  function update(){ var d=document.documentElement.getAttribute('data-theme')==='phantom-dark'; sun.style.display=d?'inline':'none'; moon.style.display=d?'none':'inline'; }
  update();
  toggle.addEventListener('click',function(){ var c=document.documentElement.getAttribute('data-theme'); var n=c==='phantom-dark'?'phantom-light':'phantom-dark'; document.documentElement.setAttribute('data-theme',n); localStorage.setItem('phantom-theme',n); update(); });
})();
(function(){
  var params=new URLSearchParams(location.search);
  var magic=params.get('magic');
  function showError(text){ document.getElementById('error-text').textContent=text; document.getElementById('error-msg').classList.add('visible'); document.getElementById('success-msg').classList.remove('visible'); }
  function showSuccess(){ document.getElementById('success-msg').classList.add('visible'); document.getElementById('error-msg').classList.remove('visible'); }
  var redirect=params.get('redirect')||'/ui/';
  if(redirect&&(!/^\\//.test(redirect)||/^\\/\\//.test(redirect))){redirect='/ui/';}
  function authenticate(token){
    var btn=document.getElementById('submit-btn');
    btn.disabled=true;
    btn.innerHTML='<span class="btn-spinner"><\\/span> Signing in...';
    fetch('/ui/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token}),credentials:'same-origin'}).then(function(res){
      if(res.ok){ showSuccess(); setTimeout(function(){ location.href=redirect; },600); }
      else { return res.json().then(function(d){ showError(d.error||'Invalid token. Please try again.'); btn.disabled=false; btn.innerHTML='Continue'; }); }
    }).catch(function(){ showError('Unable to connect. Check your network and try again.'); btn.disabled=false; btn.innerHTML='Continue'; });
  }
  if(magic){ authenticate(magic); return; }
  document.getElementById('login-form').addEventListener('submit',function(e){ e.preventDefault(); var t=document.getElementById('token').value.trim(); if(!t){ showError('Please enter an access token.'); return; } authenticate(t); });
  document.getElementById('email-form').addEventListener('submit',function(e){
    e.preventDefault();
    var emailInput=document.getElementById('email').value.trim();
    if(!emailInput){return;}
    var emailBtn=document.getElementById('email-btn');
    emailBtn.disabled=true;
    emailBtn.innerHTML='<span class="btn-spinner"><\\/span> Sending...';
    fetch('/login/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:emailInput}),credentials:'same-origin'}).then(function(){
      document.getElementById('email-success').classList.add('visible');
      emailBtn.disabled=false;
      emailBtn.innerHTML='Send link';
    }).catch(function(){
      emailBtn.disabled=false;
      emailBtn.innerHTML='Send link';
    });
  });
})();
<\/script>
</body>
</html>`;
}
