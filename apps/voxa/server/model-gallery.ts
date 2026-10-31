import gallery from './voxa-gallery.json';

export type DesignReference = {
  id: number;
  title: string;
  tags: string[];
  dimensions: number[];
  nodes: number;
  palette: number;
  animated: boolean;
  description: string;
  source: string;
};

type Entry = DesignReference & { viewCount?: number };

const entries = ((gallery as any)?.entries || []) as Entry[];
const STOP_GRAMS = new Set(['一个', '一只', '模型', '建模', '设计', '制作', '精细', '帮我', '生成', '一下', '这个', '那个']);

function grams(prompt: string) {
  const text = String(prompt || '').toLowerCase();
  const out = new Set<string>();
  const latin = text.match(/[a-z0-9]{2,}/g) || [];
  for (const term of latin) out.add(term);
  const chinese = [...text].filter((char) => /[\u4e00-\u9fff]/.test(char));
  for (let index = 0; index < chinese.length - 1; index += 1) {
    const gram = chinese[index] + chinese[index + 1];
    if (!STOP_GRAMS.has(gram)) out.add(gram);
  }
  return out;
}

/**
 * Retrieves structural design references from the public VOXA gallery snapshot.
 * These are patterns (proportions, part counts, palette size), not templates to copy.
 */
export function retrieveDesignReferences(prompt: string, limit = 4): DesignReference[] {
  if (!entries.length) return [];
  const query = grams(prompt);
  const scored = entries.map((entry, index) => {
    const haystack = `${entry.title} ${entry.description} ${(entry.tags || []).join(' ')}`.toLowerCase();
    let matches = 0;
    for (const gram of query) if (haystack.includes(gram)) matches += 1;
    const popularity = Math.log10(1 + Number(entry.viewCount || 0));
    const paletteSignal = entry.palette > 0 ? 0.1 : 0;
    return { entry, score: matches * 10 + popularity + paletteSignal, index };
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = scored.filter((item) => item.score >= 10).slice(0, limit);
  const fallback = scored.slice(0, limit);
  return (selected.length ? selected : fallback).map(({ entry }) => ({
    id: entry.id,
    title: entry.title,
    tags: entry.tags || [],
    dimensions: entry.dimensions || [],
    nodes: entry.nodes || 0,
    palette: entry.palette || 0,
    animated: Boolean(entry.animated),
    description: String(entry.description || '').replace(/\s+/g, ' ').slice(0, 140),
    source: entry.source,
  }));
}
