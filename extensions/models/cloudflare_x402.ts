/**
 * Cloudflare x402 payments — let a swamp agent pay for HTTP resources and MCP
 * tools that are gated behind the [x402 payment standard](https://x402.org).
 *
 * The `pay` method drives the full 402 flow: it requests a protected resource,
 * reads the `402 Payment Required` challenge, signs an EIP-3009
 * `TransferWithAuthorization` (USDC "exact" scheme) with the configured wallet,
 * retries with the `X-PAYMENT` header, and stores the settlement receipt from
 * `X-PAYMENT-RESPONSE`. The `probe` method inspects the price without paying.
 *
 * Modeled after the client-side flow documented at
 * https://developers.cloudflare.com/agents/tools/payments/. Signing is done
 * locally with viem; nothing but the payment authorization ever leaves the
 * process, and settlement happens on-chain via the resource server's
 * facilitator.
 *
 * @module
 */
// extensions/models/cloudflare_x402.ts
import { z } from "npm:zod@4";
import { privateKeyToAccount } from "npm:viem@2.21.26/accounts";

/** EVM networks x402 servers commonly settle on, mapped to their chain IDs. */
const NETWORK_CHAIN_IDS: Record<string, number> = {
  "base": 8453,
  "base-sepolia": 84532,
  "avalanche": 43114,
  "avalanche-fuji": 43113,
  "polygon": 137,
  "polygon-amoy": 80002,
  "sei": 1329,
  "sei-testnet": 1328,
};

/** USDC and most x402-settled stablecoins expose 6 decimals. */
const DEFAULT_TOKEN_DECIMALS = 6;

const GlobalArgsSchema = z.object({
  privateKey: z.string().regex(
    /^0x[0-9a-fA-F]{64}$/,
    "must be a 0x-prefixed 32-byte hex EVM private key",
  ).describe(
    "EVM wallet private key (0x + 64 hex chars) used to sign x402 payments. Store in a vault, never inline.",
  ),
  maxAmountUsdc: z.number().positive().default(0.1).describe(
    "Default ceiling, in whole USDC, this wallet will auto-pay for a single request. Per-call `maxAmountUsdc` overrides it.",
  ),
  tokenDecimals: z.number().int().min(0).max(36).default(
    DEFAULT_TOKEN_DECIMALS,
  ).describe(
    "Decimals of the settlement token, used to convert the USDC ceiling to base units (USDC = 6).",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** One entry from an x402 server's `accepts` list (a payment requirement). */
const PaymentRequirementSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  maxAmountRequired: z.string(),
  resource: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  payTo: z.string().optional(),
  asset: z.string().optional(),
  maxTimeoutSeconds: z.number().optional(),
  amountUsdc: z.number().optional().describe(
    "maxAmountRequired converted to whole USDC using tokenDecimals (best effort).",
  ),
});

const QuoteSchema = z.object({
  url: z.string(),
  method: z.string(),
  paymentRequired: z.boolean(),
  httpStatus: z.number(),
  x402Version: z.number().nullable(),
  accepts: z.array(PaymentRequirementSchema),
  error: z.string().nullable(),
  fetchedAt: z.string(),
});

const PaymentReceiptSchema = z.object({
  success: z.boolean(),
  transaction: z.string().nullable(),
  network: z.string().nullable(),
  payer: z.string().nullable(),
});

const PaymentSchema = z.object({
  url: z.string(),
  method: z.string(),
  paid: z.boolean(),
  httpStatus: z.number(),
  network: z.string().nullable(),
  amountUsdc: z.number().nullable(),
  payTo: z.string().nullable(),
  payer: z.string(),
  receipt: PaymentReceiptSchema.nullable(),
  responseContentType: z.string().nullable(),
  responseBody: z.string().describe(
    "Response body of the paid request (truncated to 64 KiB).",
  ),
  paidAt: z.string(),
});

const ProbeArgsSchema = z.object({
  url: z.string().url(),
  method: z.enum(HTTP_METHODS).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  requestId: z.string().default("latest").describe(
    "Instance name for the stored quote — use distinct values to keep separate quotes.",
  ),
});

const PayArgsSchema = z.object({
  url: z.string().url(),
  method: z.enum(HTTP_METHODS).default("GET"),
  headers: z.record(z.string(), z.string()).optional().describe(
    "Extra request headers (e.g. Content-Type). The X-PAYMENT header is added automatically.",
  ),
  body: z.string().optional().describe(
    "Raw request body string sent on both the challenge and paid attempts.",
  ),
  maxAmountUsdc: z.number().positive().optional().describe(
    "Override the model's default per-request ceiling for this call.",
  ),
  requestId: z.string().default("latest").describe(
    "Instance name for the stored payment record — use distinct values to keep separate receipts.",
  ),
});

/** The maximum response body we persist, to keep data snapshots bounded. */
const MAX_BODY_BYTES = 64 * 1024;

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

type PayContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: WriteResource;
};
type ProbeContext = PayContext;

