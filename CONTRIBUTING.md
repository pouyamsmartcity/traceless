# Contributing

Thank you for helping. Please read [`AGENTS.md`](AGENTS.md) first: it explains the project's map and the rules that
are not negotiable (nothing leaves the device, fail closed, every output is checked again, solid covers, honesty).

- Every change comes with tests; every bug fix with a test that fails without it.
- Run `npm run typecheck && npm test && npm run test:cli` and, for anything in `src/`, `npm run test:e2e`.
- Test files must use fake data only (see `scripts/make_fixtures.py`).
- Interface text is in `src/ui/i18n.ts`, in English, Persian and Turkish. Plain words, no jargon. New languages are
  welcome: see "Interface text" in `AGENTS.md`.
- Security problems: see [`SECURITY.md`](SECURITY.md); please do not report them in public issues.
