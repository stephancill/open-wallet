open-wallet is a tiny “open wallet request” page.

It reads a JSON-RPC request from the URL, shows it to the user, lets them connect their wallet, switches to the requested chain, and executes the request.

## Deployed

- `https://tx.steer.fun`

## URL Format

Required query params:

- `method`: JSON-RPC method (e.g. `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, `wallet_sendCalls`)
- `chainId`: integer chain id (the app will attempt to switch chains before executing)
- `params`: URL-encoded JSON (either an object or an array)

Optional:

- `redirect_url`: redirect target after execution

### redirect_url templating (no bridge)

If `redirect_url` contains `{{...}}`, the app will treat it as a template and replace placeholders instead of appending `result=...` query params.

Placeholders:

- `{{result}}`: URL-encoded result string (or URL-encoded `JSON.stringify(result)`)
- `{{result_raw}}`: unencoded result string (or `JSON.stringify(result)`)
- `{{resultType}}`: `string` or `json`
- `{{error}}`: URL-encoded error message
- `{{error_raw}}`: unencoded error message

Example (Telegram share):

```text
https://tx.steer.fun/?method=eth_sendTransaction&chainId=1&params=...&redirect_url=https%3A%2F%2Ft.me%2Fshare%2Furl%3Ftext%3DTx%2520hash%253A%2520%7B%7Bresult%7D%7D
```

Redirect query params appended (when redirect_url has no `{{...}}` placeholders):

- Success:
  - `resultType=string` and `result=<value>` OR
  - `resultType=json` and `result=<JSON.stringify(value)>`
- Failure:
  - `error=<message>`

## Examples

### personal_sign

```text
https://tx.steer.fun/?method=personal_sign&chainId=1&params=%7B%22message%22%3A%22hello%22%7D
```

### eth_sendTransaction

```text
https://tx.steer.fun/?method=eth_sendTransaction&chainId=1&params=%7B%22to%22%3A%220x4c5Ce72478D6Ce160cb31Dd25fe6a15DC269592D%22%2C%22data%22%3A%220xd09de08a%22%7D
```

## Local Dev

```bash
bun install
bun run dev
```

## Agent Skill

See `skills/open-wallet/SKILL.md` for the “agent-facing” usage guide.
