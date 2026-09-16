// Static file server for the demo. Not part of the product build.
const root = new URL('.', import.meta.url).pathname;

Bun.serve({
  port: 4311,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(root + (path === '/' ? 'index.html' : path.slice(1)));
    return new Response(file);
  },
});
console.log('demo on http://localhost:4311');
