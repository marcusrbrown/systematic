# Decision graph records

Fixture in the shape of a Deciduous sync folder: one JSON file per record.
`nodes/<change_id>.json` holds goals, decisions, options, actions, outcomes and
observations. `edges/<edge_id>.json` links two nodes by `change_id`. A record
with `deleted_at` is a tombstone. This note is not a record and is never indexed.
