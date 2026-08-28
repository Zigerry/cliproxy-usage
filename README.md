# cliproxy-usage

CLIProxyAPI quota and balance display for Pi Coding Agent.

It adds two current-model views:

- a compact widget below the editor;
- an interactive details TUI opened with `/cliproxy-usage`.

```text
Codex quota · 2 accounts
work… │ 7d ━━━━━─ left 85%    personal… │ 7d ━━━━── left 68%
```

```text
╭──────────────── CLIProxyAPI Usage ────────────────╮
│ Codex · work@example.com                          │
│   7d ━━━━━─── left 68% · resets in 2d 4h          │
│                                                   │
│ Codex · personal@example.com                      │
│   7d ━━────── left 23% · resets in 18h            │
│                                                   │
│ r refresh · Enter/Esc close                       │
╰───────────────────────────────────────────────────╯
```

## Features

- Follows Pi's active model and displays only its matching account provider.
- Shows remaining quota, reset countdowns, provider errors, and DeepSeek balances.
- Opens details immediately from the session cache when available.
- Refreshes stale data in the background and updates the TUI in place.
- Supports `r` force refresh and `↑`/`↓` scrolling.
- Keeps cached data visible when a refresh fails.
- Coalesces overlapping automatic and manual refresh requests.
- Stores no quota or balance cache on disk.

Quota bars represent **remaining** capacity:

- 30% or more: green
- below 30%: yellow
- below 10%: red

## Supported providers

| Provider | Model matching | Usage |
|---|---|---|
| Claude | `claude-*` | 7d and 5h quota windows |
| Codex | `gpt-*`, `codex-*` | Account-provided quota windows |
| DeepSeek | `deepseek-*` | Monetary balance from official `api.deepseek.com` entries |
| Grok | `grok-*`, `xai-*` | Weekly billing window |
| Kimi Code | `kimi-*`, `moonshot-*` | 7d subscription and 5h rate-limit windows |

Unsupported model families hide the widget and do not open a usage view.

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- CLIProxyAPI Management API access
- The password accepted by CLIProxyAPI's `management.html`

## Install

Recommended npm installation:

```bash
pi install npm:cliproxy-usage
```

Git installation:

```bash
pi install https://github.com/Zigerry/cliproxy-usage.git
```

Then reload Pi and configure Management API access:

```text
/reload
/cliproxy-usage setup
/cliproxy-usage
```

Enter the same password used by CLIProxyAPI's `management.html`. The password is validated before it is saved.

### Update

```bash
pi update npm:cliproxy-usage
```

Run `/reload` after updating. For a Git installation, use:

```bash
pi update --extension https://github.com/Zigerry/cliproxy-usage.git
```

## Commands

| Command | Description |
|---|---|
| `/cliproxy-usage` | Open interactive details for the active model's provider |
| `/cliproxy-usage setup` | Validate and save the Management API password |
| `/cliproxy-usage login` | Alias for `setup` |
| `/cliproxy-usage logout` | Remove the saved Management API password |
| `/cliproxy-usage settings` | Configure URL, refresh interval, widget account limit, and providers |
| `/cliproxy-usage status` | Show effective configuration and refresh state |

Details controls:

- `r`: force refresh through the existing refresh queue
- `↑` / `↓`, Page Up / Page Down: scroll
- Enter / Esc: close and return to Pi

Outside TUI mode, no interactive view is opened; UI-capable modes fall back to a text notification.

## Configuration

Settings are stored at `<getAgentDir()>/pi-cliproxy-usage.json`, normally:

```text
~/.pi/agent/pi-cliproxy-usage.json
```

```json
{
  "managementUrl": "",
  "managementKey": "",
  "refreshMinutes": 5,
  "maxVisibleAccounts": 4,
  "providers": {
    "claude": true,
    "codex": true,
    "deepseek": true,
    "grok": true,
    "kimi": true
  }
}
```

Use `/cliproxy-usage settings` instead of editing the file manually. Legacy extension settings migrate automatically when the canonical file does not exist.

`managementUrl` is normally empty, which reuses the `baseUrl` from `<getAgentDir()>/cliproxyapi.json` (normally `~/.pi/agent/cliproxyapi.json`). Set an override only when inference and Management API traffic use different addresses. Root URLs, `/v1` URLs, and trailing `/v0/management` paths are normalized automatically.

The management password is stored in the settings file with mode `0600`. Status output never prints it.

## Network and security

The extension uses CLIProxyAPI's Management API to discover accounts and proxy requests to official quota or balance endpoints:

- `/v0/management/auth-files`
- `/v0/management/api-call`
- `/v0/management/openai-compatibility` for DeepSeek

Tokens and provider API keys are not logged or persisted by this extension. Quota requests do not consume LLM input or output tokens.

After a Management API `401` or `403`, automatic retries stop for the rejected password to avoid repeated authentication failures. Run `/cliproxy-usage setup` after correcting it.

## Troubleshooting

### Management password rejected

Run `/cliproxy-usage setup` again. Use the password accepted by `management.html`, not the API key used for model inference.

### Management API returns 404

Verify that the configured URL points to the same CLIProxyAPI instance and exposes `/v0/management/auth-files` and `/v0/management/api-call`.

### DeepSeek balance is missing

Configure DeepSeek under `openai-compatibility` with the exact `api.deepseek.com` hostname. Third-party relay hosts are intentionally ignored.

### Widget is hidden

The active model must match a supported provider and that provider must be enabled in `/cliproxy-usage settings`. Check `/cliproxy-usage status` for the effective mapping and configuration.

### Git installation fails with `spawn git ENOENT`

Install Git and reopen the terminal, or use the npm installation command.

## Development

```bash
npm install
npm test
npm run check
npm pack --dry-run
pi --no-extensions -e ./index.ts
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before making changes.

## Credits and support

Originally created by Villoh and currently maintained by Zigerry.

Report bugs and request features at [Zigerry/cliproxy-usage](https://github.com/Zigerry/cliproxy-usage/issues).
