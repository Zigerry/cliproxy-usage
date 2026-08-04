# pi-cliproxy-usage

CLIProxyAPI OAuth account quota widget for Pi Coding Agent.

The widget follows Pi's active model and shows only matching account quotas:

```text
Codex │ user │ 7d ━━━━━━── left 69%
Kimi  │ user │ 7d ━━━━──── left 50% │ 5h ━━━━━━━━ left 95%
```

Multiple matching accounts use a responsive grid. Wide terminals show three columns, medium terminals show two, and narrow terminals fall back to one. The provider appears once as a compact group heading, long account labels are truncated, and bar width adapts to the column count:

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
- Grok (`type: "xai"`): 7d unified billing window
- Kimi Code (`type: "kimi"`): 7d subscription and 5h rate-limit windows

The active model id selects the account type shown by the widget:

- `gpt-*` or `codex-*` → Codex
- `kimi-*` or `moonshot-*` → Kimi
- `claude-*` → Claude
- `grok-*` or `xai-*` → Grok

Other model families hide the widget because there is no matching OAuth quota source.

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) with at least one supported OAuth account configured

## Install

From this repository:

```bash
pi install https://github.com/Zigerry/pi-cliproxyapi-oauth-usage.git
```

Or install a local development checkout:

```bash
pi install /absolute/path/to/pi-cliproxyapi-oauth-usage
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
  "accountsDir": "~/.cli-proxy-api",
  "refreshMinutes": 5,
  "maxVisibleAccounts": 4,
  "providers": {
    "claude": true,
    "codex": true,
    "grok": true,
    "kimi": true
  }
}
```

Credentials stay local and are sent only to official provider quota endpoints. Token refresh remains CLIProxyAPI's responsibility; the extension rereads account files on every refresh so it uses tokens written back by CLIProxyAPI.

The widget prioritizes errors, then accounts with the least remaining quota, and shows an overflow row when more accounts exist. Invalid setting values are ignored with a warning. Unknown fields are preserved when saving.

## Commands

- `/cliproxy-usage` — refresh and show quota for the current model
- `/cliproxy-usage settings` — interactively edit settings and provider toggles
- `/cliproxy-usage status` — show effective settings and settings path
- `/cliproxy-usage help` — show command help
- `/cliproxy-usage config` — compatibility alias for `settings`

If a provider returns `401` or `403`, let CLIProxyAPI refresh the account or log in again.

## Development

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

## Support

Report bugs and request features at [Zigerry/pi-cliproxyapi-oauth-usage](https://github.com/Zigerry/pi-cliproxyapi-oauth-usage/issues).
