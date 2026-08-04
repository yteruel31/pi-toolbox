export interface DashboardApp {
	id: string;
	label: string;
	server?: string;
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
	"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

export function renderDashboard(apps: readonly DashboardApp[]): string {
	const count = `${apps.length} active App${apps.length === 1 ? "" : "s"}`;
	const cards = apps.map((app) => `
		<li>
			<a class="group flex min-h-32 items-center justify-between gap-6 rounded-xl border border-pi-border bg-pi-surface p-5 text-pi-text no-underline transition-colors hover:border-pi-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-pi-accent" href="proxy/apps/${app.id}/">
				<span class="min-w-0"><span class="mb-2 block truncate text-base font-semibold">${escapeHtml(app.label)}</span>${app.server === undefined ? "" : `<span class="mb-2 inline-flex rounded-md border border-pi-border px-2 py-1 text-xs font-semibold text-pi-muted">MCP · ${escapeHtml(app.server)}</span>`}<span class="flex items-center gap-2 text-sm text-pi-muted"><span class="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true"></span>Active</span></span>
				<span class="shrink-0 text-sm font-semibold text-pi-accent" aria-hidden="true">Open <span class="transition-transform group-hover:translate-x-1">→</span></span>
			</a>
		</li>`).join("");
	const content = apps.length > 0
		? `<ul class="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2" aria-label="Active Apps">${cards}\n\t</ul>`
		: `<section class="rounded-xl border border-dashed border-pi-border bg-pi-surface p-8 text-center" aria-labelledby="empty-title"><h2 class="m-0 text-base font-semibold" id="empty-title">No active Apps</h2><p class="mb-0 mt-2 text-sm text-pi-muted">Apps will appear here when they are available.</p></section>`;

	return `<!doctype html>
<html lang="en" class="dark">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Pi MCP Apps (${apps.length})</title>
	<link rel="stylesheet" href="proxy/styles.css">
</head>
<body>
	<main class="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-16">
		<header class="mb-8 flex flex-col gap-4 border-b border-pi-border pb-6 sm:flex-row sm:items-end sm:justify-between">
			<div><p class="mb-3 mt-0 text-xs font-semibold uppercase tracking-widest text-pi-accent">Pi / terminal</p><h1 class="m-0 text-2xl font-bold tracking-tight sm:text-3xl">MCP Apps</h1></div>
			<p class="m-0 text-sm text-pi-muted" aria-live="polite">${count}</p>
		</header>
		${content}
	</main>
</body>
</html>`;
}
