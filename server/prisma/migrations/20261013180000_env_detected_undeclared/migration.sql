-- Server package re-check (#251): keys detected in the uploaded package that
-- neither the SKILL.md declaration nor the client listed. Author and admin review only.
ALTER TABLE "skill_versions" ADD COLUMN "detectedUndeclared" JSONB;
