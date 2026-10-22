-- Store a redacted copy of SKILL.md so authorized team members can inspect a
-- remote Skill before installing it. Raw secrets are removed before this field
-- is written by the application.
ALTER TABLE "skills" ADD COLUMN "sourceContent" TEXT;
ALTER TABLE "skills" ADD COLUMN "envDependencies" JSONB NOT NULL DEFAULT '[]';

-- Deleting a user's parent comment should also remove its direct replies.
ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "comments_parentId_fkey";
ALTER TABLE "comments"
  ADD CONSTRAINT "comments_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "comments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
