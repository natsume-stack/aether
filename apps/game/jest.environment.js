'use strict';

// Rush loads deployment .env files before invoking global repository tasks.
// Fixtures must opt into services and proxy trust before importing server code,
// so a unit test cannot connect to the operator's database or trust their proxy.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('BOX_') || name === 'PERMISSION_TOKEN_SECRET') {
    delete process.env[name];
  }
}
// Keep MODERATION_TEST_DATABASE_URL: that integration test explicitly installs
// its own temporary schema and credentials, and closes all database pools.
