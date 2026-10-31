import fs from 'node:fs';
import path from 'node:path';
import { migrateModel } from '@box/voxa-project';

const API = 'https://dao3.fun';
const ASSETS = 'https://assets.box3.fun/engine/m';
const LIMIT = Number(process.argv[2] || 40);
const OUT = path.resolve(process.argv[3] || 'server/voxa-gallery.json');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

function nextData(html: string) {
  const marker = html.indexOf('__NEXT_DATA__');
  if (marker < 0) return undefined;
  const start = html.indexOf('>', marker) + 1;
  const end = html.indexOf('</script>', start);
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return undefined;
  }
}

function tagsOf(description: string) {
  return [...new Set([...String(description || '').matchAll(/#([^\s#]{1,24})/g)].map((match) => match[1]))].slice(0, 12);
}

function statsOf(data: any) {
  const nodes = Object.keys(data?.nodes || {}).length;
  const meshes = Array.isArray(data?.meshes) ? data.meshes.length : 0;
  const palette = Array.isArray(data?.texture?.palette) ? data.texture.palette.length : Number(data?.texture?.width) || 0;
  return { nodes, meshes, palette };
}

async function enrich(id: number) {
  const detail = await json(`${API}/api/model-detail?modelId=${id}`);
  const entry: any = {
    id,
    title: String(detail.title || ''),
    description: String(detail.description || ''),
    tags: tagsOf(detail.description),
    animated: Boolean(detail.animated),
    viewCount: Number(detail.viewCount) || 0,
    likeCount: Number(detail.likeCount) || 0,
    favoritesCount: Number(detail.favoritesCount) || 0,
    author: detail.author?.nickname || '',
    previewUrl: detail.previewUrl || '',
    modelFileHash: detail.modelFileHash || '',
    source: `${API}/exp/model/detail/${id}`,
  };
  if (detail.modelFileHash) {
    try {
      const metaResponse = await fetch(`${ASSETS}/${detail.modelFileHash}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (metaResponse.ok) {
        const meta: any = await metaResponse.json();
        entry.dimensions = Array.isArray(meta.bounds) ? meta.bounds.map((value: number) => Number(value.toFixed(2))) : [];
        entry.dataHash = meta.dataHash || '';
        entry.animations = Array.isArray(meta.motionList) ? meta.motionList.length : 0;
        if (meta.dataHash) {
          const dataResponse = await fetch(`${ASSETS}/${meta.dataHash}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
          if (dataResponse.ok) {
            const bytes = new Uint8Array(await dataResponse.arrayBuffer());
            entry.bytes = bytes.byteLength;
            try {
              const parsed: any = await migrateModel(bytes);
              if (parsed) Object.assign(entry, statsOf(parsed));
            } catch {
              entry.parse = 'failed';
            }
          }
        }
      }
    } catch {
      entry.meta = 'unavailable';
    }
  }
  return entry;
}

function collectIds(value: any, out: Set<number>) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) collectIds(item, out); return; }
  if (Number.isSafeInteger(value.id) && (value.previewUrl || value.title)) out.add(Number(value.id));
  for (const child of Object.values(value)) collectIds(child, out);
}

async function main() {
  const seed = new Map<number, any>();
  const newest = await json(`${API}/api/page-translated-newest-model`);
  for (const row of newest.rows || []) seed.set(Number(row.id), row);
  const page = await fetch(`${API}/exp/model`, { headers: { 'user-agent': 'Mozilla/5.0' } }).then((response) => response.text());
  const data = nextData(page);
  for (const content of data?.props?.pageProps?.contents || []) {
    for (const row of content.modelList || []) seed.set(Number(row.id), row);
  }
  const queue = [...seed.keys()];
  const visited = new Set<number>();
  const entries: any[] = [];
  while (queue.length && entries.length < LIMIT) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    try {
      entries.push(await enrich(id));
      console.log(`ok ${entries.length}/${LIMIT} ${id}`);
    } catch (error) {
      console.log(`skip ${id} ${(error as Error).message}`);
    }
    try {
      const html = await fetch(`${API}/exp/model/detail/${id}`, { headers: { 'user-agent': 'Mozilla/5.0' } }).then((response) => response.text());
      const data = nextData(html);
      const ids = new Set<number>();
      collectIds(data?.props?.pageProps, ids);
      for (const next of ids) if (!visited.has(next) && !queue.includes(next)) queue.push(next);
    } catch { /* ignore recommendation failures */ }
    await sleep(200);
  }
  fs.writeFileSync(OUT, JSON.stringify({
    format: 'voxa-gallery-knowledge/1',
    generatedAt: new Date().toISOString(),
    source: `${API}/exp/model`,
    note: '公开展厅元数据与结构统计，用于设计模式检索；不包含模型二进制本体。',
    count: entries.length,
    entries,
  }, null, 2));
  console.log('wrote', OUT, entries.length);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
