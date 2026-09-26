/**
 * supabase/functions/_shared/like.ts
 *
 * Escaping for values interpolated into SQL `LIKE` / `ILIKE` patterns.
 *
 * FINDING M16. Account ids are matched case-insensitively with
 * `.ilike("id", value)`, which treats `%` and `_` as wildcards. Every one of
 * those call sites means "equals, ignoring case" — none of them wants pattern
 * matching — so an unescaped value turns an identity lookup into a pattern
 * search:
 *
 *   * `.ilike("id", "%")` on a SELECT matches an arbitrary account.
 *   * `.ilike("id", "%")` on an UPDATE matches EVERY row. The client used to
 *     carry exactly that shape.
 *
 * The obvious-looking fix — rejecting `%` and `_` in identifiers — is wrong
 * here: `_` is perfectly legal in a real account id (`Ares_Actual`), and
 * `gm_generate_account_id` produces ids containing it. Escaping keeps those
 * working while removing the wildcard meaning.
 */

/**
 * Escapes the three characters that carry meaning inside a LIKE pattern.
 *
 * The backslash must be escaped first, otherwise the escapes added for `%` and
 * `_` would themselves be re-escaped.
 */
export function escapeLike(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Escapes a value destined for a PostgREST `.or()` filter string.
 *
 * `.or()` takes a comma-separated list of `column.operator.value` triples, so a
 * comma, a parenthesis or a dot inside the value re-partitions the expression
 * and changes which rows the query returns. Those three go, then the LIKE
 * wildcards are escaped on what remains.
 */
export function escapeOrFilterValue(value: string): string {
  return escapeLike(String(value ?? "").replace(/[,()]/g, " "));
}
