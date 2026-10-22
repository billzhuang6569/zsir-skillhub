import { z } from 'zod'

const EditorialLabel = z.string().max(128)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), '标签不能包含换行或控制字符')
  .transform((value) => value.normalize('NFC').trim())
  .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 5, '每个标签需要 1–5 个字符')
  .refine((value) => !['精选', 'NEW', 'HOT'].includes(value.toUpperCase()), '精选、NEW、HOT 由系统控制')

export const EditorialLabelsSchema = z.array(EditorialLabel).max(8, '最多添加 8 个标签')
  .transform((values) => [...new Set(values)])

export const MarketplaceEditorialBody = z.object({
  featured: z.boolean().optional(),
  original: z.boolean().optional(),
  editorialLabels: EditorialLabelsSchema.optional(),
  expectedEditorialLabels: EditorialLabelsSchema.optional(),
}).strict().refine((value) => value.featured !== undefined || value.original !== undefined || value.editorialLabels !== undefined, '请选择要修改的字段')
  .refine((value) => (value.editorialLabels !== undefined) === (value.expectedEditorialLabels !== undefined), '编辑标签需要提供原标签，请刷新后重试')
