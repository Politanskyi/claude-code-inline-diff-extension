// Minimal stand-in for the `vscode` module so pure helpers living in editor-facing files can be unit-tested.
export const workspace = { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) };
export const window = { activeColorTheme: { kind: 2 } };
export const extensions = { all: [] };
export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}
