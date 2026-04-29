import type { MemoryHealth } from "../memory/types.ts";
import type { SchedulerHealthSummary } from "../scheduler/health.ts";

export type HealthPayload = {
	status: string;
	uptime: number;
	version: string;
	agent: string;
	avatar_url: string | null;
	public_url?: string;
	role: { id: string; name: string };
	channels: Record<string, boolean>;
	memory: MemoryHealth;
	evolution: { generation: number };
	onboarding?: string;
	peers?: Record<string, { healthy: boolean; latencyMs: number; error?: string }>;
	scheduler?: SchedulerHealthSummary;
};

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function humanUptime(seconds: number): string {
	if (typeof seconds !== "number" || seconds < 0) return "-";
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d >= 1) return `${d}d ${h}h`;
	if (h >= 1) return `${h}h ${m}m`;
	return `${m}m`;
}

function statusVariant(status: string): "success" | "warning" | "error" | "neutral" {
	if (status === "ok") return "success";
	if (status === "degraded") return "warning";
	if (status === "down") return "error";
	return "neutral";
}

function memoryDot(up: boolean, configured: boolean): string {
	if (!configured) return "neutral";
	return up ? "success" : "error";
}

function memoryLabel(up: boolean, configured: boolean): string {
	if (!configured) return "not configured";
	return up ? "up" : "down";
}

function renderChannelChips(channels: Record<string, boolean>): string {
	const entries = Object.entries(channels);
	if (entries.length === 0) {
		return '<p class="phantom-muted phantom-body" style="margin:0;">No channels configured.</p>';
	}
	return entries
		.map(([name, live]) => {
			const cls = live ? "phantom-badge phantom-badge-success" : "phantom-badge";
			const label = live ? "live" : "off";
			const dot = live ? '<span class="phantom-dot phantom-dot-live"></span>' : '<span class="phantom-dot"></span>';
			return `<span class="${cls}">${dot}${escapeHtml(name)}<span class="phantom-chip-sep">/</span>${label}</span>`;
		})
		.join("\n");
}

function renderSchedulerCard(scheduler: SchedulerHealthSummary | undefined): string {
	if (!scheduler) return "";
	const nextLabel = scheduler.nextFireAt ? escapeHtml(scheduler.nextFireAt) : "no scheduled runs";
	const failWarn =
		scheduler.recentFailures > 0
			? `<span class="phantom-badge phantom-badge-warning"><span class="phantom-dot"></span>${scheduler.recentFailures} recent failure${scheduler.recentFailures === 1 ? "" : "s"}</span>`
			: "";
	return `
  <section class="phantom-card" style="margin-bottom:var(--space-6);">
    <div class="phantom-card-head">
      <p class="phantom-eyebrow" style="margin:0;">Scheduler</p>
      ${failWarn}
    </div>
    <div class="phantom-grid-stats" id="scheduler-grid">
      <div class="phantom-stat">
        <p class="phantom-stat-label">Active</p>
        <p class="phantom-stat-value" id="stat-sched-active">${scheduler.active}</p>
        <p class="phantom-stat-trend-flat">of ${scheduler.total} total</p>
      </div>
      <div class="phantom-stat">
        <p class="phantom-stat-label">Paused</p>
        <p class="phantom-stat-value" id="stat-sched-paused">${scheduler.paused}</p>
        <p class="phantom-stat-trend-flat">idle</p>
      </div>
      <div class="phantom-stat">
        <p class="phantom-stat-label">Failed</p>
        <p class="phantom-stat-value" id="stat-sched-failed">${scheduler.failed}</p>
        <p class="phantom-stat-trend-flat">lifetime</p>
      </div>
      <div class="phantom-stat">
        <p class="phantom-stat-label">Next fire</p>
        <p class="phantom-stat-value phantom-mono" id="stat-sched-next" style="font-size:14px;">${nextLabel}</p>
        <p class="phantom-stat-trend-flat">UTC</p>
      </div>
    </div>
  </section>`;
}

