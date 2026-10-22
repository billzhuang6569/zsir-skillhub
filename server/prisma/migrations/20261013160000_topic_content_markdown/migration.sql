-- Topic articles (#211): the Markdown body is the single source of a topic's
-- Skill items and its plain-text introContent. NULL keeps a topic in its legacy
-- (un-articled) form; the DTO synthesizes a body for it. No backfill.
ALTER TABLE "marketplace_topics" ADD COLUMN "contentMarkdown" TEXT;
