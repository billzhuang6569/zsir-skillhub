// Verified 2026-10-18: fal's official nano-banana-2 page says "From $0.06/image";
// third-party comparison listings quote $0.08/image. Use the conservative estimate;
// actual fal billing is authoritative. https://fal.ai/models/fal-ai/nano-banana-2
const PER_IMAGE_USD: Readonly<Record<string, number>> = { 'fal-ai/nano-banana-2': 0.08 }

export function falPriceEstimate(model: string, count: number): { perImageUsd: number | null; estimatedCostUsd: number | null } {
  const perImageUsd = PER_IMAGE_USD[model] ?? null
  return { perImageUsd, estimatedCostUsd: perImageUsd === null ? null : Math.round(perImageUsd * count * 100) / 100 }
}
