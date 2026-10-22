ALTER TABLE "feedback"
ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';
