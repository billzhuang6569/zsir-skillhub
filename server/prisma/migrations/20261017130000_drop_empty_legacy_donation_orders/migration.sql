-- donation_orders moved to the private donation service (#389). Fresh databases
-- drop the empty legacy table; a database that still holds orders keeps it
-- untouched for the private handover and backup.
DO $$
BEGIN
  IF to_regclass('donation_orders') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "donation_orders") THEN
      DROP TABLE "donation_orders";
    END IF;
  END IF;
END $$;
