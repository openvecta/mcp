#!/usr/bin/env node
// OpenVecta MCP server — exposes OpenVecta inference as tools any MCP client
// (Claude Desktop, Cursor, agent kits) can call. OpenAI-compatible under the hood.
//
// Two auth modes (auto-detected from env):
//   • KEYED  — set OPENVECTA_API_KEY (ov_sk_...). Uses your prepaid balance / free tier.
//   • X402   — set SOLANA_PRIVATE_KEY (base58). Pays per call in USDC from that
//              wallet via x402 (no account). Chat only. Real funds move — test on
//              devnet first (SOLANA_NETWORK=devnet).
//
// Env:
//   OPENVECTA_API_KEY    ov_sk_ key (KEYED mode)
//   SOLANA_PRIVATE_KEY   base58 secret key (X402 mode)
//   SOLANA_NETWORK       mainnet (default) | devnet
//   SOLANA_RPC_URL       override RPC (defaults per network)
//   OPENVECTA_BASE_URL   default https://api.openvecta.com/v1
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import bs58 from "bs58";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { ExactSvmScheme, SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";

const BASE = (process.env.OPENVECTA_BASE_URL || "https://api.openvecta.com/v1").replace(/\/+$/, "");
const ROOT = BASE.replace(/\/v1$/, "");
const API_KEY = process.env.OPENVECTA_API_KEY || "";
const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || "";
const NETWORK = (process.env.SOLANA_NETWORK || "mainnet").toLowerCase() === "devnet" ? "devnet" : "mainnet";
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  (NETWORK === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");

// KEYED wins if both are set (explicit, predictable). Perks/free tier are keyed.
const MODE: "key" | "x402" | "none" = API_KEY ? "key" : SOLANA_PRIVATE_KEY ? "x402" : "none";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (msg: string): ToolResult => ({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true });

// --- x402: build a payment-aware fetch (lazy, memoized) ----------------------
let _payFetch: ((input: any, init?: any) => Promise<Response>) | null = null;
async function x402Fetch() {
  if (_payFetch) return _payFetch;
  const raw = bs58.decode(SOLANA_PRIVATE_KEY.trim());
  // 64 bytes = full ed25519 keypair; 32 bytes = private seed.
  const signer =
    raw.length === 64
      ? await createKeyPairSignerFromBytes(raw)
      : await createKeyPairSignerFromPrivateKeyBytes(raw);
  const scheme = new ExactSvmScheme(signer, { rpcUrl: RPC_URL });
  const caip2 = NETWORK === "devnet" ? SOLANA_DEVNET_CAIP2 : SOLANA_MAINNET_CAIP2;
  const client = new x402Client().register(caip2, scheme);
  _payFetch = wrapFetchWithPayment(fetch, client);
  return _payFetch;
}

function keyHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

async function fetchModels(): Promise<any[]> {
  const r = await fetch(`${ROOT}/models`);
  if (!r.ok) throw new Error(`GET /models -> ${r.status}`);
  const j: any = await r.json();
  return j.data || [];
}

const server = new McpServer({ name: "openvecta", version: "0.1.0" });

server.tool(
  "list_models",
  "List OpenVecta's available models with per-1M-token USDC pricing, provider, modality, and the flat per-call fee. Call this first to discover model ids.",
  {},
  async (): Promise<ToolResult> => {
    try {
      return ok(JSON.stringify(await fetchModels(), null, 2));
    } catch (e: any) {
      return fail(e.message);
    }
  }
);

server.tool(
  "chat",
  "Run a chat completion on an OpenVecta model (OpenAI-compatible). Pays via your configured mode (prepaid key or x402 per-call). Returns the reply + token usage.",
  {
    model: z.string().describe("Model id, e.g. 'glm-5.2' (see list_models)"),
    messages: z
      .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
      .describe("OpenAI-style chat messages"),
    max_tokens: z.number().int().positive().optional().describe("Max output tokens (REQUIRED in x402 mode)"),
    temperature: z.number().min(0).max(2).optional(),
  },
  async ({ model, messages, max_tokens, temperature }): Promise<ToolResult> => {
    if (MODE === "none")
      return fail("No auth configured. Set OPENVECTA_API_KEY (keyed) or SOLANA_PRIVATE_KEY (x402 pay-per-call).");
    try {
      const body: Record<string, unknown> = { model, messages };
      if (temperature !== undefined) body.temperature = temperature;
      // x402 requires max_tokens (it bounds the pre-authorization ceiling).
      if (MODE === "x402") body.max_tokens = max_tokens ?? 1024;
      else if (max_tokens !== undefined) body.max_tokens = max_tokens;

      const doFetch = MODE === "x402" ? await x402Fetch() : fetch;
      const headers = MODE === "x402" ? { "Content-Type": "application/json" } : keyHeaders();
      const r = await doFetch(`${BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
      const j: any = await r.json();
      if (!r.ok) return fail(`${r.status}: ${JSON.stringify(j.error || j)}`);
      const content = j.choices?.[0]?.message?.content ?? "";
      const u = j.usage;
      const usage = u ? `\n\n— usage: ${u.prompt_tokens} in / ${u.completion_tokens} out` : "";
      const paid = MODE === "x402" ? " (paid per-call via x402)" : "";
      return ok(content + usage + paid);
    } catch (e: any) {
      return fail(e.message);
    }
  }
);

server.tool(
  "embed",
  "Create embeddings for text with an OpenVecta embeddings model (e.g. 'text-embedding-3-small'). Keyed mode only (x402 is chat-only).",
  {
    model: z.string().describe("Embeddings model id"),
    input: z.union([z.string(), z.array(z.string())]).describe("Text or array of texts"),
  },
  async ({ model, input }): Promise<ToolResult> => {
    if (MODE !== "key")
      return fail("Embeddings require OPENVECTA_API_KEY (the x402 pay-per-call path is chat-only).");
    try {
      const r = await fetch(`${BASE}/embeddings`, {
        method: "POST",
        headers: keyHeaders(),
        body: JSON.stringify({ model, input }),
      });
      const j: any = await r.json();
      if (!r.ok) return fail(`${r.status}: ${JSON.stringify(j.error || j)}`);
      const data = j.data || [];
      const dims = data[0]?.embedding?.length ?? 0;
      return ok(`${data.length} embedding(s), ${dims} dims each\n\n${JSON.stringify(j, null, 2)}`);
    } catch (e: any) {
      return fail(e.message);
    }
  }
);

server.tool(
  "estimate_cost",
  "Estimate the USDC cost of a call before running it: input/output token counts priced against the model's live rate (+ flat per-call fee).",
  {
    model: z.string(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative().default(0),
  },
  async ({ model, input_tokens, output_tokens }): Promise<ToolResult> => {
    try {
      const m = (await fetchModels()).find((x) => x.id === model);
      if (!m) return fail(`model '${model}' not found (see list_models)`);
      const inP = Number(m.input_per_mtok) || 0;
      const outP = Number(m.output_per_mtok) || 0;
      const flat = Number(m.flat_fee_usd) || 0;
      const cost = (input_tokens / 1e6) * inP + (output_tokens / 1e6) * outP + flat;
      return ok(
        JSON.stringify(
          { model, input_tokens, output_tokens, input_per_mtok: inP, output_per_mtok: outP, flat_fee_usd: flat, estimated_usd: Number(cost.toFixed(6)) },
          null,
          2
        )
      );
    } catch (e: any) {
      return fail(e.message);
    }
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`openvecta-mcp running (stdio) · mode=${MODE}${MODE === "x402" ? ` · network=${NETWORK}` : ""}`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
