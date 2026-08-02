import { escapeHtml } from "./security.js";

export function hostHtml(label: string, allow: string): string {
	const safeLabel = escapeHtml(label);
	return `<!doctype html><html class="h-full bg-pi-bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeLabel}</title><link rel="stylesheet" href="../../styles.css"></head><body class="h-dvh min-h-screen overflow-hidden bg-pi-bg text-pi-text antialiased"><main class="flex h-full min-h-0 flex-col"><header class="flex shrink-0 items-center gap-3 border-b border-pi-border bg-pi-surface px-3 py-2 sm:px-4"><a class="shrink-0 text-xs font-semibold tracking-wide text-pi-accent no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pi-accent" href="../../../" aria-label="Back to Pi Apps">Pi / terminal</a><span class="text-pi-muted" aria-hidden="true">/</span><h1 class="min-w-0 flex-1 truncate text-sm font-medium text-pi-text">${safeLabel}</h1><p id="connection-status" class="shrink-0 text-xs text-pi-muted" role="status" aria-live="polite" data-state="connecting">Connecting</p></header><section id="loading" class="flex min-h-0 flex-1 items-center justify-center bg-pi-bg px-6 text-center" aria-label="Loading App"><div><p class="text-sm font-medium text-pi-text">Loading App</p><p class="mt-2 text-xs text-pi-muted">Establishing a secure connection…</p></div></section><iframe id="app" class="min-h-0 w-full flex-1 border-0 bg-pi-bg" hidden title="${safeLabel}" referrerpolicy="no-referrer" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"${allow ? ` allow="${escapeHtml(allow)}"` : ""}></iframe></main><script type="module" src="./bridge.js"></script></body></html>`;
}

export function hostScript(): string {
	return `import { AppBridge, PostMessageTransport } from './app-bridge.js';
const frame = document.querySelector('#app');
const loading = document.querySelector('#loading');
const status = document.querySelector('#connection-status');
const setStatus = (state, label) => { status.dataset.state = state; status.textContent = label; };
const post = (path, value = {}, signal) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal });
const bridge = new AppBridge(null, { name: 'Pi', version: '0.1.0' }, {
  serverTools: {}, openLinks: {}, logging: {}, updateModelContext: {}, message: {}
}, { hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } });
let approved = false;
let initialized = false;
let pendingInput;
let pendingResult;
const flush = () => {
  if (!initialized) return;
  if (pendingInput !== undefined) { bridge.sendToolInput(pendingInput); pendingInput = undefined; }
  if (pendingResult !== undefined) { bridge.sendToolResult(pendingResult); pendingResult = undefined; }
};
bridge.oninitialized = () => { initialized = true; frame.hidden = false; loading.remove(); setStatus('connected', 'Connected'); flush(); };
bridge.oncalltool = async ({ name, arguments: args = {} }, extra) => {
  if (!approved && !window.confirm('Allow this App to call tools on its MCP server?')) return { isError: true, content: [{ type: 'text', text: 'Tool call denied by user.' }] };
  approved = true;
  const response = await post('./tool-call', { name, arguments: args }, extra.signal);
  if (!response.ok) return { isError: true, content: [{ type: 'text', text: 'Tool call failed.' }] };
  return response.json();
};
bridge.onmessage = async params => { const response = await post('./message', params); return response.ok ? {} : { isError: true }; };
bridge.onupdatemodelcontext = async params => { await post('./context', params); return {}; };
bridge.onrequestdisplaymode = async ({ mode }) => { if (!['inline', 'fullscreen'].includes(mode)) return { mode: 'inline' }; await post('./display-mode', { mode }); return { mode }; };
bridge.onopenlink = async ({ url }) => { const response = await post('./open-link', { url }); if (response.ok) window.open(url, '_blank', 'noopener,noreferrer'); return { accepted: response.ok }; };
bridge.onrequestteardown = () => void teardown(true);
bridge.onsizechange = () => {};
bridge.onloggingmessage = params => console.debug('[MCP App]', params);
bridge.oncreatesamplingmessage = async () => { throw new Error('Sampling is not supported'); };
bridge.ondownloadfile = async () => ({ isError: true });
bridge.onlistresources = async () => ({ resources: [] });
bridge.onlistresourcetemplates = async () => ({ resourceTemplates: [] });
bridge.onreadresource = async () => { throw new Error('Resource reads are not supported'); };
const events = new EventSource('./events');
events.addEventListener('open', () => { if (!done && initialized) setStatus('connected', 'Connected'); });
events.addEventListener('error', () => { if (!done) setStatus('reconnecting', 'Reconnecting'); });
events.addEventListener('input', event => { pendingInput = JSON.parse(event.data); flush(); });
events.addEventListener('result', event => { pendingResult = JSON.parse(event.data); flush(); });
events.addEventListener('cancelled', () => teardown(false));
events.addEventListener('complete', () => teardown(false));
let done = false;
async function teardown(notify) { if (done) return; done = true; setStatus('ended', 'Ended'); events.close(); clearInterval(heartbeat); if (notify) await post('./complete').catch(() => {}); await bridge.teardownResource({}).catch(() => {}); await transport.close(); }
const heartbeat = setInterval(() => void post('./heartbeat'), 15000);
const transport = new PostMessageTransport(frame.contentWindow, frame.contentWindow);
setStatus('connecting', 'Connecting');
await bridge.connect(transport);
frame.src = './view';
addEventListener('pagehide', () => void teardown(true), { once: true });`;
}
