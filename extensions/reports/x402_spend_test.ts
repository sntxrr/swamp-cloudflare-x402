// extensions/reports/x402_spend_test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { createReportTestContext } from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import { report } from "./x402_spend.ts";

type SpendReportContext = Parameters<typeof report.execute>[0];

const MODEL_TYPE = "@sntxrr/cloudflare-x402";
const MODEL_ID = "my-wallet";

function paymentArtifact(
  name: string,
  rec: Record<string, unknown>,
  version = 1,
) {
  const content = new TextEncoder().encode(JSON.stringify(rec));
  return {
    modelType: MODEL_TYPE,
    modelId: MODEL_ID,
    data: {
      name,
      kind: "resource" as const,
      dataId: name,
      version,
      size: content.length,
      contentType: "application/json",
    },
    content,
  };
}

function paidRecord(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    url: "https://api.example.com/paid",
    method: "GET",
    paid: true,
    httpStatus: 200,
    network: "base-sepolia",
    amountUsdc: 0.01,
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    payer: "0xPayer",
    receipt: {
      success: true,
      transaction: "0xabc",
      network: "base-sepolia",
      payer: "0xPayer",
    },
    responseContentType: "application/json",
    responseBody: "{}",
    responseTruncated: false,
    paidAt: "2026-07-17T00:00:00Z",
    ...overrides,
  };
}

function ctx(dataArtifacts: ReturnType<typeof paymentArtifact>[]) {
  const { context } = createReportTestContext({
    scope: "model",
    modelType: MODEL_TYPE,
    modelId: MODEL_ID,
    methodName: "pay",
    executionStatus: "succeeded",
    dataHandles: [],
    dataArtifacts,
  });
  return context as unknown as SpendReportContext;
}

/**
 * Like ctx(), but findAllForModel lists only the latest version of each name,
 * as swamp does (the test fake lists every version, which hid this bug).
 */
function latestOnlyCtx(dataArtifacts: ReturnType<typeof paymentArtifact>[]) {
  const context = ctx(dataArtifacts);
  const repo = context.dataRepository;
  const findAll = repo.findAllForModel.bind(repo);
  repo.findAllForModel = async (type: string, id: string) => {
    const top = new Map<string, { name: string; version?: number }>();
    for (const d of await findAll(type, id)) {
      const prev = top.get(d.name);
      if (!prev || (d.version ?? 0) > (prev.version ?? 0)) top.set(d.name, d);
    }
    return [...top.values()];
  };
  return context;
}

Deno.test("x402-spend aggregates paid records by network and resource", async () => {
  const result = await report.execute(ctx([
    paymentArtifact("latest", paidRecord({ amountUsdc: 0.01 })),
    paymentArtifact(
      "weather",
      paidRecord({
        url: "https://api.example.com/weather",
        network: "base",
        amountUsdc: 0.05,
      }),
    ),
    // A quote record must be ignored by the spend report.
    paymentArtifact("q1", {
      url: "https://api.example.com/paid",
      method: "GET",
      paymentRequired: true,
      httpStatus: 402,
      x402Version: 1,
      accepts: [],
      error: null,
      fetchedAt: "2026-07-17T00:00:00Z",
    }),
  ]));

  assertEquals(result.json.paidRequests, 2);
  assertEquals(result.json.totalUsdc, 0.06);
  assertEquals(result.json.settledRate, 1);
  const byNetwork = result.json.byNetwork as Record<string, { usdc: number }>;
  // Rows are labelled by CAIP-2 id, so v1 and v2 spend on one chain share one.
  assertEquals(byNetwork["eip155:8453"].usdc, 0.05);
  assertEquals(byNetwork["eip155:84532"].usdc, 0.01);
  assertStringIncludes(result.markdown, "x402 spend summary");
  assertStringIncludes(result.markdown, "0.0600 USDC");
});

Deno.test("x402-spend counts unpaid and unconfirmed settlements", async () => {
  const result = await report.execute(ctx([
    paymentArtifact("a", paidRecord({ receipt: null })),
    paymentArtifact(
      "b",
      paidRecord({
        paid: false,
        network: null,
        amountUsdc: null,
        receipt: null,
      }),
    ),
  ]));

  assertEquals(result.json.paidRequests, 1);
  assertEquals(result.json.unpaidRequests, 1);
  assertEquals(result.json.failedSettlement, 1);
  assertEquals(result.json.settledRate, 0);
});

Deno.test("x402-spend handles a wallet with no activity", async () => {
  const result = await report.execute(ctx([]));

  assertEquals(result.json.paidRequests, 0);
  assertEquals(result.json.totalUsdc, 0);
  assertStringIncludes(result.markdown, "No x402 payment activity");
});

