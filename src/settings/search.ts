/** Pure search/filter over settings pages. No vscode dependency, unit tested directly. */

export interface SearchRow { title: string; description: string }
export interface SearchPage { id: string; title: string; rows: SearchRow[] }

export function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

/** Page ids whose title or a row matches the query, in the given page order. Empty query matches everything. */
export function filterPages(pages: SearchPage[], query: string): string[] {
  const q = query.trim();
  if (!q) return pages.map(page => page.id);
  return pages.filter(page => matchesQuery(page.title, q) || page.rows.some(row => matchesQuery(row.title, q) || matchesQuery(row.description, q))).map(page => page.id);
}

/** Rows within one page that match the query. Empty query returns every row. */
export function matchingRows(page: SearchPage, query: string): SearchRow[] {
  const q = query.trim();
  if (!q) return page.rows;
  return page.rows.filter(row => matchesQuery(row.title, q) || matchesQuery(row.description, q));
}
