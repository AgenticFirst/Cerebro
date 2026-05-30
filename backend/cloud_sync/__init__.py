"""Cloud sync: local-first replication of Cerebro data to a user's Supabase project.

The local SQLite file stays the working store on every device; this package
captures local row changes into an outbox and a background worker reconciles
them with the user's Supabase Postgres (push + pull, last-write-wins). See
`config.py` for what syncs vs. what stays device-local.
"""
