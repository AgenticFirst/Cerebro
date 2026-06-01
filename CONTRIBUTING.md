# Contributing to Cerebro

Thanks for your interest in Cerebro! We welcome contributions of all kinds — bug reports, feature requests, documentation improvements, and code.

## Opening Issues

Issues are the best way to start. Before writing any code, please [open an issue](https://github.com/AgenticFirst/Cerebro/issues/new) so we can discuss the change.

- **Bug reports** — describe what you expected, what happened instead, and steps to reproduce. Include your OS and Node/Python versions.
- **Feature requests** — explain the use case and why it matters. We'll discuss scope and approach before any implementation work begins.
- **Questions** — if something is unclear or undocumented, that's a bug in our docs. Open an issue and we'll fix it.

## How to Contribute Code

1. **Fork** the repository on GitHub
2. **Clone** your fork and set it up:

```bash
git clone https://github.com/<your-username>/Cerebro.git
cd Cerebro

# Install frontend dependencies
npm install

# Set up the Python backend (creates backend/venv + installs requirements)
npm run setup

# Start the app (also auto-creates the backend venv if it's missing)
npm start
```

> The Python backend runs from `backend/venv`. `npm run setup` creates it for you; `npm start`
> re-checks it via a `prestart` guard and bootstraps it if missing. To set it up by hand instead:
>
> ```bash
> cd backend && python3 -m venv venv && venv/bin/pip install -r requirements.txt
> ```

> **Requirements:** Node.js >= 20, Python >= 3.11. On macOS you'll also need Xcode Command Line Tools for native modules.

3. **Create a branch** for your change:

```bash
git checkout -b feat/your-feature-name
```

4. **Make your changes** — follow the existing code style (Prettier and ESLint are configured) and add tests if your change affects behavior
5. **Run the checks** before committing:

```bash
npm run lint          # ESLint
npm run format:check  # Prettier
npm test              # Frontend + backend tests
```

6. **Commit** with a clear message: `type(scope): description` (e.g., `fix(memory): prevent duplicate fact extraction`)
7. **Push** to your fork: `git push origin feat/your-feature-name`
8. **Open a Pull Request** against `main` on the original repository — reference the related issue (e.g., "Closes #42")

CI runs frontend and backend tests automatically on every PR. A maintainer will review your changes and may request updates. Please keep PRs focused — one logical change per PR.

## Project Structure

| Directory | What lives there |
|---|---|
| `src/` | Electron + React frontend (TypeScript) |
| `backend/` | Python FastAPI server |
| `docs/` | PRD, tech designs, architecture docs |
| `scripts/` | Setup and utility scripts |

## Good First Contributions

Look for issues labeled [`good first issue`](https://github.com/AgenticFirst/Cerebro/labels/good%20first%20issue) — these are scoped, well-defined, and a great way to get familiar with the codebase.

You can also help by improving documentation, adding test coverage, or translating the UI (see `src/i18n/locales/`).

## Code of Conduct

Be respectful, constructive, and inclusive. We're building something together.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
