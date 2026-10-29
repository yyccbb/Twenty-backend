-- The token ledger is append-only: corrections are new entries (rules.md §7).
CREATE FUNCTION token_ledger_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'token_ledger is append-only (% rejected)', TG_OP USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER token_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON token_ledger
  FOR EACH ROW EXECUTE FUNCTION token_ledger_reject_change();
--> statement-breakpoint
CREATE TRIGGER token_ledger_no_truncate
  BEFORE TRUNCATE ON token_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION token_ledger_reject_change();
--> statement-breakpoint
-- Reward rule v1: placeholder values from contracts/rules/fixtures.json until the game design is final.
INSERT INTO reward_rules (version, tokens_per_bar, early_bar_rate, extended_bar_rate, auto_finish_deduction_bars)
VALUES (1, 10, 0.5, 0.5, 1);
