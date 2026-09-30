Note: Demo and reference code only.

# Browserbase for BB

Using Browserbase with BB, deploy agents that can browse websites, extract page data, and automate web workflows with Browserbase cloud browsers, all from a chat thread.

## Requirements

- BB 0.43 or later with a compatible Plugin SDK.
- Node.js 24 and npm for local development.
- A Browserbase account and API key. Browser sessions use your Browserbase plan.
- Network access to `https://mcp.browserbase.com/mcp`.

## Local installation

From the plugin directory, run:

```sh
npm install
npm run typecheck
npm test
npm run build
bb plugin install .
```

Keep the existing SDK pin when a newer SDK cannot be installed under your npm package-age policy. Before releasing, verify compatibility with the target BB version. `bb plugin types` updates the SDK pin to match the CLI; run it only when that version is available under your installation policy, then install dependencies and repeat validation.

For a published Git tag, BB supports installation directly from this repository with a source such as `git:https://github.com/browserbase/bb-plugin.git@v0.1.0`. The tag must exist before that command will work.

## Configure

Open **Settings → Installed plugins → Browserbase** and set **Browserbase API key**. The setting is secret and read on the server. Start a new BB thread after installation so the agent sees the new tools. Never put the key into source files or commit a credential-bearing URL.

Give your agent this prompt:

> Use Browserbase to open https://browserbase-demo.com/ and select Search. Run the “Stripe trust center SOC 2 certifications” demo, and wait until “Searching the web…” disappears and numbered results appear. Then list the displayed titles and domains of results numbered 1, 2, and 3. If the search fails, report the error instead of listing suggested searches.


## Tools

| Tool | Purpose |
| --- | --- |
| `browserbase_start` | Create or reuse this thread's browser session |
| `browserbase_navigate` | Navigate to an HTTP or HTTPS URL |
| `browserbase_observe` | Find relevant page controls |
| `browserbase_act` | Perform an authorized page action |
| `browserbase_extract` | Extract page text or structured data |
| `browserbase_end` | Close this thread's browser session |

Each BB thread has a separate MCP client and browser session. Calls in one thread are serialized, and the backend forwards the session ID. The bundled skill guides page inspection, verification, and cleanup. The plugin uses Browserbase's hosted MCP service through the MCP SDK.

## Limitations and troubleshooting

- This version returns bounded text; it does not save screenshot or download artifacts. Request a smaller extraction when output is truncated.
- If the API key changes, end the current browser session before starting another.
- A timed-out action may have completed remotely. Inspect the page before retrying a submission.
- Session cleanup is best effort on plugin reload, disable, shutdown, and thread archive or deletion. A force-quit or interrupted session creation can leave a browser running until its service timeout. Check the Browserbase dashboard if cleanup cannot be confirmed.
- If tools are missing, check that the plugin is enabled and start a new thread. Use `bb plugin logs browserbase` for diagnostics.

## Development

`npm run typecheck` checks the backend against the installed SDK declarations. `npm test` exercises thread isolation, input validation, credential redaction, key changes, and cleanup. `npm run build` uses the installed `bb` CLI to generate the backend bundle. `bb plugin dev` rebuilds and reloads an installed local plugin during development.

The repository contains no credentials. Keep `node_modules`, `dist`, local environment files, and scaffold backups out of Git.
Licensed under the MIT License; see LICENSE.

See the [Browserbase MCP documentation](https://docs.browserbase.com/integrations/mcp/setup) and [BB plugin guide](https://github.com/get-bb/bb/tree/main/plugins/bb-guide/skills/bb-plugin-authoring).
