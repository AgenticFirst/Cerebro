# debugging-and-error-recovery

Find the root cause, not a symptom that quiets the alarm.

## Operating rules
- Reproduce first. If you can't reproduce a bug deterministically, the fix is unverifiable.
- Bisect along one axis: input, environment, code version, time. Don't change two variables.
- Read the actual error and the actual stack. Don't paraphrase from memory.
- Form a hypothesis, predict what evidence would refute it, then go look for that evidence.
- A fix without a test is a guess. Add the test.

## Anti-patterns
- Wrapping a failure in try/catch and continuing.
- "I think this might be related" — verify before editing.
- Renaming a variable to silence a warning.