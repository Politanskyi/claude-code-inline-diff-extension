// File icons from the active file icon theme, for the Claude Changes list (a webview cannot use the
// theme directly). Follows VS Code's lookup order: file name, file extension (longest first),
// language id, then the theme's default file icon. Pure: the caller reads the theme JSON.

export interface IconThemeDoc {
  iconDefinitions?: Record<string, { iconPath?: string; fontCharacter?: string; fontColor?: string; fontId?: string; fontSize?: string }>;
  fonts?: { id: string; src: { path: string; format?: string }[]; weight?: string; style?: string; size?: string }[];
  file?: string;
  fileNames?: Record<string, string>;
  fileExtensions?: Record<string, string>;
  languageIds?: Record<string, string>;
}

/** The icon definition id for a file, or undefined when the theme has none. */
export function iconIdFor(theme: IconThemeDoc, fileName: string, languageId: string | undefined): string | undefined {
  const name = fileName.toLowerCase();
  const byName = theme.fileNames?.[name];
  if (byName) return byName;
  const parts = name.split('.');
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    const byExt = theme.fileExtensions?.[ext];
    if (byExt) return byExt;
  }
  if (languageId && theme.languageIds?.[languageId]) return theme.languageIds[languageId];
  return theme.file;
}

/** Strips // and /* *\/ comments and trailing commas (icon theme files are JSONC). */
export function parseJsonc(text: string): any {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
