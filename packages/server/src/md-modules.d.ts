// Bun resolves `import x from './file.md' with { type: 'text' }` to the file's
// text at runtime. Declare the module shape so type-checking accepts it too.
declare module '*.md' {
  const content: string;
  export default content;
}
