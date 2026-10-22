-- Existing comments intentionally remain personal (teamId = NULL). They are
-- visible only to the author of the corresponding Skill.
ALTER TABLE "comments" ADD COLUMN "teamId" TEXT;

CREATE INDEX "comments_skillId_teamId_parentId_idx"
ON "comments"("skillId", "teamId", "parentId");

ALTER TABLE "comments"
ADD CONSTRAINT "comments_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "teams"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
