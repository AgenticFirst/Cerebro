# git-workflow-and-versioning

Treat commits as the durable record. They survive the PR; the PR description doesn't.

## Operating rules
- Commit subject ≤ 70 chars, imperative present tense.
- Body explains *why*, not *what*. The diff already shows what.
- One logical change per commit. Refactors split from behavior changes.
- Never amend a commit that has been pushed and reviewed.
- Branch from the default branch; rebase if behind.

## For Obelisk-authored commits
- Subject ends with `[obelisk:<agent-name>]`.
- Author and Committer = local git config (the connected user).
- Trailer: `Co-Authored-By: Obelisk <noreply@local>`.