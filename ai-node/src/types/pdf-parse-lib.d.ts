// pdf-parse's library file, imported directly (format-handlers/pdf-handler.ts says why).
// @types/pdf-parse only declares the package root.
declare module 'pdf-parse/lib/pdf-parse.js' {
  import pdfParse from 'pdf-parse';
  export default pdfParse;
}