function renderPeersCard(peers: HealthPayload["peers"]): string {
	if (!peers || Object.keys(peers).length === 0) return "";
	const rows = Object.entries(peers)
		.map(([name, info]) => {
			const dot = info.healthy ? "success" : "error";
			const label = info.healthy ? "healthy" : "unreachable";
			return `
        <tr>
          <td><span class="phantom-dot phantom-dot-${dot}"></span>&nbsp;${escapeHtml(name)}</td>
          <td>${label}</td>
          <td class="phantom-mono">${info.healthy ? `${info.latencyMs}ms` : "-"}</td>
        </tr>`;
		})
		.join("");
	return `
  <section class="phantom-card" style="margin-bottom:var(--space-6);">
    <p class="phantom-eyebrow" style="margin:0 0 var(--space-4);">Peers</p>
    <table class="phantom-table">
      <thead><tr><th>Name</th><th>Status</th><th>Latency</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

export function renderHealthHtml(payload: HealthPayload): string {
	const agent = escapeHtml(payload.agent);
	const agentTitle = escapeHtml(payload.agent.charAt(0).toUpperCase() + payload.agent.slice(1));
	const variant = statusVariant(payload.status);
	const badgeCls =
		variant === "success"
			? "phantom-badge phantom-badge-success"
			: variant === "warning"
				? "phantom-badge phantom-badge-warning"
				: variant === "error"
					? "phantom-badge phantom-badge-error"
					: "phantom-badge";
	const badgeDot =
		variant === "success" ? '<span class="phantom-dot phantom-dot-live"></span>' : '<span class="phantom-dot"></span>';
	const publicUrl = payload.public_url ? escapeHtml(payload.public_url) : "";
	const evolution = payload.evolution?.generation ?? 0;
	const role = escapeHtml(payload.role?.name ?? payload.role?.id ?? "");

	const qdrantDot = memoryDot(payload.memory.qdrant, payload.memory.configured);
	const ollamaDot = memoryDot(payload.memory.ollama, payload.memory.configured);

	return `<!DOCTYPE html>
<html lang="en" data-theme="phantom-light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${agentTitle} status</title>
<link rel="icon" href="data:,">
<script>(function(){var s=localStorage.getItem('phantom-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.setAttribute('data-theme',s||(d?'phantom-dark':'phantom-light'));})();</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px; --space-12:48px; --space-16:64px;
  --radius-sm:8px; --radius-md:10px; --radius-lg:14px; --radius-pill:9999px;
  --motion-fast:100ms; --motion-base:150ms; --ease-out:cubic-bezier(0.25,0.46,0.45,0.94);
}
[data-theme="phantom-light"] { --color-base-100:#faf9f5; --color-base-200:#ffffff; --color-base-300:#ece9df; --color-base-content:#1c1917; --color-primary:#4850c4; --color-primary-content:#ffffff; --color-success:#16a34a; --color-error:#dc2626; --color-warning:#ca8a04; --color-info:#2563eb; color-scheme:light; }
[data-theme="phantom-dark"] { --color-base-100:#0b0a09; --color-base-200:#161412; --color-base-300:#26211d; --color-base-content:#f7f6f1; --color-primary:#7078e0; --color-primary-content:#0b0a09; --color-success:#4ade80; --color-error:#f87171; --color-warning:#fbbf24; --color-info:#60a5fa; color-scheme:dark; }
html { transition: background-color 150ms ease, color 150ms ease; }
body { background:var(--color-base-100); color:var(--color-base-content); font-family:Inter,system-ui,sans-serif; margin:0; min-height:100vh; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased; font-feature-settings:"ss01","cv11"; }
@keyframes phantom-fade-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
@keyframes phantom-pulse { 0%,100% { opacity:1; } 50% { opacity:0.55; } }
main { animation: phantom-fade-in 300ms var(--ease-out); }

.phantom-page { max-width:1100px; margin:0 auto; padding:var(--space-8) var(--space-8); }
.phantom-nav { display:flex; align-items:center; gap:var(--space-4); padding:var(--space-3) var(--space-8); border-bottom:1px solid var(--color-base-300); position:sticky; top:0; background:color-mix(in oklab, var(--color-base-100) 85%, transparent); backdrop-filter:blur(8px); z-index:10; }
.phantom-nav-brand { display:inline-flex; align-items:center; gap:var(--space-2); font-family:'Instrument Serif',Georgia,serif; font-size:18px; color:var(--color-base-content); text-decoration:none; }
.phantom-nav-logo { display:inline-flex; width:22px; height:22px; border-radius:6px; background:var(--color-primary); align-items:center; justify-content:center; color:var(--color-primary-content); font-family:'Instrument Serif',serif; font-size:14px; }

.phantom-mono { font-family:'JetBrains Mono',ui-monospace,monospace; font-size:12px; font-variant-numeric:tabular-nums; }
.phantom-display { font-family:'Instrument Serif',Georgia,serif; font-size:clamp(36px,4vw,48px); font-weight:400; line-height:1.08; letter-spacing:-0.01em; margin:0 0 var(--space-3); }
.phantom-display em { font-style:italic; font-weight:400; }
.phantom-h2 { font-family:'Instrument Serif',Georgia,serif; font-size:22px; font-weight:500; line-height:1.25; margin:0 0 var(--space-3); }
.phantom-eyebrow { font-family:Inter,sans-serif; font-size:11px; font-weight:600; line-height:1; letter-spacing:0.08em; text-transform:uppercase; color:color-mix(in oklab, var(--color-base-content) 50%, transparent); margin:0 0 var(--space-3); }
.phantom-lead { font-family:Inter,sans-serif; font-size:16px; font-weight:400; line-height:1.6; color:color-mix(in oklab, var(--color-base-content) 72%, transparent); max-width:560px; }
.phantom-body { font-family:Inter,sans-serif; font-size:14px; line-height:1.55; color:var(--color-base-content); }
.phantom-muted { color:color-mix(in oklab, var(--color-base-content) 55%, transparent); }

.phantom-card { background:var(--color-base-200); border:1px solid var(--color-base-300); border-radius:var(--radius-lg); padding:var(--space-5); transition:border-color var(--motion-base) var(--ease-out); }
.phantom-card:hover { border-color:color-mix(in oklab, var(--color-primary) 28%, var(--color-base-300)); }
.phantom-card-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:var(--space-5); flex-wrap:wrap; gap:var(--space-3); }

.phantom-grid-stats { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:var(--space-4); }
@media (max-width:900px) { .phantom-grid-stats { grid-template-columns:repeat(2,1fr); } }
.phantom-grid-memory { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:var(--space-4); }
@media (max-width:700px) { .phantom-grid-memory { grid-template-columns:repeat(1,1fr); } }

.phantom-stat { display:flex; flex-direction:column; gap:var(--space-1); }
.phantom-stat-label { font:600 11px/1 Inter,sans-serif; letter-spacing:0.05em; text-transform:uppercase; color:color-mix(in oklab, var(--color-base-content) 48%, transparent); margin:0; }
.phantom-stat-value { font-family:Inter,sans-serif; font-size:26px; font-weight:500; line-height:1.1; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; color:var(--color-base-content); margin:6px 0 4px; }
.phantom-stat-trend-flat { color:color-mix(in oklab, var(--color-base-content) 50%, transparent); font-size:12px; }

.phantom-badge { display:inline-flex; align-items:center; gap:6px; font-family:Inter,sans-serif; font-size:11px; font-weight:500; line-height:1; padding:4px 9px; border-radius:var(--radius-pill); background:color-mix(in oklab, var(--color-base-content) 8%, transparent); color:color-mix(in oklab, var(--color-base-content) 75%, transparent); }
.phantom-badge-success { background:color-mix(in oklab, var(--color-success) 12%, transparent); color:var(--color-success); }
.phantom-badge-warning { background:color-mix(in oklab, var(--color-warning) 14%, transparent); color:var(--color-warning); }
.phantom-badge-error { background:color-mix(in oklab, var(--color-error) 12%, transparent); color:var(--color-error); }
.phantom-badge-primary { background:color-mix(in oklab, var(--color-primary) 12%, transparent); color:var(--color-primary); }
.phantom-chip-sep { opacity:0.4; margin:0 1px; }

.phantom-dot { width:6px; height:6px; border-radius:50%; display:inline-block; background:color-mix(in oklab, var(--color-base-content) 25%, transparent); }
.phantom-dot-success { background:var(--color-success); }
.phantom-dot-warning { background:var(--color-warning); }
.phantom-dot-error { background:var(--color-error); }
.phantom-dot-neutral { background:color-mix(in oklab, var(--color-base-content) 25%, transparent); }
.phantom-dot-live { background:var(--color-success); box-shadow:0 0 0 3px color-mix(in oklab, var(--color-success) 25%, transparent); animation:phantom-pulse 2s cubic-bezier(0.4,0,0.6,1) infinite; }

.phantom-button { display:inline-flex; align-items:center; justify-content:center; gap:var(--space-2); font-family:Inter,sans-serif; font-size:14px; font-weight:500; padding:11px 18px; border-radius:var(--radius-pill); border:1px solid transparent; background:var(--color-base-content); color:var(--color-base-100); cursor:pointer; text-decoration:none; transition:opacity var(--motion-fast), transform var(--motion-fast); }
.phantom-button:hover { opacity:0.88; }
.phantom-button-ghost { background:transparent; color:var(--color-base-content); border-color:var(--color-base-300); }
.phantom-button-ghost:hover { background:color-mix(in oklab, var(--color-base-content) 5%, transparent); }

.phantom-memory-card { background:var(--color-base-200); border:1px solid var(--color-base-300); border-radius:var(--radius-md); padding:var(--space-4); display:flex; align-items:center; gap:var(--space-3); }
.phantom-memory-card-title { font-family:Inter,sans-serif; font-size:13px; font-weight:600; }
.phantom-memory-card-sub { font-size:12px; color:color-mix(in oklab, var(--color-base-content) 55%, transparent); }

.phantom-chips { display:flex; flex-wrap:wrap; gap:var(--space-2); }

.phantom-table { width:100%; border-collapse:collapse; font-size:13px; }
.phantom-table th { text-align:left; font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:color-mix(in oklab, var(--color-base-content) 55%, transparent); padding:var(--space-2) var(--space-3); border-bottom:1px solid var(--color-base-300); }
.phantom-table td { padding:var(--space-3); border-bottom:1px solid color-mix(in oklab, var(--color-base-300) 60%, transparent); }

.phantom-link-row { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:var(--space-3); }
@media (max-width:700px) { .phantom-link-row { grid-template-columns:repeat(2,1fr); } }
.quick-link { display:flex; align-items:center; gap:var(--space-3); padding:var(--space-3) var(--space-4); border:1px solid var(--color-base-300); border-radius:var(--radius-md); text-decoration:none; color:var(--color-base-content); transition:border-color var(--motion-fast), background-color var(--motion-fast); }
.quick-link:hover { border-color:color-mix(in oklab, var(--color-primary) 30%, var(--color-base-300)); background:color-mix(in oklab, var(--color-primary) 3%, transparent); }
.quick-link-title { font-size:13px; font-weight:500; color:var(--color-base-content); }
.quick-link-desc { font-size:11px; color:color-mix(in oklab, var(--color-base-content) 55%, transparent); font-family:'JetBrains Mono',monospace; }
</style>
</head>
<body>

<nav class="phantom-nav" aria-label="Primary">
  <a href="/ui/" class="phantom-nav-brand">
    <span class="phantom-nav-logo">${escapeHtml(payload.agent.charAt(0).toUpperCase() || "P")}</span>
    <span>${agent}</span>
  </a>
  <span style="color:color-mix(in oklab,var(--color-base-content) 25%, transparent);">/</span>
  <span style="font-size:13px; color:color-mix(in oklab,var(--color-base-content) 60%, transparent);">Health</span>
  <div style="margin-left:auto; display:flex; align-items:center; gap:12px;">
    <span class="phantom-mono phantom-muted" id="refresh-stamp">-</span>
    <button id="theme-toggle" class="phantom-button phantom-button-ghost" style="padding:7px 10px;" aria-label="Toggle theme">
      <svg id="icon-moon" style="width:14px;height:14px;" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/></svg>
      <svg id="icon-sun" style="width:14px;height:14px;display:none;" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/></svg>
    </button>
  </div>
</nav>

<main class="phantom-page">

  <section style="margin:var(--space-10) 0 var(--space-10); max-width:780px;">
    <p class="phantom-eyebrow">Agent status</p>
    <h1 class="phantom-display">${agent} is <em>${escapeHtml(payload.status)}</em>.</h1>
    <p class="phantom-lead">${publicUrl ? `Live at <span class="phantom-mono">${publicUrl}</span>.` : "Running locally."} Auto-refreshing every 10 seconds.</p>
  </section>

  <section class="phantom-card" style="margin-bottom:var(--space-6);">
    <div class="phantom-card-head">
      <p class="phantom-eyebrow" style="margin:0;">Overview</p>
      <span class="${badgeCls}" id="status-badge">
        ${badgeDot}
        <span id="status-label">${escapeHtml(payload.status)}</span>
      </span>
    </div>
    <div class="phantom-grid-stats">
      <div class="phantom-stat">
        <p class="phantom-stat-label">Role</p>
        <p class="phantom-stat-value" id="stat-role" style="font-size:18px;">${role || "-"}</p>
        <p class="phantom-stat-trend-flat">current</p>
      </div>
      <div class="phantom-stat">
        <p class="phantom-stat-label">Uptime</p>
        <p class="phantom-stat-value" id="stat-uptime">${escapeHtml(humanUptime(payload.uptime))}</p>
        <p class="phantom-stat-trend-flat">since boot</p>
      </div>
      <div class="phantom-stat">
        <p class="phantom-stat-label">Version</p>
        <p class="phantom-stat-value phantom-mono" id="stat-version" style="font-size:18px;">${escapeHtml(payload.version)}</p>
        <p class="phantom-stat-trend-flat">stable</p>
      </div>
      <div class="phantom-stat">
        <p class="phantom-stat-label">Evolution</p>
        <p class="phantom-stat-value" id="stat-evolution">
          <span class="phantom-badge phantom-badge-primary">Gen ${evolution}</span>
        </p>
        <p class="phantom-stat-trend-flat">current</p>
      </div>
    </div>
  </section>

  <section class="phantom-card" style="margin-bottom:var(--space-6);">
    <p class="phantom-eyebrow" style="margin:0 0 var(--space-4);">Memory subsystems</p>
    <div class="phantom-grid-memory">
      <div class="phantom-memory-card">
        <span class="phantom-dot phantom-dot-${qdrantDot}" id="mem-qdrant-dot"></span>
        <div>
          <div class="phantom-memory-card-title">Qdrant</div>
          <div class="phantom-memory-card-sub" id="mem-qdrant-label">${memoryLabel(payload.memory.qdrant, payload.memory.configured)}</div>
        </div>
      </div>
      <div class="phantom-memory-card">
        <span class="phantom-dot phantom-dot-${ollamaDot}" id="mem-ollama-dot"></span>
        <div>
          <div class="phantom-memory-card-title">Ollama</div>
          <div class="phantom-memory-card-sub" id="mem-ollama-label">${memoryLabel(payload.memory.ollama, payload.memory.configured)}</div>
        </div>
      </div>
      <div class="phantom-memory-card">
        <span class="phantom-dot phantom-dot-${payload.memory.configured ? "success" : "neutral"}" id="mem-configured-dot"></span>
        <div>
          <div class="phantom-memory-card-title">Configured</div>
          <div class="phantom-memory-card-sub" id="mem-configured-label">${payload.memory.configured ? "yes" : "no"}</div>
        </div>
      </div>
    </div>
  </section>

  <section class="phantom-card" style="margin-bottom:var(--space-6);">
    <p class="phantom-eyebrow" style="margin:0 0 var(--space-4);">Channels</p>
    <div class="phantom-chips" id="channel-chips">
      ${renderChannelChips(payload.channels)}
    </div>
  </section>

  ${renderSchedulerCard(payload.scheduler)}
  ${renderPeersCard(payload.peers)}

  <section style="margin-top:var(--space-10); margin-bottom:var(--space-10);">
    <h2 class="phantom-h2">Quick links</h2>
    <div class="phantom-link-row">
      <a href="/ui/" class="quick-link">
        <div><div class="quick-link-title">Home</div><div class="quick-link-desc">/ui/</div></div>
      </a>
      <a href="/ui/dashboard/" class="quick-link">
        <div><div class="quick-link-title">Dashboard</div><div class="quick-link-desc">/ui/dashboard/</div></div>
      </a>
      <a href="/chat" class="quick-link">
        <div><div class="quick-link-title">Chat</div><div class="quick-link-desc">/chat</div></div>
      </a>
      <a href="/health?format=json" class="quick-link">
        <div><div class="quick-link-title">Raw JSON</div><div class="quick-link-desc">?format=json</div></div>
      </a>
    </div>
  </section>

</main>

<footer style="border-top:1px solid var(--color-base-300); margin-top:var(--space-10);">
  <div class="phantom-page" style="padding:var(--space-4) var(--space-8); display:flex; align-items:center; justify-content:space-between;">
    <span class="phantom-mono phantom-muted" style="font-size:11px;">Served by ${agent}</span>
    <span class="phantom-mono phantom-muted" style="font-size:11px;" id="footer-time">-</span>
  </div>
</footer>

<script>
(function(){
  var toggle=document.getElementById('theme-toggle');
  var sun=document.getElementById('icon-sun'); var moon=document.getElementById('icon-moon');
  function update(){ var d=document.documentElement.getAttribute('data-theme')==='phantom-dark'; sun.style.display=d?'inline':'none'; moon.style.display=d?'none':'inline'; }
  update();
  toggle.addEventListener('click',function(){ var c=document.documentElement.getAttribute('data-theme'); var n=c==='phantom-dark'?'phantom-light':'phantom-dark'; document.documentElement.setAttribute('data-theme',n); localStorage.setItem('phantom-theme',n); update(); });
})();

(function(){
  function humanUptime(seconds){
    if (typeof seconds !== 'number' || seconds < 0) return '-';
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (d >= 1) return d + 'd ' + h + 'h';
    if (h >= 1) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function setText(id, value){ var el = document.getElementById(id); if (el) el.textContent = value; }

  function badgeClass(status){
    if (status === 'ok') return 'phantom-badge phantom-badge-success';
    if (status === 'degraded') return 'phantom-badge phantom-badge-warning';
    if (status === 'down') return 'phantom-badge phantom-badge-error';
    return 'phantom-badge';
  }

  function dotClass(up, configured){
    if (!configured) return 'phantom-dot phantom-dot-neutral';
    return up ? 'phantom-dot phantom-dot-success' : 'phantom-dot phantom-dot-error';
  }

  function memLabel(up, configured){
    if (!configured) return 'not configured';
    return up ? 'up' : 'down';
  }

  function renderChip(name, live){
    var span = document.createElement('span');
    span.className = live ? 'phantom-badge phantom-badge-success' : 'phantom-badge';
    var dot = document.createElement('span');
    dot.className = live ? 'phantom-dot phantom-dot-live' : 'phantom-dot';
    span.appendChild(dot);
    span.appendChild(document.createTextNode(name));
    var sep = document.createElement('span');
    sep.className = 'phantom-chip-sep';
    sep.textContent = '/';
    span.appendChild(sep);
    span.appendChild(document.createTextNode(live ? 'live' : 'off'));
    return span;
  }

  function apply(data){
    if (!data) return;
    var badge = document.getElementById('status-badge');
    if (badge){
      badge.className = badgeClass(data.status);
      var dot = document.createElement('span');
      dot.className = data.status === 'ok' ? 'phantom-dot phantom-dot-live' : 'phantom-dot';
      var label = document.createElement('span');
      label.id = 'status-label';
      label.textContent = data.status || 'unknown';
      badge.innerHTML = '';
      badge.appendChild(dot);
      badge.appendChild(label);
    }
    setText('stat-role', (data.role && (data.role.name || data.role.id)) || '-');
    setText('stat-uptime', humanUptime(data.uptime));
    setText('stat-version', data.version || '-');
    var evEl = document.getElementById('stat-evolution');
    if (evEl){
      var gen = data.evolution && typeof data.evolution.generation === 'number' ? data.evolution.generation : 0;
      evEl.innerHTML = '';
      var pill = document.createElement('span');
      pill.className = 'phantom-badge phantom-badge-primary';
      pill.textContent = 'Gen ' + gen;
      evEl.appendChild(pill);
    }

    var mem = data.memory || { qdrant:false, ollama:false, configured:false };
    var qDot = document.getElementById('mem-qdrant-dot'); if (qDot) qDot.className = dotClass(mem.qdrant, mem.configured);
    var oDot = document.getElementById('mem-ollama-dot'); if (oDot) oDot.className = dotClass(mem.ollama, mem.configured);
    var cDot = document.getElementById('mem-configured-dot'); if (cDot) cDot.className = mem.configured ? 'phantom-dot phantom-dot-success' : 'phantom-dot phantom-dot-neutral';
    setText('mem-qdrant-label', memLabel(mem.qdrant, mem.configured));
    setText('mem-ollama-label', memLabel(mem.ollama, mem.configured));
    setText('mem-configured-label', mem.configured ? 'yes' : 'no');

    var chipsHost = document.getElementById('channel-chips');
    if (chipsHost && data.channels){
      chipsHost.innerHTML = '';
      var names = Object.keys(data.channels);
      if (names.length === 0){
        var p = document.createElement('p');
        p.className = 'phantom-muted phantom-body';
        p.style.margin = '0';
        p.textContent = 'No channels configured.';
        chipsHost.appendChild(p);
      } else {
        names.forEach(function(n){ chipsHost.appendChild(renderChip(n, !!data.channels[n])); });
      }
    }

    if (data.scheduler){
      setText('stat-sched-active', String(data.scheduler.active));
      setText('stat-sched-paused', String(data.scheduler.paused));
      setText('stat-sched-failed', String(data.scheduler.failed));
      setText('stat-sched-next', data.scheduler.nextFireAt || 'no scheduled runs');
    }

    var stamp = new Date().toISOString();
    setText('refresh-stamp', 'updated ' + stamp.split('T')[1].split('.')[0] + 'Z');
    setText('footer-time', stamp);
  }

  function tick(){
    fetch('/health?format=json', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(apply)
      .catch(function(){ /* leave last-good values in place */ });
  }

  setText('footer-time', new Date().toISOString());
  setText('refresh-stamp', 'updated ' + new Date().toISOString().split('T')[1].split('.')[0] + 'Z');
  setInterval(tick, 10000);
})();
</script>
</body>
</html>`;
}
