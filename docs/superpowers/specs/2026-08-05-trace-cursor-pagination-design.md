# Trace Cursor Pagination Design

## Goal

Replace offset pagination on the Trace list with stable bidirectional keyset pagination while keeping the list as a conventional page-replacement table.

## API Contract

`GET /dashboard/api/traces` accepts all existing filters plus:

```ts
interface DashboardTracesRequest {
  pageSize: 10 | 20 | 50 | 100;
  pageToken?: string;
}
```

The response is:

```ts
interface DashboardTracesPage {
  items: DashboardTraceSummary[];
  nextPageToken?: string;
  prevPageToken?: string;
}
```

An omitted `pageToken` requests the latest page. `nextPageToken` requests the adjacent older page and `prevPageToken` requests the adjacent newer page. The latest page has no `prevPageToken`; the terminal oldest page has no `nextPageToken`. The API no longer returns `page`, `pageCount`, or `total`.

Tokens are opaque, versioned Base64URL values encoding the direction and the stable `(startedAt, traceId)` boundary. Invalid tokens return HTTP 400. Queries remain ordered by `startedAt DESC, traceId DESC`, fetch `pageSize + 1` rows, and use a lexicographic keyset predicate instead of `OFFSET` and `COUNT(*)`.

## Dashboard State

The browser URL contains filters, `pageSize`, and optional `pageToken`. Changing any filter or `pageSize` removes `pageToken`. Previous and next controls navigate by replacing only `pageToken`, so browser back and forward restore the page.

The dashboard uses ordinary TanStack `useQuery`, not `useInfiniteQuery`. The query key includes the complete validated URL search. `keepPreviousData` keeps the existing table visible while an adjacent page loads.

Automatic polling runs only on the latest page where `pageToken` is absent. A refreshed latest response is buffered when it contains unseen Trace IDs. The in-table status row reports the number of unseen items in that latest response; accepting it replaces the current page. Older pages do not poll.

## Table Interaction

The table renders one response page. It does not configure TanStack Table manual pagination or page counts. Its footer exposes Previous and Next actions based solely on `prevPageToken` and `nextPageToken`. Loading, terminal, and invalid-token states do not invent numeric page positions.

## Error Handling

Malformed tokens are rejected by the server with 400. The dashboard shows the existing query error treatment plus an action that clears `pageToken` and returns to the latest page. Empty filtered results remain a normal empty state.

## Verification

Core tests cover stable traversal in both directions, timestamp ties, inserted newer rows, terminal tokens, and malformed tokens. Server tests cover request validation and response shape. Dashboard tests cover URL parsing, API request forwarding, previous/next navigation, polling only at the latest page, and accepting buffered new traces.
