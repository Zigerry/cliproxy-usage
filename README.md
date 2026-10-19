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
- Keeps cached data visible when a refresh fails, with explicit cached/stale/error annotations.
- Tracks each account's last valid data separately from refresh attempts and complete provider refreshes.
- Distinguishes unknown data, empty account discovery, loading, partial failure, and missing setup.
- Coalesces overlapping automatic and manual refresh requests.
- Isolates fallback data by Management source and stable account identity, not display names.
- Cancels obsolete work after logout, configuration changes, provider disablement, or session shutdown.
- Stores no quota or balance cache on disk.
- Preserves complete quota/balance fields on narrow terminals and follows Pi's active theme.
- Can hide only the persistent widget while keeping cached details and refresh policy available.

Quota bars represent **remaining** capacity:

- 30% or more: theme `success` (usually green)
- below 30%: theme `warning` (usually yellow)
- below 10%: theme `error` (usually red)

## Supported providers

| Provider | Model matching | Usage |
|---|---|---|
| Claude | `claude-*` | 7d and 5h quota windows |
| Codex | `gpt-*`, `codex-*` | Account-provided quota windows |
| DeepSeek | `deepseek-*` | Monetary balance from official `api.deepseek.com` entries |
| Grok | `grok-*`, `xai-*` | Weekly billing window |
| Kimi Code | `kimi-*`, `moonshot-*` | 7d subscription and 5h rate-limit windows |

Quota window labels use explicit provider metadata, never the distance to reset. An unknown duration uses a neutral limit label; a missing quota number stays unknown rather than showing 100% remaining. Valid reset timestamps are still shown as countdowns.

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
| `/cliproxy-usage settings` | Configure widget visibility, URL, refresh interval, account limit, and providers |
| `/cliproxy-usage status` | Show configuration and the shared cache/freshness state without provider requests |

Details controls:

- `r`: force refresh through the existing queue; bypass local backoff, but not a server's `Retry-After` wait
- `↑` / `↓`, Page Up / Page Down: scroll
- Enter / Esc: close and return to Pi

Outside TUI mode, no interactive view is opened; UI-capable modes fall back to a text notification.

### Cache freshness

Widget, details, and status use the same account-level snapshot. Failed reads can show the last valid value marked `cached`/`stale`; a successful response without usable values shows `unknown`, never the old number or an assumed 100% remaining. A genuine zero quota or zero balance stays visible.

Data becomes stale when it reaches the configured refresh age, a reported reset is due, or a refresh failure applies. Local expiry only redraws the display: it neither queries the provider nor replenishes quota. Bar colors still represent remaining quota, not freshness.

Details keep status/errors visible while scrolling and show data age and last actual query-attempt round. `Last refresh` in status means the last **complete** success; partial success only advances the successful accounts' data times. Old details close on provider/source/login/session invalidation rather than freezing on old accounts. Usage data and timestamps remain session-only.

## Refresh limits and backoff

All refresh triggers share one eligibility check. Temporary network/timeout/429/5xx failures delay automatic retries: the delay starts at `refreshMinutes`, doubles once per failed round, and caps at the larger of the configured interval or 60 minutes. Partial success does not erase a same-round failure; a clean completed round clears the corresponding local backoff, even if quota data remains unknown.

Valid `Retry-After` seconds or HTTP dates on failed responses impose a separate server wait, without the local cap. Management waits cover every provider on that source; a provider account's wait conservatively covers that provider. Management 429 without a valid future deadline uses source-level **local** backoff. Once a Management 429, authentication rejection or server wait is known, unstarted work in that round is skipped, not counted as another failure. Already-started concurrent requests may finish.

`r` can bypass local backoff, never an explicit server wait. Details/status distinguish **earliest automatic request**, **earliest manual request**, and **next automatic check**. A check can occur before eligibility and do no HTTP; no timestamp promises a request. With no active automatic schedule/configuration/model, no automatic check is advertised. No extra retry scheduler is started.

These facts are session-only. Changing source/credentials or resetting the session clears them. Switching models or disabling/re-enabling a provider cannot remove an unexpired server wait. Management authentication rejection pauses automatic requests; a provider's 401 does not mean the Management key was rejected.

## Display

At narrow widths, names and bars give way before complete quota percentages or balance amounts. Windows/currencies may move to separate rows; an unrepresentable field shows an omission marker instead of a misleading numeric prefix. Shortened or duplicate account names use `#N` to distinguish entries, not to identify which account routed a model request. Details remain scrollable with pinned state/error indicators. Provider names and quota colors use the active Pi theme, without fixed brand colors.

Set **Widget visibility** to disabled in `/cliproxy-usage settings`, or set `showWidget` to `false`, to hide the below-editor widget. This does not disable providers, clear cache/cooldowns, close details, change the periodic refresh anchor or start a refresh. Background policy and `/cliproxy-usage`/`r` continue to follow the same eligibility rules. Enabling it paints the current cache immediately. The default for existing and new configurations is `true`.

## Configuration

Settings are stored at `<getAgentDir()>/pi-cliproxy-usage.json`, normally:

```text
~/.pi/agent/pi-cliproxy-usage.json
```

```json
{
  "managementUrl": "",
  "managementKey": "",
  "showWidget": true,
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

Enable **Widget visibility** in `/cliproxy-usage settings` if you want the persistent display. The active model must also match a supported and enabled provider. `/cliproxy-usage status` reports visibility, mapping and configuration; details remain available when only the widget is hidden.

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
