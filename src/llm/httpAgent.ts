import { Agent as HttpsAgent } from "node:https";

/**
 * Both the OpenAI and Anthropic Node SDKs default to a shared `agentkeepalive` instance with
 * a 5-minute keep-alive timeout (see their respective `_shims/node-runtime.ts`). Confirmed in
 * production (2026-09-14): a review job hung indefinitely on an LLM call with zero cost/error
 * recorded — Render's load balancer sits in front of this worker and can idle-close a pooled
 * keep-alive socket well before 5 minutes; the client has no way to know the far end already
 * closed it, reuses it for the next request, and that request hangs forever waiting on a dead
 * socket. `keepAlive: false` means every request opens a fresh connection — no pooled socket
 * ever goes stale because none is ever reused. The extra TLS handshake per call is negligible
 * next to an LLM completion's own latency, and this worker makes at most a handful of calls per
 * review run, not a high-throughput hot path where connection reuse would matter.
 *
 * Both providers' APIs are HTTPS-only, so this single agent covers every call site (the SDKs
 * accept one `httpAgent` regardless of URL scheme when explicitly passed at construction).
 */
export const noKeepAliveHttpsAgent = new HttpsAgent({ keepAlive: false });
