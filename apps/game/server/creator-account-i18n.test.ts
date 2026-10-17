import fs from 'node:fs';
import path from 'node:path';

const projectsPage = fs.readFileSync(
  path.resolve(__dirname, '../pages/projects/index.tsx'),
  'utf8',
);

describe('creator account profile dialog', () => {
  test('provides react-intl context for the shared account editor', () => {
    expect(projectsPage).toContain("import { IntlProvider } from 'react-intl';");
    expect(projectsPage).toMatch(
      /<IntlProvider locale="zh-CN" messages=\{zhMessages\}>[\s\S]*<PlayerAccount/,
    );
  });
});
