CREATE TABLE "comment_mentions" (
    "commentId" TEXT NOT NULL,
    "mentionedUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_mentions_pkey" PRIMARY KEY ("commentId", "mentionedUserId")
);

CREATE INDEX "comment_mentions_mentionedUserId_createdAt_idx"
ON "comment_mentions"("mentionedUserId", "createdAt");

ALTER TABLE "comment_mentions"
ADD CONSTRAINT "comment_mentions_commentId_fkey"
FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comment_mentions"
ADD CONSTRAINT "comment_mentions_mentionedUserId_fkey"
FOREIGN KEY ("mentionedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
