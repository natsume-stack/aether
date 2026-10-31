const nextJest = require('next/jest');

const createJestConfig = nextJest({
  dir: './',
});

const customJestConfig = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.environment.js'],
  reporters: [
    'default',
    ...(process.env.JEST_HTML_REPORT === '1'
      ? [
          [
            'jest-html-reporters',
            {
              publicPath: './html-report',
              filename: 'report.html',
              openReport: false,
            },
          ],
        ]
      : []),
  ],
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = createJestConfig(customJestConfig);
