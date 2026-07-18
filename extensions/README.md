# @sntxrr/cloudflare-x402

Swamp model for the [x402 payment standard](https://x402.org) used by
[Cloudflare agents](https://developers.cloudflare.com/agents/tools/payments/).
It lets a swamp agent **pay for HTTP resources and MCP tools** that respond with
`402 Payment Required`, and **inspect their price** before committing funds.

The `pay` method drives the whole flow client-side: request the resource, read
the 402 challenge, sign an EIP-3009 `TransferWithAuthorization` (USDC "exact"
scheme) locally with your wallet, retry with the `X-PAYMENT` header, and record
the on-chain settlement receipt returned in `X-PAYMENT-RESPONSE`. Settlement
happens through the resource server's facilitator — no RPC endpoint required on
your side.

Signing is done locally with [viem](https://viem.sh); only the signed payment
authorization ever leaves the process.

## Setup

Store your wallet's private key in a vault rather than passing it inline:

```bash
swamp vault create local_encryption x402-secrets --json
echo "$EVM_PRIVATE_KEY" | swamp vault put x402-secrets EVM_PRIVATE_KEY --json
```

Create a model instance, wiring the key from the vault so it resolves fresh on
every call:

```bash
swamp model create @sntxrr/cloudflare-x402 my-wallet \
  --global-arg 'privateKey=${{ vault.get(x402-secrets, EVM_PRIVATE_KEY) }}' \
  --global-arg maxAmountUsdc=1.0
```

Global arguments:

| Arg             | Default | Description                                                             |
| --------------- | ------- | ----------------------------------------------------------------------- |
| `privateKey`    | —       | 0x-prefixed 32-byte EVM private key. **Store in a vault.**               |
| `maxAmountUsdc` | `0.1`   | Per-request spend ceiling in whole USDC. Payments above this are refused. |
| `tokenDecimals` | `6`     | Decimals of the settlement token (USDC = 6), used for USDC↔base-unit math. |

## Methods

### `probe`

Read a resource's payment requirements **without paying** — useful for an agent
to check the price and terms first.

```bash
swamp model method run my-wallet probe --input url=https://api.example.com/paid-tool
```

Optional inputs: `method` (default `GET`), `headers`, and `requestId` (stored
instance name, default `current`; the name `latest` is reserved by swamp).

The result is written to the `quote` resource:

```bash
swamp data get my-wallet --name current --json
```

It records `paymentRequired`, the raw `accepts` options (scheme, network,
`maxAmountRequired`, `payTo`, `asset`, description) and a best-effort
`amountUsdc` for each.

### `pay`

Fetch the resource and automatically pay the cheapest settleable option, subject
to the spend ceiling.

```bash
swamp model method run my-wallet pay \
  --input url=https://api.example.com/paid-tool \
  --input maxAmountUsdc=0.25
```

Optional inputs: `method` (default `GET`), `headers`, `body` (raw string),
`maxAmountUsdc` (overrides the model default for this call), and `requestId`.

The result is written to the `payment` resource — `httpStatus`, the response
body (capped at 64 KiB), and a `receipt` with the settlement `success`,
`transaction` hash, `network`, and `payer`:

```bash
swamp data get my-wallet --name current --json
```

If the resource returns a normal `2xx` (no challenge), nothing is paid and
`paid` is recorded as `false`. If the required amount exceeds your ceiling, or no
`exact` EVM option is offered on a supported network, the method fails before any
authorization is signed.

## Reports

### `@sntxrr/x402-spend`

A model-scope report bundled with this extension. It runs automatically after
the wallet model's method executions and summarizes spend from the stored
`payment` receipts: total USDC, a per-network and per-resource breakdown, the
on-chain settlement rate, and counts of unpaid / unconfirmed requests.

```bash
swamp report get @sntxrr/x402-spend --model my-wallet --json
```

Its labels are `payments`, `finops`, and `x402`; skip it for a run with
`--skip-report @sntxrr/x402-spend`.

## Supported networks

EVM "exact" scheme on: `base`, `base-sepolia`, `avalanche`, `avalanche-fuji`,
`polygon`, `polygon-amoy`, `sei`, `sei-testnet`. The network is chosen from the
server's advertised `accepts` list; unsupported networks are skipped.

## Testing

**Unit tests** (mocked fetch and report contexts — no network, no wallet):

```bash
deno test --allow-net extensions/models/ extensions/reports/
```

**End-to-end, no crypto or cost** — the repo ships a local mock x402 server
([`examples/mock_x402_server.ts`](https://github.com/sntxrr/swamp-cloudflare-x402/blob/main/examples/mock_x402_server.ts))
that issues a real `402` challenge and settles a mock payment, exercising the
full flow (EIP-712 signing, `X-PAYMENT`, receipt decode):

```bash
deno run --allow-net examples/mock_x402_server.ts &          # start on :4021

KEY="0x$(openssl rand -hex 32)"                              # throwaway wallet
swamp vault create local_encryption x402-test-secrets
echo "$KEY" | swamp vault put x402-test-secrets EVM_PRIVATE_KEY
swamp model create @sntxrr/cloudflare-x402 x402-tester \
  --global-arg 'privateKey=${{ vault.get(x402-test-secrets, EVM_PRIVATE_KEY) }}' \
  --global-arg maxAmountUsdc=1.0

swamp model method run x402-tester probe --input url=http://localhost:4021/paid
swamp model method run x402-tester pay   --input url=http://localhost:4021/paid
swamp report get @sntxrr/x402-spend --model x402-tester --markdown
swamp model delete x402-tester --force                       # clean up
```

**Real testnet** — point `pay` at a live `base-sepolia` endpoint with a wallet
funded from the [Circle USDC faucet](https://faucet.circle.com/). The `exact`
scheme is gasless for the payer, so only test USDC is needed (no testnet ETH).

## Safety notes

- The wallet holds real funds — scope `maxAmountUsdc` tightly and keep the key in
  a vault.
- `pay` makes a single paid attempt (no auto-retry) to avoid any chance of
  double submission; re-run deliberately if a request fails.
- Start on a testnet (`base-sepolia`) with test USDC before pointing at mainnet
  resources.
