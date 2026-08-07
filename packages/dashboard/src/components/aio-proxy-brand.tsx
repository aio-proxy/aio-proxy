import { m } from '@aio-proxy/i18n';
import { AioProxyLogo } from '@aio-proxy/ui/components/aio-proxy-logo';

interface AioProxyBrandProps {
  readonly className?: string;
  readonly showTagline?: boolean;
}

export const AioProxyBrand: React.FC<AioProxyBrandProps> = ({ className, showTagline = true }) => {
  return (
    <div>
      <AioProxyLogo className={className} />
      {showTagline ? <div className="mt-1 truncate text-xs text-muted-foreground">{m['brand.tagline']()}</div> : null}
    </div>
  );
};
