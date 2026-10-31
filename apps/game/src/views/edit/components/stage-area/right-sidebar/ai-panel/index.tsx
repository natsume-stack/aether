import {AiPanel as CurrentAiPanel} from '~/components/ai-panel';

export interface AiPanelProps {hide:boolean;}
/** Preserve older sidebar imports through the current provider-aware panel. */
export function AiPanel({hide}:AiPanelProps) {return hide?null:<CurrentAiPanel/>;}
