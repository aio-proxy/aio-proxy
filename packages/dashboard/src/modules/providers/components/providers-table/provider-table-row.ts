import type { DashboardProviderSummary } from '@aio-proxy/types';

export interface ConcreteProviderTableRow {
  readonly rowType: 'provider';
  readonly provider: DashboardProviderSummary;
}

export interface OAuthProviderGroupTableRow {
  readonly rowType: 'oauth-group';
  readonly groupKey: string;
  readonly accounts: ConcreteProviderTableRow[];
}

export type ProviderTableRow = ConcreteProviderTableRow | OAuthProviderGroupTableRow;

export const groupProviderRows = (providers: readonly DashboardProviderSummary[]): readonly ProviderTableRow[] => {
  const rows: ProviderTableRow[] = [];
  const groups = new Map<string, ConcreteProviderTableRow[]>();

  for (const provider of providers) {
    const concrete: ConcreteProviderTableRow = { rowType: 'provider', provider };
    if (provider.kind !== 'oauth' || provider.plugin === undefined || provider.capability === undefined) {
      rows.push(concrete);
      continue;
    }

    const groupKey = `${provider.plugin}/${provider.capability}`;
    const accounts = groups.get(groupKey);
    if (accounts === undefined) {
      const nextAccounts = [concrete];
      groups.set(groupKey, nextAccounts);
      rows.push({ rowType: 'oauth-group', groupKey, accounts: nextAccounts });
    } else {
      accounts.push(concrete);
    }
  }

  return rows;
};

export const providerTableRowId = (row: ProviderTableRow): string =>
  row.rowType === 'oauth-group' ? `oauth-group:${row.groupKey}` : `provider:${row.provider.id}`;
