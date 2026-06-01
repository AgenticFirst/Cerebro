# test-driven-development

Write the test first. The Prove-It Pattern is non-negotiable for Bug Fixer.

## Prove-It Pattern (bugs)
1. Read the bug report.
2. Write a failing test that demonstrates the bug. Run it. Confirm it fails for the reason in the report.
3. Commit the failing test on its own.
4. Make the test pass with the smallest reasonable change.
5. Run the full suite. Nothing else may regress.

## For features
- Write a unit test or integration test for each behavior the spec promises.
- Test the public surface, not the implementation. If the test breaks under refactor, the test is over-specified.
- Don't mock the database in integration tests — exercise the real path.

## Anti-patterns
- Tests that pass without exercising the new code path.
- Snapshot tests on prose output (untrustworthy).
- Tests that match implementation details instead of behavior.