import * as React from 'react'
import { createParser, parseAsInteger, useQueryState } from 'nuqs'
import { stringToHex } from 'viem'
import { config } from './wagmi'
import {
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  useSwitchChain,
  useWalletClient,
} from 'wagmi'

type JsonObject = Record<string, unknown>

const parseAsUnsafeJson = createParser({
  parse: (query: string) => {
    try {
      return JSON.parse(query) as unknown
    } catch {
      return null
    }
  },
  serialize: (value: unknown) => JSON.stringify(value),
})

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildRpcParams(
  method: string,
  rawParams: unknown,
  fallbackAddress: string | undefined,
): { ok: true; params: unknown[] } | { ok: false; error: string } {
  if (!method) {
    return { ok: false, error: 'Missing `method` query param.' }
  }

  if (rawParams == null) {
    return { ok: false, error: 'Missing or invalid `params` query param (expected JSON).' }
  }

  // Let advanced callers pass the exact JSON-RPC params array.
  if (Array.isArray(rawParams)) {
    return { ok: true, params: rawParams }
  }

  if (!isJsonObject(rawParams)) {
    return { ok: false, error: '`params` must be a JSON object or JSON array.' }
  }

  // Convenience mapping for common wallet methods.
  if (method === 'eth_sendTransaction') {
    const tx = { ...rawParams }
    const from = (tx.from as string | undefined) ?? fallbackAddress
    if (!from) {
      return {
        ok: false,
        error:
          'eth_sendTransaction needs a `from` address (either in params.from or via connected wallet).',
      }
    }
    return { ok: true, params: [{ ...tx, from }] }
  }

  if (method === 'wallet_sendCalls') {
    const calls = { ...rawParams }
    const from = (calls.from as string | undefined) ?? fallbackAddress
    if (!from) {
      return {
        ok: false,
        error:
          'wallet_sendCalls needs a `from` address (either in params.from or via connected wallet).',
      }
    }
    return { ok: true, params: [{ ...calls, from }] }
  }

  if (method === 'personal_sign') {
    const message = rawParams.message ?? rawParams.data
    const address = (rawParams.address as string | undefined) ?? fallbackAddress

    if (!address) {
      return {
        ok: false,
        error:
          'personal_sign needs an address (either in params.address or via connected wallet).',
      }
    }

    if (typeof message !== 'string') {
      return {
        ok: false,
        error: 'personal_sign needs `params.message` (or `params.data`) as a string.',
      }
    }

    const data = message.startsWith('0x') ? message : stringToHex(message)
    return { ok: true, params: [data, address] }
  }

  if (method === 'eth_signTypedData_v4') {
    const address = (rawParams.address as string | undefined) ?? fallbackAddress
    const typedData = rawParams.typedData ?? rawParams.data

    if (!address) {
      return {
        ok: false,
        error:
          'eth_signTypedData_v4 needs an address (either in params.address or via connected wallet).',
      }
    }

    if (typedData == null) {
      return {
        ok: false,
        error: 'eth_signTypedData_v4 needs `params.typedData` (or `params.data`).',
      }
    }

    const typedDataJson =
      typeof typedData === 'string' ? typedData : JSON.stringify(typedData)
    return { ok: true, params: [address, typedDataJson] }
  }

  // Generic fallback: treat the provided params object as the first param.
  return { ok: true, params: [rawParams] }
}

