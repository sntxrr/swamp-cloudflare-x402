// extensions/models/cloudflare_x402_test.ts
import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing";
import { model } from "./cloudflare_x402.ts";

type ProbeContext = Parameters<typeof model.methods.probe.execute>[1];
type PayContext = Parameters<typeof model.methods.pay.execute>[1];

// A funded throwaway test key — never used against a real network here.
const TEST_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const GLOBAL_ARGS = {
  privateKey: TEST_KEY,
  maxAmountUsdc: 1.0,
  tokenDecimals: 6,
};

// A representative Base-Sepolia USDC "exact" challenge body.
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
function challengeBody(maxAmountRequired: string) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired,
        resource: "https://api.example.com/paid",
        description: "Premium data",
        mimeType: "application/json",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        asset: USDC,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

function probeContext(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const ctx = createModelTestContext({ globalArgs, methodName: "probe" });
  return { ...ctx, context: ctx.context as unknown as ProbeContext };
}

function payContext(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const ctx = createModelTestContext({ globalArgs, methodName: "pay" });
  return { ...ctx, context: ctx.context as unknown as PayContext };
}

Deno.test("probe records payment requirements from a 402", async () => {
  const { context, getWrittenResources } = probeContext();

  await withMockedFetch(
    () =>
      Promise.resolve(
        Response.json(challengeBody("10000"), { status: 402 }),
      ),
    async () => {
      await model.methods.probe.execute(
        { url: "https://api.example.com/paid", method: "GET", requestId: "latest" },
        context,
      );
    },
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "quote");
  assertEquals(written[0].data.paymentRequired, true);
  const accepts = written[0].data.accepts as Array<Record<string, unknown>>;
  assertEquals(accepts.length, 1);
  assertEquals(accepts[0].network, "base-sepolia");
  assertEquals(accepts[0].amountUsdc, 0.01);
});

Deno.test("probe records no-payment when resource is free", async () => {
  const { context, getWrittenResources } = probeContext();

  await withMockedFetch(
    () => Promise.resolve(Response.json({ ok: true }, { status: 200 })),
    async () => {
      await model.methods.probe.execute(
        { url: "https://api.example.com/free", method: "GET", requestId: "latest" },
        context,
      );
    },
  );

  const data = getWrittenResources()[0].data;
  assertEquals(data.paymentRequired, false);
  assertEquals(data.httpStatus, 200);
  assertEquals((data.accepts as unknown[]).length, 0);
});

Deno.test("pay signs, retries with X-PAYMENT, and stores the receipt", async () => {
  const { context, getWrittenResources } = payContext();

  let calls = 0;
  let sentPaymentHeader: string | null = null;
  await withMockedFetch(
    (req) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          Response.json(challengeBody("10000"), { status: 402 }),
        );
      }
      sentPaymentHeader = req.headers.get("X-PAYMENT");
      const receipt = btoa(JSON.stringify({
        success: true,
        transaction: "0xabc123",
        network: "base-sepolia",
        payer: "0xPayer",
      }));
      return Promise.resolve(
        Response.json({ data: "premium" }, {
          status: 200,
          headers: { "X-PAYMENT-RESPONSE": receipt },
        }),
      );
    },
    async () => {
      await model.methods.pay.execute(
        { url: "https://api.example.com/paid", method: "GET", requestId: "latest" },
        context,
      );
    },
  );

  assertEquals(calls, 2);
  // The X-PAYMENT header must be valid base64 JSON for the exact scheme.
  const decoded = JSON.parse(atob(sentPaymentHeader!));
  assertEquals(decoded.scheme, "exact");
  assertEquals(decoded.network, "base-sepolia");
  assertEquals(decoded.payload.authorization.value, "10000");
  assertStringIncludes(decoded.payload.signature, "0x");

  const data = getWrittenResources()[0].data;
  assertEquals(data.paid, true);
  assertEquals(data.amountUsdc, 0.01);
  assertEquals((data.receipt as Record<string, unknown>).transaction, "0xabc123");
  assertEquals((data.receipt as Record<string, unknown>).success, true);
});

Deno.test("pay refuses when the price exceeds the ceiling", async () => {
  const { context, getWrittenResources } = payContext({
    ...GLOBAL_ARGS,
    maxAmountUsdc: 0.005,
  });

  await withMockedFetch(
    () => Promise.resolve(Response.json(challengeBody("10000"), { status: 402 })),
    async () => {
      await assertRejects(
        () =>
          model.methods.pay.execute(
            { url: "https://api.example.com/paid", method: "GET", requestId: "latest" },
            context,
          ),
        Error,
        "exceeds",
      );
    },
  );

  // Nothing paid, nothing stored.
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("pay records paid=false when no challenge is issued", async () => {
  const { context, getWrittenResources } = payContext();

  await withMockedFetch(
    () => Promise.resolve(Response.json({ free: true }, { status: 200 })),
    async () => {
      await model.methods.pay.execute(
        { url: "https://api.example.com/free", method: "GET", requestId: "latest" },
        context,
      );
    },
  );

  const data = getWrittenResources()[0].data;
  assertEquals(data.paid, false);
  assertEquals(data.receipt, null);
});

Deno.test("pay throws when no settleable exact/EVM option is offered", async () => {
  const { context, getWrittenResources } = payContext();

  const solanaOnly = {
    x402Version: 1,
    accepts: [
      { scheme: "exact", network: "solana", maxAmountRequired: "10000", payTo: "abc", asset: "xyz" },
    ],
  };

  await withMockedFetch(
    () => Promise.resolve(Response.json(solanaOnly, { status: 402 })),
    async () => {
      await assertRejects(
        () =>
          model.methods.pay.execute(
            { url: "https://api.example.com/paid", method: "GET", requestId: "latest" },
            context,
          ),
        Error,
        "No settleable",
      );
    },
  );

  assertEquals(getWrittenResources().length, 0);
});
