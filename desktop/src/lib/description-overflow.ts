export function descriptionOverflows(element: { scrollHeight: number; clientHeight: number }): boolean {
  return element.scrollHeight > element.clientHeight
}