function App() {
  const connection = useConnection()
  const { connect, status, error } = useConnect()
  const connectors = useConnectors()
  const { disconnect } = useDisconnect()
  const { data: walletClient } = useWalletClient()
  const { switchChainAsync } = useSwitchChain()

  const [method] = useQueryState('method')
  const [requestedChainId] = useQueryState('chainId', parseAsInteger)
  const [rawParams] = useQueryState('params', parseAsUnsafeJson)
  const [redirectUrl] = useQueryState('redirect_url')

  const connectedAddress = connection.addresses?.[0]
  const built = React.useMemo(
    () => buildRpcParams(method ?? '', rawParams, connectedAddress),
    [method, rawParams, connectedAddress],
  )
  const builtOk = built.ok
  const rpcParams = builtOk ? built.params : null

  const [result, setResult] = React.useState<unknown>(null)
  const [executionError, setExecutionError] = React.useState<string | null>(null)
  const [isExecuting, setIsExecuting] = React.useState(false)
  const [copyStatus, setCopyStatus] = React.useState<string | null>(null)

  React.useEffect(() => {
    setResult(null)
    setExecutionError(null)
    setCopyStatus(null)
  }, [method, rawParams, requestedChainId, redirectUrl])

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', 'true')
      el.style.position = 'absolute'
      el.style.left = '-9999px'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }
  }

  function buildRedirectTarget(input: string, payload: { result?: unknown; error?: string }) {
    const base = new URL(input, window.location.origin)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error(`Unsupported redirect_url protocol: ${base.protocol}`)
    }

    if (payload.error) {
      base.searchParams.set('error', payload.error)
    }

    if (payload.result !== undefined) {
      if (typeof payload.result === 'string') {
        base.searchParams.set('resultType', 'string')
        base.searchParams.set('result', payload.result)
      } else {
        base.searchParams.set('resultType', 'json')
        base.searchParams.set('result', JSON.stringify(payload.result))
      }
    }

    return base.toString()
  }

  const chainIdOk =
    requestedChainId != null && Number.isInteger(requestedChainId) && requestedChainId > 0

  type SupportedChainId = (typeof config.chains)[number]['id']
  const supportedChainIds = React.useMemo(
    () => config.chains.map((c) => c.id as SupportedChainId),
    [],
  )
  const chainIdSupported =
    chainIdOk && supportedChainIds.includes(requestedChainId as SupportedChainId)

  const requestError = !chainIdOk
    ? 'Missing or invalid `chainId` query param (expected integer chain id, e.g. 1, 11155111).'
    : !chainIdSupported
      ? `Unsupported chainId ${requestedChainId}. Supported: ${supportedChainIds.join(', ')}`
      : builtOk
        ? null
        : built.error

  const canOpenRequest =
    connection.status === 'connected' && walletClient != null && builtOk && chainIdSupported

  async function openRequest() {
    if (!walletClient) return
    if (!builtOk) return
    if (!method) return
    if (!chainIdSupported) return

    setIsExecuting(true)
    setExecutionError(null)
    setResult(null)
    setCopyStatus(null)

    try {
      if (connection.chainId !== requestedChainId) {
        await switchChainAsync({ chainId: requestedChainId as SupportedChainId })
      }

      const res = await walletClient.request({
        // wagmi/viem are typed for known methods; this app is intentionally generic.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        method: method as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        params: built.params as any,
      })
      setResult(res)

      if (redirectUrl) {
        const target = buildRedirectTarget(redirectUrl, { result: res })
        window.location.assign(target)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setExecutionError(message)

      if (redirectUrl) {
        try {
          const target = buildRedirectTarget(redirectUrl, { error: message })
          window.location.assign(target)
        } catch (redirectErr) {
          const redirectMessage =
            redirectErr instanceof Error ? redirectErr.message : String(redirectErr)
          setExecutionError(`${message} (redirect failed: ${redirectMessage})`)
        }
      }
    } finally {
      setIsExecuting(false)
    }
  }

  return (
    <>
      <div>
        <h2>Incoming Request</h2>

        <div>
          method: {method ?? '(missing)'}
          <br />
          chainId: {requestedChainId ?? '(missing)'}
          <br />
          redirect_url: {redirectUrl ?? '(none)'}
          <br />
          params (decoded JSON):
        </div>

        <pre>{JSON.stringify(rawParams, null, 2)}</pre>

        {requestError ? (
          <div>request error: {requestError}</div>
        ) : (
          <>
            <div>rpc params:</div>
            <pre>{JSON.stringify(rpcParams, null, 2)}</pre>
          </>
        )}

        <div>
          Tip: try something like:
          <pre>
            {`/?method=personal_sign&chainId=1&params=${encodeURIComponent(
              JSON.stringify({ message: 'hello' }),
            )}`}
          </pre>
        </div>
      </div>

      {connection.status === 'connected' ? (
        <div>
          <h2>Connection</h2>

          <div>
            status: {connection.status}
            <br />
            addresses: {JSON.stringify(connection.addresses)}
            <br />
            chainId: {connection.chainId}
          </div>

          <button type="button" onClick={() => disconnect()}>
            Disconnect
          </button>

          {!requestError && (
            <div>
              <button type="button" onClick={() => openRequest()} disabled={!canOpenRequest || isExecuting}>
                {isExecuting ? 'Opening…' : 'Open Request'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div>
          <h2>Connect</h2>
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              onClick={() => connect({ connector })}
              type="button"
            >
              {connector.name}
            </button>
          ))}
          <div>{status}</div>
          <div>{error?.message}</div>
        </div>
      )}

      <div>
        <h2>Result</h2>
        {executionError && <div>error: {executionError}</div>}

        {redirectUrl ? (
          <pre>{JSON.stringify(result, null, 2)}</pre>
        ) : (
          <>
            {executionError && (
              <div>
                <button
                  type="button"
                  onClick={async () => {
                    await copyToClipboard(executionError)
                    setCopyStatus('Copied error')
                  }}
                >
                  Copy error
                </button>
              </div>
            )}

            {result != null && (
              <div>
                <button
                  type="button"
                  onClick={async () => {
                    const text = typeof result === 'string' ? result : JSON.stringify(result)
                    await copyToClipboard(text)
                    setCopyStatus('Copied result')
                  }}
                >
                  Copy result
                </button>
              </div>
            )}

            {copyStatus && <div>{copyStatus}</div>}

            <div>
              <div>result (pretty):</div>
              <textarea
                readOnly
                rows={10}
                value={result == null ? '' : JSON.stringify(result, null, 2)}
              />
            </div>
          </>
        )}
      </div>
    </>
  )
}

export default App
