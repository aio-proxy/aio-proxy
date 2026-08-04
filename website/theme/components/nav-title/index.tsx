import { AioProxyLogo } from '@aio-proxy/ui/components/aio-proxy-logo';
import { addLeadingSlash, addTrailingSlash, useLang, useSite } from '@rspress/core/runtime';
import { Link } from '@rspress/core/theme';

export const NavTitle = () => {
  const { site } = useSite();
  const lang = useLang();
  const langRoutePrefix = lang === site?.lang ? '/' : addTrailingSlash(lang);

  return (
    <div className="rp-nav__title">
      <Link href={site?.logoHref || addLeadingSlash(langRoutePrefix)} className="rp-nav__title__link">
        <AioProxyLogo className="text-lg" />
      </Link>
    </div>
  );
};
