<!-- connect-manifest:c5dbb19a09237588 -->

## ce:connect report

**Outcome:** Connect complete.

```
Selection: all allowed projects
Sweep: covered 12 of 40 rules (current hashes); this run covered 8; about 4 runs left in the sweep.
```

> **Ledger reset.** No cache was restored for this run, so the ledger and the sweep started fresh. Earlier decisions are not remembered, and a tick for a candidate the ledger no longer knows is reported as unresolved.

## Fetch

Run one of these in a local checkout to bring the evidence in before you promote:
- `/ce:connect fetch:900.1` for candidates 1-2
- `/ce:connect fetch:905.2` for candidates 3

## Open candidates

3 open, 3 listed, 1 new.

Tick **Promoted** after you have promoted a candidate, or **Rejected** to dismiss it, one box per candidate. Ticking both boxes for one candidate is ignored. The next run reads the ticks, and a settled candidate leaves this list.

<!-- connect-decisions:begin -->

### Candidate 1

- Fetch: `/ce:connect fetch:900.1` (run 900, attempt 1)

```
Id: fed53ee6b0ddd474f9f2d93dfdb7c00321eb6538ec02a4572f6b986724403584
Kind: transferable-lesson
Target: target (acme/target)
Title: Lesson 1
Summary: Summary of lesson 1.
Next step: compound-learning
Sources:
- source docs/solutions/lesson-1.md
  Excerpt: Excerpt of lesson 1 from the source learning.
```

- [ ] Promoted <!-- connect-decision:promoted:fed53ee6b0ddd474f9f2d93dfdb7c00321eb6538ec02a4572f6b986724403584:r084cffab757a -->
- [ ] Rejected <!-- connect-decision:rejected:fed53ee6b0ddd474f9f2d93dfdb7c00321eb6538ec02a4572f6b986724403584:r084cffab757a -->

### Candidate 2

- Fetch: `/ce:connect fetch:900.1` (run 900, attempt 1)

```
Id: 5b9f45cfe85bb8dccbe042aadc887f928cba25e9241dcc0442c85e8f8d0c49e9
Kind: transferable-lesson
Target: target (acme/target)
Title: Lesson 2
Summary: Summary of lesson 2.
Next step: compound-learning
Sources:
- source docs/solutions/lesson-2.md
  Excerpt: Excerpt of lesson 2 from the source learning.
```

- [ ] Promoted <!-- connect-decision:promoted:5b9f45cfe85bb8dccbe042aadc887f928cba25e9241dcc0442c85e8f8d0c49e9:r911cca5ac9d5 -->
- [ ] Rejected <!-- connect-decision:rejected:5b9f45cfe85bb8dccbe042aadc887f928cba25e9241dcc0442c85e8f8d0c49e9:r911cca5ac9d5 -->

### Candidate 3 (new)

- Fetch: `/ce:connect fetch:905.2` (run 905, attempt 2)

```
Id: 40863b146a36aedfe80491a58026de35a518a7dc0c2b45307c5aee6d860a9d25
Kind: transferable-lesson
Target: target (acme/target)
Title: Lesson 3
Summary: Summary of lesson 3.
Next step: compound-learning
Sources:
- source docs/solutions/lesson-3.md
  Excerpt: Excerpt of lesson 3 from the source learning.
```

- [ ] Promoted <!-- connect-decision:promoted:40863b146a36aedfe80491a58026de35a518a7dc0c2b45307c5aee6d860a9d25:re455dd41c91a -->
- [ ] Rejected <!-- connect-decision:rejected:40863b146a36aedfe80491a58026de35a518a7dc0c2b45307c5aee6d860a9d25:re455dd41c91a -->

<!-- connect-decisions:end -->

## No verified details

1 open candidate has no verified details for the current revision, so there is nothing to tick. Oldest first: `9897e724e82c50cb090c27ee12e1406ccdab778b8cc2f7c10d447696e601e9c1`.
