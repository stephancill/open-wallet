import type { Chain } from "viem";
import { createConfig, http, type Transport } from "wagmi";
import * as chains from "wagmi/chains";
import { baseAccount } from "wagmi/connectors";

const chainList = Object.values(chains) as unknown as readonly [
	Chain,
	...Chain[],
];

const transports = chainList.reduce(
	(acc, chain) => {
		acc[chain.id] = http();
		return acc;
	},
	{} as Record<number, Transport>,
);

export const config = createConfig({
  connectors: [
    baseAccount({
      appName: "open-wallet",
      preference: {
        telemetry: false
      }
    })
  ],
	chains: chainList,
	transports,
});

declare module "wagmi" {
	interface Register {
		config: typeof config;
	}
}
