import { HomeFooter } from '@rspress/core/theme';
import { HomeLayout as BasicHomeLayout } from '@rspress/core/theme-original';

import { Agents } from './agents';
import { FailoverDemo } from './failover-demo';
import { Hero } from './hero';
import { HeroBackground } from './hero-background';
import { Observability } from './observability';
import { ProtocolMatrix } from './protocol-matrix';
import { QuickStart } from './quick-start';
import { Stats } from './stats';
import { Subscriptions } from './subscriptions';
import { useScrolled } from './use-scrolled';

import './home-layout.css';

type HomeLayoutProps = React.ComponentProps<typeof BasicHomeLayout>;

export function HomeLayout(props: HomeLayoutProps) {
  const { sentinelRef, scrolled } = useScrolled<HTMLDivElement>();

  // The llms.txt markdown build reads hero/features from frontmatter; keep that output from the original layout.
  if (import.meta.env.SSG_MD) return <BasicHomeLayout {...props} />;

  return (
    <div className="home-layout relative isolate overflow-x-clip" data-scrolled={scrolled || undefined}>
      <div ref={sentinelRef} className="absolute inset-x-0 top-0 h-px" aria-hidden />
      <HeroBackground />
      <Hero />
      <Stats />
      <ProtocolMatrix />
      <FailoverDemo />
      <Subscriptions />
      <Agents />
      <Observability />
      <QuickStart />
      <HomeFooter />
    </div>
  );
}
