# incremental-implementation

Build in vertical slices. Each commit should be reviewable on its own.

## Operating rules
- A vertical slice is the smallest change that takes the system from working state A to working state B. Tests stay green at every commit.
- Land one slice at a time. Refactors that aren't needed for the slice go in their own commit.
- A slice that touches more than ~5 files probably isn't a slice.
- One commit per slice. Commit subject is imperative, present tense, < 70 chars.

## Anti-patterns
- "WIP" commits that leave the build broken.
- Refactor mixed with behavior change in the same commit.
- A 600-line commit that only the author can review.