# Contributing to ContextMesh

Thanks for helping improve ContextMesh. Use [GitHub Issues](https://github.com/MarsZheng666/ContextMesh/issues) to report a bug or discuss a feature before starting a larger change.

## Product design

ContextMesh is a public project. Design installation, upgrades, configuration, documentation, and everyday workflows for the people using it.

- Provide exactly one public plugin and one installation entry. New features and milestones upgrade the existing plugin; they must not introduce additional plugins for users to install or enable.
- Keep internal modules and dependencies behind that entry and load them automatically. The current complete plugin is `dsh-contextmesh-handoff`.
- Make the default setup straightforward, minimize required configuration, and explain actions and errors in terms users understand. Users should not need to learn the internal architecture or milestone names to complete a task.
- Review changes for their effect on both first-time installation and upgrades by existing users. Keep English and Chinese user documentation aligned with the actual experience.

- Handoff and takeover preserve the conversation’s current provider, model and reasoning selection. Keep device transfer separate from model selection; use the native model selector for model changes. If the receiving device lacks the current model, explain the missing configuration instead of silently selecting a substitute.

## Development setup

Use Node.js 24.9+ and the pinned pnpm version from `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

The test suite starts an isolated PostgreSQL instance when `TEST_DATABASE_URL` is unset. If you provide that variable, point it at a dedicated test database. Ordinary tests do not need model API credentials.

Run `pnpm test:lifecycle` to check the pinned DSH lifecycle using isolated official SDK and Web profiles, the built ContextMesh provider, and PostgreSQL. These tests use a scripted model and do not require a model API key.

## Branch naming

Create a new branch for every development iteration. Use `<type>/<topic>-DNNNN`: `feature` for features and `fix` for fixes, a lowercase hyphen-separated topic, and a repository-wide iteration number padded to four digits, starting at `0001`.

Examples: `feature/m1-handoff-D0001`, `feature/m1-workspace-D0002`, and `fix/session-renewal-D0003`. Check local branches, remote branches, and merged pull requests before allocating the next number. Do not reuse an iteration number or a completed branch. Existing branches retain their historical names.

Start each iteration from the latest validated `master`. Develop and validate on the iteration branch, then merge through a pull request after checks pass. Pushing, merging, publishing, and deploying require authorization for the corresponding action.

## Pull requests

1. Create an iteration branch from `master` using the naming convention above.
2. Keep the change focused and update user-facing documentation alongside behavior changes.
3. Run checks relevant to the change. Use `pnpm check` for runtime changes; check formatting and links for documentation-only changes.
4. Open a pull request explaining the problem, the resulting behavior, and the checks you ran.

Keep `README.md` and `README.zh.md` aligned. Put installation and API guidance in `docs/`; keep personal research notes, deployment-instance records, verification reports, and PR drafts outside the public repository.

## Persistence changes

Preserve native Session data, contiguous event ordering, single-writer ownership, and idempotent retries. Changes to these behaviors should include relevant contract or integration coverage. Never point tests at a production database or replay real user sessions as test fixtures.

The adapted upstream fixtures in `tests/upstream/` retain their original license and source metadata. Preserve those files and update their recorded hashes only when intentionally updating the fixtures.

## Private data

Do not commit credentials, `.env` files, conversation exports, local database files, or personal machine configuration. `.contextmesh/` is ignored and can hold local runtime data and notes.
