import { whatsabi } from "@shazow/whatsabi";
import { createParser, parseAsInteger, useQueryState } from "nuqs";
import * as React from "react";
import {
	type Abi,
	decodeFunctionData,
	type Hex,
	isHex,
	stringToHex,
} from "viem";
import {
	useConnect,
	useConnection,
	useConnectors,
	useDisconnect,
	usePublicClient,
	useSwitchChain,
	useWalletClient,
} from "wagmi";
import { config } from "./wagmi";

type JsonObject = Record<string, unknown>;

const parseAsUnsafeJson = createParser({
	parse: (query: string) => {
		try {
			return JSON.parse(query) as unknown;
		} catch {
			return null;
		}
	},
	serialize: (value: unknown) => JSON.stringify(value),
});

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildRpcParams(
	method: string,
	rawParams: unknown,
	fallbackAddress: string | undefined,
): { ok: true; params: unknown[] } | { ok: false; error: string } {
	if (!method) {
		return { ok: false, error: "Missing `method` query param." };
	}

	if (rawParams == null) {
		return {
			ok: false,
			error: "Missing or invalid `params` query param (expected JSON).",
		};
	}

	// Let advanced callers pass the exact JSON-RPC params array.
	if (Array.isArray(rawParams)) {
		return { ok: true, params: rawParams };
	}

	if (!isJsonObject(rawParams)) {
		return {
			ok: false,
			error: "`params` must be a JSON object or JSON array.",
		};
	}

	// Convenience mapping for common wallet methods.
	if (method === "eth_sendTransaction") {
		const tx = { ...rawParams };
		const from = (tx.from as string | undefined) ?? fallbackAddress;
		if (!from) {
			return {
				ok: false,
				error:
					"eth_sendTransaction needs a `from` address (either in params.from or via connected wallet).",
			};
		}
		return { ok: true, params: [{ ...tx, from }] };
	}

	if (method === "wallet_sendCalls") {
		const calls = { ...rawParams };
		const from = (calls.from as string | undefined) ?? fallbackAddress;
		if (!from) {
			return {
				ok: false,
				error:
					"wallet_sendCalls needs a `from` address (either in params.from or via connected wallet).",
			};
		}
		return { ok: true, params: [{ ...calls, from }] };
	}

	if (method === "personal_sign") {
		const message = rawParams.message ?? rawParams.data;
		const address =
			(rawParams.address as string | undefined) ?? fallbackAddress;

		if (!address) {
			return {
				ok: false,
				error:
					"personal_sign needs an address (either in params.address or via connected wallet).",
			};
		}

		if (typeof message !== "string") {
			return {
				ok: false,
				error:
					"personal_sign needs `params.message` (or `params.data`) as a string.",
			};
		}

		const data = message.startsWith("0x") ? message : stringToHex(message);
		return { ok: true, params: [data, address] };
	}

	if (method === "eth_signTypedData_v4") {
		const address =
			(rawParams.address as string | undefined) ?? fallbackAddress;
		const typedData = rawParams.typedData ?? rawParams.data;

		if (!address) {
			return {
				ok: false,
				error:
					"eth_signTypedData_v4 needs an address (either in params.address or via connected wallet).",
			};
		}

		if (typedData == null) {
			return {
				ok: false,
				error:
					"eth_signTypedData_v4 needs `params.typedData` (or `params.data`).",
			};
		}

		const typedDataJson =
			typeof typedData === "string" ? typedData : JSON.stringify(typedData);
		return { ok: true, params: [address, typedDataJson] };
	}

	// Generic fallback: treat the provided params object as the first param.
	return { ok: true, params: [rawParams] };
}

type DecodedCall =
	| {
			ok: true;
			to: string;
			data: Hex;
			decoded: {
				functionName: string;
				args?: unknown;
			};
			resolvedAddress?: string;
			contractName?: string;
	  }
	| {
			ok: false;
			to?: string;
			data?: string;
			error: string;
			selector?: string;
			possibleSignatures?: string[];
	  };

