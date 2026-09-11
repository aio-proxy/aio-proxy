import type { ProviderRouteSource } from '../../runtime';
import type { VideoJobStore } from './job-store';

export type VideosRouteSource = ProviderRouteSource & {
  readonly videoJobs: VideoJobStore;
};
