import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@aio-proxy/ui/components/item';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import { checkLatestReleaseMutationFn, useReleaseQuery } from '@/lib/release';

import { SettingsExternalLink } from './settings-external-link';
import { SettingsRowChevron } from './settings-row-chevron';
import { SettingsUpdateNowButton } from './settings-update-now-button';

const REPOSITORY_URL = 'https://github.com/aio-proxy/aio-proxy';
const DOCUMENTATION_URL = 'https://aioproxy.dev';

export const SettingsAboutGroup: React.FC = () => {
  const queryClient = useQueryClient();
  const release = useReleaseQuery();
  const check = useMutation({
    mutationFn: checkLatestReleaseMutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.release });
    },
  });
  const current = release.data?.current;
  const persistedOutdated = release.data?.outdated === true;
  const checkOutdated = check.data?.outdated;
  const outdated = checkOutdated ?? persistedOutdated;
  const latest = check.data?.latest ?? release.data?.latest;

  // A failed lookup must not read as "up to date": an unreachable registry says nothing
  // about the published version. A failed install is the same — do not replace it with
  // the last successful "up to date" check. Mount-time GET /release already carries the
  // last persisted check, so About can show that without waiting for a manual Check.
  const versionDescription = (() => {
    if (current === undefined) return undefined;
    if (check.isError) return m['dashboard.settings.version_check_failed']();
    if (check.data === undefined && !persistedOutdated) {
      return m['dashboard.settings.version_description']({ version: current });
    }
    if (outdated && latest !== undefined) return m['dashboard.settings.version_outdated']({ version: latest });
    if (release.data?.update.status === 'failed') {
      return m['dashboard.settings.version_description']({ version: current });
    }
    return m['dashboard.settings.version_up_to_date']();
  })();

  return (
    <Card data-testid="settings-group-about">
      <CardHeader>
        <CardTitle>
          <h2>{m['dashboard.settings.about_group']()}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ItemGroup>
          {/* The version row carries its own buttons, so the row itself cannot be the link —
              nesting a button inside an anchor is invalid and swallows one of the two actions. */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{m['dashboard.settings.version']()}</ItemTitle>
              <ItemDescription>{versionDescription ?? <Skeleton className="h-4 w-40" />}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="ghost" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
                {m['dashboard.settings.version_check']()}
              </Button>
              <SettingsUpdateNowButton outdated={outdated} onUpToDate={() => check.reset()} />
              <SettingsExternalLink
                href={current === undefined ? REPOSITORY_URL : `${REPOSITORY_URL}/releases/tag/v${current}`}
                label={m['dashboard.settings.version']()}
              />
            </ItemActions>
          </Item>
          {/* These rows do nothing but navigate, so the whole row is the anchor and its title
              supplies the accessible name — the chevron is decoration, not a second control. */}
          <Item size="sm" render={<a href={REPOSITORY_URL} target="_blank" rel="noreferrer" />}>
            <ItemContent>
              <ItemTitle>{m['dashboard.settings.repository']()}</ItemTitle>
              <ItemDescription>{m['dashboard.settings.repository_description']()}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <SettingsRowChevron />
            </ItemActions>
          </Item>
          <Item size="sm" render={<a href={DOCUMENTATION_URL} target="_blank" rel="noreferrer" />}>
            <ItemContent>
              <ItemTitle>{m['dashboard.settings.documentation']()}</ItemTitle>
              <ItemDescription>{m['dashboard.settings.documentation_description']()}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <SettingsRowChevron />
            </ItemActions>
          </Item>
        </ItemGroup>
      </CardContent>
    </Card>
  );
};
