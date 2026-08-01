import { describe, expect, test } from 'bun:test';

import { createCliAuthorizationPort } from '../authorization';
import { AuthorizationUrlInvalidError } from './index';
import { createDeps } from './test-support';

describe('authorize-url presentation', () => {
  test('opens and always prints the URL without a user code', async () => {
    const { deps, opened, printed } = createDeps();
    await createCliAuthorizationPort(deps).presentAuthorizeUrl({
      url: 'https://cursor.com/loginDeepControl?challenge=c',
    });
    expect(opened).toEqual(['https://cursor.com/loginDeepControl?challenge=c']);
    expect(printed).toEqual(['Opened authorization page.', 'https://cursor.com/loginDeepControl?challenge=c']);
  });

  test('prints only the URL when the browser cannot open and resolves localized instructions', async () => {
    const { deps, printed } = createDeps({ openBrowser: () => false });
    await createCliAuthorizationPort({ ...deps, locale: 'zh-Hans' }).presentAuthorizeUrl({
      url: 'https://cursor.com/loginDeepControl',
      instructions: { default: 'Finish in browser', 'zh-Hans': '请在浏览器中完成' },
    });
    expect(printed).toEqual(['https://cursor.com/loginDeepControl', '请在浏览器中完成']);
  });

  test('rejects a non-http URL', async () => {
    const { deps } = createDeps();
    await expect(
      createCliAuthorizationPort(deps).presentAuthorizeUrl({ url: 'javascript:alert(1)' }),
    ).rejects.toBeInstanceOf(AuthorizationUrlInvalidError);
  });
});
