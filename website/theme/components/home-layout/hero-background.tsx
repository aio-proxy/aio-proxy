export function HeroBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-[calc(-1*var(--rp-nav-height))] -z-10 h-[1100px] overflow-hidden select-none"
    >
      <div className="home-hero-grid absolute inset-0" />
      <div className="home-hero-aurora absolute top-[-18%] left-[8%] h-[640px] w-[640px] rounded-full bg-teal-300/35 blur-[120px] dark:bg-teal-600/25" />
      <div className="home-hero-aurora home-hero-aurora--late absolute top-[4%] right-[-6%] h-[560px] w-[560px] rounded-full bg-emerald-200/40 blur-[120px] dark:bg-teal-900/40" />
      <div className="absolute inset-x-0 bottom-0 h-72 bg-linear-to-b from-transparent to-(--rp-c-bg)" />
    </div>
  );
}
