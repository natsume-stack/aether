import fs from 'fs';
import path from 'path';
import { apis } from '../src/apis/local-api';
import { clientConfig } from '../src/config/client';

const gameRoot = path.resolve(__dirname, '..');

function source(relativePath: string) {
  return fs.readFileSync(path.join(gameRoot, relativePath), 'utf8');
}

function functionBody(contents: string, start: string, end: string) {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}

describe('local VOXA library query contract', () => {
  test('the editor local-model tab reads server-wide private models', () => {
    const contents = source(
      'src/views/edit/components/stage-area/edit-model-panel/project-model-source.ts',
    );
    const body = functionBody(
      contents,
      'async function loadLocalModels',
      'const localProjectModelSource',
    );

    expect(body).toContain('modelType: ModelType.Private');
    expect(body).not.toContain('modelType: ModelType.Project');
  });

  test('the local-skin import dialog reads every local skin type', () => {
    const contents = source(
      'src/views/edit/components/player-manager/project-skin/skin-lib/index.tsx',
    );
    const initialLoad = functionBody(
      contents,
      '// 个人皮肤列表',
      'useEffect(() => {\n    if (!searchName)',
    );

    expect(initialLoad).toContain('fetchSkinData({})');
    expect(initialLoad).not.toContain(
      'fetchSkinData({ modelType: ModelType.ExtensionLib })',
    );
    expect(contents.match(/\? undefined\n\s*: libTab/g)).toHaveLength(2);
  });

  test('proxies local model queries through Creator with uncached same-origin credentials', async () => {
    const route = source('pages/api/creator-models/index.ts');
    const originalRequest = globalThis.Request;
    const originalFetch = globalThis.fetch;
    const originalVoxaUrl = clientConfig.VOXA_URL;
    const requests: Request[] = [];
    try {
      // Node has no document origin; provide the browser's relative-URL behavior.
      globalThis.Request = class extends originalRequest {
        constructor(input: RequestInfo | URL, init?: RequestInit) {
          super(
            typeof input === 'string'
              ? new URL(input, 'http://creator.test')
              : input,
            init,
          );
        }
      };
      clientConfig.VOXA_URL = 'http://voxa.internal:3001';
      globalThis.fetch = async (input) => {
        requests.push(input as Request);
        return Response.json({
          rows: [
            {
              id: 'model-1',
              modelPreviewUrl: '/api/creator-models/blobs/hash-1',
            },
          ],
          count: 1,
        });
      };
      const result = await apis.models.getModelsUsingGetV2({
        modelType: 1,
        modelName: '树',
        mapId: undefined,
      });
      expect(requests).toHaveLength(1);
      const url = new URL(requests[0].url);
      expect(url.origin).toBe('http://creator.test');
      expect(url.pathname).toBe('/api/creator-models');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        modelType: '1',
        modelName: '树',
      });
      expect(requests[0].credentials).toBe('same-origin');
      expect(requests[0].cache).toBe('no-store');
      expect(result.rows[0].modelPreviewUrl).toBe(
        '/api/creator-models/blobs/hash-1',
      );
    } finally {
      globalThis.Request = originalRequest;
      globalThis.fetch = originalFetch;
      clientConfig.VOXA_URL = originalVoxaUrl;
    }
    expect(route).toContain('`/api/local/models${suffix}`');
    expect(route).toContain(
      "['modelType', 'mapId', 'creativeMode', 'modelName']",
    );
  });

  test('opens the configured local VOXA origin instead of a removed platform route', () => {
    const render = source('server/server-render.ts');
    const config = source('configs/server.ts');

    expect(render).toContain('serverConfig.isLocalGameServer');
    expect(render).toContain('? extractedConfig.VOXA_URL');
    expect(config).toContain('VOXA_URL: maybeS(process.env.VOXA_URL)');
  });
});
