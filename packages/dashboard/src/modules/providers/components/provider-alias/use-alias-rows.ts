import { type AliasRow, blankAliasRow } from '../../lib/alias-editor';

export const useAliasRows = (rows: readonly AliasRow[], onAliasChange: (rows: readonly AliasRow[]) => void) => ({
  addAlias: (model: string | undefined) => {
    if (model === undefined) return;
    onAliasChange([...rows, blankAliasRow(model)]);
  },
  removeAlias: (id: string) => onAliasChange(rows.filter((row) => row.id !== id)),
  rename: (id: string, name: string) =>
    onAliasChange(
      rows.map((row) =>
        row.id === id ? { ...row, name, origin: row.origin === 'inherited' ? 'authored' : row.origin } : row,
      ),
    ),
});