function extractCalldataTargets(
	method: string | null,
	rpcParams: unknown[] | null,
) {
	if (!method || !rpcParams || rpcParams.length === 0)
		return [] as Array<{ to: string; data: Hex }>;

	const first = rpcParams[0];
	if (!first || typeof first !== "object") return [];

	if (method === "eth_sendTransaction") {
		const tx = first as Record<string, unknown>;
		const to = tx.to;
		const data = (tx.data ?? tx.input) as unknown;
		if (
			typeof to === "string" &&
			typeof data === "string" &&
			isHex(data) &&
			data !== "0x"
		) {
			return [{ to, data: data as Hex }];
		}
	}

	if (method === "wallet_sendCalls") {
		const obj = first as Record<string, unknown>;
		const calls = obj.calls;
		if (Array.isArray(calls)) {
			const out: Array<{ to: string; data: Hex }> = [];
			for (const call of calls) {
				if (!call || typeof call !== "object") continue;
				const c = call as Record<string, unknown>;
				const to = c.to;
				const data = (c.data ?? c.callData) as unknown;
				if (
					typeof to === "string" &&
					typeof data === "string" &&
					isHex(data) &&
					data !== "0x"
				) {
					out.push({ to, data: data as Hex });
				}
			}
			return out;
		}
	}

	return [];
}

