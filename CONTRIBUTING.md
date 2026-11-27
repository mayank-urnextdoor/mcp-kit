# Contributing

Thanks for taking the time. Bug reports, fixes and focused features are welcome.

## Setup

```bash
npm ci
npm run typecheck && npm run lint && npm test
```

Node.js 22.13 or newer is required (see `.nvmrc`).

## Ground rules

- **Open an issue first for features.** mcp-kit stays small on purpose, so it helps to agree on scope before you write code. Bug fixes can go straight to a pull request.
- **Tests come with the change.** New behaviour needs a test, and a bug fix needs a test that fails without the fix. Tests must run offline. Use `127.0.0.1` with port `0` for anything that needs a socket.
- **Security-sensitive code** (`src/auth/`, `src/http.ts`) gets extra review. Explain the threat model in the PR description.
- **No new runtime dependencies** without discussion. Today there are two: the MCP SDK and zod.
- **Keep the public API in `src/index.ts`.** Anything not exported there is internal.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `build:`, `ci:`, `chore:`.
- Keep each PR to one concern. CI (typecheck, lint, tests) must pass.
- Update `README.md` when behaviour or configuration changes.

## Reporting security issues

Do not open a public issue for vulnerabilities. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").
