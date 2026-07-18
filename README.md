# swamp-cloudflare-x402

A [swamp](https://github.com/swamp-club/swamp) extension for the
[x402 payment standard](https://x402.org) used by
[Cloudflare agents](https://developers.cloudflare.com/agents/tools/payments/).

It lets a swamp agent **pay for HTTP resources and MCP tools** gated behind
`402 Payment Required`, and **inspect their price** before spending. Payments are
the USDC "exact" scheme, signed locally with [viem](https://viem.sh) via an
EIP-3009 `TransferWithAuthorization` — only the signed authorization ever leaves
the process, and settlement happens on-chain through the resource server's
facilitator.

## Model: `@sntxrr/cloudflare-x402`

| Method  | What it does                                                                    |
| ------- | ------------------------------------------------------------------------------- |
| `probe` | Read a resource's 402 challenge and record the price/terms **without paying**.  |
| `pay`   | Fetch the resource and auto-pay the cheapest settleable option, capped by `maxAmountUsdc`. |

## Quick start

```bash
swamp extension pull @sntxrr/cloudflare-x402

# Keep the wallet key in a vault
swamp vault create local_encryption x402-secrets
echo "$EVM_PRIVATE_KEY" | swamp vault put x402-secrets EVM_PRIVATE_KEY

# Create a wallet-backed model with a 1 USDC per-request ceiling
swamp model create @sntxrr/cloudflare-x402 my-wallet \
  --global-arg 'privateKey=${{ vault.get(x402-secrets, EVM_PRIVATE_KEY) }}' \
  --global-arg maxAmountUsdc=1.0

# Check the price, then pay
swamp model method run my-wallet probe --input url=https://api.example.com/paid-tool
swamp model method run my-wallet pay   --input url=https://api.example.com/paid-tool
swamp data get my-wallet --name latest --json
```

Full method reference, global arguments, supported networks, and safety notes
live in [`extensions/models/README.md`](extensions/models/README.md).

## Supported networks

EVM "exact" scheme on `base`, `base-sepolia`, `avalanche`, `avalanche-fuji`,
`polygon`, `polygon-amoy`, `sei`, `sei-testnet`. Start on a testnet
(`base-sepolia`) with test USDC before pointing at mainnet resources — the wallet
holds real funds.

## Development

```bash
deno test --allow-net extensions/models/cloudflare_x402_test.ts   # unit tests
swamp extension quality extensions/models/manifest.yaml           # quality score
swamp extension push    extensions/models/manifest.yaml --dry-run # publish check
```

## License

[MIT](extensions/models/LICENSE.md)
