import { HomeBackground as BasicHomeBackground } from '@rspress/core/theme-original';

export function HomeBackground() {
  return (
    <BasicHomeBackground className="blur-none!">
      <svg aria-hidden="true" className="h-full w-full" fill="none" preserveAspectRatio="none" viewBox="0 0 1440 640">
        <g stroke="var(--color-teal-500)" strokeWidth="1">
          <path d="M-80 170C210 40 440 410 760 240s430-170 760-30" opacity="0.12" />
          <path d="M-60 470c330-210 560 50 850-100s420-170 710 10" opacity="0.1" />
          <path d="M160 690C350 390 700 590 930 350s350-210 650-100" opacity="0.08" />
        </g>
        <g className="motion-reduce:hidden">
          <circle fill="var(--color-teal-400)" r="3">
            <animateMotion dur="9s" path="M-80 170C210 40 440 410 760 240s430-170 760-30" repeatCount="indefinite" />
          </circle>
          <circle fill="var(--color-teal-400)" opacity="0.2" r="12">
            <animateMotion dur="9s" path="M-80 170C210 40 440 410 760 240s430-170 760-30" repeatCount="indefinite" />
          </circle>
        </g>
      </svg>
    </BasicHomeBackground>
  );
}
