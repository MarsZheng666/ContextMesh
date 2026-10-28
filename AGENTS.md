# ContextMesh development rules

- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, validation, and pull requests.
- Create a new branch for each iteration using `feature/<topic>-DNNNN` or `fix/<topic>-DNNNN`. Topics use lowercase words joined by hyphens; the four-digit iteration number increases across the repository and is never reused. The first numbered iteration is `feature/m1-handoff-D0001`.
- Start from the latest validated `master`; develop and test on the iteration branch, then use a pull request. Do not develop directly on `master`.
- Obtain authorization before pushing, merging, publishing, or deploying. Authorization for one action does not imply authorization for the others.
- Keep research, design drafts, validation reports, personal deployment records, and credentials outside this public repository. Maintain user-facing documentation in English and Chinese.
- Expose exactly one public ContextMesh plugin and one installation entry. Extend and upgrade the existing plugin across milestones; never add a separate user-installed plugin for a new capability. Internal modules and dependencies load automatically.
- Design this public project from the end user’s perspective: keep installation, upgrades, configuration, and everyday actions simple. Do not require users to understand internal architecture or development milestones to use the product.
- Run `pnpm check` for runtime changes. Preserve the pinned DSH persistence contracts and never use production databases or real user conversations as test fixtures.
