// Static file server for the demo. Not part of the product build.
const root = new URL('.', import.meta.url).pathname;

Bun.serve({
  port: 4312,
  fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(Bun.file(root + (path === '/' ? 'index.html' : path.slice(1))));
  },
});
console.log('demo on http://localhost:4312');
