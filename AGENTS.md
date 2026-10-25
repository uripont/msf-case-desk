# Agent notes

- This is a pnpm workspace. Run everything from the repository root. `pnpm check` must pass.
- `apps/web` is a Foldkit app. Read `apps/web/FOLDKIT.md` before changing it. Foldkit's conventions are enforced by the lint rules.
- `packages/domain` is pure. No clocks, no randomness, no I/O, no UI imports.
- Data is synthetic only. Never add real case data, names or personal information.
- Effect is pinned to two versions on purpose. Read `docs/decisions.md` before touching any dependency.
- Nothing is committed yet. Ask before committing or pushing.