/** Convert a base-unit token amount string to whole USDC, best effort. */
function toUsdc(base: string, decimals: number): number | undefined {
  try {
    return Number(BigInt(base)) / 10 ** decimals;
  } catch {
    return undefined;
  }
}

/** Read a response body as text, capped at MAX_BODY_BYTES. */
async function readCappedBody(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > MAX_BODY_BYTES
    ? text.slice(0, MAX_BODY_BYTES) + "\n…[truncated]"
    : text;
}

/** Normalize the `accepts` array from a 402 body into typed requirements. */
function parseAccepts(
  body: unknown,
  decimals: number,
): {
  version: number | null;
  accepts: z.infer<typeof PaymentRequirementSchema>[];
  error: string | null;
} {
  const obj = (body ?? {}) as Record<string, unknown>;
  const rawAccepts = Array.isArray(obj.accepts) ? obj.accepts : [];
  const accepts = rawAccepts.map((raw) => {
    const r = raw as Record<string, unknown>;
    const maxAmountRequired = String(r.maxAmountRequired ?? "");
    return {
      scheme: String(r.scheme ?? ""),
      network: String(r.network ?? ""),
      maxAmountRequired,
      resource: r.resource != null ? String(r.resource) : undefined,
      description: r.description != null ? String(r.description) : undefined,
      mimeType: r.mimeType != null ? String(r.mimeType) : undefined,
      payTo: r.payTo != null ? String(r.payTo) : undefined,
      asset: r.asset != null ? String(r.asset) : undefined,
      maxTimeoutSeconds: typeof r.maxTimeoutSeconds === "number"
        ? r.maxTimeoutSeconds
        : undefined,
      amountUsdc: maxAmountRequired
        ? toUsdc(maxAmountRequired, decimals)
        : undefined,
    };
  });
  return {
    version: typeof obj.x402Version === "number" ? obj.x402Version : null,
    accepts,
    error: obj.error != null ? String(obj.error) : null,
  };
}

/** A random 32-byte nonce as a 0x-prefixed hex string. */
function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

/**
 * Build the base64 `X-PAYMENT` header value for the "exact" EVM scheme by
 * signing an EIP-3009 TransferWithAuthorization with the wallet.
 */
