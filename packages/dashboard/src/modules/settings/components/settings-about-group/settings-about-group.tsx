import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@aio-proxy/ui/components/item';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useMutation } from '@tanstack/react-query';

import { useReleaseQuery } from '../../hooks/use-release-query';
import { checkLatestReleaseMutationFn } from '../../services/release-service';
import { SettingsExternalLink } from './settings-external-link';
import { SettingsRowChevron } from './settings-row-chevron';

const REPOSITORY_URL = 'https://github.com/aio-proxy/aio-proxy';
const DOCUMENTATION_URL = 'https://aio-proxy.github.io';

export const SettingsAboutGroup: React.FC = () => {
  const release = useReleaseQuery();
  const check = useMutation({ mutationFn: checkLatestReleaseMutationFn });
  const current = release.data?.current;

  // A failed lookup must not read as "up to date": an unreachable registry says nothing
  // about the published version.
  const versionDescription = (() => {
    if (current === undefined) return undefined;
    if (check.isError) return m['dashboard.settings.version_check_failed']();
    if (check.data === undefined) return m['dashboard.settings.version_description']({ version: current });
    return check.data.outdated
      ? m['dashboard.settings.version_outdated']({ version: check.data.latest })
      : m['dashboard.settings.version_up_to_date']();
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
          {/* The version row carries its own button, so the row itself cannot be the link —
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
