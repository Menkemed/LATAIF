// ═══════════════════════════════════════════════════════════
// LATAIF — AI Business Review Engine: Orchestrator
// Multi-turn OpenAI tool-calling loop. Returns user-visible
// blocks + assistant's final prose.
// ═══════════════════════════════════════════════════════════

import { callOpenAIWithTools } from './ai-service';
import { toolExecutors, toolSchemas, SYSTEM_PROMPT, type AIBlock, type ToolName } from './business-tools';

interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface AIToolInvocation {
  name: ToolName | string;
  args: Record<string, unknown>;
  block: AIBlock;
}

export interface AIEngineResult {
  blocks: AIBlock[];
  invocations: AIToolInvocation[];
  finalText: string;
  history: ChatMsg[];
}

const MAX_TOOL_HOPS = 4;

export async function runBusinessQuery(
  userQuestion: string,
  prevHistory: ChatMsg[] = [],
): Promise<AIEngineResult> {
  const messages: ChatMsg[] = prevHistory.length > 0
    ? [...prevHistory, { role: 'user', content: userQuestion }]
    : [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userQuestion },
      ];

  const invocations: AIToolInvocation[] = [];
  const blocks: AIBlock[] = [];

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const reply = await callOpenAIWithTools(messages, toolSchemas as any, 1500, 0.2);
    messages.push(reply as ChatMsg);

    const toolCalls = reply.tool_calls || [];
    if (toolCalls.length === 0) {
      // Final answer
      return {
        blocks,
        invocations,
        finalText: typeof reply.content === 'string' ? reply.content : '',
        history: messages,
      };
    }

    for (const call of toolCalls) {
      const name = call.function?.name as ToolName;
      let args: Record<string, unknown> = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }

      let block: AIBlock;
      const exec = toolExecutors[name];
      if (!exec) {
        block = { type: 'error', message: `Unknown tool: ${name}` };
      } else {
        try {
          block = exec(args);
        } catch (e: any) {
          block = { type: 'error', message: e?.message || String(e) };
        }
      }

      invocations.push({ name, args, block });
      blocks.push(block);

      // Feed result back as 'tool' message — content must be string for OpenAI.
      const toolPayload = block.type === 'error'
        ? { error: block.message }
        : block; // pass full structured block; OpenAI parses JSON.
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: JSON.stringify(toolPayload),
      });
    }
  }

  // Hit max hops without a final assistant reply.
  return {
    blocks,
    invocations,
    finalText: '_(reached tool-call limit)_',
    history: messages,
  };
}

export type { ChatMsg };
