import { Injectable } from '@angular/core';
import { MatPaginatorIntl } from '@angular/material/paginator';

/**
 * A paginator label for a list that has no total.
 *
 * `MatPaginator` was written for offset paging and wants `length` — the row count — to
 * work out how many pages exist. The register is paged by keyset instead: the server
 * answers "here are fifteen rows, and here is the cursor for the next fifteen", which
 * is what keeps the order stable when a resident is added mid-browse and what avoids a
 * `COUNT(*)` that gets slower as the building fills.
 *
 * So `length` is fed a derived value that says only "there is at least one more page"
 * or "this is the last one", enough for the arrows to enable correctly. That value is
 * not a row count, and the default label would print it as one — "1 – 15 of 61" would
 * be a number nobody measured. This prints the range alone.
 */
@Injectable()
export class KeysetPaginatorIntl extends MatPaginatorIntl {
  override itemsPerPageLabel = 'Rows per page';
  override nextPageLabel = 'Next page';
  override previousPageLabel = 'Previous page';
  override firstPageLabel = 'First page';
  override lastPageLabel = 'Last page';

  override getRangeLabel = (page: number, pageSize: number, length: number): string => {
    if (length === 0 || pageSize === 0) return 'No rows';
    const first = page * pageSize + 1;
    const last = Math.min((page + 1) * pageSize, length);
    return `${first} – ${last}`;
  };
}
