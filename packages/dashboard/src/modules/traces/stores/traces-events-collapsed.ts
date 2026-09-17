import { atomWithStorage } from 'jotai/utils';

// 折叠是个人显示偏好，存 localStorage 而不是 URL：进了 URL 就会被分享出去，
// 对方打开链接看到的是你的折叠状态。
// getOnInit 让首帧就读到存的值，否则会先展开一帧再收起来，闪一下。
export const tracesEventsCollapsedAtom = atomWithStorage('aio-proxy:traces-events-collapsed', false, undefined, {
  getOnInit: true,
});
