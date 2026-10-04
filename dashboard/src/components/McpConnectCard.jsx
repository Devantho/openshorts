import { useState, useCallback } from 'react';
import { Plug, Copy, Check } from 'lucide-react';
import { getApiUrl } from '../config';

// "Connect an agent": how to drive this panel from Claude Code, Claude
// Desktop, Cursor or n8n through the built-in MCP server. The panel is
// password-protected, so agents authenticate with the APP_API_TOKEN set in
// the server's .env (Authorization: Bearer ...).

const TOKEN = 'YOUR_APP_API_TOKEN';

function mcpUrl() {
  const u = getApiUrl('/mcp');
  if (u.startsWith('http')) return u;
  try { return `${window.location.origin}/mcp`; } catch { return 'http://localhost:8000/mcp'; }
}

function buildClients(url) {
  return [
    {
      id: 'claude-code', label: 'Claude Code', lang: 'bash',
      snippet: `claude mcp add --transport http bomshort ${url} \\\n  --header "Authorization: Bearer ${TOKEN}"`,
    },
    {
      id: 'claude-desktop', label: 'Claude Desktop', lang: 'json',
      snippet: `{\n  "mcpServers": {\n    "bomshort": {\n      "command": "npx",\n      "args": ["-y", "mcp-remote", "${url}", "--header", "Authorization: Bearer ${TOKEN}"]\n    }\n  }\n}`,
      note: 'Settings → Developer → Edit config (claude_desktop_config.json), then restart Claude.',
    },
    {
      id: 'cursor', label: 'Cursor', lang: 'json',
      snippet: `{\n  "mcpServers": {\n    "bomshort": {\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${TOKEN}" }\n    }\n  }\n}`,
    },
    {
      id: 'n8n', label: 'n8n', lang: 'text',
      snippet: `MCP Client Tool node\nEndpoint: ${url}\nTransport: HTTP Streamable\nAuthentication: Bearer ${TOKEN}`,
    },
    {
      id: 'curl', label: 'curl', lang: 'bash',
      snippet: `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${TOKEN}" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    },
  ];
}

export default function McpConnectCard() {
  const clients = buildClients(mcpUrl());
  const [active, setActive] = useState(clients[0].id);
  const [copied, setCopied] = useState(false);
  const current = clients.find((c) => c.id === active) || clients[0];

  const copy = useCallback(() => {
    navigator.clipboard?.writeText(current.snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  }, [current]);

  return (
    <div className="card p-6" id="connect-agent">
      <h3 className="font-display lowercase text-lg text-ink mb-1 flex items-center gap-2">
        <Plug size={16} className="text-brass" /> Connect an agent (MCP)
      </h3>
      <p className="text-muted text-sm mb-4">
        Let an agent clip and publish for you through the built-in MCP server. Set <code>APP_API_TOKEN</code> in
        the server's <code>.env</code> and use it in place of <code>{TOKEN}</code>.
      </p>

      <div className="flex flex-wrap gap-1.5 mb-4" role="tablist" aria-label="client">
        {clients.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={c.id === active}
            onClick={() => { setActive(c.id); setCopied(false); }}
            className={`px-3 py-1.5 rounded-input text-xs border transition-colors ${
              c.id === active ? 'border-brass text-ink bg-brass/10' : 'border-rule text-muted hover:text-ink'}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <pre className="font-mono text-ink2 whitespace-pre-wrap break-all rounded-card border border-rule bg-paper p-3 pr-20 text-xs leading-relaxed">
          {current.snippet}
        </pre>
        <button onClick={copy} className="btn-ghost absolute top-2 right-2 px-2.5 py-1 text-xs" aria-label="copy">
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {current.note && <p className="text-muted text-xs mt-2">{current.note}</p>}
    </div>
  );
}
