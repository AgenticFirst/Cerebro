# Critical flows (in test priority order)

These flows MUST pass on every nightly Manual QA run. If any of these stay broken, ship is blocked.

1. **Login** — see `qa/playwright/flows/login.flow.md`
2. **Sign up** — see `qa/playwright/flows/sign-up.flow.md`
3. **Logout** — see `qa/playwright/flows/logout.flow.md`
4. **Create main resource** — see `qa/playwright/flows/create-main-resource.flow.md`
5. **Refresh keeps state** — see `qa/playwright/flows/refresh-keeps-state.flow.md`

To add a flow, drop a new `*.flow.md` in `qa/playwright/flows/` and append it here.
