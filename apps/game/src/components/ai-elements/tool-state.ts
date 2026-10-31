import type {ToolUIPart} from 'ai';
/** Additional states rendered by the approval UI; application approval uses authoring plans. */
export type ToolDisplayState=ToolUIPart['state']|'approval-requested'|'approval-responded'|'output-denied';
