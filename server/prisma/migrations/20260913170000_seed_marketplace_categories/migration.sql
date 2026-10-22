-- Marketplace directories are product-owned taxonomy, not demonstration data.
-- Keep stable IDs so listings can be mapped consistently across environments.
INSERT INTO "marketplace_categories" ("id", "slug", "name", "description", "sortOrder", "enabled", "createdAt", "updatedAt")
VALUES
  ('88000000-0000-4000-8000-000000000001', 'collaboration-office', '协作与办公', NULL, 10, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('88000000-0000-4000-8000-000000000002', 'development-engineering', '开发与工程', NULL, 20, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('88000000-0000-4000-8000-000000000003', 'content-creation', '内容与创作', NULL, 30, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('88000000-0000-4000-8000-000000000004', 'automation-integration', '自动化与集成', NULL, 40, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('88000000-0000-4000-8000-000000000005', 'search-research', '搜索与研究', NULL, 50, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('88000000-0000-4000-8000-000000000006', 'data-analysis', '数据与分析', NULL, 60, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "slug" = EXCLUDED."slug",
  "sortOrder" = EXCLUDED."sortOrder",
  "enabled" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "marketplace_listings" AS listing
SET "categoryId" = category."id"
FROM "marketplace_submissions" AS submission,
     "marketplace_categories" AS category
WHERE listing."submissionId" = submission."id"
  AND listing."categoryId" IS NULL
  AND submission."category" = category."name";
