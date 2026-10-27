# feat: implement M0 remote DeepSeek Session persistence

ContextMesh previously contained only research and design documents. This change adds a PostgreSQL-backed HTTP service, authenticated client and CLI, and a DeepSeek Harness SessionPersistence provider with a local installation bundle.

Session creation retains pending visibility; live events are batched in order, flush drains and confirms durable storage, and close releases ownership. Transactions enforce contiguous appends and idempotent retries, including lost responses. Write epochs and leases prevent stale writers; abnormal recovery requires explicit confirmation that the previous executor stopped. Native JSON is preserved without HTTP coercion or PostgreSQL JSONB Unicode restrictions.

Validation covers the pinned upstream persistence and live-write helpers, real PostgreSQL transactions and immediate-shutdown recovery, separate server/plugin processes, the official SDK profile's real agent-loop resume, and official base patch composition. The optional physical-file torn-tail helper branch does not apply to PostgreSQL. An additional macOS-to-Ubuntu run used real deepseek-flash requests to resume one Session in both directions, preserving event prefixes across an API restart. Web authentication, HTML responses, and installed-provider status were also checked. Exact validation results and artifact hashes are recorded in the M0 verification documents.

M1 Handoff, M2 model relay, full GUI interaction, and automatic cross-host title/workspace synchronization remain outside this change. Docker/Compose and Linux CI are provided but have not been executed; the remote run used a PostgreSQL container and Node/systemd services. No remote branch, PR or push has been created.
