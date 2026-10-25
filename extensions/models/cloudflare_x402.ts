/**
 * Cloudflare x402 payments — let a swamp agent pay for HTTP resources and MCP
 * tools that are gated behind the [x402 payment standard](https://x402.org).
 *
 * The `pay` method drives the full 402 flow: it requests a protected resource,
 * reads the `402 Payment Required` challenge, signs an EIP-3009
 * `TransferWithAuthorization` (USDC "exact" scheme) with the configured wallet,
 * retries with the signed payment, and stores the settlement receipt. The
 * `probe` method inspects the price without paying.
 *
 * Both x402 transports are supported. v1 sends the challenge as a JSON body and
 * uses `X-PAYMENT` / `X-PAYMENT-RESPONSE`; v2 sends it base64-encoded in the
 * `PAYMENT-REQUIRED` header with CAIP-2 network ids (`eip155:8453`) and uses
 * `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`. The envelope follows the
 * challenge's `x402Version`.
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

const SUPPORTED_CHAIN_IDS = new Set(Object.values(NETWORK_CHAIN_IDS));

/**
 * The chain ID for a v1 network name (`base`) or a v2 CAIP-2 id
 * (`eip155:8453`). CAIP-2 ids are accepted only for the chains the v1 names
 * cover, so v2 does not widen the set of chains this wallet will sign for.
 */
function chainIdFor(network: string): number | undefined {
  if (Object.hasOwn(NETWORK_CHAIN_IDS, network)) {
    return NETWORK_CHAIN_IDS[network];
  }
  const m = /^eip155:(\d+)$/.exec(network);
  if (m) {
    const id = Number(m[1]);
    if (SUPPORTED_CHAIN_IDS.has(id)) return id;
  }
  return undefined;
}