async function buildPaymentHeader(
  account: ReturnType<typeof privateKeyToAccount>,
  requirement: z.infer<typeof PaymentRequirementSchema>,
  extra: Record<string, unknown>,
  x402Version: number,
): Promise<string> {
  const chainId = NETWORK_CHAIN_IDS[requirement.network];
  if (chainId === undefined) {
    throw new Error(
      `Unsupported x402 network "${requirement.network}". Supported: ${
        Object.keys(NETWORK_CHAIN_IDS).join(", ")
      }`,
    );
  }
  if (!requirement.payTo || !requirement.asset) {
    throw new Error(
      "Payment requirement is missing payTo or asset; cannot sign authorization",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const validBefore = now + (requirement.maxTimeoutSeconds ?? 60);
  const nonce = randomNonce();
  const value = BigInt(requirement.maxAmountRequired);

  // Domain name/version come from the requirement's `extra` (EIP-712 domain of
  // the token contract, e.g. { name: "USDC", version: "2" }).
  const domainName = typeof extra.name === "string" ? extra.name : "USD Coin";
  const domainVersion = typeof extra.version === "string" ? extra.version : "2";

  const signature = await account.signTypedData({
    domain: {
      name: domainName,
      version: domainVersion,
      chainId,
      verifyingContract: requirement.asset as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: requirement.payTo as `0x${string}`,
      value,
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  const payload = {
    x402Version,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: requirement.payTo,
        value: value.toString(),
        validAfter: "0",
        validBefore: String(validBefore),
        nonce,
      },
    },
  };

  return btoa(JSON.stringify(payload));
}

/** Decode the base64 `X-PAYMENT-RESPONSE` settlement receipt, if present. */
function decodePaymentResponse(
  header: string | null,
): z.infer<typeof PaymentReceiptSchema> | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(atob(header)) as Record<string, unknown>;
    return {
      success: decoded.success === true,
      transaction: decoded.transaction != null
        ? String(decoded.transaction)
        : null,
      network: decoded.network != null ? String(decoded.network) : null,
      payer: decoded.payer != null ? String(decoded.payer) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Cloudflare x402 model — pay for and inspect x402-protected HTTP resources.
 */
export const model = {
  type: "@sntxrr/cloudflare-x402",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "payment": {
      description:
        "Result of a paid x402 request, including the on-chain settlement receipt",
      schema: PaymentSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "quote": {
      description:
        "Payment requirements advertised by an x402 resource, captured without paying",
      schema: QuoteSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    probe: {
      description:
        "Inspect an x402 resource's price by reading its 402 challenge, without paying",
      arguments: ProbeArgsSchema,
      execute: async (
        args: z.infer<typeof ProbeArgsSchema>,
        context: ProbeContext,
      ) => {
        const { globalArgs, logger } = context;
        logger.info("Probing x402 resource {url}", { url: args.url });

        const res = await fetch(args.url, {
          method: args.method,
          headers: args.headers,
        });

        let parsed = {
          version: null as number | null,
          accepts: [] as z.infer<typeof PaymentRequirementSchema>[],
          error: null as string | null,
        };
        if (res.status === 402) {
          try {
            parsed = parseAccepts(await res.json(), globalArgs.tokenDecimals);
          } catch {
            parsed.error = "402 response body was not valid JSON";
          }
        } else {
          // Drain the body so the connection can be reused.
          await res.text().catch(() => {});
        }

        const handle = await context.writeResource("quote", args.requestId, {
          url: args.url,
          method: args.method,
          paymentRequired: res.status === 402,
          httpStatus: res.status,
          x402Version: parsed.version,
          accepts: parsed.accepts,
          error: parsed.error,
          fetchedAt: new Date().toISOString(),
        });

        logger.info(
          res.status === 402
            ? "Resource requires payment: {count} option(s)"
            : "Resource returned {status} — no payment required",
          { count: parsed.accepts.length, status: res.status },
        );
        return { dataHandles: [handle] };
      },
    },
    pay: {
      description:
        "Fetch an x402-protected resource, auto-paying the required USDC via the configured wallet",
      arguments: PayArgsSchema,
      execute: async (
        args: z.infer<typeof PayArgsSchema>,
        context: PayContext,
      ) => {
        const { globalArgs, logger } = context;
        const account = privateKeyToAccount(
          globalArgs.privateKey as `0x${string}`,
        );
        const ceilingUsdc = args.maxAmountUsdc ?? globalArgs.maxAmountUsdc;

        logger.info("Requesting x402 resource {url} as {payer}", {
          url: args.url,
          payer: account.address,
        });

        // First attempt — expect a 402 challenge (or a free 200).
        const challenge = await fetch(args.url, {
          method: args.method,
          headers: args.headers,
          body: args.body,
        });

        if (challenge.status !== 402) {
          const body = await readCappedBody(challenge);
          const handle = await context.writeResource(
            "payment",
            args.requestId,
            {
              url: args.url,
              method: args.method,
              paid: false,
              httpStatus: challenge.status,
              network: null,
              amountUsdc: null,
              payTo: null,
              payer: account.address,
              receipt: null,
              responseContentType: challenge.headers.get("content-type"),
              responseBody: body,
              paidAt: new Date().toISOString(),
            },
          );
          logger.info(
            "Resource returned {status} without a payment challenge — nothing paid",
            { status: challenge.status },
          );
          return { dataHandles: [handle] };
        }

        const challengeBody = await challenge.json().catch(() => ({}));
        const { version, accepts } = parseAccepts(
          challengeBody,
          globalArgs.tokenDecimals,
        );

        // Select a requirement we can settle: an EVM "exact" scheme on a known
        // network, cheapest first.
        const candidates = accepts
          .filter((r) =>
            r.scheme === "exact" && NETWORK_CHAIN_IDS[r.network] !== undefined
          )
          .sort((a, b) => {
            try {
              const d = BigInt(a.maxAmountRequired) -
                BigInt(b.maxAmountRequired);
              return d < 0n ? -1 : d > 0n ? 1 : 0;
            } catch {
              return 0;
            }
          });

        const requirement = candidates[0];
        if (!requirement) {
          throw new Error(
            `No settleable "exact" EVM payment option offered by ${args.url}. Offered: ${
              accepts.map((a) => `${a.scheme}/${a.network}`).join(", ") ||
              "none"
            }`,
          );
        }

        // Enforce the spend ceiling before signing anything.
        const ceilingBase = BigInt(
          Math.round(ceilingUsdc * 10 ** globalArgs.tokenDecimals),
        );
        const required = BigInt(requirement.maxAmountRequired);
        if (required > ceilingBase) {
          const amountUsdc = toUsdc(
            requirement.maxAmountRequired,
            globalArgs.tokenDecimals,
          );
          throw new Error(
            `Required payment ${amountUsdc} USDC exceeds the ${ceilingUsdc} USDC ceiling for ${args.url}. Raise maxAmountUsdc to proceed.`,
          );
        }

        const rawRequirement = (Array.isArray(
            (challengeBody as Record<string, unknown>).accepts,
          )
          ? ((challengeBody as Record<string, unknown>).accepts as unknown[])[
            accepts.indexOf(requirement)
          ]
          : {}) as Record<string, unknown>;
        const extra = (rawRequirement.extra ?? {}) as Record<string, unknown>;

        logger.info(
          "Paying {amount} USDC on {network} to {payTo}",
          {
            amount: requirement.amountUsdc,
            network: requirement.network,
            payTo: requirement.payTo,
          },
        );

        const paymentHeader = await buildPaymentHeader(
          account,
          requirement,
          extra,
          version ?? 1,
        );

        // Retry with the signed payment authorization.
        const paidRes = await fetch(args.url, {
          method: args.method,
          headers: { ...args.headers, "X-PAYMENT": paymentHeader },
          body: args.body,
        });

        const receipt = decodePaymentResponse(
          paidRes.headers.get("x-payment-response"),
        );
        const responseBody = await readCappedBody(paidRes);

        if (!paidRes.ok) {
          throw new Error(
            `x402 payment retry failed with ${paidRes.status}: ${responseBody}`,
          );
        }

        const handle = await context.writeResource("payment", args.requestId, {
          url: args.url,
          method: args.method,
          paid: true,
          httpStatus: paidRes.status,
          network: requirement.network,
          amountUsdc: requirement.amountUsdc ?? null,
          payTo: requirement.payTo ?? null,
          payer: account.address,
          receipt,
          responseContentType: paidRes.headers.get("content-type"),
          responseBody,
          paidAt: new Date().toISOString(),
        });

        logger.info(
          "Paid request settled ({success}) — tx {tx}",
          {
            success: receipt?.success ?? "unknown",
            tx: receipt?.transaction ?? "n/a",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
