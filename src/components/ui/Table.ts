/**
 * src/components/ui/Table.ts
 *
 * Modern wrapper around the existing .gm-table / .gm-table-wrap primitives
 * (shadcn/ui philosophy) — sticky headers, alignment helpers, accessible
 * loading/empty states (role="status") and conditional row highlighting.
 *
 * The full renderTable() generator suits JSON-style grids. For imperative
 * grids (editable score tables) the granular helpers below (tableWrap,
 * renderTableHead, renderTableCell, renderTableEmpty, renderTableLoading)
 * compose the same DOM contract without re-architecting the row renderer.
 */

import { cn } from '../../core/utils/cn';
import { escapeHTML } from '../../core/utils/text';

export type TableAlign = 'left' | 'center' | 'right';

export interface TableColumn<T = Record<string, unknown>> {
  key: string;
  label: string;
  align?: TableAlign;
  /** Extra class on both th and td (e.g. data-label contracts). */
  className?: string;
  /** Per-column content override; ignored when the row-level `cell` returns. */
  render?: (row: T) => string | null;
  /** Column header class override (e.g. sticky). */
  headerClassName?: string;
}

export interface TableProps<T = Record<string, unknown>> {
  columns: TableColumn<T>[];
  rows?: T[];
  /** Row-level class add-ons based on the row (e.g. 'participated'). */
  rowClass?: (row: T, index: number) => string;
  /** Conditional highlight class (alert / target reached) + data-state. */
  highlight?: (row: T, index: number) => string | null;
  /** Row-level cell override; returning null falls through to the column. */
  cell?: (row: T, column: TableColumn<T>) => string | null;
  /** Full-width empty-state message (already i18n-resolved). */
  emptyText?: string;
  /** Renders an accessible loading state instead of rows. */
  loading?: boolean;
  loadingText?: string;
  /** Adds the responsive .gm-resp-table class. */
  responsive?: boolean;
  /** Sticky table header (top: 0 within the scroll wrap). */
  sticky?: boolean;
  /** Wrap the table in gm-table-wrap/gm-table-scroll. */
  wrapped?: boolean;
  /** Row key attribute data (e.g. pseudo). */
  rowKey?: (row: T, index: number) => string;
  ariaLabel?: string;
}

function thClass(col: TableColumn<unknown>): string {
  const align = col.align ? ' gm-' + col.align : '';
  return cn('gm-ui-table-th' + align, col.className, col.headerClassName);
}

function tdClass(col: TableColumn<unknown>): string {
  const align = col.align ? ' gm-' + col.align : '';
  return cn('gm-ui-table-td' + align, col.className);
}

export function renderTableHead<T = Record<string, unknown>>(columns: TableColumn<T>[]): string {
  return '<thead><tr>' +
    columns.map((col) =>
      '<th class="' + cn(thClass(col as TableColumn<unknown>)) + '">' + escapeHTML(col.label) + '</th>'
    ).join('') +
    '</tr></thead>';
}

export function renderTableCell(content: string | number, align?: TableAlign, dataLabel?: string): string {
  return '<td class="gm-ui-table-td' + (align ? ' gm-' + align : '') + '"' +
    (dataLabel ? ' data-label="' + escapeHTML(dataLabel) + '"' : '') + '>' +
    String(content) + '</td>';
}

export function renderTableEmpty(colspan: number, emptyText: string): string {
  return '<tbody><tr class="gm-ui-table-empty-row"><td colspan="' + colspan + '" role="status" aria-live="polite">' +
    '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' +
    escapeHTML(emptyText) + '</div></div></td></tr></tbody>';
}

export function renderTableLoading(colspan: number, loadingText?: string): string {
  const label = loadingText === undefined ? 'Loading…' : loadingText;
  return '<tbody><tr class="gm-ui-table-loading-row"><td colspan="' + colspan + '" role="status" aria-live="polite">' +
    '<span class="gm-ui-table-loading" aria-busy="true">' + escapeHTML(label) + '</span></td></tr></tbody>';
}

export function tableClass(props: Pick<TableProps, 'sticky' | 'responsive'>): string {
  return cn('gm-table', 'gm-ui-table-el', props.responsive ? 'gm-resp-table' : '', props.sticky ? 'gm-ui-table-sticky' : '');
}

export function tableWrapClass(props: Pick<TableProps, 'wrapped'>): string {
  return cn('gm-table-wrap', 'gm-ui-table-wrap', props.wrapped !== false ? '' : undefined);
}

export function renderTable<T = Record<string, unknown>>(props: TableProps<T>): string {
  const columns = props.columns;
  const colspan = Math.max(1, columns.length);

  let bodyHtml = '';
  if (props.loading) {
    bodyHtml = renderTableLoading(colspan, props.loadingText);
  } else if (!props.rows || props.rows.length === 0) {
    bodyHtml = renderTableEmpty(colspan, props.emptyText || 'No data');
  } else {
    const rowsHtml = props.rows.map((row, i) => {
      const rowClass = cn('gm-ui-table-row', props.rowClass?.(row, i), props.highlight?.(row, i));
      const dataState = props.highlight?.(row, i);
      const dataKey = props.rowKey?.(row, i);
      const cells = columns.map((col) => {
        const custom = props.cell?.(row, col as TableColumn<T>);
        const value = custom !== null && custom !== undefined
          ? custom
          : (col.render?.(row) ?? escapeHTML(String((row as Record<string, unknown>)[col.key] ?? '')));
        return '<td class="' + cn(tdClass(col as TableColumn<unknown>)) + '">' + value + '</td>';
      }).join('');
      return '<tr class="' + rowClass + '"' +
        (dataState ? ' data-state="' + escapeHTML(dataState) + '"' : '') +
        (dataKey ? ' data-row-key="' + escapeHTML(dataKey) + '"' : '') +
        '>' + cells + '</tr>';
    }).join('');
    bodyHtml = '<tbody>' + rowsHtml + '</tbody>';
  }

  const caption = props.ariaLabel
    ? '<caption class="gm-ui-table-caption"><span class="visually-hidden">' + escapeHTML(props.ariaLabel) + '</span></caption>'
    : '';

  const table =
    '<table class="' + cn(tableClass(props)) + '"' + (props.ariaLabel ? ' aria-label="' + escapeHTML(props.ariaLabel) + '"' : '') + '>' +
      caption +
      renderTableHead(columns) +
      bodyHtml +
    '</table>';

  const wrapped = props.wrapped !== false;
  return wrapped
    ? '<div class="gm-table-wrap gm-ui-table-wrap"><div class="gm-table-scroll">' + table + '</div></div>'
    : table;
}

/** Mounts renderTable() output into `host` and returns the table element. */
export function createTable<T = Record<string, unknown>>(host: HTMLElement, props: TableProps<T>): HTMLTableElement | null {
  host.innerHTML = renderTable(props);
  return host.querySelector<HTMLTableElement>('table');
}