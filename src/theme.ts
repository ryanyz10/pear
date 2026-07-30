import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

/** Minimal ANSI SGR wrapper — no chalk. */
function style(...codes: number[]): (text: string) => string {
  const open = `\x1b[${codes.join(";")}m`;
  return (text: string) => `${open}${text}\x1b[0m`;
}

const dim = style(2);
const bold = style(1);
const cyan = style(36);
const dimCyan = style(2, 36);
const yellow = style(33);
const blue = style(34);
const red = style(31);

export const selectTheme: SelectListTheme = {
  selectedPrefix: cyan,
  selectedText: style(1, 36),
  description: dim,
  scrollInfo: dim,
  noMatch: red,
};

export const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: selectTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: style(1, 35),
  link: blue,
  linkUrl: style(2, 34),
  code: yellow,
  codeBlock: dim,
  codeBlockBorder: dimCyan,
  codeBlockIndent: "  ",
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic: style(3),
  strikethrough: style(9),
  underline: style(4),
};

export { dim, bold, cyan, dimCyan, yellow, blue, red };
