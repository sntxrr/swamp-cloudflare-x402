// extensions/models/cloudflare_x402_test.ts
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import { privateKeyToAccount } from "npm:viem@2.21.26/accounts";
import { verifyTypedData } from "npm:viem@2.21.26";
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
        {
          url: "https://api.example.com/paid",
          method: "GET",
          requestId: "current",
        },
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
        {
          url: "https://api.example.com/free",
          method: "GET",
          requestId: "current",
        },
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
        {
          url: "https://api.example.com/paid",
          method: "GET",
          requestId: "current",
        },
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
  assertEquals(
    (data.receipt as Record<string, unknown>).transaction,
    "0xabc123",
  );
  assertEquals((data.receipt as Record<string, unknown>).success, true);
});

Deno.test("pay refuses when the price exceeds the ceiling", async () => {
  const { context, getWrittenResources } = payContext({
    ...GLOBAL_ARGS,
    maxAmountUsdc: 0.005,
  });

  await withMockedFetch(
    () =>
      Promise.resolve(Response.json(challengeBody("10000"), { status: 402 })),
    async () => {
      await assertRejects(
        () =>
          model.methods.pay.execute(
            {
              url: "https://api.example.com/paid",
              method: "GET",
              requestId: "current",
            },
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
        {
          url: "https://api.example.com/free",
          method: "GET",
          requestId: "current",
        },
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
      {
        scheme: "exact",
        network: "solana",
        maxAmountRequired: "10000",
        payTo: "abc",
        asset: "xyz",
      },
    ],
  };

  await withMockedFetch(
    () => Promise.resolve(Response.json(solanaOnly, { status: 402 })),
    async () => {
      await assertRejects(
        () =>
          model.methods.pay.execute(
            {
              url: "https://api.example.com/paid",
              method: "GET",
              requestId: "current",
            },
            context,
          ),
        Error,
        "No settleable",
      );
    },
  );

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("probe and pay default to different data names", () => {
  const url = "https://api.example.com/paid";
  const probe = model.methods.probe.arguments.parse({ url });
  const pay = model.methods.pay.arguments.parse({ url });
  assertEquals(probe.requestId, "quote");
  assertEquals(pay.requestId, "payment");
});

// A server that accepts the request and never answers: the returned promise
// settles only when the request's signal aborts. The guard fails the test
// (instead of hanging it) when no timeout signal was passed.
function hangUntilAborted(req: Request): Promise<Response> {
  return new Promise((_, reject) => {
    const guard = setTimeout(
      () => reject(new Error("request was never aborted")),
      3000,
    );
    req.signal.addEventListener("abort", () => {
      clearTimeout(guard);
      reject(req.signal.reason);
    }, { once: true });
  });
}

// Headers arrive, then the body stalls until the request's signal aborts.
function stalledBody(req: Request, init: ResponseInit): Response {
  let guard: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream({
    start(controller) {
      guard = setTimeout(
        () => controller.error(new Error("request was never aborted")),
        3000,
      );
      req.signal.addEventListener("abort", () => {
        clearTimeout(guard);
        controller.error(req.signal.reason);
      }, { once: true });
    },
  });
  return new Response(body, init);
}

Deno.test("timeoutSeconds defaults to 30", () => {
  assertEquals(
    model.globalArguments.parse({ privateKey: TEST_KEY }).timeoutSeconds,
    30,
  );
});

Deno.test("probe times out a resource that never answers", async () => {
  const { context, getWrittenResources } = probeContext();
  await withMockedFetch(hangUntilAborted, async () => {
    await assertRejects(
      () =>
        model.methods.probe.execute(
          {
            url: "https://api.example.com/hang",
            method: "GET",
            requestId: "quote",
            timeoutSeconds: 1,
          },
          context,
        ),
      Error,
      "Probe of https://api.example.com/hang timed out after 1s",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("probe times out a 402 whose body never arrives", async () => {
  const { context } = probeContext({ ...GLOBAL_ARGS, timeoutSeconds: 1 });
  await withMockedFetch(
    (req: Request) => Promise.resolve(stalledBody(req, { status: 402 })),
    async () => {
      await assertRejects(
        () =>
          model.methods.probe.execute(
            {
              url: "https://api.example.com/hang",
              method: "GET",
              requestId: "quote",
            },
            context,
          ),
        Error,
        "timed out after 1s",
      );
    },
  );
});

Deno.test("pay times out the challenge without paying or recording", async () => {
  const { context, getWrittenResources } = payContext();
  await withMockedFetch(hangUntilAborted, async () => {
    await assertRejects(
      () =>
        model.methods.pay.execute(
          {
            url: "https://api.example.com/hang",
            method: "GET",
            requestId: "payment",
            timeoutSeconds: 1,
          },
          context,
        ),
      Error,
      "Payment challenge request to https://api.example.com/hang timed out after 1s",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("pay records a timed-out paid retry as paid with no receipt", async () => {
  const { context, getWrittenResources } = payContext();
  let paidAttempts = 0;
  await withMockedFetch((req: Request) => {
    if (!req.headers.get("X-PAYMENT")) {
      return Promise.resolve(
        Response.json(challengeBody("10000"), { status: 402 }),
      );
    }
    paidAttempts += 1;
    return hangUntilAborted(req);
  }, async () => {
    await assertRejects(
      () =>
        model.methods.pay.execute(
          {
            url: "https://api.example.com/paid",
            method: "GET",
            requestId: "payment",
            timeoutSeconds: 1,
          },
          context,
        ),
      Error,
      "the payment may have settled",
    );
  });

  assertEquals(paidAttempts, 1);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "payment");
  assertEquals(written[0].data.paid, true);
  assertEquals(written[0].data.receipt, null);
  assertEquals(written[0].data.httpStatus, 0);
  assertEquals(written[0].data.amountUsdc, 0.01);
});

Deno.test("pay keeps the receipt when the paid response body stalls", async () => {
  const { context, getWrittenResources } = payContext();
  const receipt = btoa(JSON.stringify({
    success: true,
    transaction: "0xabc",
    network: "base-sepolia",
    payer: "0x0",
  }));
  await withMockedFetch((req: Request) => {
    if (!req.headers.get("X-PAYMENT")) {
      return Promise.resolve(
        Response.json(challengeBody("10000"), { status: 402 }),
      );
    }
    return Promise.resolve(stalledBody(req, {
      status: 200,
      headers: { "x-payment-response": receipt },
    }));
  }, async () => {
    await assertRejects(
      () =>
        model.methods.pay.execute(
          {
            url: "https://api.example.com/paid",
            method: "GET",
            requestId: "payment",
            timeoutSeconds: 1,
          },
          context,
        ),
      Error,
      "timed out after 1s",
    );
  });

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].data.paid, true);
  assertEquals(written[0].data.httpStatus, 200);
  assertEquals(
    (written[0].data.receipt as Record<string, unknown>).transaction,
    "0xabc",
  );
});

// Pays against a resource whose X-PAYMENT retry answers with `paidResponse`,
// expecting pay to fail; returns what it wrote and how often it paid.
async function payAgainstPaidError(paidResponse: () => Response) {
  const { context, getWrittenResources } = payContext();
  let paidAttempts = 0;
  await withMockedFetch((req: Request) => {
    if (!req.headers.get("X-PAYMENT")) {
      return Promise.resolve(
        Response.json(challengeBody("10000"), { status: 402 }),
      );
    }
    paidAttempts += 1;
    return Promise.resolve(paidResponse());
  }, async () => {
    await assertRejects(
      () =>
        model.methods.pay.execute(
          {
            url: "https://api.example.com/paid",
            method: "GET",
            requestId: "payment",
          },
          context,
        ),
      Error,
      "the payment may have settled",
    );
  });
  return { written: getWrittenResources(), paidAttempts };
}

Deno.test("pay records an error-status paid retry with its receipt", async () => {
  const receipt = btoa(JSON.stringify({
    success: true,
    transaction: "0xmock",
    network: "base-sepolia",
    payer: "0x0",
  }));
  const { written, paidAttempts } = await payAgainstPaidError(() =>
    new Response("upstream exploded", {
      status: 500,
      headers: { "x-payment-response": receipt },
    })
  );

  assertEquals(paidAttempts, 1);
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "payment");
  assertEquals(written[0].data.paid, true);
  assertEquals(written[0].data.httpStatus, 500);
  assertEquals(written[0].data.amountUsdc, 0.01);
  assertEquals(written[0].data.responseBody, "upstream exploded");
  assertEquals(
    (written[0].data.receipt as Record<string, unknown>).transaction,
    "0xmock",
  );
});

Deno.test("pay records an error-status paid retry without a receipt", async () => {
  const { written } = await payAgainstPaidError(() =>
    new Response("bad gateway", { status: 502 })
  );

  assertEquals(written.length, 1);
  assertEquals(written[0].data.paid, true);
  assertEquals(written[0].data.httpStatus, 502);
  assertEquals(written[0].data.receipt, null);
});

// ---------------------------------------------------------------------------
// x402 v2. Fixtures are the spec's own examples, copied byte for byte from
// coinbase/x402 specs/transports-v2/http.md at commit 0e6e8c5.

/** The spec's example `PAYMENT-REQUIRED` header (eip155:84532, 10000 base units). */
const SPEC_PAYMENT_REQUIRED =
  "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19";

/** The spec's example successful `PAYMENT-RESPONSE` header. */
const SPEC_PAYMENT_RESPONSE =
  "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWYxMjM0NTY3ODkwYWJjZGVmMTIzNDU2Nzg5MGFiY2RlZiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9";

const SPEC_CHALLENGE = JSON.parse(atob(SPEC_PAYMENT_REQUIRED));

function utf8ToB64(text: string): string {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function b64ToUtf8(value: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
  );
}

/** A v2 402: the challenge in PAYMENT-REQUIRED and an empty body. */
function v2Challenge(header = SPEC_PAYMENT_REQUIRED): Response {
  return Response.json({}, {
    status: 402,
    headers: { "PAYMENT-REQUIRED": header },
  });
}

function v2Header(challenge: Record<string, unknown>): string {
  return utf8ToB64(JSON.stringify(challenge));
}

/** Run pay against a v2 server whose paid retry is answered by `answer`. */
async function payV2(
  answer: (req: Request) => Response,
  challenge: () => Response = () => v2Challenge(),
) {
  const { context, getWrittenResources } = payContext();
  const requests: Request[] = [];
  let error: unknown = null;
  await withMockedFetch(
    (req) => {
      requests.push(req);
      return Promise.resolve(
        requests.length === 1 ? challenge() : answer(req),
      );
    },
    async () => {
      try {
        await model.methods.pay.execute(
          {
            url: "https://api.example.com/premium-data",
            method: "GET",
            requestId: "p",
          },
          context,
        );
      } catch (err) {
        error = err;
      }
    },
  );
  return { requests, written: getWrittenResources(), error };
}

Deno.test("v2: probe reads the spec's PAYMENT-REQUIRED header", async () => {
  const { context, getWrittenResources } = probeContext();
  await withMockedFetch(
    () => Promise.resolve(v2Challenge()),
    async () => {
      await model.methods.probe.execute(
        {
          url: "https://api.example.com/premium-data",
          method: "GET",
          requestId: "q",
        },
        context,
      );
    },
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.x402Version, 2);
  assertEquals(data.error, "PAYMENT-SIGNATURE header is required");
  const accepts = data.accepts as Array<Record<string, unknown>>;
  assertEquals(accepts.length, 1);
  assertEquals(accepts[0].network, "eip155:84532");
  assertEquals(accepts[0].maxAmountRequired, "10000");
  assertEquals(accepts[0].amountUsdc, 0.01);
  assertEquals(accepts[0].resource, "https://api.example.com/premium-data");
  // Only the quote schema's keys are stored: the raw requirement never leaks.
  const schemaKeys = [
    "scheme",
    "network",
    "maxAmountRequired",
    "resource",
    "description",
    "mimeType",
    "payTo",
    "asset",
    "maxTimeoutSeconds",
    "amountUsdc",
  ];
  for (const key of Object.keys(accepts[0])) {
    assertEquals(schemaKeys.includes(key), true, `unexpected key ${key}`);
  }
  assertEquals("extra" in accepts[0], false);
  assertEquals("amount" in accepts[0], false);
});

Deno.test("v2: the PAYMENT-REQUIRED header wins over a v1 body", async () => {
  const { context, getWrittenResources } = probeContext();
  await withMockedFetch(
    () =>
      Promise.resolve(
        Response.json(challengeBody("99999"), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": SPEC_PAYMENT_REQUIRED },
        }),
      ),
    async () => {
      await model.methods.probe.execute(
        {
          url: "https://api.example.com/premium-data",
          method: "GET",
          requestId: "q",
        },
        context,
      );
    },
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.x402Version, 2);
  const accepts = data.accepts as Array<Record<string, unknown>>;
  assertEquals(accepts[0].maxAmountRequired, "10000");
});

Deno.test("v2: a malformed PAYMENT-REQUIRED header is reported, not parsed", async () => {
  const { context, getWrittenResources } = probeContext();
  await withMockedFetch(
    () => Promise.resolve(v2Challenge("not base64 json!")),
    async () => {
      await model.methods.probe.execute(
        {
          url: "https://api.example.com/premium-data",
          method: "GET",
          requestId: "q",
        },
        context,
      );
    },
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.error, "PAYMENT-REQUIRED header was not valid base64 JSON");
  assertEquals((data.accepts as unknown[]).length, 0);
});

Deno.test("v2: a PAYMENT-REQUIRED header without x402Version 2 is refused before signing", async () => {
  const challenge = { ...SPEC_CHALLENGE } as Record<string, unknown>;
  delete challenge.x402Version;
  const { context, getWrittenResources } = probeContext();
  await withMockedFetch(
    () => Promise.resolve(v2Challenge(v2Header(challenge))),
    async () => {
      await model.methods.probe.execute(
        {
          url: "https://api.example.com/premium-data",
          method: "GET",
          requestId: "q",
        },
        context,
      );
    },
  );
  assertStringIncludes(
    String(getWrittenResources()[0].data.error),
    "only 2 is supported",
  );

  const res = await payV2(
    () => Response.json({}, { status: 200 }),
    () => v2Challenge(v2Header(challenge)),
  );
  assertEquals(res.requests.length, 1);
  assertEquals(res.written.length, 0);
  assertStringIncludes(String(res.error), "nothing was signed");
});

Deno.test("v2: pay sends PAYMENT-SIGNATURE echoing the offer, signed for the spec's domain", async () => {
  const res = await payV2(() =>
    Response.json({ data: "premium" }, {
      status: 200,
      headers: { "PAYMENT-RESPONSE": SPEC_PAYMENT_RESPONSE },
    })
  );
  assertEquals(res.error, null);
  assertEquals(res.requests.length, 2);
  const paidReq = res.requests[1];
  assertEquals(paidReq.headers.get("X-PAYMENT"), null);
  const sent = JSON.parse(b64ToUtf8(paidReq.headers.get("PAYMENT-SIGNATURE")!));
  assertEquals(sent.x402Version, 2);
  assertEquals(sent.accepted, SPEC_CHALLENGE.accepts[0]);
  assertEquals(sent.resource, SPEC_CHALLENGE.resource);
  assertEquals("scheme" in sent, false);

  // The domain is built from the spec's literal values, never via the model's
  // network mapping, so a wrong mapping cannot sign and verify consistently.
  const auth = sent.payload.authorization;
  const wallet = privateKeyToAccount(TEST_KEY as `0x${string}`).address;
  assertEquals(auth.from, wallet);
  assertEquals(auth.to, "0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
  assertEquals(auth.value, "10000");
  const valid = await verifyTypedData({
    address: wallet,
    domain: {
      name: "USDC",
      version: "2",
      chainId: 84532,
      verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature: sent.payload.signature,
  });
  assertEquals(valid, true);

  const data = res.written[0].data;
  assertEquals(data.paid, true);
  assertEquals(data.refused, false);
  assertEquals(data.network, "eip155:84532");
  assertEquals(data.authorizationNonce, auth.nonce);
  assertEquals(
    data.validBefore,
    new Date(Number(auth.validBefore) * 1000).toISOString(),
  );
  const receipt = data.receipt as Record<string, unknown>;
  assertEquals(receipt.success, true);
  assertEquals(
    receipt.transaction,
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  );
  assertEquals(receipt.network, "eip155:84532");
});

Deno.test("v2: a v2 challenge in the body still gets the v2 envelope", async () => {
  const res = await payV2(
    () => Response.json({}, { status: 200 }),
    () => Response.json(SPEC_CHALLENGE, { status: 402 }),
  );
  assertEquals(res.error, null);
  assertEquals(res.requests[1].headers.get("X-PAYMENT"), null);
  const sent = JSON.parse(
    b64ToUtf8(res.requests[1].headers.get("PAYMENT-SIGNATURE")!),
  );
  assertEquals(sent.accepted, SPEC_CHALLENGE.accepts[0]);
});

Deno.test("v2: non-ASCII resource text round-trips through the headers", async () => {
  const challenge = structuredClone(SPEC_CHALLENGE);
  challenge.resource.description = "Café ☕ données — 東京";
  const res = await payV2(
    () => Response.json({}, { status: 200 }),
    () => v2Challenge(v2Header(challenge)),
  );
  assertEquals(res.error, null);
  const sent = JSON.parse(
    b64ToUtf8(res.requests[1].headers.get("PAYMENT-SIGNATURE")!),
  );
  assertEquals(sent.resource.description, "Café ☕ données — 東京");
});

Deno.test("v2: a verify refusal is recorded as refused, with its reason and expiry", async () => {
  const refusal = {
    ...SPEC_CHALLENGE,
    error: "invalid_exact_evm_insufficient_balance",
  };
  const res = await payV2(() =>
    Response.json({}, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": v2Header(refusal) },
    })
  );
  assertStringIncludes(String(res.error), "refused at verification");
  assertStringIncludes(
    String(res.error),
    "invalid_exact_evm_insufficient_balance",
  );
  assertEquals(String(res.error).includes("may have settled"), false);
  const data = res.written[0].data;
  assertEquals(data.paid, true);
  assertEquals(data.refused, true);
  assertEquals(data.httpStatus, 402);
  assertEquals(typeof data.validBefore, "string");
  assertEquals(typeof data.authorizationNonce, "string");
  const receipt = data.receipt as Record<string, unknown>;
  assertEquals(receipt.success, false);
  assertEquals(receipt.transaction, null);
  assertEquals(receipt.errorReason, "invalid_exact_evm_insufficient_balance");
});

Deno.test("v2: a failed settlement that carries a tx is not a refusal", async () => {
  const failed = utf8ToB64(JSON.stringify({
    success: false,
    errorReason: "transfer_event_mismatch",
    transaction: "0xdead",
    network: "eip155:84532",
    payer: "0xPayer",
  }));
  const res = await payV2(() =>
    Response.json({}, {
      status: 402,
      headers: {
        "PAYMENT-RESPONSE": failed,
        "PAYMENT-REQUIRED": v2Header({
          ...SPEC_CHALLENGE,
          error: "settle failed",
        }),
      },
    })
  );
  assertStringIncludes(String(res.error), "may have settled");
  assertStringIncludes(String(res.error), "transfer_event_mismatch");
  const data = res.written[0].data;
  assertEquals(data.refused, false);
  const receipt = data.receipt as Record<string, unknown>;
  assertEquals(receipt.success, false);
  assertEquals(receipt.transaction, "0xdead");
  assertEquals(receipt.errorReason, "transfer_event_mismatch");
});

Deno.test("v2: the ceiling is enforced on the v2 amount before signing", async () => {
  const challenge = structuredClone(SPEC_CHALLENGE);
  challenge.accepts[0].amount = "2000000"; // 2 USDC, over the 1.0 ceiling
  const res = await payV2(
    () => Response.json({}, { status: 200 }),
    () => v2Challenge(v2Header(challenge)),
  );
  assertStringIncludes(String(res.error), "exceeds the 1 USDC ceiling");
  assertEquals(res.requests.length, 1);
  assertEquals(res.written.length, 0);
});

Deno.test("v2: CAIP-2 ids outside the supported chains are not signed", async () => {
  const challenge = structuredClone(SPEC_CHALLENGE);
  challenge.accepts[0].network = "eip155:1";
  const res = await payV2(
    () => Response.json({}, { status: 200 }),
    () => v2Challenge(v2Header(challenge)),
  );
  assertStringIncludes(String(res.error), "No settleable");
  assertStringIncludes(String(res.error), "exact/eip155:1");
  assertEquals(res.requests.length, 1);
});

Deno.test("v2: a permit2-only offer is not signed", async () => {
  const challenge = structuredClone(SPEC_CHALLENGE);
  challenge.accepts[0].extra.assetTransferMethod = "permit2";
  const res = await payV2(
    () => Response.json({}, { status: 200 }),
    () => v2Challenge(v2Header(challenge)),
  );
  assertStringIncludes(String(res.error), "No settleable");
  assertStringIncludes(String(res.error), "(permit2)");
  assertEquals(res.requests.length, 1);
});
