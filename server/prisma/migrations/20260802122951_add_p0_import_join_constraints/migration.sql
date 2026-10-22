/*
  Warnings:

  - A unique constraint covering the columns `[authorId,name]` on the table `skills` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[teamId,applicantId]` on the table `team_join_requests` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "team_join_requests" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE UNIQUE INDEX "skills_authorId_name_key" ON "skills"("authorId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "team_join_requests_teamId_applicantId_key" ON "team_join_requests"("teamId", "applicantId");
