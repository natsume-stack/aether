import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dataRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'box-local-default-skin-scope-'),
);
process.env.VOXA_DATA_PATH = dataRoot;
const previousPermissionSecret = process.env.PERMISSION_TOKEN_SECRET;
process.env.PERMISSION_TOKEN_SECRET = 'default-skin-regression-secret';

function requestHeaders() {
  return {
    host: '127.0.0.1:3001',
    authorization: 'Bearer default-skin-regression-secret',
  };
}

type MockResponse = {
  statusCode: number;
  body: unknown;
  setHeader: () => void;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  end: (body?: unknown) => MockResponse;
};

function response(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end(body) {
      this.body = body;
      return this;
    },
  };
}

async function main() {
  const [{ default: handler }, { saveModel }] = await Promise.all([
    import('../pages/api/local/default-skin'),
    import('../server/local-voxa-store'),
  ]);
  const skin = await saveModel({
    creativeMode: 2,
    modelName: 'Project A skin',
  });

  const putResponse = response();
  await handler(
    {
      method: 'PUT',
      query: { projectKey: 'project-a' },
      body: { projectKey: 'project-a', skinId: skin.modelId },
      headers: requestHeaders(),
      socket: { remoteAddress: '127.0.0.1' },
    } as any,
    putResponse as any,
  );
  assert.equal(putResponse.statusCode, 200);

  const projectAResponse = response();
  await handler(
    {
      method: 'GET',
      query: { projectKey: 'project-a' },
      headers: requestHeaders(),
      socket: { remoteAddress: '127.0.0.1' },
    } as any,
    projectAResponse as any,
  );
  assert.equal((projectAResponse.body as any)?.modelId, skin.modelId);

  const projectBResponse = response();
  await handler(
    {
      method: 'GET',
      query: { projectKey: 'project-b' },
      headers: requestHeaders(),
      socket: { remoteAddress: '127.0.0.1' },
    } as any,
    projectBResponse as any,
  );
  assert.equal(projectBResponse.body, null);
}

main()
  .then(() => console.log('default skin project scope regression passed'))
  .finally(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    if (previousPermissionSecret === undefined) delete process.env.PERMISSION_TOKEN_SECRET;
    else process.env.PERMISSION_TOKEN_SECRET = previousPermissionSecret;
  });
