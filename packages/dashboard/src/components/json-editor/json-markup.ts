import { Marked } from 'marked';

const marked = new Marked({
  gfm: true,
  breaks: true,
});

export const markdownToDom = (markdown: string): DocumentFragment => {
  const wrap = document.createElement('div');
  wrap.className = 'typeset';
  wrap.innerHTML = marked.parse(markdown, { async: false });

  const fragment = document.createDocumentFragment();
  fragment.append(wrap);
  return fragment;
};
