export type PaginationItem = number | "ellipsis";

export function getPaginationItems(pageOptions: readonly number[], pageIndex: number): PaginationItem[] {
  if (pageOptions.length <= 7) return [...pageOptions];

  const firstPage = pageOptions[0];
  const lastPage = pageOptions.at(-1);
  if (firstPage === undefined || lastPage === undefined) return [];

  if (pageIndex <= 3) return [...pageOptions.slice(0, 5), "ellipsis", lastPage];
  if (pageIndex >= lastPage - 3) return [firstPage, "ellipsis", ...pageOptions.slice(-5)];

  return [firstPage, "ellipsis", pageIndex - 1, pageIndex, pageIndex + 1, "ellipsis", lastPage];
}
