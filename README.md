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
- DeepSeek (`openai-compatibility` with the exact `api.deepseek.com` host): monetary account balance discovered through the Management API
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
- CLIProxyAPI Management API with `/auth-files` and `/api-call` support; DeepSeek also requires `/openai-compatibility`
- The password used by CLIProxyAPI's `management.html`

## Install

From npm (recommended; does not require Git):

```bash
pi install npm:cliproxy-usage
```

Or directly from this repository:

```bash
pi install https://github.com/Zigerry/cliproxy-usage.git
```

Git sources require a working `git` executable. On Windows, `spawn git ENOENT` means Git for Windows is not installed or is not available in `PATH`; use the npm package or install Git and reopen the terminal.

For a local development checkout:

```bash
pi install /absolute/path/to/cliproxy-usage
```

### Quick start

After installation, start or reload Pi and configure Management API access:

```text
/reload
/cliproxy-usage setup
/cliproxy-usage status
```

Enter the same password used by CLIProxyAPI's `management.html`. The setup command validates the password before saving it.

### Update

Update only this npm package:

```bash
pi update npm:cliproxy-usage
```

Update a GitHub installation:

```bash
pi update --extension https://github.com/Zigerry/cliproxy-usage.git
```

Or update all installed Pi packages:

```bash
pi update --extensions
```

Run `/reload` after updating. Git installations without an explicit tag follow the repository's default branch; installations pinned to a tag remain on that tag.

#### Upgrading from 0.3.x to 0.4

Version 0.4 replaces local CLIProxyAPI credential-file reads with the Management API. Existing display and provider settings migrate automatically, but quota refresh requires one interactive setup after upgrading:

```text
/cliproxy-usage setup
```

The setup reuses the provider's existing Base URL and asks for the password accepted by CLIProxyAPI's `management.html`.

To test only the local extension while an older installed package is still present:

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

CLIProxyAPI requires a valid management key even for localhost. Direct LAN or public access also requires remote management to be enabled on the server. The extension preserves the configured Management URL protocol and does not rewrite or warn about HTTP versus HTTPS.

The extension uses only the Management API as its account source. It lists OAuth accounts through `/v0/management/auth-files`. DeepSeek entries are discovered through `/v0/management/openai-compatibility` by requiring the exact `api.deepseek.com` hostname and retaining only each entry's `auth-index`; returned API key fields are never logged, persisted, or forwarded by the extension. The server then calls official quota/balance endpoints through `/v0/management/api-call`. These quota HTTP requests do **not** consume LLM input/output tokens. With the default settings, account discovery plus one quota request per supported account runs every five minutes.

After a `401` or `403`, automatic retries stop for the rejected password to avoid CLIProxyAPI's temporary ban after repeated authentication failures. Run `/cliproxy-usage setup` again after changing the password.

The widget prioritizes errors, then accounts with the least remaining quota or balance, and shows an overflow row when more accounts exist. Invalid setting values are ignored with a warning. Unknown fields are preserved when saving. Retired local-file fields are removed the next time settings are saved.

## Commands

- `/cliproxy-usage` — refresh and show quota for the current model
- `/cliproxy-usage setup` — enter, validate, and save the Management API password
- `/cliproxy-usage logout` — remove the saved Management API password
- `/cliproxy-usage settings` — edit the management URL override, refresh interval, and provider toggles
- `/cliproxy-usage status` — show effective URLs and whether management access is configured

If an upstream provider quota request returns `401` or `403`, let CLIProxyAPI refresh the account or log in again.

## Troubleshooting

### Management password rejected

Run `/cliproxy-usage setup` again. The password is the one accepted by CLIProxyAPI's `management.html`, not the ordinary API key used for model inference.

### Management API returns 404

Check that the configured root URL reaches the same CLIProxyAPI instance and that its Management API exposes `/v0/management/auth-files` and `/v0/management/api-call`.

### DeepSeek balance is missing

DeepSeek must be configured under `openai-compatibility` with a base URL whose hostname is exactly `api.deepseek.com`. The extension discovers its `auth-index` through `/v0/management/openai-compatibility`; arbitrary provider names are supported. Third-party relay URLs are intentionally ignored.

### The widget is hidden after switching models

The widget is scoped to the active model family. Run `/cliproxy-usage status`, then `/cliproxy-usage` for a detailed refresh result. Unsupported model families intentionally hide the widget.

### Git installation fails with `spawn git ENOENT`

Install Git for Windows and reopen PowerShell, or install from npm instead:

```powershell
pi install npm:cliproxy-usage
```

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