const quoteRecord = {
  url: "https://api.example.com/paid",
  method: "GET",
  paymentRequired: true,
  httpStatus: 402,
  x402Version: 1,
  accepts: [],
  error: null,
  fetchedAt: "2026-07-17T00:00:00Z",
};

Deno.test("x402-spend still counts a payment when a newer quote shares its name", async () => {
  // Pre-2026.09.29.1 defaults wrote probe and pay to one name: v1 payment,
  // then a later probe as v2. The payment must not vanish.
  const result = await report.execute(latestOnlyCtx([
    paymentArtifact("current", paidRecord({ amountUsdc: 0.01 }), 1),
    paymentArtifact("current", quoteRecord, 2),
  ]));

  assertEquals(result.json.paidRequests, 1);
  assertEquals(result.json.totalUsdc, 0.01);
});

Deno.test("x402-spend counts every retained version of one payment name", async () => {
  const result = await report.execute(latestOnlyCtx([
    paymentArtifact("payment", paidRecord({ amountUsdc: 0.01 }), 1),
    paymentArtifact("payment", paidRecord({ amountUsdc: 0.02 }), 2),
  ]));

  assertEquals(result.json.paidRequests, 2);
  assertEquals(result.json.totalUsdc, 0.03);
});

Deno.test("x402-spend stops at garbage-collected versions", async () => {
  // Versions 1-2 were collected; only 3-4 remain.
  const result = await report.execute(latestOnlyCtx([
    paymentArtifact("payment", paidRecord({ amountUsdc: 0.01 }), 3),
    paymentArtifact("payment", paidRecord({ amountUsdc: 0.02 }), 4),
  ]));

  assertEquals(result.json.paidRequests, 2);
  assertEquals(result.json.totalUsdc, 0.03);
});

Deno.test("x402-spend merges v1 and v2 names for one chain into one row", async () => {
  const result = await report.execute(ctx([
    paymentArtifact("v1", paidRecord({ network: "base", amountUsdc: 0.02 })),
    paymentArtifact(
      "v2",
      paidRecord({ network: "eip155:8453", amountUsdc: 0.03 }),
    ),
  ]));
  const byNetwork = result.json.byNetwork as Record<string, { usdc: number }>;
  assertEquals(Object.keys(byNetwork), ["eip155:8453"]);
  assertEquals(byNetwork["eip155:8453"].usdc, 0.05);
});

Deno.test("x402-spend shows a refusal as outstanding until validBefore, then refused", async () => {
  const refusal = (validBefore: string) =>
    paidRecord({
      network: "eip155:84532",
      amountUsdc: 0.001,
      httpStatus: 402,
      refused: true,
      validBefore,
      authorizationNonce: "0x01",
      receipt: {
        success: false,
        transaction: null,
        network: "eip155:84532",
        payer: "0xPayer",
        errorReason: "invalid_exact_evm_insufficient_balance",
      },
    });

  const open = await report.execute(ctx([
    paymentArtifact("unfunded", refusal("2999-01-01T00:00:00.000Z")),
  ]));
  assertEquals(open.json.paidRequests, 0);
  assertEquals(open.json.totalUsdc, 0);
  assertEquals(open.json.outstandingCount, 1);
  assertEquals(open.json.outstandingUsdc, 0.001);
  assertEquals(open.json.refusedCount, 0);
  assertStringIncludes(open.markdown, "**Outstanding:** 1 payment(s)");

  const expired = await report.execute(ctx([
    paymentArtifact("unfunded", refusal("2020-01-01T00:00:00.000Z")),
  ]));
  assertEquals(expired.json.totalUsdc, 0);
  assertEquals(expired.json.outstandingCount, 0);
  assertEquals(expired.json.refusedCount, 1);
  assertEquals(expired.json.refusedUsdc, 0.001);
  assertStringIncludes(expired.markdown, "**Refused (server-reported):** 1");
});

Deno.test("x402-spend still counts a failed settlement that carries a tx", async () => {
  const result = await report.execute(ctx([
    paymentArtifact(
      "failed",
      paidRecord({
        network: "eip155:84532",
        amountUsdc: 0.001,
        httpStatus: 402,
        refused: false,
        receipt: {
          success: false,
          transaction: "0xdead",
          network: "eip155:84532",
          payer: "0xPayer",
          errorReason: "transfer_event_mismatch",
        },
      }),
    ),
  ]));
  assertEquals(result.json.paidRequests, 1);
  assertEquals(result.json.totalUsdc, 0.001);
  assertEquals(result.json.failedSettlement, 1);
  assertEquals(result.json.refusedCount, 0);
});
