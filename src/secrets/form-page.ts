import { escapeHtml } from "../shared/strings.ts";
import type { SecretField, SecretRequest } from "./store.ts";

/**
 * Generates the secret collection form HTML. Matches login-page.ts quality:
 * same DaisyUI themes, Inter font, animations, card patterns, error/success states.
 * Server-rendered from stored request data - the agent defines WHAT to collect,
 * TypeScript decides HOW to render it.
 */
export function secretsFormHtml(request: SecretRequest): string {
	const fieldsHtml = request.fields.map((field) => buildFieldCard(field)).join("\n");
	const escapedPurpose = escapeHtml(request.purpose.toLowerCase());

	return `<!DOCTYPE html>
<html lang="en" data-theme="phantom-light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secure Credentials - Phantom</title>
<script>
  (function() {
    var stored = localStorage.getItem('phantom-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored || (prefersDark ? 'phantom-dark' : 'phantom-light');
    document.documentElement.setAttribute('data-theme', theme);
  })();
<\/script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"><\/script>
<style type="text/tailwindcss">
  @theme {
    --color-phantom: #0891b2;
    --color-phantom-bright: #22d3ee;
    --color-phantom-dim: #0e7490;
    --font-family-sans: 'Inter', system-ui, -apple-system, sans-serif;
  }
  [data-theme="phantom-light"] {
    --color-base-100: #fafaf9; --color-base-200: #ffffff; --color-base-300: #e7e5e4;
    --color-base-content: #1c1917; --color-primary: #0891b2; --color-primary-content: #ffffff;
    --color-secondary: #57534e; --color-secondary-content: #ffffff;
    --color-accent: #0891b2; --color-accent-content: #ffffff;
    --color-neutral: #f5f5f4; --color-neutral-content: #57534e;
    --color-info: #2563eb; --color-info-content: #ffffff;
    --color-success: #16a34a; --color-success-content: #ffffff;
    --color-warning: #ca8a04; --color-warning-content: #ffffff;
    --color-error: #dc2626; --color-error-content: #ffffff;
    --radius-box: 0.75rem; --radius-field: 0.625rem; --radius-selector: 0.5rem;
    --border: 1px; --depth: 1; --noise: 0; color-scheme: light;
  }
  [data-theme="phantom-dark"] {
    --color-base-100: #0c0a09; --color-base-200: #1c1917; --color-base-300: #292524;
    --color-base-content: #fafaf9; --color-primary: #22d3ee; --color-primary-content: #0c0a09;
    --color-secondary: #a8a29e; --color-secondary-content: #0c0a09;
    --color-accent: #22d3ee; --color-accent-content: #0c0a09;
    --color-neutral: #1c1917; --color-neutral-content: #a8a29e;
    --color-info: #60a5fa; --color-info-content: #0c0a09;
    --color-success: #4ade80; --color-success-content: #0c0a09;
    --color-warning: #fbbf24; --color-warning-content: #0c0a09;
    --color-error: #f87171; --color-error-content: #0c0a09;
    --radius-box: 0.75rem; --radius-field: 0.625rem; --radius-selector: 0.5rem;
    --border: 1px; --depth: 1; --noise: 0; color-scheme: dark;
  }
  html { transition: background-color 0.2s ease, color 0.2s ease; }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .form-animate { animation: fadeUp 0.4s ease-out; }
  .btn-spinner {
    display: inline-block; width: 16px; height: 16px;
    border: 2px solid currentColor; border-right-color: transparent;
    border-radius: 50%; animation: spin 0.6s linear infinite;
    margin-right: 8px; vertical-align: middle; opacity: 0.6;
  }
</style>
</head>
<body class="bg-base-100 text-base-content font-sans min-h-screen flex flex-col items-center justify-center px-6 py-12">

  <button id="theme-toggle" class="fixed top-4 right-4 btn btn-ghost btn-sm btn-square z-50" aria-label="Toggle theme">
    <svg id="icon-sun" class="w-4 h-4 hidden" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
    </svg>
    <svg id="icon-moon" class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
    </svg>
  </button>

  <div class="w-full max-w-lg form-animate">
    <div class="flex flex-col items-center mb-8">
      <div class="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
        <svg class="w-6 h-6 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
        </svg>
      </div>
      <h1 class="text-xl font-semibold tracking-tight mb-1">Secure Credential Entry</h1>
      <p class="text-sm text-base-content/50 text-center leading-relaxed max-w-sm">
        Phantom needs these credentials to ${escapedPurpose}.
        Your data is encrypted and stored securely on this server only.
      </p>
    </div>

    <form id="secrets-form" data-request-id="${escapeAttr(request.requestId)}" autocomplete="off">
${fieldsHtml}

      <div class="flex items-start gap-3 p-4 rounded-xl bg-base-200 border border-base-300 mb-6">
        <svg class="w-4 h-4 text-primary flex-shrink-0 mt-0.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
        <p class="text-xs text-base-content/50 leading-relaxed">
          Encrypted with AES-256-GCM. Stored on this agent's server only.
          Never sent to Anthropic, logged, or shared with third parties.
        </p>
      </div>

      <button type="submit" id="save-btn" class="btn btn-primary w-full text-sm font-medium">
        Save Credentials
      </button>

      <div id="error-msg" class="hidden mt-4">
        <div class="flex items-center gap-2 p-3 rounded-xl bg-error/10 border border-error/20">
          <svg class="w-4 h-4 text-error flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
          <span id="error-text" class="text-xs text-error"></span>
        </div>
      </div>
    </form>

    <div id="success-msg" class="hidden mt-6">
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-8 text-center">
          <div class="flex justify-center mb-4">
            <div class="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center">
              <svg class="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            </div>
          </div>
          <h2 class="text-lg font-semibold mb-2">Credentials Saved</h2>
          <p class="text-sm text-base-content/50">
            Your credentials are encrypted and stored securely.
            You can close this tab and return to Slack.
          </p>
        </div>
      </div>
    </div>

    <p class="text-center text-xs text-base-content/30 mt-6">Phantom - AI that works alongside you</p>
  </div>

  <script>
    (function() {
      var toggle = document.getElementById('theme-toggle');
      var sun = document.getElementById('icon-sun');
      var moon = document.getElementById('icon-moon');
      function updateIcons() {
        var theme = document.documentElement.getAttribute('data-theme');
        var isDark = theme === 'phantom-dark';
        sun.classList.toggle('hidden', !isDark);
        moon.classList.toggle('hidden', isDark);
      }
      updateIcons();
      toggle.addEventListener('click', function() {
        var current = document.documentElement.getAttribute('data-theme');
        var next = current === 'phantom-dark' ? 'phantom-light' : 'phantom-dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('phantom-theme', next);
        updateIcons();
      });
    })();

    (function() {
      function toggleVisibility(fieldId, btn) {
        var input = document.getElementById(fieldId);
        if (!input) return;
        var isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.querySelector('.icon-eye').classList.toggle('hidden', !isPassword);
        btn.querySelector('.icon-eye-off').classList.toggle('hidden', isPassword);
      }

      document.querySelectorAll('.toggle-vis-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var fieldId = this.getAttribute('data-field');
          toggleVisibility(fieldId, this);
        });
      });

      var firstInput = document.querySelector('#secrets-form input');
      if (firstInput) firstInput.focus();

      document.getElementById('secrets-form').addEventListener('submit', function(e) {
        e.preventDefault();
        var btn = document.getElementById('save-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="btn-spinner"><\\/span>Saving...';

        var formData = {};
        var inputs = this.querySelectorAll('input[name]');
        inputs.forEach(function(input) {
          if (input.value.trim()) formData[input.name] = input.value.trim();
        });

        var requestId = document.getElementById('secrets-form').getAttribute('data-request-id');
        fetch('/ui/api/secrets/' + requestId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secrets: formData }),
          credentials: 'same-origin'
        }).then(function(res) {
          if (res.ok) {
            document.getElementById('secrets-form').classList.add('hidden');
            document.getElementById('success-msg').classList.remove('hidden');
          } else {
            return res.json().then(function(data) {
              document.getElementById('error-text').textContent = data.error || 'Failed to save. Please try again.';
              document.getElementById('error-msg').classList.remove('hidden');
              btn.disabled = false;
              btn.innerHTML = 'Save Credentials';
            });
          }
        }).catch(function() {
          document.getElementById('error-text').textContent = 'Unable to connect. Check your network and try again.';
          document.getElementById('error-msg').classList.remove('hidden');
          btn.disabled = false;
          btn.innerHTML = 'Save Credentials';
        });
      });
    })();
  <\/script>
</body>
</html>`;
}

