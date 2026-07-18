# @openvecta/mcp

MCP server for **OpenVecta** — call OpenVecta inference models (OpenAI-compatible,
USDC-settled on Solana) as tools from any MCP client: Claude Desktop, Cursor,
Windsurf, agent kits.

[![npm](https://img.shields.io/npm/v/@openvecta/mcp)](https://www.npmjs.com/package/@openvecta/mcp)

## Tools

| Tool | What it does | Auth needed |
|------|--------------|-------------|
| `list_models` | Catalog + per-1M-token USDC pricing, modality, flat fee | none (public) |
| `estimate_cost` | Estimate a call's USDC cost before running it | none (public) |
| `chat` | Chat completion on any model | keyed **or** x402 |
| `embed` | Embeddings | keyed only |

## Two auth modes (auto-detected from env)

**KEYED** — set `OPENVECTA_API_KEY` (`ov_sk_...`). Uses your prepaid balance / free
tier. Simplest; works everywhere. (Wins if both are set.)

**X402** — set `SOLANA_PRIVATE_KEY` (base58). Pays **per call in USDC** from that
wallet via the x402 protocol — no account, no key. **Chat only.**
⚠️ **Real funds move.** Test on devnet first (`SOLANA_NETWORK=devnet`).

## Install

No install step needed — `npx` fetches it on demand:

```bash
npx -y @openvecta/mcp
```

## Add to Claude Desktop / Cursor

Config file — Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).

**Keyed:**
```json
{
  "mcpServers": {
    "openvecta": {
      "command": "npx",
      "args": ["-y", "@openvecta/mcp"],
      "env": { "OPENVECTA_API_KEY": "ov_sk_live_..." }
    }
  }
}
```

**x402 — pay per call, no account (test on devnet first!):**
```json
{
  "mcpServers": {
    "openvecta": {
      "command": "npx",
      "args": ["-y", "@openvecta/mcp"],
      "env": {
        "SOLANA_PRIVATE_KEY": "base58-secret-key",
        "SOLANA_NETWORK": "devnet"
      }
    }
  }
}
```

Restart the client, then ask e.g. *"list the OpenVecta models"* or
*"use OpenVecta's glm-5.2 to explain Solana"*.

## Env reference

| Var | Default | Notes |
|-----|---------|-------|
| `OPENVECTA_API_KEY` | — | `ov_sk_` key → KEYED mode |
| `SOLANA_PRIVATE_KEY` | — | base58 secret → X402 mode |
| `SOLANA_NETWORK` | `mainnet` | `mainnet` \| `devnet` |
| `SOLANA_RPC_URL` | per-network | override RPC |
| `OPENVECTA_BASE_URL` | `https://api.openvecta.com/v1` | staging / self-host |

## How x402 mode works

Uses the official `@x402/fetch` client (`@x402/svm` `ExactSvmScheme` + a
`@solana/kit` signer) to wrap `fetch`: the request hits `/v1/chat/completions`,
gets a `402` challenge, the library builds + signs the USDC transfer from your
wallet, resends with the payment header, and OpenVecta settles + serves. `chat`
requires `max_tokens` here (it bounds the pre-authorization ceiling; defaults to
1024 if omitted).

The public model catalogue and per-token pricing are readable without auth at
[`/.well-known/x402`](https://api.openvecta.com/.well-known/x402).

> **Security:** never commit a private key. For production/agents, load it from a
> secrets manager, not a config file. `list_models` / `estimate_cost` need no auth.

## Build from source

```bash
npm install
npm run build   # -> dist/index.js
```

## License

MIT
