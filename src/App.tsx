import { whatsabi } from "@shazow/whatsabi";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
	AlertTriangle,
	Braces,
	Check,
	Copy,
	Loader2,
	LogOut,
	SquareFunction,
	Wallet,
} from "lucide-react";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { config } from "./wagmi";

type JsonObject = Record<string, unknown>;

type AbiInput = {
	name?: string;
	type?: string;
	internalType?: string;
	components?: AbiInput[];
};

function safeJsonStringify(value: unknown, space?: number) {
	return JSON.stringify(
		value,
		(_, v) => {
			if (typeof v === "bigint") return v.toString();
			return v;
		},
		space,
	);
}

const parseAsUnsafeJson = createParser({
	parse: (query: string) => {
		const maybeDecodeOnce = (value: string) => {
			if (!value.includes("%")) return value;
			try {
				return decodeURIComponent(value);
			} catch {
				return value;
			}
		};

		const candidates = [
			query,
			maybeDecodeOnce(query),
			maybeDecodeOnce(maybeDecodeOnce(query)),
		];

		for (const candidate of candidates) {
			try {
				return JSON.parse(candidate) as unknown;
			} catch {
				// keep trying
			}
		}

		return null;
	},
	serialize: (value: unknown) => JSON.stringify(value),
});

function normalizeRedirectUrl(input: string) {
	const maybeDecodeOnce = (value: string) => {
		if (!value.includes("%")) return value;
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	};

	let out = input;
	for (let i = 0; i < 2; i += 1) {
		const decoded = maybeDecodeOnce(out);
		if (decoded === out) break;
		out = decoded;
	}

	return out;
}

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
		// Some wallets/providers require `from`, but we can still show/validate the
		// request before a wallet is connected. Once connected, we will fill it.
		return { ok: true, params: [from ? { ...tx, from } : tx] };
	}

	if (method === "wallet_sendCalls") {
		const calls = { ...rawParams };
		const from = (calls.from as string | undefined) ?? fallbackAddress;
		return { ok: true, params: [from ? { ...calls, from } : calls] };
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
				inputs?: AbiInput[];
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

function shortenHex(value: string, start = 6, end = 4) {
	if (!value.startsWith("0x")) return value;
	if (value.length <= start + end + 2) return value;
	return `${value.slice(0, start + 2)}…${value.slice(-end)}`;
}

function isAddressLike(value: string) {
	return value.startsWith("0x") && value.length === 42;
}

function formatAbiType(input: AbiInput | undefined) {
	const t = input?.type;
	const it = input?.internalType;
	if (t === "tuple" || (typeof t === "string" && t.startsWith("tuple"))) {
		if (typeof it === "string" && it.startsWith("struct ")) {
			const structPath = it.replace(/^struct\s+/, "").trim();
			const name = structPath.split(".").pop();
			return name ? `tuple ${name}` : "tuple";
		}
		return "tuple";
	}
	if (typeof it === "string" && it.length > 0) return it;
	return typeof t === "string" ? t : "unknown";
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
	const normalizedRedirectUrl = React.useMemo(() => {
		if (!redirectUrl) return null;
		const normalized = normalizeRedirectUrl(redirectUrl).trim();
		return normalized.length > 0 ? normalized : null;
	}, [redirectUrl]);

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

	const [copyStatus, setCopyStatus] = React.useState<string | null>(null);

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
		const stringifyResult = (value: unknown) => {
			if (typeof value === "string")
				return { resultType: "string", result: value };
			return { resultType: "json", result: safeJsonStringify(value) };
		};

		// Template mode: if redirect_url contains `{{...}}`, replace placeholders instead
		// of appending `?result=...` style query params.
		//
		// Placeholders:
		// - {{result}} / {{error}} are URL-encoded
		// - {{result_raw}} / {{error_raw}} are unencoded
		// - {{resultType}} is `string` or `json`
		if (input.includes("{{")) {
			const replaceAll = (
				source: string,
				search: string,
				replacement: string,
			) => source.split(search).join(replacement);

			const res =
				payload.result !== undefined ? stringifyResult(payload.result) : null;
			const error = payload.error ?? "";
			let out = input;
			out = replaceAll(out, "{{resultType}}", res?.resultType ?? "");
			out = replaceAll(out, "{{result_raw}}", res?.result ?? "");
			out = replaceAll(out, "{{error_raw}}", error);
			out = replaceAll(
				out,
				"{{result}}",
				res ? encodeURIComponent(res.result) : "",
			);
			out = replaceAll(
				out,
				"{{error}}",
				error ? encodeURIComponent(error) : "",
			);

			const url = new URL(out, window.location.origin);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error(`Unsupported redirect_url protocol: ${url.protocol}`);
			}
			return url.toString();
		}

		// Default mode: append result/error as query params.
		const base = new URL(input, window.location.origin);
		if (base.protocol !== "http:" && base.protocol !== "https:") {
			throw new Error(`Unsupported redirect_url protocol: ${base.protocol}`);
		}

		if (payload.error) {
			base.searchParams.set("error", payload.error);
		}

		if (payload.result !== undefined) {
			const res = stringifyResult(payload.result);
			base.searchParams.set("resultType", res.resultType);
			base.searchParams.set("result", res.result);
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

	const chainSwitchMutation = useMutation({
		mutationFn: async (chainId: SupportedChainId) => {
			await switchChainAsync({ chainId });
		},
	});
	const isSwitchingChain = chainSwitchMutation.isPending;
	const chainSwitchError = chainSwitchMutation.error
		? chainSwitchMutation.error instanceof Error
			? chainSwitchMutation.error.message
			: String(chainSwitchMutation.error)
		: null;

	const lastAutoSwitchKeyRef = React.useRef<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: auto-switch once per (address, chainId)
	React.useEffect(() => {
		if (!isConnected) return;
		if (!chainIdSupported) return;
		if (!connectedAddress) return;
		if (requestedChainId == null) return;
		if (connection.chainId === requestedChainId) return;

		const key = `${connectedAddress}:${requestedChainId}`;
		if (lastAutoSwitchKeyRef.current === key) return;
		lastAutoSwitchKeyRef.current = key;

		chainSwitchMutation.mutate(requestedChainId as SupportedChainId);
	}, [
		chainIdSupported,
		connectedAddress,
		connection.chainId,
		isConnected,
		requestedChainId,
	]);

	const canOpenRequest =
		connection.status === "connected" &&
		walletClient != null &&
		builtOk &&
		chainIdSupported &&
		!needsChainSwitch &&
		!isSwitchingChain;

	const { data: decodedCalls = null, isLoading: isDecoding } = useQuery({
		queryKey: ["decodedCalls", method, calldataTargets] as const,
		queryFn: async () => {
			if (!publicClient) throw new Error("No public client");

			// Prefer Sourcify for ABI loading (no Etherscan dependency).
			const abiLoader = new whatsabi.loaders.SourcifyABILoader({
				chainId: requestedChainId ?? 1,
			});

			const signatureLookup = new whatsabi.loaders.OpenChainSignatureLookup();

			return Promise.all(
				calldataTargets.map(async ({ to, data }): Promise<DecodedCall> => {
					const selector = data.slice(0, 10);
					try {
						const r = await whatsabi.autoload(to, {
							provider: publicClient,
							followProxies: true,
							abiLoader,
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

						const toAbiInput = (inp: any): AbiInput => {
							const out: AbiInput = {
								name: typeof inp?.name === "string" ? inp.name : undefined,
								type: typeof inp?.type === "string" ? inp.type : undefined,
								internalType:
									typeof inp?.internalType === "string"
										? inp.internalType
										: undefined,
							};
							if (Array.isArray(inp?.components)) {
								out.components = inp.components.map(toAbiInput);
							}
							return out;
						};

						let inputs: AbiInput[] | undefined;
						try {
							const abiArray = r.abi as unknown as Array<any>;
							const candidates = abiArray.filter(
								(item) =>
									item?.type === "function" &&
									item?.name === decodedFn.functionName,
							);
							const argCount = Array.isArray(decodedFn.args)
								? decodedFn.args.length
								: 0;
							const exact = candidates.find(
								(item) => (item?.inputs?.length || 0) === argCount,
							);
							const fnItem = exact || candidates[0];
							if (fnItem?.inputs && Array.isArray(fnItem.inputs)) {
								inputs = fnItem.inputs.map(toAbiInput);
							}
						} catch {
							// ignore
						}

						return {
							ok: true,
							to,
							data,
							decoded: {
								functionName: decodedFn.functionName,
								args: decodedFn.args as unknown,
								inputs,
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
		},
		enabled:
			chainIdSupported &&
			builtOk &&
			!!method &&
			!!publicClient &&
			calldataTargets.length > 0,
	});

	const executionMutation = useMutation({
		mutationFn: async () => {
			if (!walletClient || !method || !built.ok) {
				throw new Error("Missing wallet client or method");
			}

			try {
				return await walletClient.request({
					// wagmi/viem are typed for known methods; this app is intentionally generic.
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					method: method as any,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					params: built.params as any,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);

				if (normalizedRedirectUrl) {
					try {
						const target = buildRedirectTarget(normalizedRedirectUrl, {
							error: message,
						});
						window.location.assign(target);
					} catch (redirectErr) {
						const redirectMessage =
							redirectErr instanceof Error
								? redirectErr.message
								: String(redirectErr);
						throw new Error(`${message} (redirect failed: ${redirectMessage})`);
					}
				}

				throw new Error(message);
			}
		},
		onSuccess: (res) => {
			if (normalizedRedirectUrl) {
				const target = buildRedirectTarget(normalizedRedirectUrl, {
					result: res,
				});
				window.location.assign(target);
			}
		},
	});

	const result = executionMutation.data ?? null;
	const executionError = executionMutation.error?.message ?? null;
	const isExecuting = executionMutation.isPending;

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset state when inputs change
	React.useEffect(() => {
		executionMutation.reset();
		setCopyStatus(null);
	}, [method, rawParams, requestedChainId, redirectUrl]);

	const requestPreview = React.useMemo(() => {
		if (requestError) return null;
		return safeJsonStringify({ method, params: rpcParams }, 2);
	}, [method, rpcParams, requestError]);

	const responseText = React.useMemo(() => {
		if (executionError) return executionError;
		if (result == null) return "";
		return typeof result === "string"
			? result
			: safeJsonStringify(result, 2);
	}, [executionError, result]);

	const decodedOkCalls = React.useMemo(
		() => (decodedCalls?.filter((c) => c.ok) ?? []) as Array<Extract<DecodedCall, { ok: true }>>,
		[decodedCalls],
	);
	const hasSuccessfulDecoding = decodedOkCalls.length > 0;
	const [requestPreviewMode, setRequestPreviewMode] = React.useState<
		"decoded" | "raw"
	>("raw");
	const hadDecodedRef = React.useRef(false);

	// Default to Decoded when it becomes available for a request.
	React.useEffect(() => {
		const hasDecodedNow = decodedOkCalls.length > 0;
		if (!hadDecodedRef.current && hasDecodedNow) {
			setRequestPreviewMode("decoded");
		}
		hadDecodedRef.current = hasDecodedNow;
	}, [decodedOkCalls.length]);

	// If the decoded view disappears, fall back to Raw.
	React.useEffect(() => {
		if (requestPreviewMode === "decoded" && decodedOkCalls.length === 0) {
			setRequestPreviewMode("raw");
		}
	}, [decodedOkCalls.length, requestPreviewMode]);

	function renderArgValue(value: unknown, input?: AbiInput) {
		const type = input?.type;
		if (type === "address" && typeof value === "string" && isAddressLike(value)) {
			return (
				<span className="inline-flex items-center gap-1">
					<span className="font-mono break-all">{value}</span>
					<Button
						variant="ghost"
						size="icon-xs"
						onClick={async () => {
							await copyToClipboard(value);
							setCopyStatus("Copied address");
						}}
						title="Copy address"
					>
						<Copy />
					</Button>
				</span>
			);
		}

		if (type === "address[]" && Array.isArray(value)) {
			return (
				<div className="space-y-1">
					{value.map((addr) => {
						if (typeof addr !== "string" || !isAddressLike(addr)) {
							return <div key={safeJsonStringify(addr)}>{String(addr)}</div>;
						}
						return (
							<div key={addr}>
								{renderArgValue(addr, { name: "", type: "address" })}
							</div>
						);
					})}
				</div>
			);
		}

		if (type === "tuple" && Array.isArray(value) && input?.components) {
			return (
				<div className="divide-y rounded-md border">
					{input.components.map((c, idx) => (
						<div key={`${idx}:${c.name ?? ""}:${c.type ?? ""}`} className="p-2">
							<div className="flex items-center justify-between gap-2">
								<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
									{c.name || `arg${idx}`}
								</div>
								<Badge variant="outline">{formatAbiType(c)}</Badge>
							</div>
							<div className="mt-1 text-sm">
								{renderArgValue(value[idx], c)}
							</div>
						</div>
					))}
				</div>
			);
		}

		const isTupleArrayType =
			type === "tuple[]" || (typeof type === "string" && /^tuple\[\d+\]$/.test(type));
		if (
			isTupleArrayType &&
			Array.isArray(value) &&
			input?.components
		) {
			return (
				<div className="space-y-2">
					{value.map((item, i) => (
						<div
							key={`${i}:${typeof item === "string" ? item : typeof item === "bigint" ? item.toString() : ""}`}
							className="rounded-md border p-2"
						>
							<div className="mb-1 text-xs text-muted-foreground">#{i}</div>
							{renderArgValue(item, { ...input, type: "tuple" })}
						</div>
					))}
				</div>
			);
		}

		if (typeof value === "bigint") return value.toString();
		if (typeof value === "string") {
			if (isAddressLike(value)) {
				return renderArgValue(value, { name: "", type: "address" });
			}
			return value.startsWith("0x") ? (
				<span className="font-mono break-all">{value}</span>
			) : (
				<span>{value}</span>
			);
		}
		if (Array.isArray(value) || (value && typeof value === "object")) {
			return (
				<pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">
					{safeJsonStringify(value, 2)}
				</pre>
			);
		}
		return <span>{String(value)}</span>;
	}

	return (
		<div className="min-h-svh bg-background text-foreground">
			<main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
				<header className="flex items-start justify-between gap-3">
					<div className="space-y-1">
						<h1 className="text-lg font-semibold">Open Tx</h1>
						<p className="text-sm text-muted-foreground">
							review a wallet request, connect, approve
						</p>
					</div>
					<Badge variant={requestError ? "destructive" : "secondary"}>
						{requestError ? (
							<>
								<AlertTriangle />
								Fix request
							</>
						) : (
							<>
								<Check />
								Ready
							</>
						)}
					</Badge>
				</header>

				<Card>
					<CardHeader className="space-y-1">
						<CardTitle className="text-base">Wallet</CardTitle>
						<div className="text-sm text-muted-foreground">
							{isConnected ? "Connected" : "Connect to continue"}
						</div>
					</CardHeader>
					<CardContent className="space-y-3">
						{isConnected ? (
							<>
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<Badge variant="secondary">
										<Wallet />
										{connectedAddress ?? "(unknown)"}
									</Badge>
									{connectedAddress && (
										<Button
											variant="ghost"
											size="icon-xs"
											onClick={async () => {
												await copyToClipboard(connectedAddress);
												setCopyStatus("Copied address");
											}}
											title="Copy connected address"
										>
											<Copy />
										</Button>
									)}
									<Badge variant="outline">
										chainId: {connection.chainId ?? "(unknown)"}
									</Badge>
								</div>

								<div className="flex flex-wrap gap-2">
									{needsChainSwitch && requestedChainId != null && (
										<Button
											variant="outline"
											onClick={() =>
												chainSwitchMutation.mutate(
													requestedChainId as SupportedChainId,
												)
											}
											disabled={isSwitchingChain}
										>
											{isSwitchingChain ? (
												<>
													<Loader2 className="animate-spin" />
													Switching
												</>
											) : (
												<>Switch to {requestedChainId}</>
											)}
										</Button>
									)}
									<Button variant="outline" onClick={() => disconnect()}>
										<LogOut />
										Disconnect
									</Button>
								</div>
							</>
						) : (
							<>
								<div className="flex flex-col gap-2">
									{connectors.map((connector) => (
										<Button
											key={connector.uid}
											variant="outline"
											onClick={() => connect({ connector })}
										>
											<Wallet />
											{connector.name}
										</Button>
									))}
								</div>
								{status && (
									<p className="text-sm text-muted-foreground">{status}</p>
								)}
								{error?.message && (
									<Alert variant="destructive">
										<AlertTriangle className="h-4 w-4" />
										<AlertTitle>Connection error</AlertTitle>
										<AlertDescription>{error.message}</AlertDescription>
									</Alert>
								)}
							</>
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="space-y-1">
						<CardTitle className="text-base">Request</CardTitle>
						<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
							<Badge variant="outline">method: {method ?? "(missing)"}</Badge>
							<Badge variant="outline">
								chainId: {requestedChainId ?? "(missing)"}
							</Badge>
							{normalizedRedirectUrl ? (
								<Badge variant="secondary">redirect enabled</Badge>
							) : (
								<Badge variant="outline">no redirect</Badge>
							)}
						</div>
					</CardHeader>
					<CardContent className="space-y-3">
						{requestError ? (
							<Alert variant="destructive">
								<AlertTriangle className="h-4 w-4" />
								<AlertTitle>Invalid request</AlertTitle>
								<AlertDescription>{requestError}</AlertDescription>
							</Alert>
						) : (
							<>
								{needsChainSwitch && (
									<Alert variant={chainSwitchError ? "destructive" : undefined}>
										{chainSwitchError ? (
											<AlertTriangle className="h-4 w-4" />
										) : (
											<Loader2
												className={isSwitchingChain ? "animate-spin" : ""}
											/>
										)}
										<AlertTitle>
											{chainSwitchError
												? "Chain switch failed"
												: isSwitchingChain
													? "Switching chain"
													: "Chain switch required"}
										</AlertTitle>
										<AlertDescription>
											{chainSwitchError
												? chainSwitchError
												: isSwitchingChain
													? `Approve switching to chainId ${requestedChainId} in your wallet.`
													: `Please switch to chainId ${requestedChainId} in your wallet.`}
										</AlertDescription>
									</Alert>
								)}

								{hasSuccessfulDecoding ? (
									<Tabs
										value={requestPreviewMode}
										onValueChange={(v) =>
											setRequestPreviewMode(v as "decoded" | "raw")
										}
									>
										<div className="flex flex-wrap items-center justify-between gap-2">
											<div className="text-sm font-medium">Preview</div>
											<TabsList>
												<TabsTrigger value="decoded">
													<SquareFunction className="mr-2 h-4 w-4" />
													Decoded
												</TabsTrigger>
												<TabsTrigger value="raw">
													<Braces className="mr-2 h-4 w-4" />
													Raw
												</TabsTrigger>
											</TabsList>
										</div>

										<TabsContent value="decoded" className="mt-3">
											<div className="space-y-2">
												{decodedOkCalls.map((call, i) => {
													const args = Array.isArray(call.decoded.args)
														? (call.decoded.args as unknown[])
														: [];
												const inputs = call.decoded.inputs ?? [];
												const signature = `${call.decoded.functionName}(${inputs
													.map((inp, idx) =>
														`${formatAbiType(inp)} ${inp.name ?? `arg${idx}`}`.trim(),
													)
													.join(", ")})`;

														return (
															<div
																key={`${call.to}:${call.data}:${i}`}
																className="rounded-md border p-3"
															>
														<div className="flex items-start justify-between gap-2">
															<div className="min-w-0">
																<div className="flex items-center gap-2">
																	<SquareFunction className="h-4 w-4 shrink-0 text-muted-foreground" />
																	<div className="min-w-0">
																		<div className="truncate text-sm font-medium">
																			{call.decoded.functionName}
																		</div>
																		<div className="truncate text-xs text-muted-foreground">
																			{call.contractName ? `${call.contractName} • ` : ""}
																			{shortenHex(call.to)}
																		</div>
																		{call.resolvedAddress && call.resolvedAddress !== call.to && (
																			<div className="truncate text-xs text-muted-foreground">
																				impl: {shortenHex(call.resolvedAddress)}
																			</div>
																		)}
																	</div>
																</div>
															</div>

																<Button
																	variant="outline"
																	size="icon-sm"
																	onClick={async () => {
																	await copyToClipboard(call.to);
																	setCopyStatus("Copied address");
																}}
																title="Copy to address"
															>
																<Copy />
															</Button>
														</div>

														<div className="mt-2 text-xs text-muted-foreground">
															<span className="font-mono">{signature}</span>
														</div>

														{args.length > 0 ? (
															<div className="mt-3 divide-y rounded-md border">
														{args.map((arg, idx) => {
															const inp = inputs[idx] ?? {};
															const label = inp.name || `arg${idx}`;
															const type = inp.type;
															return (
																<div
																	key={`${label}:${type ?? ""}:${safeJsonStringify(arg)}`}
																	className="p-2"
																>
																<div className="flex items-center justify-between gap-2">
																	<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
																		{label}
																	</div>
																	{type && (
																		<Badge variant="outline">{formatAbiType(inp)}</Badge>
																	)}
																</div>
																	<div className="mt-1 text-sm">
																		{renderArgValue(arg, inp)}
																	</div>
																</div>
															);
														})}
														</div>
													) : (
														<p className="mt-3 text-sm text-muted-foreground">No arguments.</p>
													)}
												</div>
											);
										})}
										</div>
									</TabsContent>

									<TabsContent value="raw" className="mt-3">
										<pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
											{requestPreview}
										</pre>
									</TabsContent>
								</Tabs>
							) : (
									<>
										<div>
											<div className="mb-2 flex items-center justify-between gap-2">
												<div className="text-sm font-medium">Preview</div>
												{calldataTargets.length > 0 && (
													<Badge variant="outline">
														{isDecoding
															? "decoding"
															: decodedCalls
																? "decoded"
																: "pending"}
													</Badge>
												)}
											</div>
											<pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
												{requestPreview}
											</pre>
										</div>

										{calldataTargets.length > 0 && decodedCalls && !isDecoding && (
											<>
												<Separator />
												<p className="text-sm text-muted-foreground">
													Decoding did not resolve a function for this calldata.
												</p>
											</>
										)}
									</>
								)}
							</>
						)}

						<Separator />
						<div className="flex flex-wrap items-center gap-2">
							<Button
								onClick={() => executionMutation.mutate()}
								disabled={!canOpenRequest || isExecuting}
							>
								{isExecuting ? (
									<>
										<Loader2 className="animate-spin" />
										Opening
									</>
								) : (
									<>Open Request</>
								)}
							</Button>
							{normalizedRedirectUrl && (
								<Badge variant="secondary">redirect after approval</Badge>
							)}
						</div>
						{!canOpenRequest && !isExecuting && (
							<p className="text-sm text-muted-foreground">
								{!isConnected
									? "Connect your wallet above to open this request."
									: needsChainSwitch
										? `Switch to chainId ${requestedChainId} to continue.`
										: requestError
											? `Fix request: ${requestError}`
											: "Waiting for wallet client…"}
							</p>
						)}
					</CardContent>
				</Card>

				{!normalizedRedirectUrl &&
					(result != null || executionError != null) && (
						<Card>
							<CardHeader className="space-y-1">
								<CardTitle className="text-base">Response</CardTitle>
								<div className="text-sm text-muted-foreground">
									copy the value and send it back
								</div>
							</CardHeader>
							<CardContent className="space-y-3">
								<div className="flex flex-wrap items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={async () => {
											await copyToClipboard(responseText);
											setCopyStatus("Copied");
										}}
										disabled={!responseText}
									>
										<Copy />
										Copy
									</Button>
									{copyStatus && (
										<Badge variant="secondary">{copyStatus}</Badge>
									)}
								</div>

								<Textarea readOnly rows={10} value={responseText} />
							</CardContent>
						</Card>
					)}
			</main>
		</div>
	);
}

export default App;
