import { escapeHtml } from "./security.js";

export function hostHtml(label: string, allow: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(label)}</title></head><body><iframe id="app" hidden title="${escapeHtml(label)}" referrerpolicy="no-referrer" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"${allow ? ` allow="${escapeHtml(allow)}"` : ""}></iframe><script type="module" src="./bridge.js"></script></body></html>`;
}

export function hostScript(): string {
	return `import { AppBridge, PostMessageTransport } from './app-bridge.js';
const frame = document.querySelector('#app');
const post = (path, value = {}, signal) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal });
const bridge = new AppBridge(null, { name: 'Pi', version: '0.1.0' }, {
  serverTools: {}, openLinks: {}, logging: {}, updateModelContext: {}, message: {}
}, { hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } });
let approved = false;
let initialized = false;
let pendingInput;
let pendingResult;
const flush = () => {
  if (!initialized) return;
  if (pendingInput !== undefined) { bridge.sendToolInput(pendingInput); pendingInput = undefined; }
  if (pendingResult !== undefined) { bridge.sendToolResult(pendingResult); pendingResult = undefined; }
};
bridge.oninitialized = () => { initialized = true; frame.hidden = false; flush(); };
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
bridge.onsizechange = size => { frame.style.width = size.width + 'px'; frame.style.height = size.height + 'px'; };
bridge.onloggingmessage = params => console.debug('[MCP App]', params);
bridge.oncreatesamplingmessage = async () => { throw new Error('Sampling is not supported'); };
bridge.ondownloadfile = async () => ({ isError: true });
bridge.onlistresources = async () => ({ resources: [] });
bridge.onlistresourcetemplates = async () => ({ resourceTemplates: [] });
bridge.onreadresource = async () => { throw new Error('Resource reads are not supported'); };
const events = new EventSource('./events');
events.addEventListener('input', event => { pendingInput = JSON.parse(event.data); flush(); });
events.addEventListener('result', event => { pendingResult = JSON.parse(event.data); flush(); });
events.addEventListener('cancelled', () => teardown(false));
events.addEventListener('complete', () => teardown(false));
let done = false;
async function teardown(notify) { if (done) return; done = true; events.close(); clearInterval(heartbeat); if (notify) await post('./complete').catch(() => {}); await bridge.teardownResource({}).catch(() => {}); await transport.close(); }
const heartbeat = setInterval(() => void post('./heartbeat'), 15000);
const transport = new PostMessageTransport(frame.contentWindow, frame.contentWindow);
await bridge.connect(transport);
frame.src = './view';
addEventListener('pagehide', () => void teardown(true), { once: true });`;
}
