import { m } from "@aio-proxy/i18n";

interface AioProxyBrandProps {
  readonly logoHeight?: string;
  readonly showTagline?: boolean;
}

export const AioProxyBrand: React.FC<AioProxyBrandProps> = ({ logoHeight = "24px", showTagline = true }) => {
  return (
    <div>
      <div
        className="flex items-center gap-1 font-heading text-[calc(var(--logo-height)*0.75)] font-semibold text-foreground"
        style={{ "--logo-height": logoHeight } as React.CSSProperties}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 672 480"
          className="inline-block h-(--logo-height) w-auto fill-current"
          style={{ height: logoHeight }}
        >
          <title>AIO</title>
          <path d="M515.704 110q29.952 0 54.528 10.368 24.96 10.368 43.392 29.184 18.816 18.816 28.8 44.16t9.984 55.296-9.984 55.296-28.8 44.16q-18.432 18.816-43.392 29.184-24.576 10.368-54.528 10.368-29.568 0-54.528-10.368t-43.776-28.8q-18.431-18.816-28.416-44.16Q379 278.96 379 249.008q0-30.336 9.984-55.296 9.984-25.344 28.416-44.16 18.816-18.816 43.776-29.184T515.704 110M379 385h-59L220 116h59zm-114.496-1.2h-59.136l-21.112-56.448H81.113L59.832 383.8H3L108.216 115h51.456zm251.2-219.272q-16.896 0-31.104 6.528-14.208 6.144-24.96 17.664-10.752 11.136-16.512 26.496-5.376 15.36-5.376 33.792t5.376 33.792q5.76 15.36 16.512 26.88t24.96 17.664 31.104 6.144 31.104-6.144q14.592-6.144 24.96-17.664t16.128-26.88q6.144-15.36 6.144-33.792t-6.144-33.792q-5.76-15.36-16.128-26.496-10.369-11.52-24.96-17.664-14.208-6.528-31.104-6.528M132.792 184.12a1365 1365 0 0 1-5.76 19.2 406 406 0 0 1-6.528 18.816 799 799 0 0 0-6.528 18.048L98.63 280.888h68.248l-15.654-41.856a1316 1316 0 0 1-5.76-15.744q-3.072-9.6-6.528-20.352a15412 15412 0 0 1-6.09-18.987z" />
        </svg>
        <span>Proxy</span>
      </div>
      {showTagline ? <div className="mt-1 truncate text-xs text-muted-foreground">{m["brand.tagline"]()}</div> : null}
    </div>
  );
};