function App() {
	const connection = useConnection();
	const { connect, status, error } = useConnect();
	const connectors = useConnectors();
	const { disconnect } = useDisconnect();
	const { data: walletClient } = useWalletClient();
	const { switchChainAsync } = useSwitchChain();

	const [method] = useQueryState("method");
	const [requestedChainId] = useQueryState("chainId", parseAsInteger);
	const [rawParams] = useQueryState("params", parseAsUnsafeJson);
	const [redirectUrl] = useQueryState("redirect_url");

	const connectedAddress = connection.addresses?.[0];
	const built = React.useMemo(
		() => buildRpcParams(method ?? "", rawParams, connectedAddress),
		[method, rawParams, connectedAddress],
	);
	const builtOk = built.ok;
	const rpcParams = builtOk ? built.params : null;

	const calldataTargets = React.useMemo(
		() => extractCalldataTargets(method, rpcParams),
		[method, rpcParams],
	);

	const [result, setResult] = React.useState<unknown>(null);
	const [executionError, setExecutionError] = React.useState<string | null>(
		null,
	);
	const [isExecuting, setIsExecuting] = React.useState(false);
	const [copyStatus, setCopyStatus] = React.useState<string | null>(null);
	const [decodedCalls, setDecodedCalls] = React.useState<DecodedCall[] | null>(
		null,
	);
	const [isDecoding, setIsDecoding] = React.useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset state when inputs change
	React.useEffect(() => {
		setResult(null);
		setExecutionError(null);
		setCopyStatus(null);
		setDecodedCalls(null);
	}, [method, rawParams, requestedChainId, redirectUrl]);

	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const el = document.createElement("textarea");
			el.value = text;
			el.setAttribute("readonly", "true");
			el.style.position = "absolute";
			el.style.left = "-9999px";
			document.body.appendChild(el);
			el.select();
			document.execCommand("copy");
			document.body.removeChild(el);
		}
	}

	function buildRedirectTarget(
		input: string,
		payload: { result?: unknown; error?: string },
	) {
		const base = new URL(input, window.location.origin);
		if (base.protocol !== "http:" && base.protocol !== "https:") {
			throw new Error(`Unsupported redirect_url protocol: ${base.protocol}`);
		}

		if (payload.error) {
			base.searchParams.set("error", payload.error);
		}

		if (payload.result !== undefined) {
			if (typeof payload.result === "string") {
				base.searchParams.set("resultType", "string");
				base.searchParams.set("result", payload.result);
			} else {
				base.searchParams.set("resultType", "json");
				base.searchParams.set("result", JSON.stringify(payload.result));
			}
		}

		return base.toString();
	}

	const chainIdOk =
		requestedChainId != null &&
		Number.isInteger(requestedChainId) &&
		requestedChainId > 0;

	type SupportedChainId = (typeof config.chains)[number]["id"];
	const supportedChainIds = React.useMemo(
		() => config.chains.map((c) => c.id as SupportedChainId),
		[],
	);
	const chainIdSupported =
		chainIdOk &&
		supportedChainIds.includes(requestedChainId as SupportedChainId);

	const publicClient = usePublicClient(
		chainIdSupported
			? { chainId: requestedChainId as SupportedChainId }
			: undefined,
	);

	const requestError = !chainIdOk
		? "Missing or invalid `chainId` query param (expected integer chain id, e.g. 1, 11155111)."
		: !chainIdSupported
			? `Unsupported chainId ${requestedChainId}. Supported: ${supportedChainIds.join(", ")}`
			: builtOk
				? null
				: built.error;

	const isConnected = connection.status === "connected";
	const needsChainSwitch =
		isConnected &&
		requestedChainId != null &&
		connection.chainId != null &&
		connection.chainId !== requestedChainId;

	const canOpenRequest =
		connection.status === "connected" &&
		walletClient != null &&
		builtOk &&
		chainIdSupported;

	React.useEffect(() => {
		let cancelled = false;

		async function run() {
			if (!chainIdSupported) return;
			if (!builtOk) return;
			if (!method) return;
			if (!publicClient) return;
			if (calldataTargets.length === 0) return;

			setIsDecoding(true);
			try {
				const signatureLookup = new whatsabi.loaders.OpenChainSignatureLookup();

				const decoded = await Promise.all(
					calldataTargets.map(async ({ to, data }): Promise<DecodedCall> => {
						const selector = data.slice(0, 10);
						try {
							const r = await whatsabi.autoload(to, {
								provider: publicClient,
								followProxies: true,
							});

							if (!r.abi) {
								const possibleSignatures =
									await signatureLookup.loadFunctions(selector);
								return {
									ok: false,
									to,
									data,
									error: "ABI not found",
									selector,
									possibleSignatures: possibleSignatures.slice(0, 5),
								};
							}

							const decodedFn = decodeFunctionData({
								abi: r.abi as Abi,
								data,
							});

							return {
								ok: true,
								to,
								data,
								decoded: {
									functionName: decodedFn.functionName,
									args: decodedFn.args as unknown,
								},
								resolvedAddress:
									typeof (r as unknown as { address?: unknown }).address ===
									"string"
										? ((r as unknown as { address: string }).address as string)
										: undefined,
								contractName:
									typeof (r as unknown as { name?: unknown }).name === "string"
										? ((r as unknown as { name: string }).name as string)
										: undefined,
							};
						} catch (e) {
							const message = e instanceof Error ? e.message : String(e);
							let possibleSignatures: string[] | undefined;
							try {
								possibleSignatures = (
									await signatureLookup.loadFunctions(selector)
								).slice(0, 5);
							} catch {
								// ignore
							}
							return {
								ok: false,
								to,
								data,
								error: message,
								selector,
								possibleSignatures,
							};
						}
					}),
				);

				if (!cancelled) setDecodedCalls(decoded);
			} finally {
				if (!cancelled) setIsDecoding(false);
			}
		}

		run();
		return () => {
			cancelled = true;
		};
	}, [builtOk, calldataTargets, chainIdSupported, method, publicClient]);

	async function openRequest() {
		if (!walletClient) return;
		if (!builtOk) return;
		if (!method) return;
		if (!chainIdSupported) return;

		setIsExecuting(true);
		setExecutionError(null);
		setResult(null);
		setCopyStatus(null);

		try {
			if (connection.chainId !== requestedChainId) {
				await switchChainAsync({
					chainId: requestedChainId as SupportedChainId,
				});
			}

			const res = await walletClient.request({
				// wagmi/viem are typed for known methods; this app is intentionally generic.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				method: method as any,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				params: built.params as any,
			});
			setResult(res);

			if (redirectUrl) {
				const target = buildRedirectTarget(redirectUrl, { result: res });
				window.location.assign(target);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setExecutionError(message);

			if (redirectUrl) {
				try {
					const target = buildRedirectTarget(redirectUrl, { error: message });
					window.location.assign(target);
				} catch (redirectErr) {
					const redirectMessage =
						redirectErr instanceof Error
							? redirectErr.message
							: String(redirectErr);
					setExecutionError(`${message} (redirect failed: ${redirectMessage})`);
				}
			}
		} finally {
			setIsExecuting(false);
		}
	}

	return (
		<>
			<div>
				<h2>Request</h2>

				<div>
					method: {method ?? "(missing)"}
					<br />
					chainId: {requestedChainId ?? "(missing)"}
					<br />
					redirect_url: {redirectUrl ?? "(none)"}
				</div>

				{requestError ? (
					<div>error: {requestError}</div>
				) : (
					<>
						{needsChainSwitch && (
							<div>
								note: will switch chain to {requestedChainId} before executing
							</div>
						)}
						<div>will request:</div>
						<pre>{JSON.stringify({ method, params: rpcParams }, null, 2)}</pre>

						{calldataTargets.length > 0 && (
							<>
								<div>
									calldata decoding:{" "}
									{isDecoding ? "loading…" : decodedCalls ? "ready" : "pending"}
								</div>
								{decodedCalls && (
									<pre>
										{JSON.stringify(
											decodedCalls.map((c) =>
												c.ok
													? {
															to: c.to,
															contractName: c.contractName,
															resolvedAddress: c.resolvedAddress,
															function: c.decoded.functionName,
															args: c.decoded.args,
														}
													: {
															to: c.to,
															selector: c.selector,
															error: c.error,
															possibleSignatures: c.possibleSignatures,
														},
											),
											null,
											2,
										)}
									</pre>
								)}
							</>
						)}
					</>
				)}
			</div>

			{isConnected ? (
				<div>
					<h2>Wallet</h2>

					<div>connected: {connectedAddress ?? "(unknown)"}</div>
					<div>current chainId: {connection.chainId ?? "(unknown)"}</div>

					<button type="button" onClick={() => disconnect()}>
						Disconnect
					</button>

					<div>
						<button
							type="button"
							onClick={() => openRequest()}
							disabled={!canOpenRequest || isExecuting}
						>
							{isExecuting ? "Opening…" : "Open Request"}
						</button>
						{!canOpenRequest && !isExecuting && (
							<div>
								{requestError
									? `fix request: ${requestError}`
									: "waiting for wallet client…"}
							</div>
						)}
						{redirectUrl && (
							<div>after approval, you will be redirected to redirect_url</div>
						)}
					</div>
				</div>
			) : (
				<div>
					<h2>Connect Wallet</h2>
					<div>connect to review + open the request</div>
					{connectors.map((connector) => (
						<button
							key={connector.uid}
							onClick={() => connect({ connector })}
							type="button"
						>
							{connector.name}
						</button>
					))}
					{status && <div>{status}</div>}
					{error?.message && <div>{error.message}</div>}
				</div>
			)}

			{!redirectUrl && (result != null || executionError != null) && (
				<div>
					<h2>Response</h2>
					{executionError && <div>error: {executionError}</div>}

					<div>
						{executionError && (
							<button
								type="button"
								onClick={async () => {
									await copyToClipboard(executionError);
									setCopyStatus("Copied error");
								}}
							>
								Copy error
							</button>
						)}
						{result != null && (
							<button
								type="button"
								onClick={async () => {
									const text =
										typeof result === "string"
											? result
											: JSON.stringify(result);
									await copyToClipboard(text);
									setCopyStatus("Copied result");
								}}
							>
								Copy result
							</button>
						)}
						{copyStatus && <span> {copyStatus}</span>}
					</div>

					<textarea
						readOnly
						rows={10}
						value={
							executionError
								? executionError
								: result == null
									? ""
									: typeof result === "string"
										? result
										: JSON.stringify(result, null, 2)
						}
					/>
				</div>
			)}
		</>
	);
}

export default App;
