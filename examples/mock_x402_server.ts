// A minimal mock x402 resource server for testing @sntxrr/cloudflare-x402.
// Issues a real 402 challenge (USDC "exact" scheme on base-sepolia) and, when
// an X-PAYMENT header is present, "settles" it and returns a mock receipt in
// X-PAYMENT-RESPONSE. No blockchain, no funds — it validates the client flow.
const PORT = Number(Deno.args[0] ?? "4021");

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

Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);
  if (url.pathname !== "/paid") {
    return new Response("not found", { status: 404 });
  }

  const payment = req.headers.get("x-payment");
  if (!payment) {
    console.log(`[mock] 402 challenge issued for ${url.pathname}`);
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
});