export function secretsExpiredHtml(): string {
	return `<!DOCTYPE html>
<html lang="en" data-theme="phantom-light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link Expired - Phantom</title>
<script>
  (function() {
    var stored = localStorage.getItem('phantom-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', stored || (prefersDark ? 'phantom-dark' : 'phantom-light'));
  })();
<\/script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"><\/script>
<style type="text/tailwindcss">
  @theme { --font-family-sans: 'Inter', system-ui, sans-serif; }
  [data-theme="phantom-light"] { --color-base-100: #fafaf9; --color-base-200: #ffffff; --color-base-300: #e7e5e4; --color-base-content: #1c1917; --color-primary: #0891b2; color-scheme: light; }
  [data-theme="phantom-dark"] { --color-base-100: #0c0a09; --color-base-200: #1c1917; --color-base-300: #292524; --color-base-content: #fafaf9; --color-primary: #22d3ee; color-scheme: dark; }
</style>
</head>
<body class="bg-base-100 text-base-content font-sans min-h-screen flex items-center justify-center px-6">
  <div class="card bg-base-200 border border-base-300 max-w-sm w-full">
    <div class="card-body p-8 text-center">
      <svg class="w-10 h-10 text-base-content/30 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
      <h2 class="text-lg font-semibold mb-2">Link Expired</h2>
      <p class="text-sm text-base-content/50">This link has expired. Ask your Phantom agent to generate a new one.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildFieldCard(field: SecretField): string {
	const isPassword = field.type === "password";
	const fieldId = `field-${escapeAttr(field.name)}`;
	const requiredMark = field.required ? '<span class="text-error ml-1">*</span>' : "";
	const descHtml = field.description
		? `<p class="text-xs text-base-content/50 mb-3 leading-relaxed">${escapeHtml(field.description)}</p>`
		: "";
	const placeholderAttr = field.placeholder ? ` placeholder="${escapeAttr(field.placeholder)}"` : "";
	const valueAttr = field.default ? ` value="${escapeAttr(field.default)}"` : "";
	const requiredAttr = field.required ? " required" : "";

	const eyeToggle = isPassword
		? `<button type="button" class="toggle-vis-btn absolute right-3 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs btn-square" data-field="${fieldId}" aria-label="Toggle visibility">
            <svg class="icon-eye w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
            <svg class="icon-eye-off w-4 h-4 hidden" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
          </button>`
		: "";

	return `      <div class="card bg-base-200 border border-base-300 mb-4">
        <div class="card-body p-5">
          <label class="text-sm font-medium mb-1 block" for="${fieldId}">
            ${escapeHtml(field.label)}${requiredMark}
          </label>
          ${descHtml}<div class="relative">
            <input
              class="input input-bordered w-full bg-base-100 border-base-300 focus:border-primary focus:outline-none text-sm font-mono${isPassword ? " pr-10" : ""}"
              id="${fieldId}"
              name="${escapeAttr(field.name)}"
              type="${field.type}"${placeholderAttr}${valueAttr}${requiredAttr}
              autocomplete="off"
              spellcheck="false"
            />${eyeToggle}
          </div>
        </div>
      </div>`;
}

const escapeAttr = escapeHtml;
