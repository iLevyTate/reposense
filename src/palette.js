/**
 * Language detection + colour system.
 *
 * Colours are drawn from GitHub Linguist's palette, then nudged toward higher
 * chroma so they survive the bloom pass without washing out to white.
 */

const LANGUAGE_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#4f8cf7',
  Python: '#3aa3f5',
  Java: '#e76f00',
  'C#': '#8a5cf6',
  'C++': '#f34b7d',
  C: '#8fb6ff',
  Go: '#00ffd0',
  Rust: '#ff9166',
  Ruby: '#ff4d6a',
  PHP: '#8f8ff0',
  Swift: '#ff6b52',
  Kotlin: '#b07cff',
  Scala: '#ff3c3c',
  Dart: '#3ad6ff',
  Elixir: '#c07cff',
  Haskell: '#8f68b0',
  Lua: '#4f6bff',
  Perl: '#43c9ff',
  R: '#3fa7ff',
  Julia: '#c66bff',
  Shell: '#63f26e',
  PowerShell: '#3a6ff5',
  HTML: '#ff5c33',
  CSS: '#8f6bff',
  SCSS: '#ff5fa8',
  Vue: '#41d18a',
  Svelte: '#ff5426',
  SQL: '#ffb347',
  Markdown: '#7fa8d0',
  JSON: '#c9d24a',
  YAML: '#ff8fa3',
  TOML: '#b0895f',
  XML: '#7fd0c0',
  Docker: '#3aa9f5',
  Terraform: '#a06bff',
  Protobuf: '#7fc4d0',
  GraphQL: '#ff4fb0',
  Solidity: '#a0a0ff',
  Zig: '#ffb84d',
  Nix: '#6fa0ff',
  Assembly: '#a8917d',
  'Objective-C': '#4f8fff',
  'Jupyter Notebook': '#ff9a3f',
  Image: '#57e0b0',
  Font: '#d0a0ff',
  Audio: '#ffcf5c',
  Video: '#ff7fb0',
  Archive: '#9a9aa8',
  Binary: '#6b7280',
  Config: '#9fb0c0',
  Text: '#8b98a8',
  Other: '#5f6b7a',
};

/** extension (no dot, lowercased) -> language name */
const EXT_MAP = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  py: 'Python', pyi: 'Python', pyw: 'Python',
  java: 'Java', class: 'Java', jar: 'Archive',
  cs: 'C#', csx: 'C#',
  cpp: 'C++', cxx: 'C++', cc: 'C++', hpp: 'C++', hxx: 'C++',
  c: 'C', h: 'C',
  go: 'Go', mod: 'Go', sum: 'Go',
  rs: 'Rust',
  rb: 'Ruby', erb: 'Ruby', gemspec: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kt: 'Kotlin', kts: 'Kotlin',
  dart: 'Dart',
  ex: 'Elixir', exs: 'Elixir',
  hs: 'Haskell',
  lua: 'Lua',
  pl: 'Perl', pm: 'Perl',
  r: 'R',
  jl: 'Julia',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell',
  ps1: 'PowerShell', psm1: 'PowerShell',
  html: 'HTML', htm: 'HTML',
  css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'SCSS',
  vue: 'Vue',
  svelte: 'Svelte',
  sql: 'SQL',
  md: 'Markdown', mdx: 'Markdown', markdown: 'Markdown', rst: 'Markdown',
  json: 'JSON', jsonc: 'JSON', json5: 'JSON',
  yml: 'YAML', yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML', svg: 'XML', xsd: 'XML',
  tf: 'Terraform', tfvars: 'Terraform',
  proto: 'Protobuf',
  graphql: 'GraphQL', gql: 'GraphQL',
  sol: 'Solidity',
  zig: 'Zig',
  nix: 'Nix',
  asm: 'Assembly', s: 'Assembly',
  m: 'Objective-C', mm: 'Objective-C',
  ipynb: 'Jupyter Notebook',
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image',
  ico: 'Image', bmp: 'Image', avif: 'Image', tiff: 'Image',
  woff: 'Font', woff2: 'Font', ttf: 'Font', otf: 'Font', eot: 'Font',
  mp3: 'Audio', wav: 'Audio', ogg: 'Audio', flac: 'Audio', m4a: 'Audio',
  mp4: 'Video', webm: 'Video', mov: 'Video', avi: 'Video', mkv: 'Video',
  zip: 'Archive', gz: 'Archive', tar: 'Archive', bz2: 'Archive',
  xz: 'Archive', rar: 'Archive', '7z': 'Archive',
  wasm: 'Binary', so: 'Binary', dll: 'Binary', dylib: 'Binary',
  exe: 'Binary', bin: 'Binary', o: 'Binary', a: 'Binary', pdf: 'Binary',
  lock: 'Config', ini: 'Config', cfg: 'Config', conf: 'Config',
  env: 'Config', properties: 'Config', editorconfig: 'Config',
  txt: 'Text', log: 'Text', csv: 'Text', tsv: 'Text',
};

/** Whole filenames that beat extension matching. */
const NAME_MAP = {
  dockerfile: 'Docker',
  containerfile: 'Docker',
  makefile: 'Shell',
  rakefile: 'Ruby',
  gemfile: 'Ruby',
  procfile: 'Config',
  'cargo.toml': 'Rust',
  'go.mod': 'Go',
  'go.sum': 'Go',
  license: 'Text',
  'license.md': 'Text',
  notice: 'Text',
  '.gitignore': 'Config',
  '.gitattributes': 'Config',
  '.npmrc': 'Config',
  '.nvmrc': 'Config',
  '.dockerignore': 'Config',
};

export function basename(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function extensionOf(path) {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

export function languageOf(path) {
  const name = basename(path).toLowerCase();
  if (NAME_MAP[name]) return NAME_MAP[name];
  if (name.startsWith('dockerfile')) return 'Docker';
  const ext = extensionOf(path);
  return EXT_MAP[ext] || (ext ? 'Other' : 'Text');
}

export function colorOf(language) {
  return LANGUAGE_COLORS[language] || LANGUAGE_COLORS.Other;
}

export function knownLanguages() {
  return Object.keys(LANGUAGE_COLORS);
}

/** '#rrggbb' -> {r,g,b} in 0..1, sRGB. */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}
