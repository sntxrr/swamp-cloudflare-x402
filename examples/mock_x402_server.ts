// A minimal mock x402 resource server for testing @sntxrr/cloudflare-x402.
// No blockchain, no funds — it checks the client flow, not settlement.
//
//   deno run --allow-net examples/mock_x402_server.ts [port] [--v2] [--unfunded <address>]
//
// v1 (default): issues the challenge as a JSON body (USDC "exact" on
// base-sepolia) and, when an X-PAYMENT header is present, "settles" it and
// returns a mock receipt in X-PAYMENT-RESPONSE.
//
// --v2: serves the x402 v2 spec's example challenge byte for byte in the
// PAYMENT-REQUIRED header (eip155:84532) and requires PAYMENT-SIGNATURE. It
// verifies the payment the way a facilitator would before answering: the
// echoed `accepted` must equal the offer, the authorization must pay the
// offered amount to payTo, and the EIP-712 signature must recover `from`.
// A refusal is answered like the reference server's failed verify: 402, an
// empty body, and a fresh PAYMENT-REQUIRED header whose `error` names the
// reason. --unfunded <address> refuses that payer for insufficient balance.
import { verifyTypedData } from "npm:viem@2.21.26";

const args = [...Deno.args];
const v2 = args.includes("--v2");
const unfundedAt = args.indexOf("--unfunded");
const UNFUNDED = unfundedAt >= 0 ? args[unfundedAt + 1]?.toLowerCase() : null;
const portArg = args.find((a, i) =>
  /^\d+$/.test(a) && args[i - 1] !== "--unfunded"
);
const PORT = Number(portArg ?? "4021");

// Base-Sepolia USDC contract + an arbitrary payee address.
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PRICE = "10000"; // 0.01 USDC (6 decimals)

function challenge() {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: PRICE,
        resource: `http://localhost:${PORT}/paid`,
        description: "Mock premium weather data",
        mimeType: "application/json",
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

// The x402 v2 spec's example PAYMENT-REQUIRED header, byte for byte
// (coinbase/x402 specs/transports-v2/http.md at commit 0e6e8c5).
const V2_PAYMENT_REQUIRED =
  "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19";
const V2_CHALLENGE = JSON.parse(atob(V2_PAYMENT_REQUIRED));
const V2_OFFER = V2_CHALLENGE.accepts[0];

function utf8ToB64(text: string): string {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function b64ToUtf8(value: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
  );
}

/** Order-insensitive deep equality for plain JSON values. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) =>
    k === kb[i] &&
    sameJson(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    )
  );
}

/** A refusal shaped like the reference server's failed verify. */
function v2Refusal(reason: string): Response {
  console.log(`[mock v2] 402 refused at verify: ${reason}`);
  return Response.json({}, {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": utf8ToB64(
        JSON.stringify({ ...V2_CHALLENGE, error: reason }),
      ),
    },
  });
}

/** Verify a v2 PAYMENT-SIGNATURE; the reason it fails, or null. */
async function v2VerifyFailure(header: string): Promise<string | null> {
  let sent: Record<string, unknown>;
  try {
    sent = JSON.parse(b64ToUtf8(header));
  } catch {
    return "invalid_payload";
  }
  if (sent.x402Version !== 2) return "invalid_x402_version";
  if (!sameJson(sent.accepted, V2_OFFER)) return "invalid_exact_evm_payload";
  const payload = (sent.payload ?? {}) as Record<string, unknown>;
  const auth = (payload.authorization ?? {}) as Record<string, string>;
  if (auth.value !== V2_OFFER.amount) return "invalid_exact_evm_payload";
  if (String(auth.to).toLowerCase() !== V2_OFFER.payTo.toLowerCase()) {
    return "invalid_exact_evm_payload";
  }
  let valid = false;
  try {
    // A facilitator's domain: chainId 84532 for eip155:84532, and the offered
    // asset as the verifying contract. Literal here on purpose.
    valid = await verifyTypedData({
      address: auth.from as `0x${string}`,
      domain: {
        name: V2_OFFER.extra.name,
        version: V2_OFFER.extra.version,
        chainId: 84532,
        verifyingContract: V2_OFFER.asset,
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
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: payload.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return "invalid_exact_evm_signature";
  if (UNFUNDED && String(auth.from).toLowerCase() === UNFUNDED) {
    return "invalid_exact_evm_insufficient_balance";
  }
  return null;
}

async function serveV2(req: Request): Promise<Response> {
  if (req.headers.get("x-payment")) {
    return v2Refusal("invalid_x402_version");
  }
  const payment = req.headers.get("payment-signature");
  if (!payment) {
    console.log("[mock v2] 402 challenge issued in PAYMENT-REQUIRED");
    return Response.json({}, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": V2_PAYMENT_REQUIRED },
    });
  }
  const failure = await v2VerifyFailure(payment);
  if (failure) return v2Refusal(failure);

  const payer = JSON.parse(b64ToUtf8(payment)).payload.authorization.from;
  console.log(`[mock v2] PAYMENT-SIGNATURE verified from=${payer}`);
  const receipt = utf8ToB64(JSON.stringify({
    success: true,
    transaction:
      "0xmock000000000000000000000000000000000000000000000000000000000002",
    network: V2_OFFER.network,
    payer,
  }));
  console.log("[mock v2] 200 settled — returning resource + PAYMENT-RESPONSE");
  return Response.json(
    { temperature: "72F", conditions: "sunny", city: "Gainesville" },
    { status: 200, headers: { "PAYMENT-RESPONSE": receipt } },
  );
}

function serveV1(req: Request, path: string): Response {
  const payment = req.headers.get("x-payment");
  if (!payment) {
    console.log(`[mock] 402 challenge issued for ${path}`);
    return Response.json(challenge(), { status: 402 });
  }

  // "Settle" the payment: decode the authorization and echo a mock receipt.
  let payer = "0xunknown";
  try {
    const decoded = JSON.parse(atob(payment));
    payer = decoded?.payload?.authorization?.from ?? payer;
    console.log(
      `[mock] received X-PAYMENT scheme=${decoded.scheme} network=${decoded.network} from=${payer}`,
    );
  } catch {
    console.log("[mock] X-PAYMENT header was not valid base64 JSON");
  }

  const receipt = btoa(JSON.stringify({
    success: true,
    transaction:
      "0xmock000000000000000000000000000000000000000000000000000000000001",
    network: "base-sepolia",
    payer,
  }));

  console.log("[mock] 200 settled — returning resource + X-PAYMENT-RESPONSE");
  return Response.json(
    { temperature: "72F", conditions: "sunny", city: "Gainesville" },
    { status: 200, headers: { "X-PAYMENT-RESPONSE": receipt } },
  );
}

Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);
  if (url.pathname !== "/paid") {
    return new Response("not found", { status: 404 });
  }
  return v2 ? serveV2(req) : serveV1(req, url.pathname);
});
