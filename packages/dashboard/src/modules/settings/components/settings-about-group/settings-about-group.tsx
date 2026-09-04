import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { FieldGroup } from '@aio-proxy/ui/components/field';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useMutation } from '@tanstack/react-query';

import { useReleaseQuery } from '../../hooks/use-release-query';
import { checkLatestReleaseMutationFn } from '../../services/release-service';
import { SettingsFieldRow } from '../settings-field-row';
import { SettingsExternalLink } from './settings-external-link';

const REPOSITORY_URL = 'https://github.com/aio-proxy/aio-proxy';
const DOCUMENTATION_URL = 'https://aio-proxy.github.io';

export const SettingsAboutGroup: React.FC = () => {
  const release = useReleaseQuery();
  const check = useMutation({ mutationFn: checkLatestReleaseMutationFn });
  const current = release.data?.current;

  // A failed lookup must not read as "up to date": an unreachable registry says nothing
  // about the published version.
  const versionDescription = (() => {
    if (check.isError) return m['dashboard.settings.version_check_failed']();
    if (check.data === undefined) return m['dashboard.settings.version_description']();
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
        <FieldGroup>
          <SettingsFieldRow label={m['dashboard.settings.version']()} description={versionDescription}>
            <div className="flex items-center gap-2">
              {current === undefined ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <SettingsExternalLink href={`${REPOSITORY_URL}/releases/tag/v${current}`}>
                  {current}
                </SettingsExternalLink>
              )}
              <Button variant="ghost" disabled={check.isPending} onClick={() => check.mutate()}>
                {m['dashboard.settings.version_check']()}
              </Button>
            </div>
          </SettingsFieldRow>
          <SettingsFieldRow
            label={m['dashboard.settings.repository']()}
            description={m['dashboard.settings.repository_description']()}
          >
            <SettingsExternalLink href={REPOSITORY_URL}>{m['dashboard.settings.open']()}</SettingsExternalLink>
          </SettingsFieldRow>
          <SettingsFieldRow
            label={m['dashboard.settings.documentation']()}
            description={m['dashboard.settings.documentation_description']()}
          >
            <SettingsExternalLink href={DOCUMENTATION_URL}>{m['dashboard.settings.open']()}</SettingsExternalLink>
          </SettingsFieldRow>
        </FieldGroup>
      </CardContent>
    </Card>
  );
};
