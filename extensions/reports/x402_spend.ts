/**
 * x402 spend report — a model-scope report that summarizes payment activity for
 * a `@sntxrr/cloudflare-x402` wallet: total USDC spent, per-network and
 * per-resource breakdowns, and the on-chain settlement rate. It reads the
 * wallet's stored `payment` records (written by the model's `pay` method) and
 * ignores `quote` records.
 *
 * @module
 */
// extensions/reports/x402_spend.ts
import { z } from "npm:zod@4";

/** The subset of a stored `payment` record this report reads. */
const PaymentSchema = z.object({
  url: z.string(),
  paid: z.boolean(),
  network: z.string().nullable().optional(),
  amountUsdc: z.number().nullable().optional(),
  paidAt: z.string(),
  receipt: z.object({ success: z.boolean() }).nullable().optional(),
});

type Payment = z.infer<typeof PaymentSchema>;

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
};

/** Minimal view of the model-scope report context this report relies on. */
type ModelReportContext = {
  modelType: string;
  modelId: string;
  definition?: { name?: string };
  logger: Logger;
  dataRepository: {
    findAllForModel: (
      type: string,
      modelId: string,
    ) => Promise<Array<{ name: string; version?: number }>>;
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

type Bucket = { requests: number; usdc: number };

/** Format a USDC number with 4 decimals, tolerating null/undefined. */
function fmtUsdc(value: number | null | undefined): string {
  return (value ?? 0).toFixed(4);
}

/** Load the latest version of every `payment` record for a model instance. */
async function loadPayments(context: ModelReportContext): Promise<Payment[]> {
  const { modelType, modelId, dataRepository } = context;
  const all = await dataRepository.findAllForModel(modelType, modelId);

  // Keep only the highest version per data name; skip report artifacts.
  const latest = new Map<string, { name: string; version?: number }>();
  for (const d of all) {
    if (d.name.startsWith("report-")) continue;
    const prev = latest.get(d.name);
    if (!prev || (d.version ?? 0) > (prev.version ?? 0)) latest.set(d.name, d);
  }

  const payments: Payment[] = [];
  for (const d of latest.values()) {
    const bytes = await dataRepository.getContent(
      modelType,
      modelId,
      d.name,
      d.version,
    );
    if (!bytes) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      continue;
    }
    // Payment records carry `paid` + `paidAt`; quote records (which carry
    // `paymentRequired`) fail this parse and are skipped.
    const result = PaymentSchema.safeParse(parsed);
    if (result.success) payments.push(result.data);
  }
  return payments;
}

/**
 * x402 spend summary report definition. Model-scope, so it runs after the
 * wallet model's method executions and can be fetched with
 * `swamp report get @sntxrr/x402-spend --model <wallet>`.
 */
export const report = {
  name: "@sntxrr/x402-spend",
  description:
    "Summarize x402 spend for a wallet — total USDC, breakdown by network and resource, and settlement rate",
  scope: "model" as const,
  labels: ["payments", "finops", "x402"],
  execute: async (
    context: ModelReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const modelName = context.definition?.name ?? context.modelId;
    const payments = await loadPayments(context);
    const paid = payments.filter((p) => p.paid);
    const unpaid = payments.length - paid.length;

    let totalUsdc = 0;
    let settled = 0;
    const byNetwork = new Map<string, Bucket>();
    const byResource = new Map<string, Bucket>();

    for (const p of paid) {
      const usdc = p.amountUsdc ?? 0;
      totalUsdc += usdc;
      if (p.receipt?.success) settled += 1;

      const net = p.network ?? "unknown";
      const n = byNetwork.get(net) ?? { requests: 0, usdc: 0 };
      n.requests += 1;
      n.usdc += usdc;
      byNetwork.set(net, n);

      const r = byResource.get(p.url) ?? { requests: 0, usdc: 0 };
      r.requests += 1;
      r.usdc += usdc;
      byResource.set(p.url, r);
    }

    const settledRate = paid.length ? settled / paid.length : 0;
    const failedSettlement = paid.length - settled;

    context.logger.info(
      "x402 spend report: {paid} paid request(s), {usdc} USDC",
      { paid: paid.length, usdc: fmtUsdc(totalUsdc) },
    );

    const lines: string[] = [];
    lines.push(`## x402 spend summary — ${modelName}`);
    lines.push("");
    if (paid.length === 0) {
      lines.push(
        unpaid > 0
          ? `No paid x402 requests yet (${unpaid} request(s) needed no payment).`
          : "No x402 payment activity recorded for this wallet.",
      );
    } else {
      lines.push(
        `**${paid.length}** paid request(s) · **${
          fmtUsdc(totalUsdc)
        } USDC** total · **${
          Math.round(settledRate * 100)
        }%** settled on-chain`,
      );
      if (failedSettlement > 0 || unpaid > 0) {
        const notes: string[] = [];
        if (failedSettlement > 0) {
          notes.push(`${failedSettlement} unconfirmed settlement(s)`);
        }
        if (unpaid > 0) notes.push(`${unpaid} unpaid request(s)`);
        lines.push("");
        lines.push(`_${notes.join(", ")}._`);
      }

      lines.push("");
      lines.push("| Network | Requests | USDC |");
      lines.push("| ------- | -------: | ---: |");
      for (
        const [net, v] of [...byNetwork.entries()].sort((a, b) =>
          b[1].usdc - a[1].usdc
        )
      ) {
        lines.push(`| ${net} | ${v.requests} | ${fmtUsdc(v.usdc)} |`);
      }

      lines.push("");
      lines.push("| Resource | Requests | USDC |");
      lines.push("| -------- | -------: | ---: |");
      for (
        const [url, v] of [...byResource.entries()].sort((a, b) =>
          b[1].usdc - a[1].usdc
        )
      ) {
        lines.push(`| ${url} | ${v.requests} | ${fmtUsdc(v.usdc)} |`);
      }
    }

    const toObj = (m: Map<string, Bucket>) =>
      Object.fromEntries(
        [...m.entries()].map(
          (
            [k, v],
          ) => [k, { requests: v.requests, usdc: Number(v.usdc.toFixed(6)) }],
        ),
      );

    return {
      markdown: lines.join("\n") + "\n",
      json: {
        model: modelName,
        paidRequests: paid.length,
        unpaidRequests: unpaid,
        totalUsdc: Number(totalUsdc.toFixed(6)),
        settledCount: settled,
        failedSettlement,
        settledRate: Number(settledRate.toFixed(4)),
        byNetwork: toObj(byNetwork),
        byResource: toObj(byResource),
      },
    };
  },
};
