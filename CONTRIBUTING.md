# Contributing to ContextMesh

Thanks for helping improve ContextMesh. Use [GitHub Issues](https://github.com/MarsZheng666/ContextMesh/issues) to report a bug or discuss a feature before starting a larger change.

## Development setup

Use Node.js 24.9+ and the pinned pnpm version from `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

The test suite starts an isolated PostgreSQL instance when `TEST_DATABASE_URL` is unset. If you provide that variable, point it at a dedicated test database. Ordinary tests do not need model API credentials.

## Pull requests

1. Create a `feature/` or `fix/` branch from the repository's default branch.
2. Keep the change focused and update user-facing documentation alongside behavior changes.
3. Run checks relevant to the change. Use `pnpm check` for runtime changes; check formatting and links for documentation-only changes.
4. Open a pull request explaining the problem, the resulting behavior, and the checks you ran.

Keep `README.md` and `README.zh.md` aligned. Put installation and API guidance in `docs/`; keep personal research notes, deployment-instance records, verification reports, and PR drafts outside the public repository.

## Persistence changes

Preserve native Session data, contiguous event ordering, single-writer ownership, and idempotent retries. Changes to these behaviors should include relevant contract or integration coverage. Never point tests at a production database or replay real user sessions as test fixtures.

The adapted upstream fixtures in `tests/upstream/` retain their original license and source metadata. Preserve those files and update their recorded hashes only when intentionally updating the fixtures.

## Private data

Do not commit credentials, `.env` files, conversation exports, local database files, or personal machine configuration. `.contextmesh/` is ignored and can hold local runtime data and notes.
