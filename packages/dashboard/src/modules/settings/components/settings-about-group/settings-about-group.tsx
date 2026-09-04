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
        <FieldGroup>
          <SettingsFieldRow
            label={m['dashboard.settings.version']()}
            description={versionDescription ?? <Skeleton className="h-4 w-40" />}
          >
            <div className="flex items-center justify-end gap-1">
              <Button variant="ghost" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
                {m['dashboard.settings.version_check']()}
              </Button>
              <SettingsExternalLink
                href={current === undefined ? REPOSITORY_URL : `${REPOSITORY_URL}/releases/tag/v${current}`}
                label={m['dashboard.settings.version']()}
              />
            </div>
          </SettingsFieldRow>
          <SettingsFieldRow
            label={m['dashboard.settings.repository']()}
            description={m['dashboard.settings.repository_description']()}
          >
            <div className="flex justify-end">
              <SettingsExternalLink href={REPOSITORY_URL} label={m['dashboard.settings.repository']()} />
            </div>
          </SettingsFieldRow>
          <SettingsFieldRow
            label={m['dashboard.settings.documentation']()}
            description={m['dashboard.settings.documentation_description']()}
          >
            <div className="flex justify-end">
              <SettingsExternalLink href={DOCUMENTATION_URL} label={m['dashboard.settings.documentation']()} />
            </div>
          </SettingsFieldRow>
        </FieldGroup>
      </CardContent>
    </Card>
  );
};
