import { expect, test } from 'bun:test';

import { Glob } from 'bun';

import { spanName, spanRegistry } from './semantic';

const SRC = new URL('../../', import.meta.url).pathname;

async function sourceFiles(): Promise<readonly string[]> {
  const paths = await Array.fromAsync(new Glob('**/*.ts').scan({ cwd: SRC, absolute: true }));
  return paths.filter((path) => !path.includes('/request-tracing/semantic/') && !path.includes('.test.'));
}

// 只要文件里出现过常量就算「有创建点」是不够的：一次比较、一次过滤、一行日志都能蒙过去。
// 下面两条都要求名字落在某个 `start*Span(` 的参数表里 —— 本包开 span 只有这一种写法
// （OTel 的 `tracer.startSpan` 与包内的 `startPipelineSpan`）。`[^;]` 不跨分号，所以同文件里
// 另一处 span 的创建点借不到位置；但它放行括号，`startPipelineSpan(rootOf(session), …)`
// 这种把前一个参数改成计算式的普通重构不会被误判成「创建点没了」。
const OPENS_A_SPAN = /\bstart\w*Span\s*\(/u;

function opensSpanNamed(key: string): RegExp {
  return new RegExp(String.raw`\bstart\w*Span\s*\(\s*[^;]*\bspanName\.${key}\b`, 'u');
}

test('every declared span has a creation site that goes through the registry', async () => {
  for (const [key, declaration] of Object.entries(spanRegistry)) {
    // 名字只能引用 spanName，不能手写：第三条 test 只比 key 的集合，比不出值被写错。
    expect(declaration.name, `${key}: registry 里的名字和 spanName 对不上`).toBe(
      (spanName as Record<string, string | undefined>)[key],
    );
    const file = Bun.file(`${SRC}${declaration.createdBy}`);
    expect(await file.exists(), `${key}: createdBy 指向的文件不存在`).toBe(true);
    const source = await file.text();
    // 固定名的 span 必须用常量创建；动态名的 span（GenAI、上游 HTTP）只能校验创建点存在。
    if (declaration.name === undefined) {
      expect(OPENS_A_SPAN.test(source), `${key}: ${declaration.createdBy} 里没有 span 创建点`).toBe(true);
    } else {
      expect(
        opensSpanNamed(key).test(source),
        `${key}: ${declaration.createdBy} 没有用 spanName.${key} 创建 span`,
      ).toBe(true);
    }
    for (const parent of declaration.parent) {
      expect(Object.keys(spanRegistry)).toContain(parent);
    }
  }
});

test('no aio_proxy name is minted outside the semantic module', async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles()) {
    if ((await Bun.file(path).text()).includes("'aio_proxy.")) offenders.push(path.slice(SRC.length));
  }

  expect(offenders).toEqual([]);
});

test('spanName and the registry describe the same set of spans', () => {
  expect(Object.keys(spanName).sort()).toEqual(
    Object.entries(spanRegistry)
      .filter(([, declaration]) => declaration.name !== undefined)
      .map(([key]) => key)
      .sort(),
  );
});