/** Base64 of a string's UTF-8 bytes (v2 headers carry server free text). */
function b64EncodeUtf8(text: string): string {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/** Decode base64 to a UTF-8 string; throws on invalid base64 or UTF-8. */
function b64DecodeUtf8(value: string): string {
  const binary = atob(value.trim());
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** USDC and most x402-settled stablecoins expose 6 decimals. */
const DEFAULT_TOKEN_DECIMALS = 6;

/** swamp imposes no method timeout, so every request carries its own. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** The longest a signed authorization stays valid, whatever the server asks. */
const MAX_VALIDITY_SECONDS = 300;

const GlobalArgsSchema = z.object({
  privateKey: z.string().meta({ sensitive: true }).regex(
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
  timeoutSeconds: z.number().int().min(1).default(DEFAULT_TIMEOUT_SECONDS)
    .describe(
      "Default time limit, in seconds, for each HTTP request including its response body. Per-call `timeoutSeconds` overrides it.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** One entry from an x402 server's `accepts` list (a payment requirement). */
const PaymentRequirementSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  maxAmountRequired: z.string().describe(
    "Price in token base units: v1 `maxAmountRequired`, or v2 `amount`.",
  ),
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
  errorReason: z.string().nullable().optional().describe(
    "Why the server did not settle, when it said so.",
  ),
});

const PaymentSchema = z.object({
  url: z.string(),
  method: z.string(),
  paid: z.boolean(),
  httpStatus: z.number().describe(
    "HTTP status of the final response; 0 when the paid retry timed out before any response arrived.",
  ),
  network: z.string().nullable(),
  amountUsdc: z.number().nullable(),
  payTo: z.string().nullable(),
  payer: z.string(),
  receipt: PaymentReceiptSchema.nullable(),
  responseContentType: z.string().nullable(),
  responseBody: z.string().describe(
    "Response body of the paid request (truncated to 64 KiB).",
  ),
  responseTruncated: z.boolean().describe(
    "True when responseBody was capped at 64 KiB.",
  ),
  paidAt: z.string(),
  refused: z.boolean().optional().describe(
    "True when the server refused the signed payment at verification (a v2 402 carrying a PAYMENT-REQUIRED error and no PAYMENT-RESPONSE). paid stays true: the authorization was sent and stays valid until validBefore, so this is the server's word, not proof.",
  ),
  validBefore: z.string().optional().describe(
    "When the signed authorization expires (ISO 8601); after this it can no longer settle.",
  ),
  authorizationNonce: z.string().optional().describe(
    "The EIP-3009 nonce of the signed authorization, to check its use on-chain.",
  ),
});

const ProbeArgsSchema = z.object({
  url: z.string().url(),
  method: z.enum(HTTP_METHODS).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutSeconds: z.number().int().min(1).optional().describe(
    "Override the model's default per-request time limit for this call.",
  ),
  requestId: z.string().default("quote").describe(
    "Instance name for the stored quote (default 'quote', distinct from pay's 'payment' so a probe never becomes the latest version of a payment). Use distinct values to keep separate quotes. Avoid the reserved name 'latest'.",
  ),
});

const PayArgsSchema = z.object({
  url: z.string().url(),
  method: z.enum(HTTP_METHODS).default("GET"),
  headers: z.record(z.string(), z.string()).optional().describe(
    "Extra request headers (e.g. Content-Type). The payment header (X-PAYMENT for x402 v1, PAYMENT-SIGNATURE for v2) is added automatically.",
  ),
  body: z.string().optional().describe(
    "Raw request body string sent on both the challenge and paid attempts.",
  ),
  maxAmountUsdc: z.number().positive().optional().describe(
    "Override the model's default per-request ceiling for this call.",
  ),
  timeoutSeconds: z.number().int().min(1).optional().describe(
    "Override the model's default per-request time limit for this call.",
  ),
  requestId: z.string().default("payment").describe(
    "Instance name for the stored payment record (default 'payment', distinct from probe's 'quote'). Repeated pays on one name are kept as versions and all count toward spend. Avoid the reserved name 'latest'.",
  ),
});

/** True for the rejection an `AbortSignal.timeout` signal produces. */
function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

function timeoutError(what: string, url: string, seconds: number): Error {
  return new Error(`${what} ${url} timed out after ${seconds}s`);
}

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
async function readCappedBody(
  res: Response,
): Promise<{ body: string; truncated: boolean }> {
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) {
    return {
      body: text.slice(0, MAX_BODY_BYTES) + "\n…[truncated]",
      truncated: true,
    };
  }
  return { body: text, truncated: false };
}

/** Where a 402 challenge was read from, and its decoded object. */
type Challenge = {
  source: "header" | "body";
  obj: Record<string, unknown>;
  error: string | null;
};

/**
 * Read a 402 challenge: the v2 `PAYMENT-REQUIRED` header (base64 JSON) when
 * present, otherwise the v1 JSON body. The header wins over the body.
 */
async function readChallenge(res: Response): Promise<Challenge> {
  const header = res.headers.get("payment-required");
  if (header) {
    // Drain the body so the connection can be reused.
    await res.text().catch((err) => {
      if (isTimeout(err)) throw err;
    });
    try {
      const obj = JSON.parse(b64DecodeUtf8(header));
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return { source: "header", obj, error: null };
      }
    } catch {
      // fall through
    }
    return {
      source: "header",
      obj: {},
      error: "PAYMENT-REQUIRED header was not valid base64 JSON",
    };
  }
  try {
    const body = await res.json();
    return {
      source: "body",
      obj: (body ?? {}) as Record<string, unknown>,
      error: null,
    };
  } catch (err) {
    if (isTimeout(err)) throw err;
    return {
      source: "body",
      obj: {},
      error: "402 response body was not valid JSON",
    };
  }
}

/**
 * Normalize a challenge's `accepts` into typed requirements. `raws[i]` is the
 * server's own object for `accepts[i]`: it is signed against and echoed back
 * (v2 `accepted`), and is kept apart so it never reaches a stored quote.
 */
function parseAccepts(
  obj: Record<string, unknown>,
  decimals: number,
): {
  version: number | null;
  accepts: z.infer<typeof PaymentRequirementSchema>[];
  raws: Record<string, unknown>[];
  resource: unknown;
  error: string | null;
} {
  const rawAccepts = Array.isArray(obj.accepts) ? obj.accepts : [];
  const raws = rawAccepts.map((raw) =>
    (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  );
  // v2 names the resource once, at the top level, as an object.
  const topResource = obj.resource as Record<string, unknown> | undefined;
  const topResourceUrl = topResource && typeof topResource === "object" &&
      topResource.url != null
    ? String(topResource.url)
    : undefined;
  const version = typeof obj.x402Version === "number" ? obj.x402Version : null;
  const accepts = raws.map((r) => {
    // The price field follows x402Version, like the envelope: v2 `amount`,
    // v1 `maxAmountRequired`, each falling back to the other.
    const maxAmountRequired = String(
      (version === 2
        ? r.amount ?? r.maxAmountRequired
        : r.maxAmountRequired ?? r.amount) ?? "",
    );
    return {
      scheme: String(r.scheme ?? ""),
      network: String(r.network ?? ""),
      maxAmountRequired,
      resource: r.resource != null && typeof r.resource !== "object"
        ? String(r.resource)
        : topResourceUrl,
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
    version,
    accepts,
    raws,
    resource: obj.resource,
    error: obj.error != null ? String(obj.error) : null,
  };
}

/**
 * True when this wallet can settle a requirement: the EVM "exact" scheme on a
 * supported chain, via EIP-3009 (the default when `assetTransferMethod` is
 * absent). Permit2 and other transfer methods are not signed.
 */
function isSettleable(
  r: z.infer<typeof PaymentRequirementSchema>,
  raw: Record<string, unknown>,
): boolean {
  const extra = (raw.extra ?? {}) as Record<string, unknown>;
  const method = extra.assetTransferMethod;
  return r.scheme === "exact" && chainIdFor(r.network) !== undefined &&
    (method === undefined || method === "eip3009");
}

/** A random 32-byte nonce as a 0x-prefixed hex string. */
function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

/** A signed payment, ready to send, and what is needed to audit it. */
type SignedPayment = {
  headerName: "X-PAYMENT" | "PAYMENT-SIGNATURE";
  headerValue: string;
  validBefore: number;
  nonce: string;
};

/**
 * Sign an EIP-3009 TransferWithAuthorization for the "exact" EVM scheme and
 * wrap it in the envelope for the challenge's x402 version: v1 `X-PAYMENT`
 * `{x402Version, scheme, network, payload}`, or v2 `PAYMENT-SIGNATURE`
 * `{x402Version, resource, accepted, payload}` with `accepted` the server's own
 * requirement object, echoed as received.
 */
async function signPayment(
  account: ReturnType<typeof privateKeyToAccount>,
  requirement: z.infer<typeof PaymentRequirementSchema>,
  raw: Record<string, unknown>,
  x402Version: 1 | 2,
  resource: unknown,
): Promise<SignedPayment> {
  const chainId = chainIdFor(requirement.network);
  if (chainId === undefined) {
    throw new Error(
      `Unsupported x402 network "${requirement.network}". Supported: ${
        Object.entries(NETWORK_CHAIN_IDS).map(([name, id]) =>
          `${name} (eip155:${id})`
        ).join(", ")
      }`,
    );
  }
  if (!requirement.payTo || !requirement.asset) {
    throw new Error(
      "Payment requirement is missing payTo or asset; cannot sign authorization",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  // The server sets maxTimeoutSeconds, so cap it: a signed authorization stays
  // spendable until validBefore, and a refused payment stays outstanding. A
  // timeout of 0 or less would sign an already-expired authorization, and a
  // fractional one cannot be signed as a uint256.
  const asked = requirement.maxTimeoutSeconds === undefined
    ? undefined
    : Math.floor(requirement.maxTimeoutSeconds);
  const validBefore = now +
    Math.min(
      asked !== undefined && asked > 0 ? asked : 60,
      MAX_VALIDITY_SECONDS,
    );
  const nonce = randomNonce();
  const value = BigInt(requirement.maxAmountRequired);

  // Domain name/version come from the requirement's `extra` (EIP-712 domain of
  // the token contract, e.g. { name: "USDC", version: "2" }).
  const extra = (raw.extra ?? {}) as Record<string, unknown>;
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

  const signed = {
    signature,
    authorization: {
      from: account.address,
      to: requirement.payTo,
      value: value.toString(),
      validAfter: "0",
      validBefore: String(validBefore),
      nonce,
    },
  };

  if (x402Version === 2) {
    const payload: Record<string, unknown> = { x402Version: 2 };
    if (resource !== undefined) payload.resource = resource;
    payload.accepted = raw;
    payload.payload = signed;
    return {
      headerName: "PAYMENT-SIGNATURE",
      headerValue: b64EncodeUtf8(JSON.stringify(payload)),
      validBefore,
      nonce,
    };
  }

  return {
    headerName: "X-PAYMENT",
    headerValue: btoa(JSON.stringify({
      x402Version,
      scheme: requirement.scheme,
      network: requirement.network,
      payload: signed,
    })),
    validBefore,
    nonce,
  };
}

/**
 * Decode a settlement receipt: v2 `PAYMENT-RESPONSE` (base64 UTF-8 JSON) or
 * v1 `X-PAYMENT-RESPONSE`. Returns null when neither header is present or the
 * value cannot be decoded.
 */
function decodePaymentResponse(
  res: Response,
): z.infer<typeof PaymentReceiptSchema> | null {
  const v2 = res.headers.get("payment-response");
  const header = v2 ?? res.headers.get("x-payment-response");
  if (!header) return null;
  try {
    const decoded = JSON.parse(
      v2 ? b64DecodeUtf8(header) : atob(header),
    ) as Record<string, unknown>;
    return {
      success: decoded.success === true,
      // v2 facilitators send "" when nothing was broadcast.
      transaction: decoded.transaction != null &&
          !(v2 && decoded.transaction === "")
        ? String(decoded.transaction)
        : null,
      network: decoded.network != null ? String(decoded.network) : null,
      payer: decoded.payer != null ? String(decoded.payer) : null,
      errorReason: decoded.errorReason != null
        ? String(decoded.errorReason)
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * The reason a v2 server refused a payment at verification: a non-2xx paid
 * retry with no settlement receipt, carrying a fresh `PAYMENT-REQUIRED` header
 * whose `error` names why. Null when the response is not that shape.
 */
function verifyRefusalReason(res: Response): string | null {
  if (res.ok) return null;
  if (res.headers.get("payment-response")) return null;
  if (res.headers.get("x-payment-response")) return null;
  const header = res.headers.get("payment-required");
  if (!header) return null;
  try {
    const obj = JSON.parse(b64DecodeUtf8(header)) as Record<string, unknown>;
    return obj.error != null && String(obj.error) !== ""
      ? String(obj.error)
      : null;
  } catch {
    return null;
  }
}

/**
 * Cloudflare x402 model — pay for and inspect x402-protected HTTP resources.
 */
export const model = {
  type: "@sntxrr/cloudflare-x402",
  version: "2026.10.24.1",
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
        // Definitions saved before 2026.09.29.2 may lack timeoutSeconds.
        const timeoutSeconds = args.timeoutSeconds ??
          globalArgs.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
        logger.info("Probing x402 resource {url}", { url: args.url });

        // One signal covers the request and the body read.
        const signal = AbortSignal.timeout(timeoutSeconds * 1000);
        let res: Response;
        try {
          res = await fetch(args.url, {
            method: args.method,
            headers: args.headers,
            signal,
          });
        } catch (err) {
          if (isTimeout(err)) {
            throw timeoutError("Probe of", args.url, timeoutSeconds);
          }
          throw err;
        }

        let parsed = {
          version: null as number | null,
          accepts: [] as z.infer<typeof PaymentRequirementSchema>[],
          error: null as string | null,
        };
        if (res.status === 402) {
          let challenge: Challenge;
          try {
            challenge = await readChallenge(res);
          } catch (err) {
            if (isTimeout(err)) {
              throw timeoutError("Probe of", args.url, timeoutSeconds);
            }
            throw err;
          }
          if (challenge.error) {
            parsed.error = challenge.error;
          } else {
            const { version, accepts, error } = parseAccepts(
              challenge.obj,
              globalArgs.tokenDecimals,
            );
            parsed = { version, accepts, error };
            if (challenge.source === "header" && version !== 2) {
              parsed.error = `PAYMENT-REQUIRED header carried x402Version ${
                version ?? "(none)"
              }; only 2 is supported in that header`;
            }
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
        // Definitions saved before 2026.09.29.2 may lack timeoutSeconds.
        const timeoutSeconds = args.timeoutSeconds ??
          globalArgs.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

        logger.info("Requesting x402 resource {url} as {payer}", {
          url: args.url,
          payer: account.address,
        });

        // First attempt — expect a 402 challenge (or a free 200). Nothing
        // has been signed yet, so a timeout here spends nothing.
        const challengeSignal = AbortSignal.timeout(timeoutSeconds * 1000);
        const challengeTimedOut = () =>
          timeoutError(
            "Payment challenge request to",
            args.url,
            timeoutSeconds,
          );
        let challenge: Response;
        try {
          challenge = await fetch(args.url, {
            method: args.method,
            headers: args.headers,
            body: args.body,
            signal: challengeSignal,
          });
        } catch (err) {
          if (isTimeout(err)) throw challengeTimedOut();
          throw err;
        }

        if (challenge.status !== 402) {
          const { body, truncated } = await readCappedBody(challenge).catch(
            (err) => {
              throw isTimeout(err) ? challengeTimedOut() : err;
            },
          );
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
              responseTruncated: truncated,
              paidAt: new Date().toISOString(),
            },
          );
          logger.info(
            "Resource returned {status} without a payment challenge — nothing paid",
            { status: challenge.status },
          );
          return { dataHandles: [handle] };
        }

        let parsedChallenge: Challenge;
        try {
          parsedChallenge = await readChallenge(challenge);
        } catch (err) {
          throw isTimeout(err) ? challengeTimedOut() : err;
        }
        if (parsedChallenge.source === "header" && parsedChallenge.error) {
          throw new Error(
            `${parsedChallenge.error} from ${args.url}; nothing was signed.`,
          );
        }
        const { version, accepts, raws, resource } = parseAccepts(
          parsedChallenge.obj,
          globalArgs.tokenDecimals,
        );

        // The envelope follows the challenge's x402Version, not where the
        // challenge was found. A version we cannot send is refused before
        // anything is signed, and so is a PAYMENT-REQUIRED header that is not
        // v2, which probe reports as an error too.
        let envelope: 1 | 2;
        if (version === 2) {
          envelope = 2;
        } else if (
          parsedChallenge.source === "body" &&
          (version === 1 || version === null)
        ) {
          envelope = 1;
        } else {
          throw new Error(
            `Unsupported x402Version ${version ?? "(none)"} in the ${
              parsedChallenge.source === "header"
                ? "PAYMENT-REQUIRED header"
                : "402 body"
            } from ${args.url}; nothing was signed.`,
          );
        }

        // Select a requirement we can settle: an EVM "exact" scheme on a known
        // network via EIP-3009, cheapest first.
        const candidates = accepts
          .map((r, i) => ({ r, raw: raws[i] }))
          .filter(({ r, raw }) => isSettleable(r, raw))
          .sort((a, b) => {
            try {
              const d = BigInt(a.r.maxAmountRequired) -
                BigInt(b.r.maxAmountRequired);
              return d < 0n ? -1 : d > 0n ? 1 : 0;
            } catch {
              return 0;
            }
          });

        const chosen = candidates[0];
        if (!chosen) {
          throw new Error(
            `No settleable "exact" EVM payment option offered by ${args.url}. Offered: ${
              accepts.map((a, i) => {
                const method = ((raws[i].extra ?? {}) as Record<
                  string,
                  unknown
                >).assetTransferMethod;
                return `${a.scheme}/${a.network}${
                  method !== undefined ? ` (${String(method)})` : ""
                }`;
              }).join(", ") || "none"
            }`,
          );
        }
        const requirement = chosen.r;

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

        logger.info(
          "Paying {amount} USDC on {network} to {payTo}",
          {
            amount: requirement.amountUsdc,
            network: requirement.network,
            payTo: requirement.payTo,
          },
        );

        const signed = await signPayment(
          account,
          requirement,
          chosen.raw,
          envelope,
          resource,
        );
        const validBeforeIso = new Date(signed.validBefore * 1000)
          .toISOString();
        const audit = {
          validBefore: validBeforeIso,
          authorizationNonce: signed.nonce,
        };

        // Retry with the signed payment authorization. Once it is sent the
        // payment may settle, so a timeout from here on must still leave a
        // payment record (receipt unknown) rather than lose it.
        const paidSignal = AbortSignal.timeout(timeoutSeconds * 1000);
        let paidRes: Response | null = null;
        let receipt: z.infer<typeof PaymentReceiptSchema> | null = null;
        let refusal: string | null = null;
        let responseBody = "";
        let responseTruncated = false;
        try {
          paidRes = await fetch(args.url, {
            method: args.method,
            headers: {
              ...args.headers,
              [signed.headerName]: signed.headerValue,
            },
            body: args.body,
            signal: paidSignal,
          });
          receipt = decodePaymentResponse(paidRes);
          refusal = receipt ? null : verifyRefusalReason(paidRes);
          ({ body: responseBody, truncated: responseTruncated } =
            await readCappedBody(paidRes));
        } catch (err) {
          if (!isTimeout(err)) throw err;
          const handle = await context.writeResource(
            "payment",
            args.requestId,
            {
              url: args.url,
              method: args.method,
              paid: true,
              httpStatus: paidRes?.status ?? 0,
              network: requirement.network,
              amountUsdc: requirement.amountUsdc ?? null,
              payTo: requirement.payTo ?? null,
              payer: account.address,
              receipt,
              responseContentType: paidRes?.headers.get("content-type") ??
                null,
              responseBody: "",
              responseTruncated: false,
              paidAt: new Date().toISOString(),
              refused: false,
              ...audit,
            },
          );
          logger.warn(
            "Paid retry timed out; recorded as {name} with an unconfirmed receipt",
            { name: handle.name },
          );
          throw new Error(
            `Paid retry to ${args.url} timed out after ${timeoutSeconds}s after the ${signed.headerName} header was sent — the payment may have settled. Recorded as paid with no receipt in '${args.requestId}'; check the payer's on-chain history before retrying.`,
          );
        }

        if (refusal !== null) {
          receipt = {
            success: false,
            transaction: null,
            network: requirement.network,
            payer: account.address,
            errorReason: refusal,
          };
        }

        // Record before checking the status: an error response to the paid
        // retry does not mean the payment failed to settle (the receipt may
        // even say it did), so the evidence is kept either way.
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
          responseTruncated,
          paidAt: new Date().toISOString(),
          refused: refusal !== null,
          ...audit,
        });

        if (refusal !== null) {
          logger.warn(
            "Payment refused at verification ({reason}); recorded as {name}",
            { reason: refusal, name: handle.name },
          );
          throw new Error(
            `x402 payment to ${args.url} was refused at verification (${paidRes.status}): ${refusal}. The server reported it did not settle. The signed authorization (nonce ${signed.nonce}) stays valid until ${validBeforeIso}; treat it as outstanding until then. Recorded as refused in '${args.requestId}'.`,
          );
        }

        if (!paidRes.ok) {
          logger.warn(
            "Paid retry returned {status}; recorded as {name} (settled: {success})",
            {
              status: paidRes.status,
              name: handle.name,
              success: receipt?.success ?? "unknown",
            },
          );
          throw new Error(
            `x402 payment retry failed with ${paidRes.status}: ${responseBody} — the ${signed.headerName} header was sent, so the payment may have settled. Recorded as paid in '${args.requestId}' (receipt: ${
              receipt?.transaction ?? "none"
            }${
              receipt?.errorReason ? `, reason: ${receipt.errorReason}` : ""
            }); check the payer's on-chain history before retrying.`,
          );
        }

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
  reports: ["@sntxrr/x402-spend"],
  upgrades: [
    {
      toVersion: "2026.09.29.1",
      description:
        "probe and pay default to separate data names ('quote' / 'payment') instead of sharing 'current'; no globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.29.2",
      description:
        "HTTP requests time out (new optional global argument timeoutSeconds, default 30 — no migration needed); a timed-out paid retry is recorded as paid with no receipt",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.29.3",
      description:
        "a paid retry that returns an error status is recorded as paid (with its status and any receipt) before the method fails; no globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.24.1",
      description:
        "x402 v2 support (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers, CAIP-2 networks); payment records gain optional refused, validBefore and authorizationNonce, receipts gain errorReason; a signed authorization is valid for at most 300s, and for 60s when the offer asks 0 or less (v1 and v2 alike); the x402-spend report labels networks by CAIP-2 id, so v1 rows read eip155:8453 where they read base (markdown and json.byNetwork); no globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};
