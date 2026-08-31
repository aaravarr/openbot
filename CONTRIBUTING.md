# Contributing

Open a pull request from a branch. Do not push extra commits to `main` after the initial commit.

1. Branch from `main`.
2. Keep the change one story. Prefer a small PR.
3. If you change `web/`, run `npm run build` so `ui/` matches.
4. Run `npm test` and `npm run typecheck`.
5. Write the PR in English using the template in `.github/PULL_REQUEST_TEMPLATE.md`.
6. Commits use Conventional Commits: `type(scope): subject`.

The control page source lives in `web/`. `npm run build` writes the files served on `:9280` into `ui/`. Read `DESIGN.md` before changing layout or color. Read `AGENTS.md` before changing wrap, hop, or `DesiredState`.
