# cliproxy-usage

CLIProxyAPI account quota and balance widget for Pi Coding Agent.

The widget follows Pi's active model and shows only matching account usage:

```text
Codex   │ user │ 7d ━━━━━━── left 69%
Kimi    │ user │ 7d ━━━━──── left 50% │ 5h ━━━━━━━━ left 95%
DeepSeek │ ¥42.50
```

Multiple matching accounts use a content-aware compact layout. Cards keep their natural width and are packed left-to-right with a fixed gap, up to three per row. The renderer prioritizes fewer rows, then uses the longest progress bar that still fits. Codex cards often fit three per row because they only contain `7d`; wider Kimi cards naturally fit fewer. The provider appears once as a compact group heading and long account labels are truncated:

```text
Codex quota · 3 accounts
work-a… │ 7d ━━━━━─ left 85%    work-b… │ 7d ━━━━── left 68%
work-c… │ 7d ━━━━━━ left 96%
```

Quota windows always use the same order: **7d first, 5h second**. A window is omitted when the provider does not return it. In particular, Codex accounts that expose only a 7-day window no longer show it as a session window.

Bars and percentages represent quota **remaining**:

- 30% or more: green
- below 30%: yellow
- below 10%: red

## Supported accounts

- Claude (`type: "claude"`): 7d and 5h windows
- Codex (`type: "codex"`): 7d and/or 5h windows returned by the account plan
- DeepSeek (`openai-compatibility` with `api.deepseek.com`): monetary account balance
- Grok (`type: "xai"`): 7d unified billing window
- Kimi Code (`type: "kimi"`): 7d subscription and 5h rate-limit windows

The active model id selects the account type shown by the widget:

- `gpt-*` or `codex-*` → Codex
- `kimi-*` or `moonshot-*` → Kimi
- `claude-*` → Claude
- `deepseek-*` → DeepSeek
- `grok-*` or `xai-*` → Grok

Other model families hide the widget because there is no matching quota or balance source.

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) with at least one supported OAuth account or official provider API key configured
- CLIProxyAPI Management API with `/auth-files` and `/api-call` support
- The password used by CLIProxyAPI's `management.html`

## Install

From npm:

```bash
pi install npm:cliproxy-usage
```

Or directly from this repository:

```bash
pi install https://github.com/Zigerry/cliproxy-usage.git
```

For a local development checkout:

```bash
pi install /absolute/path/to/cliproxy-usage
```

After installing or updating, run `/reload` in Pi.

To test only the local extension while an older npm package is still installed:

```bash
pi --no-extensions -e ./index.ts
```

## Settings

User file: `<getAgentDir()>/pi-cliproxy-usage.json`, normally:

```text
~/.pi/agent/pi-cliproxy-usage.json
```

Missing files use defaults. Changes from the interactive settings UI apply immediately. Older `~/.pi/agent/extensions/pi-cliproxy-usage/config.json` files migrate automatically when the canonical file does not exist.

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

### Management setup

Run the interactive setup command after installation:

```text
/cliproxy-usage setup
```

The extension reads `<getAgentDir()>/cliproxyapi.json` and reuses its `baseUrl`. It then displays a masked password prompt for the password used by CLIProxyAPI's `management.html`, validates it against `/v0/management/auth-files`, and saves it only after validation succeeds.

The password is stored as `managementKey` in `pi-cliproxy-usage.json`. This file is written with mode `0600`; `/cliproxy-usage status` only reports whether the key is configured and never prints it. CLIProxyAPI stores its own `remote-management.secret-key` as a bcrypt hash, so the original password cannot be recovered from the server's YAML config.

`managementUrl` is normally empty. Set it through `/cliproxy-usage settings` only when the management endpoint differs from the provider base URL, for example when using a private SSH tunnel while inference uses a public address. Enter the CLIProxyAPI root URL; a trailing `/v0/management` is accepted and normalized.

CLIProxyAPI requires a valid management key even for localhost. Direct LAN or public access also requires remote management to be enabled on the server. Use HTTPS, a VPN, or an SSH tunnel for untrusted networks because the management key can access privileged Management API operations.

The extension uses only the Management API as its account source. It lists accounts through `/v0/management/auth-files`, then asks the remote server to call official quota/balance endpoints through `/v0/management/api-call`. OAuth access tokens and provider API keys stay on the CLIProxyAPI server. These quota HTTP requests do **not** consume LLM input/output tokens. With the default settings, one account-list request plus one quota request per supported account runs every five minutes.

After a `401` or `403`, automatic retries stop for the rejected password to avoid CLIProxyAPI's temporary ban after repeated authentication failures. Run `/cliproxy-usage setup` again after changing the password.

The widget prioritizes errors, then accounts with the least remaining quota or balance, and shows an overflow row when more accounts exist. Invalid setting values are ignored with a warning. Unknown fields are preserved when saving. Retired local-file fields are removed the next time settings are saved.

## Commands

- `/cliproxy-usage` — refresh and show quota for the current model
- `/cliproxy-usage setup` — enter, validate, and save the Management API password
- `/cliproxy-usage logout` — remove the saved Management API password
- `/cliproxy-usage settings` — edit the management URL override, refresh interval, and provider toggles
- `/cliproxy-usage status` — show effective URLs and whether management access is configured

If an upstream provider quota request returns `401` or `403`, let CLIProxyAPI refresh the account or log in again.

## Development

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

The published npm package is intentionally minimal. Its allowlist includes only
`index.ts`, `src/`, and `README.md`; npm also includes `package.json` and
`LICENSE`. Tests, assets, repository instructions, and local configuration are
not published.

## Support

Report bugs and request features at [Zigerry/cliproxy-usage](https://github.com/Zigerry/cliproxy-usage/issues).
