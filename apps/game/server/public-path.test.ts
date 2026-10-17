import { publicPath } from './public-path';

const base = process.env.BOX_APP_BASE_PATH;
const peers = process.env.BOX_PUBLIC_SERVICE_PREFIXES;

afterEach(() => {
  if (base === undefined) delete process.env.BOX_APP_BASE_PATH;
  else process.env.BOX_APP_BASE_PATH = base;
  if (peers === undefined) delete process.env.BOX_PUBLIC_SERVICE_PREFIXES;
  else process.env.BOX_PUBLIC_SERVICE_PREFIXES = peers;
});

test('prefixes runtime navigation paths exactly once', () => {
  process.env.BOX_APP_BASE_PATH = '/woooow';
  process.env.BOX_PUBLIC_SERVICE_PREFIXES = '["/abc","/wdjcj"]';
  expect(publicPath('/e/project-one')).toBe('/woooow/e/project-one');
  expect(publicPath('/p/project-one')).toBe('/woooow/p/project-one');
  expect(publicPath('/woooow/e/project-one')).toBe('/woooow/e/project-one');
  expect(publicPath('/abc/e/project-one')).toBe('/abc/e/project-one');
  expect(publicPath('https://example.test/e/one')).toBe('https://example.test/e/one');
});

test('leaves paths untouched without a deployment base path', () => {
  delete process.env.BOX_APP_BASE_PATH;
  delete process.env.BOX_PUBLIC_SERVICE_PREFIXES;
  expect(publicPath('/e/project-one')).toBe('/e/project-one');
});
