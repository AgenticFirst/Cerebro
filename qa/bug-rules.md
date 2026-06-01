# Universal bug rules

These are always bugs, regardless of product:

- A button that does nothing when clicked.
- A blank screen after a successful navigation.
- An uncaught console error during a successful flow.
- A 5xx response on the happy path.
- A successful navigation followed by data loss on refresh.
- A "save" or "submit" handler that doesn't persist.

These rules apply even when this file is empty downstream — they're hard-coded into Manual QA's oracle.
