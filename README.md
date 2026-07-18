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

## Contents

| Kind       | Name                                                        | Description                                                                        |
| ---------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Model**  | [`@sntxrr/cloudflare-x402`](extensions/models/cloudflare_x402.ts) | Pay for and probe x402-protected resources with a local EVM wallet.          |
| **Report** | [`@sntxrr/x402-spend`](extensions/reports/x402_spend.ts)    | Model-scope spend summary — total USDC, per-network/per-resource, settlement rate. |

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
swamp data get my-wallet --name current --json
```

Full method reference, global arguments, supported networks, and safety notes
live in [`extensions/README.md`](extensions/README.md).

## Reports

### `@sntxrr/x402-spend`

A model-scope report that summarizes payment activity for a wallet. It runs
automatically after `@sntxrr/cloudflare-x402` method executions (reading the
stored `payment` receipts) and can be fetched on demand:

```bash
swamp report get @sntxrr/x402-spend --model my-wallet            # terminal view
swamp report get @sntxrr/x402-spend --model my-wallet --markdown # raw markdown
swamp report get @sntxrr/x402-spend --model my-wallet --json     # structured
```

It reports total USDC spent, a per-network and per-resource breakdown, the
on-chain settlement rate, and counts of unpaid / unconfirmed requests. Example:

```
## x402 spend summary — my-wallet

**18** paid request(s) · **3.4200 USDC** total · **100%** settled on-chain

| Network      | Requests |   USDC |
| ------------ | -------: | -----: |
| base         |       11 | 2.1000 |
| base-sepolia |        7 | 1.3200 |
```

Skip it for a run with `--skip-report @sntxrr/x402-spend`, or filter by its
labels (`payments`, `finops`, `x402`).

## Supported networks

EVM "exact" scheme on `base`, `base-sepolia`, `avalanche`, `avalanche-fuji`,
`polygon`, `polygon-amoy`, `sei`, `sei-testnet`. Start on a testnet
(`base-sepolia`) with test USDC before pointing at mainnet resources — the wallet
holds real funds.

## Development

```bash
deno test --allow-net extensions/models/ extensions/reports/  # unit tests
swamp extension quality extensions/manifest.yaml              # quality score
swamp extension push    extensions/manifest.yaml --dry-run    # publish check
```

## License

[MIT](extensions/LICENSE.md)
